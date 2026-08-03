import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import {
  RESYNC_DEBOUNCE_MS,
  RESYNC_TRIGGER_TYPES,
  connectionStateFrame,
  initialGameState,
  makeResyncScheduler,
  resolveResyncIdleMs,
  shouldEmitStateSync,
  shouldResyncOnObservation,
  snapshotFingerprint,
  stateSyncFrame,
} from "./account-socket.js"
import { libStateToSnapshot } from "./lib-state.js"
import type { FullStateSnapshot } from "./lib-state.js"
import type { GameState as LibGameState } from "@spacemolt/lib"

const snap = (): FullStateSnapshot => ({
  player: { username: "Pilot", current_system: "first_step", current_poi: "poiA", docked_at_base: null } as never,
  ship: { fuel: 6, max_fuel: 100, hull: 80, max_hull: 100, cargo_used: 3, cargo_capacity: 10 } as never,
  cargo: [{ item_id: "ore_iron", quantity: 3 }],
  system: { id: "first_step", name: "First Step" } as never,
  poi: { id: "poiA", name: "Rubble Field" } as never,
})

/**
 * A realistic raw `LibGameState`-shaped cache — player/ship/location fixed,
 * `missions`/`queue` supplied per-test — for exercising the FULL
 * `libStateToSnapshot` → `snapshotFingerprint` pipeline the way `account-socket.ts`
 * actually calls it, rather than testing `snapshotFingerprint` in isolation
 * against a hand-built `FullStateSnapshot` (which can't express "the raw cache
 * had different missions data" at all, once `FullStateSnapshot` is not the
 * carrier of that data).
 */
const rawCacheFixture = (missions: unknown, queue: unknown): LibGameState =>
  ({
    player: { id: "p1", username: "Pilot", credits: 4200 },
    ship: {
      id: "s1", class_id: "prospector", name: "Prospector",
      hull: 80, max_hull: 100, fuel: 6, max_fuel: 100,
      cargo_used: 3, cargo_capacity: 10,
    },
    location: { system_id: "first_step", poi_id: "poiA", docked_at: null },
    cargo: [{ item_id: "ore_iron", quantity: 3 }],
    modules: [],
    skills: {},
    missions,
    queue,
  }) as unknown as LibGameState

describe("shouldEmitStateSync — the observation-bridge suppressor", () => {
  it("SUPPRESSES a location-only firing whose identity did not move", () => {
    // OBSERVED LIVE 2026-08-02 (Task 3 probe): 8 of 9 non-seed onStateChange
    // firings were subscribeObservation()'s presence bridge patching
    // nearby_players into the location section. RE-OBSERVED against the actual
    // adapter (this task, 2026-08-03, character vcarl, 120s window, docked the
    // whole time): 6 observation_update pushes arrived and state_sync fired
    // exactly once (the seed) — zero of the six bridge-only onStateChange
    // firings produced a spurious "you moved" frame. Emitting on those would
    // put a false movement frame in front of the appraiser several times a
    // minute, forever.
    expect(shouldEmitStateSync(["location"], "sys|poi|base", "sys|poi|base")).toBe(false)
  })

  it("EMITS a location-only firing whose identity actually moved", () => {
    expect(shouldEmitStateSync(["location"], "sys|poiA|", "sys|poiB|")).toBe(true)
    expect(shouldEmitStateSync(["location"], "sys|poiA|base", "sys|poiA|")).toBe(true)
  })

  it("EMITS whenever any non-location section changed, identity or not", () => {
    expect(shouldEmitStateSync(["ship"], "x", "x")).toBe(true)
    expect(shouldEmitStateSync(["cargo", "location"], "x", "x")).toBe(true)
    expect(shouldEmitStateSync(["player", "ship", "modules", "cargo", "location", "missions", "queue", "skills"], "", "x")).toBe(true)
  })

  it("never emits for an empty change list", () => {
    expect(shouldEmitStateSync([], "x", "y")).toBe(false)
  })
})

describe("stateSyncFrame", () => {
  it("leads the payload with the changed section names, then tick, then the snapshot", () => {
    // Order is load-bearing: the loop renders an event as
    // `type: <t>\n<JSON.stringify(event)>`, so the 2B's first tokens after the
    // type line are English section names rather than an opening brace.
    const f = stateSyncFrame(["ship", "cargo"], snap(), 1514396)
    expect(f.type).toBe("state_sync")
    expect(Object.keys(f.payload as object)).toEqual(["sections", "tick", "snapshot"])
    expect((f.payload as { sections: string[] }).sections).toEqual(["ship", "cargo"])
    expect((f.payload as { tick: number }).tick).toBe(1514396)
  })

  it("copies the section list rather than aliasing the library's array", () => {
    const sections = ["ship"]
    const f = stateSyncFrame(sections, snap(), 1)
    sections.push("cargo")
    expect((f.payload as { sections: string[] }).sections).toEqual(["ship"])
  })
})

