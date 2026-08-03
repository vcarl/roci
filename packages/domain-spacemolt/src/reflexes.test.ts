import { describe, it, expect } from "vitest"
import {
  COMBAT_REARM_QUIET_TICKS,
  createCombatOnsetAppraiser,
  isSelfParticipant,
  nextCombatState,
  playerDeathRule,
  spaceMoltInterruptRegistry,
} from "./reflexes.js"
import { SituationType } from "./types.js"
import type { CombatState, GameState, Situation } from "./types.js"

const ME = "me-player-id"

const makeState = (over: Partial<GameState> = {}): GameState =>
  ({
    player: { id: ME, username: "Pilot", docked_at_base: null },
    ship: { hull: 100, max_hull: 100, fuel: 50, max_fuel: 50, cargo_used: 0, cargo_capacity: 10, cargo: [] },
    poi: null, system: null, cargo: [], nearby: [],
    inCombat: false, connected: true,
    combat: { lastEventTick: null, onsetSeq: 0 },
    deathPending: false,
    tick: 100, timestamp: 0,
    ...over,
  }) as unknown as GameState

// Cast, deliberately: `SituationFlags` collapsed to one member (`atMineablePoi`)
// in Task 11. Neither reflex reads a flag, so pinning the exact flag set here
// would only make this file churn for a change it does not care about.
const situation = { type: SituationType.InSpace, flags: {} } as unknown as Situation

describe("isSelfParticipant", () => {
  it("battle_joined: only when the joiner is you", () => {
    expect(isSelfParticipant("battle_joined", { player_id: ME, side_id: 1, username: "Pilot" }, ME)).toBe(true)
    expect(isSelfParticipant("battle_joined", { player_id: "someone-else", side_id: 1, username: "X" }, ME)).toBe(false)
  })

  it("battle_damage: either end of the exchange counts", () => {
    expect(isSelfParticipant("battle_damage", { attacker_id: "foe", target_id: ME }, ME)).toBe(true)
    expect(isSelfParticipant("battle_damage", { attacker_id: ME, target_id: "foe" }, ME)).toBe(true)
    expect(isSelfParticipant("battle_damage", { attacker_id: "a", target_id: "b" }, ME)).toBe(false)
  })

  it("battle_update: your_side_id exists only on YOUR copy of the frame", () => {
    expect(isSelfParticipant("battle_update", { battle_id: "b", your_side_id: 0 }, ME)).toBe(true)
    expect(isSelfParticipant("battle_update", { battle_id: "b" }, ME)).toBe(false)
  })

  it("battle_alert: a nearby fight you are NOT in does not count", () => {
    // battle_alert fired unprompted during the 2026-08-02 production probe on a
    // character doing nothing. Treating arrival as participation would put the
    // character into other people's fights.
    const others = { battle_id: "b", participants: [{ player_id: "a" }, { player_id: "b" }] }
    expect(isSelfParticipant("battle_alert", others, ME)).toBe(false)
    expect(isSelfParticipant("battle_alert", { battle_id: "b", participants: [{ player_id: ME }] }, ME)).toBe(true)
  })

  it("never throws on a malformed or empty payload, and is false without a player id", () => {
    expect(isSelfParticipant("battle_damage", undefined, ME)).toBe(false)
    expect(isSelfParticipant("battle_started", { participants: "nope" }, ME)).toBe(false)
    expect(isSelfParticipant("battle_started", { participants: [null] }, ME)).toBe(false)
    expect(isSelfParticipant("battle_joined", { player_id: ME }, "")).toBe(false)
    expect(isSelfParticipant("chat_message", { player_id: ME }, ME)).toBe(false)
  })
})

describe("nextCombatState", () => {
  const fresh: CombatState = { lastEventTick: null, onsetSeq: 0 }

  it("the first combat frame is an onset", () => {
    expect(nextCombatState(fresh, 100, false)).toEqual({ lastEventTick: 100, onsetSeq: 1 })
  })

  it("frames within the same fight do NOT bump the onset counter", () => {
    let c = nextCombatState(fresh, 100, false)
    for (const t of [101, 102, 105, 110]) c = nextCombatState(c, t, true)
    expect(c.onsetSeq).toBe(1)
    expect(c.lastEventTick).toBe(110)
  })

  it("a frame after the quiet backstop is a FRESH onset", () => {
    // The backstop is why a dropped battle_ended cannot latch the reflex off
    // forever — which would silently disable one of only two reflexes. It only
    // applies mid-"fight" (prevInCombat true and both frames ticked).
    const c = nextCombatState(fresh, 100, false)
    const later = nextCombatState(c, 100 + COMBAT_REARM_QUIET_TICKS, true)
    expect(later.onsetSeq).toBe(2)
  })

  it("one tick short of the backstop is still the same fight", () => {
    const c = nextCombatState(fresh, 100, false)
    expect(nextCombatState(c, 100 + COMBAT_REARM_QUIET_TICKS - 1, true).onsetSeq).toBe(1)
  })

  it("a backwards tick (server restart) counts as a fresh onset rather than latching", () => {
    const c = nextCombatState(fresh, 1_000_000, false)
    expect(nextCombatState(c, 5, true).onsetSeq).toBe(2)
  })

  it("a tickless frame while ALREADY in combat neither fabricates nor loses an onset", () => {
    const c = nextCombatState(fresh, 100, false)
    expect(nextCombatState(c, undefined, true)).toEqual({ lastEventTick: 100, onsetSeq: 1 })
    expect(nextCombatState(c, Number.NaN, true)).toEqual({ lastEventTick: 100, onsetSeq: 1 })
  })

  it("a tickless onset (not previously in combat, no tick at all) still fires exactly once", () => {
    // battle_started / battle_joined / battle_alert never carry a tick in the
    // generated payload shapes — the fresh-onset test must not depend on one.
    expect(nextCombatState(fresh, undefined, false)).toEqual({ lastEventTick: null, onsetSeq: 1 })
  })

  it("REGRESSION: a run of tickless frames mid-fight does NOT re-fire the onset counter", () => {
    // The bug this guards against: freshness inferred from `lastEventTick ===
    // null` instead of from `!prevInCombat` meant every tickless frame of an
    // ongoing fight re-read as a fresh onset (measured: battle_started →
    // battle_joined → 30×battle_damage fired 3 times instead of 1). Simulate
    // the tickless part of that sequence directly against nextCombatState.
    let c = nextCombatState(fresh, undefined, false) // battle_started: the one true onset
    expect(c.onsetSeq).toBe(1)
    for (let i = 0; i < 10; i++) {
      c = nextCombatState(c, undefined, true) // battle_joined / battle_alert-shaped, same fight
      expect(c.onsetSeq).toBe(1)
    }
  })

  it("the quiet backstop cannot apply across a tickless gap — it never guesses without two real ticks", () => {
    const c = nextCombatState(fresh, 100, false) // onset 1, lastEventTick 100
    const still = nextCombatState(c, undefined, true) // no tick on this frame — can't compute a gap
    expect(still).toEqual({ lastEventTick: 100, onsetSeq: 1 })
  })
})