describe("snapshotFingerprint — the idle-floor poll-dedup guard", () => {
  it("is equal for two structurally-identical snapshots", () => {
    // FIX for review finding "Important 2": StateCache.copySection reports a
    // section as changed by PRESENCE in a get_status response, not by
    // diffing values, so the 120s idle floor's refresh() reports all 8
    // sections changed every time it fires — whether or not anything moved.
    // Without this fingerprint check, that would mint an identical
    // state_sync every 120s forever: the dead 45s poll wearing a longer
    // interval. Two calls to libStateToSnapshot on an unchanged cache must
    // fingerprint equal so the sink can suppress the second one.
    expect(snapshotFingerprint(snap())).toBe(snapshotFingerprint(snap()))
  })

  it("differs when a real translated field actually changed", () => {
    const a = snap()
    const b = { ...snap(), ship: { ...snap().ship, fuel: 5 } }
    expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint(b))
  })

  // REVIEW ROUND 3 — the critical regression this test locks down, and the
  // design decision behind why the fix looks like this. Full story in
  // `snapshotFingerprint`'s docblock and task-4-report.md's "Fix round 3".
  //
  // Round 2 folded the RAW `missions`/`queue` cache sections into the hash to
  // fix round 1's silent-drop bug. But `missions.active[].expires_in_ticks`
  // is a per-tick countdown (56422 in the live captured snapshot), hashed
  // verbatim — so the idle floor's 120s check differed on essentially every
  // firing for the entire lifetime of any active mission: a full state_sync
  // minted every 120s for potentially days. Missions are core gameplay, not
  // a narrow edge case, so this was Critical, not cosmetic.
  //
  // DECISION: reverted to hashing ONLY the translated snapshot.
  // `FullStateSnapshot` never carries missions/queue VALUES regardless of
  // whether a frame fires (Task 3's deliberate scope), and nothing
  // downstream reads the emitted frame's `sections` list specially either —
  // so a missions/queue-only change is invisible to this read path BY
  // CONSTRUCTION, not merely under-hashed. That makes the fingerprint
  // correctly — not as a residual bug — insensitive to ALL missions/queue
  // content: both a bare countdown tick AND a genuine standalone mission
  // change produce the SAME (non-)result, because the emitted frame could
  // not convey either one's content anyway. See the report for the design
  // gap this surfaces: `briefing.ts` already renders
  // `GameState.missions`/`activeMissions` with actionable text, but the new
  // `Account`-based `initialGameState()` never populates either field — a
  // real gap, but a bigger fix than a dedupe hash, deliberately NOT
  // implemented this round.
  //
  // These exercise the FULL pipeline (`libStateToSnapshot` →
  // `snapshotFingerprint`), not `snapshotFingerprint` in isolation, because
  // the actual round-2 defect lived in what the raw cache fed into the hash —
  // a hand-built `FullStateSnapshot` can't express "the raw cache had
  // different missions data" once `FullStateSnapshot` isn't the carrier.
  it("does NOT change for a realistic missions countdown decrementing — the round-2 regression, closed", () => {
    const before = rawCacheFixture(
      { active: [{ id: "m1", title: "Deliver cargo", status: "active", expires_in_ticks: 56422 }], max_missions: 3 },
      { has_pending: false },
    )
    const after = rawCacheFixture(
      { active: [{ id: "m1", title: "Deliver cargo", status: "active", expires_in_ticks: 56410 }], max_missions: 3 },
      { has_pending: false },
    )
    expect(snapshotFingerprint(libStateToSnapshot(before))).toBe(snapshotFingerprint(libStateToSnapshot(after)))
  })

  it("also does NOT change for a genuine standalone mission change — a documented gap, not a bug (see report)", () => {
    const before = rawCacheFixture({ active: [], max_missions: 3 }, { has_pending: false })
    const after = rawCacheFixture(
      { active: [{ id: "m2", title: "New mission accepted", status: "active", expires_in_ticks: 90000 }], max_missions: 3 },
      { has_pending: false },
    )
    // Equal is CORRECT here, not incomplete: emitting would forward a
    // `snapshot` payload byte-identical to the last one (missions was never
    // in it) alongside a `sections` list nothing downstream reads — a
    // content-free duplicate frame, exactly what this fix removes.
    expect(snapshotFingerprint(libStateToSnapshot(before))).toBe(snapshotFingerprint(libStateToSnapshot(after)))
  })

  it("still differs on a genuine change to a TRANSLATED field even with realistic missions data present", () => {
    const before = rawCacheFixture(
      { active: [{ id: "m1", expires_in_ticks: 56422 }], max_missions: 3 },
      { has_pending: false },
    )
    const after = {
      ...before,
      ship: { ...before.ship, fuel: (before.ship as { fuel: number }).fuel - 1 },
    } as LibGameState
    expect(snapshotFingerprint(libStateToSnapshot(before))).not.toBe(snapshotFingerprint(libStateToSnapshot(after)))
  })
})

describe("shouldResyncOnObservation — the REST-divergence travel/jump detector", () => {
  // This predicate, and the debounce below, are the one part of this module
  // that could NOT be validated against the live production probe (issuing a
  // move/jump to trigger it is a forbidden mutating command under this task's
  // safety boundary) — so unit coverage against the cache-vs-push comparison
  // it implements is the only evidence it works. See task-4-report.md.
  it("is false when the push's poi/system agree with the cached location", () => {
    expect(shouldResyncOnObservation(
      { poi_id: "poiA", system_id: "sys" },
      { poi_id: "poiA", system_id: "sys" },
    )).toBe(false)
  })

  it("is true when the push's poi disagrees with the cached location", () => {
    expect(shouldResyncOnObservation(
      { poi_id: "poiB", system_id: "sys" },
      { poi_id: "poiA", system_id: "sys" },
    )).toBe(true)
  })

  it("is true when the push's system disagrees with the cached location", () => {
    expect(shouldResyncOnObservation(
      { poi_id: "poiA", system_id: "sys2" },
      { poi_id: "poiA", system_id: "sys" },
    )).toBe(true)
  })

  it("is false (not undefined-vs-missing noise) when the push omits a field the cache has", () => {
    // An observation_update that only carries poi_id says nothing about
    // system_id — omission is not disagreement.
    expect(shouldResyncOnObservation({ poi_id: "poiA" }, { poi_id: "poiA", system_id: "sys" })).toBe(false)
  })

  it("is false for an undefined payload or an unseeded (undefined) cache location", () => {
    expect(shouldResyncOnObservation(undefined, { poi_id: "poiA" })).toBe(false)
    expect(shouldResyncOnObservation({ poi_id: "poiA" }, undefined)).toBe(true)
    expect(shouldResyncOnObservation(undefined, undefined)).toBe(false)
  })
})