describe("combat-onset appraiser — EDGE-TRIGGERED", () => {
  it("is silent when no fight has ever started", () => {
    expect(createCombatOnsetAppraiser()(makeState(), situation)).toBeNull()
  })

  it("fires once on onset, at the interrupt rung", () => {
    const a = createCombatOnsetAppraiser()
    const r = a(makeState({ inCombat: true, combat: { lastEventTick: 100, onsetSeq: 1 } }), situation)
    expect(r).not.toBeNull()
    expect(r!.interrupt).toBe(true)
    expect(r!.disposition).toBe("escalate")
    expect(r!.drive).toBe("safety")
    expect(r!.weight).toBe(5)
  })

  it("DOES NOT RE-FIRE for the duration of the fight — the property hull_critical lacked", () => {
    // This is the single most important assertion in this file. `hull_critical`
    // was level-triggered with no cooldown, so it fired every tick of a long
    // emergency and each firing destroyed the plan that would have ended it.
    // No test would have caught that. This one would.
    const a = createCombatOnsetAppraiser()
    const s = makeState({ inCombat: true, combat: { lastEventTick: 100, onsetSeq: 1 } })
    expect(a(s, situation)).not.toBeNull()
    for (let tick = 101; tick < 140; tick++) {
      expect(a(makeState({ inCombat: true, tick, combat: { lastEventTick: tick, onsetSeq: 1 } }), situation)).toBeNull()
    }
  })

  it("fires again for a NEW fight — the latch re-arms, it does not silence the reflex", () => {
    const a = createCombatOnsetAppraiser()
    expect(a(makeState({ combat: { lastEventTick: 100, onsetSeq: 1 } }), situation)).not.toBeNull()
    expect(a(makeState({ combat: { lastEventTick: 200, onsetSeq: 2 } }), situation)).not.toBeNull()
  })

  it("latches PER PLAYER — the processor is a module singleton shared by every character", () => {
    const a = createCombatOnsetAppraiser()
    const ada = makeState({ player: { id: "ada" } as never, combat: { lastEventTick: 100, onsetSeq: 1 } })
    const bob = makeState({ player: { id: "bob" } as never, combat: { lastEventTick: 100, onsetSeq: 1 } })
    expect(a(ada, situation)).not.toBeNull()
    expect(a(bob, situation)).not.toBeNull() // ada's fight must not silence bob's
    expect(a(ada, situation)).toBeNull()
  })

  it("does not throw on a state with no combat block at all", () => {
    const a = createCombatOnsetAppraiser()
    expect(a({} as never, situation)).toBeNull()
  })

  it("REGRESSION: re-fires after a reconnect resets onsetSeq back to a low value", () => {
    // The latch compares by EQUALITY, not a high-water mark. `initialGameState`
    // re-seeds a fresh GameState with onsetSeq: 0 on every reconnect within the
    // same process — the appraiser instance is a process-lifetime singleton and
    // does not know that happened. A high-water-mark latch would compare the
    // new, low-numbered post-reset sequence against the OLD run's stale maximum
    // and stay silent forever (measured: 0 firings across a post-reset
    // session). Equality only suppresses a literal repeat of the same number.
    const a = createCombatOnsetAppraiser()
    expect(a(makeState({ combat: { lastEventTick: 100, onsetSeq: 1 } }), situation)).not.toBeNull()
    expect(a(makeState({ combat: { lastEventTick: 200, onsetSeq: 2 } }), situation)).not.toBeNull()
    // Reconnect: onsetSeq resets to 0 (silent, seq===0 short-circuits), then
    // the next fight bumps it back to 1 — a value already "seen" before the
    // reset. Equality must still fire here.
    expect(a(makeState({ combat: { lastEventTick: 10, onsetSeq: 1 } }), situation)).not.toBeNull()
  })

  it("REGRESSION: fires on a post-reconnect fight whose onsetSeq COINCIDES with the pre-reset latch", () => {
    // Fix round 1 introduced a narrower version of the same silencing bug: the
    // latch was only WRITTEN when the appraiser fired. So if the appraiser is
    // called with a quiescent onsetSeq: 0 tick after a reconnect (which
    // short-circuits without firing), that call left the stale latch from the
    // previous run untouched. If the very next fight's onsetSeq happened to
    // equal that stale value, the equality check wrongly suppressed it — with
    // only a handful of fights per run, a coincidence, not an edge case.
    // Measured against the pre-fix code: previous run ends with lastReported
    // = 1; post-reconnect fight 1 (onsetSeq: 1) → silently suppressed.
    const a = createCombatOnsetAppraiser()
    // Previous run: one fight, onsetSeq reaches 1. Latch records 1 on fire.
    expect(a(makeState({ combat: { lastEventTick: 100, onsetSeq: 1 } }), situation)).not.toBeNull()
    // Reconnect: a quiescent tick at onsetSeq: 0 (no fight yet). The fix
    // requires this call to ALSO update the latch (to 0), not just skip firing.
    expect(a(makeState({ combat: { lastEventTick: null, onsetSeq: 0 } }), situation)).toBeNull()
    // Post-reconnect fight 1 coincidentally reaches onsetSeq: 1 again — the
    // exact value the stale (pre-fix) latch still held. Must fire.
    expect(a(makeState({ combat: { lastEventTick: 5, onsetSeq: 1 } }), situation)).not.toBeNull()
  })
})

describe("the interrupt registry — exactly one rule", () => {
  it("holds only player_died, at critical", () => {
    expect(spaceMoltInterruptRegistry.rules.map((r) => r.name)).toEqual(["player_died"])
    expect(playerDeathRule.priority).toBe("critical")
  })

  it("fires only while deathPending is set", () => {
    expect(spaceMoltInterruptRegistry.criticals(makeState(), situation)).toEqual([])
    const alerts = spaceMoltInterruptRegistry.criticals(makeState({ deathPending: true }), situation)
    expect(alerts.map((a) => a.ruleName)).toEqual(["player_died"])
  })

  it("is a PURE level condition — evaluating it twice does not consume it", () => {
    // InterruptRegistry evaluates every condition twice per tick: explain() for
    // the audit trail, then criticals() for the firing path. A self-consuming
    // latch in the condition would be eaten by the audit call — the same class
    // of bug that made suppressWhenTaskIs inert.
    const s = makeState({ deathPending: true })
    expect(spaceMoltInterruptRegistry.explain(s, situation).map((e) => e.ruleName)).toEqual(["player_died"])
    expect(spaceMoltInterruptRegistry.criticals(s, situation)).toHaveLength(1)
    expect(spaceMoltInterruptRegistry.criticals(s, situation)).toHaveLength(1)
  })

  it("none of the ten deleted rules can fire — not hull, fuel, cargo, trades or chat", () => {
    const dying = makeState({
      ship: { hull: 1, max_hull: 100, fuel: 1, max_fuel: 100, cargo_used: 10, cargo_capacity: 10, cargo: [] } as never,
      inCombat: true,
    })
    const combatSituation = { type: SituationType.InCombat, flags: {} } as unknown as Situation
    expect(spaceMoltInterruptRegistry.evaluate(dying, combatSituation)).toEqual([])
  })
})