describe("makeResyncScheduler — debounce coalescing and the closing guard", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("coalesces a burst of schedule() calls into exactly one run()", () => {
    const run = vi.fn()
    const s = makeResyncScheduler(run, RESYNC_DEBOUNCE_MS)
    s.schedule()
    s.schedule()
    s.schedule()
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(RESYNC_DEBOUNCE_MS)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("allows a new run() after the debounce window has elapsed", () => {
    const run = vi.fn()
    const s = makeResyncScheduler(run, RESYNC_DEBOUNCE_MS)
    s.schedule()
    vi.advanceTimersByTime(RESYNC_DEBOUNCE_MS)
    expect(run).toHaveBeenCalledTimes(1)
    s.schedule()
    vi.advanceTimersByTime(RESYNC_DEBOUNCE_MS)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("does not fire early — run() waits the full debounce window", () => {
    const run = vi.fn()
    const s = makeResyncScheduler(run, RESYNC_DEBOUNCE_MS)
    s.schedule()
    vi.advanceTimersByTime(RESYNC_DEBOUNCE_MS - 1)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("close() cancels a pending timer so run() never fires", () => {
    // FIX for review finding "Important 1"/teardown safety: the connection's
    // finalizer calls close() before account.close(); a resync that was mid-
    // debounce at teardown must not call refresh() against a socket that's
    // being torn down.
    const run = vi.fn()
    const s = makeResyncScheduler(run, RESYNC_DEBOUNCE_MS)
    s.schedule()
    s.close()
    vi.advanceTimersByTime(RESYNC_DEBOUNCE_MS * 2)
    expect(run).not.toHaveBeenCalled()
  })

  it("schedule() is a no-op after close()", () => {
    const run = vi.fn()
    const s = makeResyncScheduler(run, RESYNC_DEBOUNCE_MS)
    s.close()
    s.schedule()
    vi.advanceTimersByTime(RESYNC_DEBOUNCE_MS * 2)
    expect(run).not.toHaveBeenCalled()
  })

  it("close() is idempotent", () => {
    const run = vi.fn()
    const s = makeResyncScheduler(run, RESYNC_DEBOUNCE_MS)
    s.schedule()
    expect(() => { s.close(); s.close() }).not.toThrow()
    vi.advanceTimersByTime(RESYNC_DEBOUNCE_MS * 2)
    expect(run).not.toHaveBeenCalled()
  })
})

describe("connectionStateFrame", () => {
  it("reports connected: true only for the connected phase", () => {
    expect((connectionStateFrame("connected").payload as { connected: boolean }).connected).toBe(true)
    expect((connectionStateFrame("reconnecting", { attempt: 3 }).payload as { connected: boolean }).connected).toBe(false)
    expect((connectionStateFrame("disconnected", { reason: "going away" }).payload as { connected: boolean }).connected).toBe(false)
  })

  it("carries the attempt number and the close reason when supplied, and omits them otherwise", () => {
    expect(connectionStateFrame("reconnecting", { attempt: 3 }).payload).toEqual({
      connected: false, phase: "reconnecting", attempt: 3,
    })
    expect(connectionStateFrame("disconnected", { reason: "going away" }).payload).toEqual({
      connected: false, phase: "disconnected", reason: "going away",
    })
    expect(connectionStateFrame("connected").payload).toEqual({ connected: true, phase: "connected" })
  })
})

describe("initialGameState", () => {
  it("folds the seeded snapshot into a complete GameState at the welcome tick", () => {
    const s = initialGameState(snap(), 1514396)
    expect(s.player.username).toBe("Pilot")
    expect(s.ship.fuel).toBe(6)
    expect(s.system?.name).toBe("First Step")
    expect(s.poi?.name).toBe("Rubble Field")
    expect(s.cargo).toEqual([{ item_id: "ore_iron", quantity: 3 }])
    expect(s.tick).toBe(1514396)
    expect(s.inCombat).toBe(false)
    expect(s.nearby).toEqual([])
  })

  it("defaults poi/system/cargo rather than leaving them undefined", () => {
    const s = initialGameState({ player: {}, ship: {} }, 0)
    expect(s.poi).toBeNull()
    expect(s.system).toBeNull()
    expect(s.cargo).toEqual([])
  })
})

describe("RESYNC_TRIGGER_TYPES", () => {
  it("includes the pushes that mean YOUR OWN numbers moved", () => {
    for (const t of ["mining_yield", "battle_damage", "skill_level_up", "crafting_update", "trade_complete"]) {
      expect(RESYNC_TRIGGER_TYPES.has(t)).toBe(true)
    }
  })

  it("EXCLUDES the ambient high-frequency pushes — they are world news, not your numbers", () => {
    // observation_update in particular arrives constantly (6 times in the live
    // 120s probe, all while docked); it triggers a resync only when its
    // poi_id/system_id disagrees with the cache, which is handled in the onAny
    // sink, not by membership here.
    for (const t of ["observation_update", "chat_message", "market_update", "battle_alert", "scan_detected"]) {
      expect(RESYNC_TRIGGER_TYPES.has(t)).toBe(false)
    }
  })
})

describe("resolveResyncIdleMs", () => {
  afterEach(() => { delete process.env.ROCI_SM_RESYNC_IDLE_MS })

  it("defaults to 120s — a reconciliation floor, not the dead 45s poll", () => {
    expect(resolveResyncIdleMs()).toBe(120_000)
  })

  it("honors an explicit 0 as 'disabled'", () => {
    process.env.ROCI_SM_RESYNC_IDLE_MS = "0"
    expect(resolveResyncIdleMs()).toBe(0)
  })

  it("honors a positive override", () => {
    process.env.ROCI_SM_RESYNC_IDLE_MS = "30000"
    expect(resolveResyncIdleMs()).toBe(30_000)
  })

  it("falls back to the default on garbage or a negative value", () => {
    process.env.ROCI_SM_RESYNC_IDLE_MS = "banana"
    expect(resolveResyncIdleMs()).toBe(120_000)
    process.env.ROCI_SM_RESYNC_IDLE_MS = "-5"
    expect(resolveResyncIdleMs()).toBe(120_000)
  })

  it("treats an empty or whitespace-only value as unset, not as zero", () => {
    // FIX for review Minor 1: Number("") === 0, so without this a
    // set-but-empty ROCI_SM_RESYNC_IDLE_MS= (routine in shells and compose
    // files) silently disabled the floor instead of falling back to the
    // default, contradicting this function's own "any other invalid /
    // non-positive value falls back to the default" contract.
    process.env.ROCI_SM_RESYNC_IDLE_MS = ""
    expect(resolveResyncIdleMs()).toBe(120_000)
    process.env.ROCI_SM_RESYNC_IDLE_MS = "   "
    expect(resolveResyncIdleMs()).toBe(120_000)
  })

  it("does not treat '-0' as the disabling '0'", () => {
    // FIX for review Minor 1: Number("-0") === 0 is true in JS, so a naive
    // numeric check would silently disable the floor for a value that isn't
    // the literal "0" the docs promise disables it. Only the trimmed string
    // "0" disables; "-0" is non-positive and falls back to the default.
    process.env.ROCI_SM_RESYNC_IDLE_MS = "-0"
    expect(resolveResyncIdleMs()).toBe(120_000)
  })

  it("still honors the literal '0' (optionally padded with whitespace) as disabled", () => {
    process.env.ROCI_SM_RESYNC_IDLE_MS = " 0 "
    expect(resolveResyncIdleMs()).toBe(0)
  })
})
