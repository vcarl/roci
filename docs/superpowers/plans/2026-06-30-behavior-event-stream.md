# Structured Behavior Event Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bot behaviors — both the operational/machinery layer and the cognitive/action layer — first-class structured `kind:"behavior"` events that are the source of truth, with the console as a rendered view and the QA digest reading structure directly instead of recovering it by regex.

**Architecture:** A new `Behavior` discriminated union rides on `UnifiedEvent` as one `kind:"behavior"` variant. A module-level per-character digest accumulator folds every behavior on emit; the terminal `session_end` event snapshots that accumulator inline so it is the authoritative run digest. The QA monitor reads `session_end`'s digest directly and keeps its legacy regex fold only as a crash fallback. Work is split into two waves: Wave 1 wires machinery seams (no cortex hot-loop changes); Wave 2 performs a mechanical emit-call swap of the cognitive sites in `cortex/loop.ts`/`tiers.ts` and adds per-tier latency.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Effect 3.x, vitest 3.x, pnpm + nx monorepo. Four nx projects: `@roci/core` (`packages/core`), `roci` app (`apps/roci`), `@roci/domain-spacemolt`, `@roci/domain-github`.

## Global Constraints

- **Wave 1 touches NO cortex hot loop.** Do not edit `packages/core/src/cortex/loop.ts` or `packages/core/src/cortex/tiers.ts` in any Wave 1 task.
- **Wave 2 is the ONLY change to `cortex/loop.ts`, and is emit-calls only — NO control-flow change.** Swap `logToConsole(...)` string emits for `logBehavior(...)` structured emits at the existing call sites; do not move, add, or remove any branch, loop, `yield*` ordering, or early return.
- **Behavior emits are best-effort and must never throw** into the loop or orchestrator. Every emit helper ends in `.pipe(Effect.catchAll(() => Effect.void))`, mirroring the existing emit resilience in `log-writer.ts` and `tiers.ts`.
- **The digest accumulator must never crash a run.** It is plain synchronous code with no I/O; snapshot defensively (copy fields, never throw).
- **`session_end` is idempotent** via a module-level guard flag (`tryMarkEnded(character)`), so the `Effect.onExit` path and a signal handler cannot double-emit.
- **No-drop rule:** if a behavior cannot be mapped to a known `TransitionType`, `classifyEvent` maps it to the new `NOTE` transition — it is never silently dropped.
- **Build is green across all 4 nx projects** (`pnpm build`) and **all tests pass** (`pnpm vitest run`) at the end of every task.
- Conventional-commit messages. End every commit message body with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

**Test command (single file):** `pnpm vitest run <relative-path-to-test-file>`
Run from the repo root `/Users/vcarl/workspace/roci`. The root `vitest.config.ts` declares a workspace (`projects: ["apps/*/vitest.config.ts", "packages/*/vitest.config.ts"]`); there are no nx `test` targets (no `project.json`, no nx vite inference plugin), so vitest is invoked directly. Confirmed working: `pnpm vitest run packages/core/src/logging/log-writer.test.ts`.

---

## File Structure

**New files:**
- `packages/core/src/logging/behavior.ts` — the `Behavior` discriminated union and the `BehaviorDigest` interface (the inline-digest payload type). One responsibility: the behavior data model.
- `packages/core/src/logging/behavior-digest.ts` — the per-character digest accumulator (fold/snapshot), the `session_end` idempotency guard, and the shutdown-signal capture cell. One responsibility: digest + terminal-state bookkeeping.
- `packages/core/src/logging/behavior.test.ts` — unit tests for the model + level classification.
- `packages/core/src/logging/behavior-digest.test.ts` — unit tests for the accumulator fold/snapshot.
- `packages/core/src/logging/console-renderer.test.ts` — unit tests for the behavior render case.
- `packages/core/src/core/phase-runner.test.ts` — integration test: runPhases emits phase enter/exit behaviors.
- `apps/roci/src/session-end.ts` — pure `sessionEndReasonForExit(exit)` helper + the `withSessionEnd` onExit wrapper used by the orchestrator. One responsibility: map an Effect `Exit` to a `session_end` reason.
- `apps/roci/src/session-end.test.ts` — unit tests for `sessionEndReasonForExit`.

**Modified files:**
- `packages/core/src/logging/events.ts` — add the `kind:"behavior"` variant to `UnifiedEvent`.
- `packages/core/src/logging/levels.ts` — add the `kind:"behavior"` case to `classifyLevel`.
- `packages/core/src/logging/console-renderer.ts` — add the `kind:"behavior"` case to `renderEvent`.
- `packages/core/src/logging/log-writer.ts` — add `logBehavior` and `logSessionEnd` emit helpers.
- `packages/core/src/index.ts` — re-export `Behavior` and `BehaviorDigest` types.
- `packages/core/src/core/phase-runner.ts` — emit `phase` enter/exit behaviors.
- `packages/core/src/core/orchestrator/planned-action.ts` — emit `reflection` consolidate/dream/promote behaviors (promote carries N including 0).
- `apps/roci/src/orchestrator.ts` — emit `session_start`, `provision`, and `session_end` (via `withSessionEnd`); compute gitSha.
- `apps/roci/src/embed-server.ts` — emit `provision{component:"embed_server"}`.
- `apps/roci/src/main.ts` — record the shutdown signal name in the signal handlers.
- `apps/roci/src/qa/types.ts` — add `NOTE` to `TransitionType`.
- `apps/roci/src/qa/markers.ts` — add the `kind:"behavior"` branch to `classifyEvent`.
- `apps/roci/src/qa/feed.ts` — skip the auto-injected `SESSION_START` when the first event is a behavior `session_start` (Wave 1); switch tick counting to `appraisal` behaviors (Wave 2).
- `apps/roci/src/qa/ingest.ts` — surface a parsed `session_end` digest from `ingestChunk`.
- `apps/roci/src/qa/digest.ts` — add the `finalizeDigest` selector (session_end digest authoritative, fold fallback).
- `apps/roci/src/qa/monitor.ts` — write `run-digest.json` from the `session_end` digest, fold as crash fallback.
- Wave 2 cortex: `packages/core/src/cortex/tiers.ts`, `packages/core/src/cortex/loop.ts`.
- Wave 2 QA fixtures: `apps/roci/src/qa/feed.test.ts`, `apps/roci/src/qa/ingest.test.ts`, `apps/roci/src/qa/markers.test.ts`.

---

# WAVE 1 — Machinery (no cortex hot loop)

## Task 1: Behavior event model + level classification

**Files:**
- Create: `packages/core/src/logging/behavior.ts`
- Modify: `packages/core/src/logging/events.ts:14-24`
- Modify: `packages/core/src/logging/levels.ts:12-27`
- Modify: `packages/core/src/index.ts:2`
- Test: `packages/core/src/logging/behavior.test.ts`

**Interfaces:**
- Produces: `Behavior` (discriminated union on `type`), `BehaviorDigest` interface, the `UnifiedEvent` variant `{ kind:"behavior"; behavior: Behavior }`. Consumed by every later task.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/logging/behavior.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import type { Behavior } from "./behavior.js"
import type { UnifiedEvent } from "./events.js"
import { effectiveLevel } from "./levels.js"

const behaviorEvent = (behavior: Behavior): UnifiedEvent => ({
  timestamp: "2026-06-30T00:00:00.000Z",
  character: "ada",
  system: "orchestrator",
  subsystem: "main",
  kind: "behavior",
  behavior,
})

describe("behavior event level classification", () => {
  it("classifies a machinery behavior at info", () => {
    const ev = behaviorEvent({ type: "phase", phase: "active", transition: "enter" })
    expect(effectiveLevel(ev)).toBe("info")
  })

  it("classifies a failed provision at warn", () => {
    const ev = behaviorEvent({ type: "provision", component: "memory_cli", status: "failed", detail: "exit 127" })
    expect(effectiveLevel(ev)).toBe("warn")
  })

  it("classifies an error-reason session_end at warn", () => {
    const ev = behaviorEvent({
      type: "session_end",
      reason: "error",
      digest: { counts: {}, sequence: [], timings: { firstForebrainMs: null, firstPlanMs: null }, startTs: null, terminalCause: null },
    })
    expect(effectiveLevel(ev)).toBe("warn")
  })

  it("honors a note's explicit severity", () => {
    const ev = behaviorEvent({ type: "note", label: "weird", severity: "error" })
    expect(effectiveLevel(ev)).toBe("error")
  })

  it("defaults a note with no severity to info", () => {
    const ev = behaviorEvent({ type: "note", label: "fyi" })
    expect(effectiveLevel(ev)).toBe("info")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/logging/behavior.test.ts`
Expected: FAIL — `Cannot find module './behavior.js'` (the module does not exist yet).

- [ ] **Step 3: Create the behavior model**

Create `packages/core/src/logging/behavior.ts`:

```ts
import type { LogLevel } from "./events.js"

/**
 * The inline run digest carried by a terminal `session_end` behavior. Mirrors
 * the analytic fields of the QA `RunDigest` (minus `env`, which the monitor adds
 * from CLI args), so the monitor can adopt it directly as the authoritative
 * digest. `sequence` holds behavior-type strings.
 */
export interface BehaviorDigest {
  counts: Record<string, number>
  sequence: string[]
  timings: { firstForebrainMs: number | null; firstPlanMs: number | null }
  startTs: string | null
  terminalCause: string | null
}

/**
 * A structured behavior — the source of truth for "what the bot did". Machinery
 * types ship in Wave 1; cognition types are emitted in Wave 2; `note` is the
 * no-drop escape hatch for anything that resists taxonomy.
 */
export type Behavior =
  // ── Machinery (Wave 1) ──────────────────────────────────────
  | { type: "session_start"; domain: string; character: string; gitSha: string; tickIntervalMs: number }
  | { type: "session_end"; reason: "clean" | "signal" | "error"; signal?: string; digest: BehaviorDigest }
  | {
      type: "provision"
      component: "container" | "embed_server" | "memory_cli" | "conscious_provider"
      status: "ready" | "failed"
      detail?: string
    }
  | { type: "phase"; phase: string; transition: "enter" | "exit" }
  | { type: "reflection"; stage: "consolidate" | "dream" | "promote"; status: "start" | "done"; counts?: Record<string, number> }
  // ── Cognition (Wave 2) ──────────────────────────────────────
  | { type: "tier_call"; tier: "hindbrain" | "forebrain" | "conscious"; latencyMs: number; outcome: "ok" | "error" | "timeout"; attempt?: number }
  | { type: "appraisal"; disposition: string; weight?: number; escalated: boolean }
  | { type: "orient"; headline: string }
  | { type: "decision"; disposition: "plan" | "wait" | "terminate" }
  | { type: "step"; phase: "start" | "done" | "salvage"; turn?: number; task?: string }
  | { type: "action"; domain: string; name: string; input?: unknown; result?: unknown }
  // ── Escape hatch ────────────────────────────────────────────
  | { type: "note"; label: string; data?: unknown; severity?: Exclude<LogLevel, "debug"> }
```

- [ ] **Step 4: Wire the variant into `UnifiedEvent`**

In `packages/core/src/logging/events.ts`, add the import after line 1 and the variant inside the union (after the `exchange` line, line 23):

```ts
import type { InternalEvent } from "./stream-normalizer.js"
import type { Behavior } from "./behavior.js"
```

```ts
export type UnifiedEvent = EventBase & (
  | { kind: "system"; message: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; tool: string; id: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; text: string }
  | { kind: "subagent_start"; description: string; data: unknown }
  | { kind: "subagent_stop"; data: unknown }
  | { kind: "error"; message: string }
  | { kind: "exchange"; channel: string; step: string; prompt: string; response: string; meta?: Record<string, unknown> }
  | { kind: "behavior"; behavior: Behavior }
)
```

- [ ] **Step 5: Add the `behavior` case to `classifyLevel`**

In `packages/core/src/logging/levels.ts`, replace the `classifyLevel` switch (lines 12-27) with:

```ts
/** Default level for an event when no explicit level was set. */
export function classifyLevel(event: UnifiedEvent): LogLevel {
  switch (event.kind) {
    case "error":
      return "error"
    case "thinking":
    case "exchange":
      return "debug"
    case "behavior": {
      const b = event.behavior
      if (b.type === "note") return b.severity ?? "info"
      if (b.type === "provision" && b.status === "failed") return "warn"
      if (b.type === "session_end" && b.reason === "error") return "warn"
      return "info"
    }
    case "system":
    case "text":
    case "tool_use":
    case "tool_result":
    case "subagent_start":
    case "subagent_stop":
      return "info"
  }
}
```

- [ ] **Step 6: Re-export the types from the package index**

In `packages/core/src/index.ts`, replace line 2 (`export type { UnifiedEvent } from "./logging/events.js"`) with:

```ts
export type { UnifiedEvent } from "./logging/events.js"
export type { Behavior, BehaviorDigest } from "./logging/behavior.js"
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/logging/behavior.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Verify the package still typechecks**

Run: `pnpm exec tsc -p packages/core --noEmit`
Expected: no output (clean exit). The exhaustive `renderEvent` switch in `console-renderer.ts` will NOT be flagged yet because TypeScript only errors on a missing case when the switch has no default and is consumed in a context requiring exhaustiveness — `renderEvent` returns `string[]` with no default, so this MAY surface a "not all code paths return" error. If it does, it is fixed in Task 4; for now confirm only `behavior.ts`/`events.ts`/`levels.ts`/`index.ts` are clean by re-running after Task 4. If `tsc` errors solely on `console-renderer.ts`, proceed.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/logging/behavior.ts packages/core/src/logging/behavior.test.ts packages/core/src/logging/events.ts packages/core/src/logging/levels.ts packages/core/src/index.ts
git commit -m "feat(logging): add Behavior event model and level classification

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Behavior digest accumulator

**Files:**
- Create: `packages/core/src/logging/behavior-digest.ts`
- Test: `packages/core/src/logging/behavior-digest.test.ts`

**Interfaces:**
- Consumes: `Behavior`, `BehaviorDigest` from `./behavior.js`.
- Produces:
  - `emptyBehaviorDigest(): BehaviorDigest`
  - `recordBehavior(character: string, behavior: Behavior, ts: string): void`
  - `snapshotDigest(character: string): BehaviorDigest`
  - `resetBehaviorDigest(character: string): void`
  - `tryMarkEnded(character: string): boolean`
  - `recordShutdownSignal(signal: string): void`
  - `consumeShutdownSignal(): string | undefined`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/logging/behavior-digest.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest"
import {
  emptyBehaviorDigest,
  recordBehavior,
  snapshotDigest,
  resetBehaviorDigest,
  tryMarkEnded,
  recordShutdownSignal,
  consumeShutdownSignal,
} from "./behavior-digest.js"

beforeEach(() => {
  resetBehaviorDigest("ada")
})

describe("behavior digest accumulator", () => {
  it("counts by behavior type and records the type sequence", () => {
    recordBehavior("ada", { type: "session_start", domain: "spacemolt", character: "ada", gitSha: "abc", tickIntervalMs: 30000 }, "2026-06-30T00:00:00.000Z")
    recordBehavior("ada", { type: "phase", phase: "active", transition: "enter" }, "2026-06-30T00:00:01.000Z")
    recordBehavior("ada", { type: "phase", phase: "active", transition: "exit" }, "2026-06-30T00:00:02.000Z")
    const d = snapshotDigest("ada")
    expect(d.counts).toEqual({ session_start: 1, phase: 2 })
    expect(d.sequence).toEqual(["session_start", "phase", "phase"])
  })

  it("captures first-forebrain timing from a forebrain tier_call relative to session_start", () => {
    recordBehavior("ada", { type: "session_start", domain: "d", character: "ada", gitSha: "x", tickIntervalMs: 30000 }, "2026-06-30T00:00:00.000Z")
    recordBehavior("ada", { type: "tier_call", tier: "forebrain", latencyMs: 1800, outcome: "ok" }, "2026-06-30T00:00:02.000Z")
    expect(snapshotDigest("ada").timings.firstForebrainMs).toBe(2000)
  })

  it("captures first-plan timing from a plan decision", () => {
    recordBehavior("ada", { type: "session_start", domain: "d", character: "ada", gitSha: "x", tickIntervalMs: 30000 }, "2026-06-30T00:00:00.000Z")
    recordBehavior("ada", { type: "decision", disposition: "plan" }, "2026-06-30T00:00:05.000Z")
    expect(snapshotDigest("ada").timings.firstPlanMs).toBe(5000)
  })

  it("sets terminalCause from a session_end reason and signal", () => {
    recordBehavior("ada", { type: "session_start", domain: "d", character: "ada", gitSha: "x", tickIntervalMs: 30000 }, "2026-06-30T00:00:00.000Z")
    recordBehavior("ada", { type: "session_end", reason: "signal", signal: "SIGTERM", digest: emptyBehaviorDigest() }, "2026-06-30T00:00:09.000Z")
    expect(snapshotDigest("ada").terminalCause).toBe("session ended (signal: SIGTERM)")
  })

  it("isolates accumulators per character", () => {
    recordBehavior("ada", { type: "phase", phase: "active", transition: "enter" }, "2026-06-30T00:00:00.000Z")
    expect(snapshotDigest("bob").counts).toEqual({})
    resetBehaviorDigest("bob")
  })

  it("tryMarkEnded returns true once then false (idempotency guard)", () => {
    expect(tryMarkEnded("ada")).toBe(true)
    expect(tryMarkEnded("ada")).toBe(false)
  })

  it("captures and consumes the shutdown signal once", () => {
    recordShutdownSignal("SIGINT")
    expect(consumeShutdownSignal()).toBe("SIGINT")
    expect(consumeShutdownSignal()).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/logging/behavior-digest.test.ts`
Expected: FAIL — `Cannot find module './behavior-digest.js'`.

- [ ] **Step 3: Implement the accumulator**

Create `packages/core/src/logging/behavior-digest.ts`:

```ts
import type { Behavior, BehaviorDigest } from "./behavior.js"

interface DigestState extends BehaviorDigest {
  _terminalRank: number
}

// Only `session_end` is a terminal behavior; ranked so a stray double would not
// downgrade the cause. (Crash terminal causes — PROCESS_DIED — are the QA
// monitor's fold-fallback concern, not the accumulator's.)
const TERMINAL_RANK: Partial<Record<Behavior["type"], number>> = {
  session_end: 1,
}

const accumulators = new Map<string, DigestState>()
const ended = new Set<string>()
let shutdownSignal: string | undefined

export function emptyBehaviorDigest(): BehaviorDigest {
  return {
    counts: {},
    sequence: [],
    timings: { firstForebrainMs: null, firstPlanMs: null },
    startTs: null,
    terminalCause: null,
  }
}

function stateFor(character: string): DigestState {
  let s = accumulators.get(character)
  if (!s) {
    s = { ...emptyBehaviorDigest(), _terminalRank: 0 }
    accumulators.set(character, s)
  }
  return s
}

/** Fold one behavior into the character's running digest. Never throws. */
export function recordBehavior(character: string, behavior: Behavior, ts: string): void {
  const s = stateFor(character)
  s.counts[behavior.type] = (s.counts[behavior.type] ?? 0) + 1
  s.sequence.push(behavior.type)

  if (s.startTs === null && behavior.type === "session_start") s.startTs = ts
  const sinceStart = s.startTs ? Date.parse(ts) - Date.parse(s.startTs) : null

  if (s.timings.firstForebrainMs === null && behavior.type === "tier_call" && behavior.tier === "forebrain") {
    s.timings.firstForebrainMs = sinceStart
  }
  if (s.timings.firstPlanMs === null && behavior.type === "decision" && behavior.disposition === "plan") {
    s.timings.firstPlanMs = sinceStart
  }

  const incomingRank = TERMINAL_RANK[behavior.type] ?? 0
  if (incomingRank > s._terminalRank) {
    s._terminalRank = incomingRank
    if (behavior.type === "session_end") {
      s.terminalCause = behavior.signal
        ? `session ended (${behavior.reason}: ${behavior.signal})`
        : `session ended (${behavior.reason})`
    }
  }
}

/** Defensive copy of the character's current digest. Never throws. */
export function snapshotDigest(character: string): BehaviorDigest {
  const s = stateFor(character)
  return {
    counts: { ...s.counts },
    sequence: [...s.sequence],
    timings: { ...s.timings },
    startTs: s.startTs,
    terminalCause: s.terminalCause,
  }
}

/** Test/lifecycle reset for a character's accumulator + end-guard. */
export function resetBehaviorDigest(character: string): void {
  accumulators.delete(character)
  ended.delete(character)
}

/** Returns true exactly once per character — the session_end idempotency guard. */
export function tryMarkEnded(character: string): boolean {
  if (ended.has(character)) return false
  ended.add(character)
  return true
}

/** Capture the OS signal name from a (synchronous) signal handler. */
export function recordShutdownSignal(signal: string): void {
  shutdownSignal = signal
}

/** Read-and-clear the captured shutdown signal name. */
export function consumeShutdownSignal(): string | undefined {
  const s = shutdownSignal
  shutdownSignal = undefined
  return s
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/logging/behavior-digest.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/logging/behavior-digest.ts packages/core/src/logging/behavior-digest.test.ts
git commit -m "feat(logging): add per-character behavior digest accumulator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Emit helpers — logBehavior + logSessionEnd

**Files:**
- Modify: `packages/core/src/logging/log-writer.ts` (add after `logExchange`, line 127)
- Test: `packages/core/src/logging/log-writer.test.ts` (add cases)

**Interfaces:**
- Consumes: `CharacterLog.emit`, `eventBase` (existing); `recordBehavior`, `snapshotDigest`, `tryMarkEnded`, `emptyBehaviorDigest` from `./behavior-digest.js`; `Behavior` from `./behavior.js`.
- Produces:
  - `logBehavior(character: string, system: string, subsystem: string, behavior: Behavior): Effect.Effect<void, never, CharacterLog>` — folds the behavior into the accumulator, fills `session_end`'s inline digest snapshot, emits; best-effort (never fails).
  - `logSessionEnd(character: string, reason: "clean" | "signal" | "error", signal?: string): Effect.Effect<void, never, CharacterLog>` — idempotent terminal emit.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/logging/log-writer.test.ts` (inside the existing `describe("CharacterLog emit", ...)` block, before its closing `})`). Also add the imports at the top of the file:

```ts
import { CharacterLog, CharacterLogLive, logToConsole, logExchange, logError, logBehavior, logSessionEnd } from "./log-writer.js"
import { resetBehaviorDigest } from "./behavior-digest.js"
```

```ts
  it("logBehavior writes a kind:behavior line carrying the structured behavior", async () => {
    resetBehaviorDigest("c")
    const contents = await readJsonl(
      logBehavior("c", "orchestrator", "main", { type: "phase", phase: "active", transition: "enter" }),
    )
    const line = JSON.parse(contents.trim().split("\n").pop() as string)
    expect(line.kind).toBe("behavior")
    expect(line.behavior.type).toBe("phase")
    expect(line.behavior.phase).toBe("active")
    expect(line.level).toBe("info")
  })

  it("logSessionEnd embeds a live digest snapshot inline", async () => {
    resetBehaviorDigest("c")
    const contents = await readJsonl(
      Effect.gen(function* () {
        yield* logBehavior("c", "orchestrator", "main", {
          type: "session_start",
          domain: "spacemolt",
          character: "c",
          gitSha: "abc1234",
          tickIntervalMs: 30000,
        })
        yield* logSessionEnd("c", "clean")
      }),
    )
    const last = JSON.parse(contents.trim().split("\n").pop() as string)
    expect(last.behavior.type).toBe("session_end")
    expect(last.behavior.reason).toBe("clean")
    expect(last.behavior.digest.counts.session_start).toBe(1)
    expect(last.behavior.digest.counts.session_end).toBe(1)
    expect(last.behavior.digest.terminalCause).toBe("session ended (clean)")
  })

  it("logSessionEnd is idempotent — a second call emits nothing", async () => {
    resetBehaviorDigest("c")
    const contents = await readJsonl(
      Effect.gen(function* () {
        yield* logSessionEnd("c", "clean")
        yield* logSessionEnd("c", "signal", "SIGTERM")
      }),
    )
    const endLines = contents.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "behavior" && e.behavior.type === "session_end")
    expect(endLines).toHaveLength(1)
    expect(endLines[0].behavior.reason).toBe("clean")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/logging/log-writer.test.ts`
Expected: FAIL — `logBehavior`/`logSessionEnd` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `packages/core/src/logging/log-writer.ts` (after `logExchange`, after line 127). Add the imports near the top (after line 9):

```ts
import type { Behavior } from "./behavior.js"
import { recordBehavior, snapshotDigest, tryMarkEnded, emptyBehaviorDigest } from "./behavior-digest.js"
```

```ts
/**
 * Emit a structured behavior event — the source of truth for "what the bot did".
 * Folds the behavior into the per-character digest accumulator, and for the
 * terminal `session_end` snapshots that accumulator inline so the emitted event
 * is the authoritative run digest. Best-effort: a log-write failure can never
 * crash the loop or orchestrator (mirrors logExchange's resilience).
 */
export const logBehavior = (
  character: string,
  system: string,
  subsystem: string,
  behavior: Behavior,
): Effect.Effect<void, never, CharacterLog> =>
  Effect.gen(function* () {
    const base = eventBase(character, system, subsystem)
    recordBehavior(character, behavior, base.timestamp)
    const finalBehavior: Behavior =
      behavior.type === "session_end"
        ? { ...behavior, digest: snapshotDigest(character) }
        : behavior
    const log = yield* CharacterLog
    yield* log.emit(
      { name: character, dir: "" } as CharacterConfig,
      { ...base, kind: "behavior", behavior: finalBehavior },
    )
  }).pipe(Effect.catchAll(() => Effect.void))

/**
 * Idempotent terminal emit. The first call per character emits a `session_end`
 * carrying the inline digest snapshot; subsequent calls (e.g. the onExit path
 * AND a signal handler racing) are no-ops via the `tryMarkEnded` guard.
 */
export const logSessionEnd = (
  character: string,
  reason: "clean" | "signal" | "error",
  signal?: string,
): Effect.Effect<void, never, CharacterLog> =>
  Effect.gen(function* () {
    if (!tryMarkEnded(character)) return
    yield* logBehavior(character, "orchestrator", "main", {
      type: "session_end",
      reason,
      ...(signal ? { signal } : {}),
      digest: emptyBehaviorDigest(),
    })
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/logging/log-writer.test.ts`
Expected: PASS (9 tests — 6 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/logging/log-writer.ts packages/core/src/logging/log-writer.test.ts
git commit -m "feat(logging): add logBehavior and idempotent logSessionEnd emit helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Console rendering for behavior events

**Files:**
- Modify: `packages/core/src/logging/console-renderer.ts:59-117` (add a `case "behavior":` to the `renderEvent` switch)
- Test: `packages/core/src/logging/console-renderer.test.ts`

**Interfaces:**
- Consumes: `renderEvent`, `tag` (existing); `UnifiedEvent` with the `behavior` variant.
- Produces: a `case "behavior":` that returns one `[char:subsystem] …` line per behavior.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/logging/console-renderer.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import type { UnifiedEvent } from "./events.js"
import type { Behavior } from "./behavior.js"
import { renderEvent } from "./console-renderer.js"

const ev = (behavior: Behavior): UnifiedEvent => ({
  timestamp: "2026-06-30T00:00:00.000Z",
  character: "ada",
  system: "orchestrator",
  subsystem: "main",
  kind: "behavior",
  behavior,
})

// Strip ANSI so assertions match the rendered text content.
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))

describe("renderEvent — behavior", () => {
  it("renders a phase behavior on one tagged line", () => {
    const lines = plain(renderEvent(ev({ type: "phase", phase: "active", transition: "enter" })))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe("[ada:main] phase active enter")
  })

  it("renders a provision behavior with component and status", () => {
    const lines = plain(renderEvent(ev({ type: "provision", component: "memory_cli", status: "ready" })))
    expect(lines[0]).toBe("[ada:main] provision memory_cli ready")
  })

  it("renders a reflection promote with its count", () => {
    const lines = plain(renderEvent(ev({ type: "reflection", stage: "promote", status: "done", counts: { promoted: 0 } })))
    expect(lines[0]).toContain("reflection promote done")
    expect(lines[0]).toContain("promoted=0")
  })

  it("renders a session_end with reason", () => {
    const lines = plain(renderEvent(ev({
      type: "session_end",
      reason: "signal",
      signal: "SIGTERM",
      digest: { counts: {}, sequence: [], timings: { firstForebrainMs: null, firstPlanMs: null }, startTs: null, terminalCause: null },
    })))
    expect(lines[0]).toBe("[ada:main] session_end signal (SIGTERM)")
  })

  it("renders a note with its label", () => {
    const lines = plain(renderEvent(ev({ type: "note", label: "opencode-blob", severity: "warn" })))
    expect(lines[0]).toContain("note opencode-blob")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/logging/console-renderer.test.ts`
Expected: FAIL — `renderEvent` returns `undefined` for `kind:"behavior"` (no matching case), so `.map` throws / assertions fail.

- [ ] **Step 3: Implement the behavior render case**

In `packages/core/src/logging/console-renderer.ts`, add a `renderBehavior` helper above `renderEvent` (after line 57) and a `case "behavior":` inside the switch (add it before `case "error":`, around line 114):

```ts
function renderBehavior(b: import("./behavior.js").Behavior): string {
  switch (b.type) {
    case "session_start":
      return `session_start ${b.domain} (${b.character}) sha=${b.gitSha} tick=${b.tickIntervalMs}ms`
    case "session_end":
      return `session_end ${b.reason}${b.signal ? ` (${b.signal})` : ""}`
    case "provision":
      return `provision ${b.component} ${b.status}${b.detail ? ` — ${b.detail}` : ""}`
    case "phase":
      return `phase ${b.phase} ${b.transition}`
    case "reflection":
      return `reflection ${b.stage} ${b.status}${b.counts ? ` ${Object.entries(b.counts).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}`
    case "tier_call":
      return `tier_call ${b.tier} ${b.latencyMs}ms ${b.outcome}`
    case "appraisal":
      return `appraisal ${b.disposition}${b.weight !== undefined ? ` w=${b.weight}` : ""}${b.escalated ? " (escalated)" : ""}`
    case "orient":
      return `orient ${b.headline}`
    case "decision":
      return `decision ${b.disposition}`
    case "step":
      return `step ${b.phase}${b.turn !== undefined ? ` turn=${b.turn}` : ""}${b.task ? `: ${b.task}` : ""}`
    case "action":
      return `action ${b.domain}/${b.name}`
    case "note":
      return `note ${b.label}`
  }
}
```

```ts
    case "behavior":
      return [`${t} ${levelMarker(event)}${truncateLine(renderBehavior(event.behavior))}`]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/logging/console-renderer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify the core package typechecks (exhaustive switch now satisfied)**

Run: `pnpm exec tsc -p packages/core --noEmit`
Expected: no output (clean exit).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/logging/console-renderer.ts packages/core/src/logging/console-renderer.test.ts
git commit -m "feat(logging): render kind:behavior events to the console

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: classifyEvent behavior branch + NOTE transition

**Files:**
- Modify: `apps/roci/src/qa/types.ts:1-13` (add `NOTE` to `TransitionType`)
- Modify: `apps/roci/src/qa/markers.ts:4` (add the `kind:"behavior"` branch at the top of `classifyEvent`)
- Test: `apps/roci/src/qa/markers.test.ts` (add a `describe` block for behavior classification)

**Interfaces:**
- Consumes: `UnifiedEvent` (with the `behavior` variant), `Marker`, `TransitionType`.
- Produces: `classifyEvent` returns a `Marker` for every `kind:"behavior"` event (no-drop: unknown types → `NOTE`). The legacy string-regex shim below it is unchanged (interim, removed in Wave 2 Task 16).

- [ ] **Step 1: Write the failing test**

Add to `apps/roci/src/qa/markers.test.ts` a behavior helper and a new `describe` block (append before the file's final `})` is not needed — add a sibling `describe`):

```ts
const beh = (behavior: import("@roci/core").Behavior): UnifiedEvent => ({
  timestamp: "2026-06-21T00:00:00.000Z",
  character: "ada",
  system: "orchestrator",
  subsystem: "main",
  kind: "behavior",
  behavior,
})

describe("classifyEvent — behavior branch", () => {
  it("maps session_start and session_end to their transitions", () => {
    expect(classifyEvent(beh({ type: "session_start", domain: "d", character: "ada", gitSha: "x", tickIntervalMs: 30000 }))?.type).toBe("SESSION_START")
    expect(classifyEvent(beh({ type: "session_end", reason: "clean", digest: { counts: {}, sequence: [], timings: { firstForebrainMs: null, firstPlanMs: null }, startTs: null, terminalCause: null } }))?.type).toBe("SESSION_END")
  })

  it("maps escalated appraisal to ESCALATE and non-escalate to NOTE (no-drop)", () => {
    expect(classifyEvent(beh({ type: "appraisal", disposition: "escalate", weight: 4, escalated: true }))?.type).toBe("ESCALATE")
    expect(classifyEvent(beh({ type: "appraisal", disposition: "accumulate", weight: 1, escalated: false }))?.type).toBe("NOTE")
  })

  it("maps orient/decision/step/action to their transitions", () => {
    expect(classifyEvent(beh({ type: "orient", headline: "regroup" }))?.type).toBe("FOREBRAIN")
    expect(classifyEvent(beh({ type: "decision", disposition: "plan" }))?.type).toBe("DECISION")
    expect(classifyEvent(beh({ type: "step", phase: "start", turn: 1, task: "scout" }))?.type).toBe("STEP_START")
    expect(classifyEvent(beh({ type: "step", phase: "done" }))?.type).toBe("STEP_DONE")
    expect(classifyEvent(beh({ type: "step", phase: "salvage" }))?.type).toBe("STEP_SALVAGE")
    expect(classifyEvent(beh({ type: "action", domain: "spacemolt", name: "frontier" }))?.type).toBe("DELEGATION")
  })

  it("maps machinery + tier_call + note to NOTE (no-drop)", () => {
    expect(classifyEvent(beh({ type: "provision", component: "container", status: "ready" }))?.type).toBe("NOTE")
    expect(classifyEvent(beh({ type: "phase", phase: "active", transition: "enter" }))?.type).toBe("NOTE")
    expect(classifyEvent(beh({ type: "reflection", stage: "promote", status: "done", counts: { promoted: 0 } }))?.type).toBe("NOTE")
    expect(classifyEvent(beh({ type: "tier_call", tier: "forebrain", latencyMs: 1800, outcome: "ok" }))?.type).toBe("NOTE")
    expect(classifyEvent(beh({ type: "note", label: "opencode-blob" }))?.type).toBe("NOTE")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/roci/src/qa/markers.test.ts`
Expected: FAIL — `"NOTE"` is not assignable / `classifyEvent` returns `null` for behavior events.

- [ ] **Step 3: Add NOTE to the TransitionType union**

In `apps/roci/src/qa/types.ts`, append `NOTE` to the `TransitionType` union (after `"SESSION_END"`, line 13):

```ts
export type TransitionType =
  | "SESSION_START"
  | "ESCALATE"
  | "FOREBRAIN"
  | "DECISION"
  | "STEER"
  | "STEP_START"
  | "STEP_DONE"
  | "STEP_SALVAGE"
  | "EVALUATE"
  | "DELEGATION"
  | "CRITICAL"
  | "SESSION_END"
  | "NOTE"
```

- [ ] **Step 4: Add the behavior branch to classifyEvent**

In `apps/roci/src/qa/markers.ts`, insert this block at the very start of `classifyEvent` (immediately after `export function classifyEvent(ev: UnifiedEvent): Marker | null {`, before the existing `tool_use` block):

```ts
  if (ev.kind === "behavior") {
    const b = ev.behavior
    const note = (): Marker => ({
      type: "NOTE",
      summary: `${b.type}`,
      fields: { behaviorType: b.type },
    })
    switch (b.type) {
      case "session_start":
        return { type: "SESSION_START", summary: `session start (${b.character})`, fields: { domain: b.domain, gitSha: b.gitSha } }
      case "session_end":
        return { type: "SESSION_END", summary: `session end (${b.reason})`, fields: { reason: b.reason, ...(b.signal ? { signal: b.signal } : {}) } }
      case "appraisal":
        return b.escalated
          ? { type: "ESCALATE", summary: `hindbrain escalate (${b.disposition})`, fields: { disposition: b.disposition, ...(b.weight !== undefined ? { weight: String(b.weight) } : {}) } }
          : note()
      case "orient":
        return { type: "FOREBRAIN", summary: `forebrain: ${b.headline}`, fields: { headline: b.headline } }
      case "decision":
        return { type: "DECISION", summary: `conscious decision: ${b.disposition}`, fields: { decision: b.disposition } }
      case "step":
        return b.phase === "start"
          ? { type: "STEP_START", summary: `step start${b.task ? `: ${b.task}` : ""}`, fields: { ...(b.task ? { task: b.task } : {}), ...(b.turn !== undefined ? { turn: String(b.turn) } : {}) } }
          : b.phase === "done"
            ? { type: "STEP_DONE", summary: "step done", fields: {} }
            : { type: "STEP_SALVAGE", summary: "step salvage", fields: {} }
      case "action":
        return { type: "DELEGATION", summary: `delegation: ${b.domain}/${b.name}`, fields: { domain: b.domain, name: b.name } }
      default:
        return note()
    }
  }

```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run apps/roci/src/qa/markers.test.ts`
Expected: PASS (existing string tests + the new behavior block).

- [ ] **Step 6: Commit**

```bash
git add apps/roci/src/qa/types.ts apps/roci/src/qa/markers.ts apps/roci/src/qa/markers.test.ts
git commit -m "feat(qa): classify kind:behavior events with a NOTE no-drop fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: feed.ts — skip the auto SESSION_START guess for a real session_start

**Files:**
- Modify: `apps/roci/src/qa/feed.ts:21-31`
- Test: `apps/roci/src/qa/feed.test.ts` (add one case; existing cases unchanged — they guard the Wave 1 interim shim)

**Interfaces:**
- Consumes: `classifyEvent` (now behavior-aware), `UnifiedEvent`.
- Produces: `reduce` no longer double-emits `SESSION_START` when the first event is a real behavior `session_start` (the classify branch produces it instead).

- [ ] **Step 1: Write the failing test**

Add to `apps/roci/src/qa/feed.test.ts` inside the `describe("reduce", ...)` block:

```ts
  it("does not double-emit SESSION_START when the first event is a behavior session_start", () => {
    const startBehavior: UnifiedEvent = {
      timestamp: "2026-06-21T00:00:00.000Z",
      character: "ada",
      system: "orchestrator",
      subsystem: "main",
      kind: "behavior",
      behavior: { type: "session_start", domain: "spacemolt", character: "ada", gitSha: "x", tickIntervalMs: 30000 },
    }
    const { records } = run([startBehavior])
    const starts = records.filter((r) => r.type === "SESSION_START")
    expect(starts).toHaveLength(1)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/roci/src/qa/feed.test.ts`
Expected: FAIL — two `SESSION_START` records (the auto-inject plus the classify branch).

- [ ] **Step 3: Guard the auto-inject**

In `apps/roci/src/qa/feed.ts`, replace the `if (!started)` block (lines 21-31) with:

```ts
  // Auto-inject a SESSION_START guess on the very first event — UNLESS that first
  // event is a real behavior session_start, which classifyEvent already maps to
  // SESSION_START below (avoids a double count). The structured event is the
  // source of truth; this guess only covers pre-behavior / legacy streams.
  const isBehaviorSessionStart = ev.kind === "behavior" && ev.behavior.type === "session_start"
  if (!started && !isBehaviorSessionStart) {
    started = true
    records.push({
      ts: ev.timestamp,
      kind: "transition",
      type: "SESSION_START",
      severity: "info",
      tick,
      summary: `session start (${ev.character})`,
    })
  } else if (!started) {
    started = true
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/roci/src/qa/feed.test.ts`
Expected: PASS (existing cases + the new one).

- [ ] **Step 5: Commit**

```bash
git add apps/roci/src/qa/feed.ts apps/roci/src/qa/feed.test.ts
git commit -m "fix(qa): avoid double SESSION_START when a real session_start behavior leads

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: ingest surfaces the session_end digest + finalizeDigest selector

**Files:**
- Modify: `apps/roci/src/qa/ingest.ts:12-34`
- Modify: `apps/roci/src/qa/digest.ts` (add `finalizeDigest`)
- Test: `apps/roci/src/qa/ingest.test.ts` (add a case), `apps/roci/src/qa/digest.test.ts` (add a `describe`)

**Interfaces:**
- Consumes: `BehaviorDigest` from `@roci/core`, `RunDigest` (existing).
- Produces:
  - `ingestChunk(...)` return type gains `sessionEndDigest?: BehaviorDigest` — set when a `kind:"behavior"` `session_end` line is parsed.
  - `finalizeDigest(env: RunDigest["env"], endDigest: BehaviorDigest | undefined, fold: RunDigest): RunDigest` — returns the session_end digest (authoritative) with `env` attached, else the fold (crash fallback).

- [ ] **Step 1: Write the failing tests**

Add to `apps/roci/src/qa/ingest.test.ts`:

```ts
import type { BehaviorDigest } from "@roci/core"

const sessionEndLine = (digest: BehaviorDigest) =>
  JSON.stringify({
    timestamp: "2026-06-21T00:00:09.000Z",
    character: "ada",
    system: "orchestrator",
    subsystem: "main",
    kind: "behavior",
    behavior: { type: "session_end", reason: "clean", digest },
  })

it("surfaces the inline digest from a behavior session_end line", () => {
  const digest: BehaviorDigest = { counts: { session_start: 1, session_end: 1 }, sequence: ["session_start", "session_end"], timings: { firstForebrainMs: 1800, firstPlanMs: null }, startTs: "2026-06-21T00:00:00.000Z", terminalCause: "session ended (clean)" }
  const { sessionEndDigest } = ingestChunk(initialIngestState, sessionEndLine(digest) + "\n")
  expect(sessionEndDigest?.terminalCause).toBe("session ended (clean)")
  expect(sessionEndDigest?.timings.firstForebrainMs).toBe(1800)
})
```

Add to `apps/roci/src/qa/digest.test.ts`:

```ts
import { emptyDigest, foldDigest, toPublicDigest, finalizeDigest } from "./digest.js"
import type { BehaviorDigest } from "@roci/core"

describe("finalizeDigest", () => {
  const endDigest: BehaviorDigest = {
    counts: { session_start: 1, phase: 2, session_end: 1 },
    sequence: ["session_start", "phase", "phase", "session_end"],
    timings: { firstForebrainMs: 1800, firstPlanMs: 5000 },
    startTs: "2026-06-21T00:00:00.000Z",
    terminalCause: "session ended (clean)",
  }

  it("adopts the session_end digest as authoritative, attaching env", () => {
    const fold = emptyDigest(env)
    const out = finalizeDigest(env, endDigest, fold)
    expect(out.env).toEqual(env)
    expect(out.terminalCause).toBe("session ended (clean)")
    expect(out.counts.phase).toBe(2)
  })

  it("falls back to the fold when no session_end digest is present (crash)", () => {
    const fold = [
      { ts: "t", kind: "transition", type: "SESSION_START", severity: "info", tick: 0, summary: "" },
      { ts: "t", kind: "anomaly", type: "PROCESS_DIED", severity: "error", tick: 1, summary: "session process 99 exited" },
    ].reduce(foldDigest, emptyDigest(env))
    const out = finalizeDigest(env, undefined, fold)
    expect(out.terminalCause).toContain("session process 99 exited")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/roci/src/qa/ingest.test.ts apps/roci/src/qa/digest.test.ts`
Expected: FAIL — `sessionEndDigest` undefined in the return type; `finalizeDigest` not exported.

- [ ] **Step 3: Surface the digest from ingestChunk**

Replace `apps/roci/src/qa/ingest.ts` lines 1-34 with:

```ts
import type { UnifiedEvent, BehaviorDigest } from "@roci/core"
import type { FeedRecord } from "./types.js"
import { type ReducerState, initialState, reduce } from "./feed.js"

export interface IngestState {
  reducer: ReducerState
  remainder: string
}

export const initialIngestState: IngestState = { reducer: initialState, remainder: "" }

export function ingestChunk(
  state: IngestState,
  chunk: string,
): { state: IngestState; records: FeedRecord[]; sessionEndDigest?: BehaviorDigest } {
  const text = state.remainder + chunk
  const parts = text.split("\n")
  const remainder = parts.pop() ?? ""
  let reducer = state.reducer
  const records: FeedRecord[] = []
  let sessionEndDigest: BehaviorDigest | undefined
  for (const lineStr of parts) {
    if (lineStr.trim() === "") continue
    let ev: UnifiedEvent
    try {
      ev = JSON.parse(lineStr) as UnifiedEvent
    } catch {
      continue
    }
    if (ev.kind === "behavior" && ev.behavior.type === "session_end") {
      sessionEndDigest = ev.behavior.digest
    }
    const out = reduce(reducer, ev)
    reducer = out.state
    records.push(...out.records)
  }
  return { state: { reducer, remainder }, records, sessionEndDigest }
}
```

- [ ] **Step 4: Add finalizeDigest to digest.ts**

Append to `apps/roci/src/qa/digest.ts`:

```ts
import type { BehaviorDigest } from "@roci/core"

/**
 * Choose the authoritative run digest. The emitted `session_end` digest is the
 * source of truth (snapshotted live in the logging package); the regex fold
 * survives only as a crash fallback for runs that die before `session_end`.
 */
export function finalizeDigest(
  env: RunDigest["env"],
  endDigest: BehaviorDigest | undefined,
  fold: RunDigest,
): RunDigest {
  if (!endDigest) return toPublicDigest(fold)
  return {
    env,
    counts: endDigest.counts,
    sequence: endDigest.sequence as TransitionType[],
    timings: endDigest.timings,
    startTs: endDigest.startTs,
    terminalCause: endDigest.terminalCause,
  }
}
```

(Note: `TransitionType` and `RunDigest`/`toPublicDigest` are already in scope in `digest.ts`; only the `BehaviorDigest` import is new.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run apps/roci/src/qa/ingest.test.ts apps/roci/src/qa/digest.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/roci/src/qa/ingest.ts apps/roci/src/qa/digest.ts apps/roci/src/qa/ingest.test.ts apps/roci/src/qa/digest.test.ts
git commit -m "feat(qa): surface session_end digest and add the finalizeDigest selector

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: monitor writes run-digest.json from the session_end digest

**Files:**
- Modify: `apps/roci/src/qa/monitor.ts:55-128, :80-108`

**Interfaces:**
- Consumes: `ingestChunk` (now returns `sessionEndDigest`), `finalizeDigest`.
- Produces: `finalise()` writes `finalizeDigest(args.env, sessionEndDigest, foldDigest)` — `session_end` authoritative, fold as crash fallback. No new exported surface (this is the CLI wiring of Task 7's pure helpers, which carry the tests).

- [ ] **Step 1: Import finalizeDigest and add a capture cell**

In `apps/roci/src/qa/monitor.ts`, update the digest import (line 5) and add a module-level capture variable near `let finalised = false` (line 55):

```ts
import { emptyDigest, finalizeDigest, foldDigest, toPublicDigest, type RunDigest } from "./digest.js"
```

```ts
let finalised = false
let sessionEndDigest: import("@roci/core").BehaviorDigest | undefined
```

- [ ] **Step 2: Capture the digest in poll()**

In the `poll` function, after `ingest = out.state` (line 89), capture the surfaced digest:

```ts
          const out = ingestChunk(ingest, buf.toString("utf8"))
          ingest = out.state
          if (out.sessionEndDigest) sessionEndDigest = out.sessionEndDigest
```

- [ ] **Step 3: Write from the authoritative digest in finalise()**

In `finalise()` (line 113), replace the `writeFile` line:

```ts
    const finalDigest = finalizeDigest(args.env, sessionEndDigest, digest)
    await writeFile(args.digestOut, `${JSON.stringify(finalDigest, null, 2)}\n`)
```

And update the `baseline` compare just below to compare against `finalDigest` instead of `digest`:

```ts
        const base = JSON.parse(await readFile(args.baseline, "utf8")) as RunDigest
        const report = compareBaseline(finalDigest, base)
```

- [ ] **Step 4: Verify the app typechecks and the QA tests still pass**

Run: `pnpm exec tsc -p apps/roci --noEmit`
Expected: no output. `toPublicDigest` may now be unused in `monitor.ts` — if `tsc`/biome flags it as unused, remove it from the import in line 5 (`finalizeDigest` handles both paths).

Run: `pnpm vitest run apps/roci/src/qa/digest.test.ts apps/roci/src/qa/ingest.test.ts apps/roci/src/qa/feed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/roci/src/qa/monitor.ts
git commit -m "feat(qa): write run-digest.json from the session_end digest, fold as fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: phase-runner emits phase enter/exit behaviors

**Files:**
- Modify: `packages/core/src/core/phase-runner.ts:29-65`
- Test: `packages/core/src/core/phase-runner.test.ts`

**Interfaces:**
- Consumes: `logBehavior` from `../logging/log-writer.js`; `PhaseContext`, `PhaseRegistry`, `runPhases` (existing).
- Produces: a `phase{phase, transition:"enter"}` behavior on entering each phase and a `phase{phase, transition:"exit"}` behavior on every Continue/Restart/Shutdown transition out of it. Existing `logToConsole` lines are retained (operational prose alongside the structured events).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/core/phase-runner.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FileSystem } from "@effect/platform"
import * as os from "node:os"
import * as path from "node:path"
import { CharacterLogLive } from "../logging/log-writer.js"
import { ProjectRoot } from "../services/ProjectRoot.js"
import { runPhases } from "./phase-runner.js"
import type { PhaseContext, PhaseRegistry, PhaseResult } from "./phase.js"

let tmp: string
beforeEach(() => {
  tmp = path.join(os.tmpdir(), `phasetest-${process.hrtime.bigint()}`)
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("runPhases — phase behaviors", () => {
  it("emits phase enter then exit behaviors around a phase", async () => {
    const ctx = { char: { name: "p", dir: "" }, connection: undefined, phaseData: undefined } as unknown as PhaseContext<unknown, unknown>
    const registry: PhaseRegistry<unknown, unknown, never> = {
      initialPhase: "only",
      getPhase: (name) =>
        name === "only"
          ? { name: "only", run: () => Effect.succeed({ _tag: "Shutdown" } as PhaseResult<unknown, unknown>) }
          : undefined,
    } as unknown as PhaseRegistry<unknown, unknown, never>

    const layer = CharacterLogLive.pipe(
      Layer.provide(Layer.mergeAll(NodeFileSystem.layer, Layer.succeed(ProjectRoot, tmp))),
    )
    const contents = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runPhases(ctx, registry)
        const fs = yield* FileSystem.FileSystem
        return yield* fs.readFileString(path.join(tmp, "players", "p", "logs", "events.jsonl"))
      }).pipe(
        Effect.provide(layer),
        Effect.provide(NodeFileSystem.layer),
      ) as Effect.Effect<string, unknown, never>,
    )
    const behaviors = contents.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "behavior" && e.behavior.type === "phase")
    expect(behaviors.map((e) => e.behavior.transition)).toEqual(["enter", "exit"])
    expect(behaviors[0].behavior.phase).toBe("only")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/core/phase-runner.test.ts`
Expected: FAIL — no `phase` behaviors in the stream.

- [ ] **Step 3: Emit the behaviors**

In `packages/core/src/core/phase-runner.ts`, update the import (line 3) and add emits:

```ts
import { logToConsole, logBehavior } from "../logging/log-writer.js"
```

After the existing enter log (line 29), add an enter behavior:

```ts
      yield* logToConsole(context.char.name, "orchestrator", `Entering phase: ${phase.name}`)
      yield* logBehavior(context.char.name, "orchestrator", "phase", { type: "phase", phase: phase.name, transition: "enter" })
```

Then emit an exit behavior at each transition. In the `Continue` case (after line 39's log), the `Restart` case (after line 56's log), and the `Shutdown` case (after line 62's log), add immediately after each existing `logToConsole`:

```ts
          yield* logBehavior(context.char.name, "orchestrator", "phase", { type: "phase", phase: phase.name, transition: "exit" })
```

(Three insertions — one per case. The `Unknown phase` early-return at line 21-27 has no matching enter and needs no exit.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/core/phase-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/phase-runner.ts packages/core/src/core/phase-runner.test.ts
git commit -m "feat(core): emit phase enter/exit behaviors from the phase runner

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: planned-action emits reflection behaviors (promote carries N including 0)

**Files:**
- Modify: `packages/core/src/core/orchestrator/planned-action.ts:59-102`
- Test: `packages/core/src/core/orchestrator/planned-action.test.ts`

**Interfaces:**
- Consumes: `logBehavior` from `../../logging/log-writer.js`; the existing `runReflection` services (`CharacterFs`, `LongtermStore`, `consolidate`, `dream`).
- Produces: `reflection{stage:"promote", status:"done", counts:{promoted: n}}` emitted even when `n === 0` (today the promote path returns early before logging when nothing is fresh); `reflection{stage:"consolidate"|"dream", status:"start"}` at each stage.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/core/orchestrator/planned-action.test.ts`. This stubs the four services so `runReflection` runs with an empty diary (the fresh-length-0 path) and asserts a `reflection promote` behavior carrying `promoted: 0` is still emitted:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FileSystem } from "@effect/platform"
import * as os from "node:os"
import * as path from "node:path"
import { CharacterLogLive } from "../../logging/log-writer.js"
import { ProjectRoot } from "../../services/ProjectRoot.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { LongtermStore } from "../../conscious/longterm-store.js"
import { consolidate } from "../limbic/hippocampus/consolidate.js"
import { dream } from "../limbic/hippocampus/dream.js"
import { runReflection } from "./planned-action.js"
import { DEFAULT_MODEL_CONFIG } from "../model-config.js"

let tmp: string
beforeEach(() => {
  tmp = path.join(os.tmpdir(), `reflecttest-${process.hrtime.bigint()}`)
  vi.spyOn(console, "log").mockImplementation(() => {})
  // Stub the two cull steps to no-ops so the test exercises only the reflection emits.
  vi.spyOn(consolidate, "execute").mockReturnValue(Effect.void as never)
  vi.spyOn(dream, "execute").mockReturnValue(Effect.void as never)
})
afterEach(() => vi.restoreAllMocks())

const char = { name: "r", dir: "" } as never

// Minimal stub layers: empty diary (no fresh entries), a mark, a store.
const CharacterFsStub = Layer.succeed(CharacterFs, {
  readDiary: () => Effect.succeed(""),
  writeDiary: () => Effect.void,
} as never)
const LongtermStoreStub = Layer.succeed(LongtermStore, {
  readMark: () => Effect.succeed(null),
  promote: () => Effect.succeed(0),
  writeMark: () => Effect.void,
} as never)

describe("runReflection — reflection behaviors", () => {
  it("emits reflection promote with promoted:0 even when nothing is fresh", async () => {
    const layer = CharacterLogLive.pipe(
      Layer.provide(Layer.mergeAll(NodeFileSystem.layer, Layer.succeed(ProjectRoot, tmp))),
    )
    const contents = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runReflection(char, "container-1", DEFAULT_MODEL_CONFIG)
        const fs = yield* FileSystem.FileSystem
        return yield* fs.readFileString(path.join(tmp, "players", "r", "logs", "events.jsonl"))
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, CharacterFsStub, LongtermStoreStub)),
        Effect.provide(NodeFileSystem.layer),
      ) as Effect.Effect<string, unknown, never>,
    )
    const reflections = contents.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "behavior" && e.behavior.type === "reflection")
    const promote = reflections.find((e) => e.behavior.stage === "promote")
    expect(promote).toBeDefined()
    expect(promote.behavior.counts.promoted).toBe(0)
    expect(reflections.some((e) => e.behavior.stage === "consolidate")).toBe(true)
    expect(reflections.some((e) => e.behavior.stage === "dream")).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/core/orchestrator/planned-action.test.ts`
Expected: FAIL — no `reflection` behaviors emitted.

- [ ] **Step 3: Emit the reflection behaviors**

In `packages/core/src/core/orchestrator/planned-action.ts`, update the import (line 10) and add emits. First the import:

```ts
import { logToConsole, logError, logBehavior } from "../../logging/log-writer.js"
```

In the promotion inner block (lines 59-78), restructure so the promote behavior fires with N including 0 — replace the `if (fresh.length === 0) return` early-return so the count is always emitted:

```ts
    yield* Effect.gen(function* () {
      const charFs = yield* CharacterFs
      const store = yield* LongtermStore
      const diary = yield* charFs.readDiary(char)
      const mark = yield* store.readMark(containerId, char)
      const fresh = newSinceMark(diary, mark)
      const n = fresh.length === 0 ? 0 : yield* store.promote(containerId, char, fresh)
      if (n > 0) {
        yield* logToConsole(
          char.name,
          "orchestrator",
          `Reflecting — promoted ${n} raw diary entr${n === 1 ? "y" : "ies"} to long-term memory before cull`,
        )
      }
      yield* logBehavior(char.name, "hippocampus", "reflection", { type: "reflection", stage: "promote", status: "done", counts: { promoted: n } })
    }).pipe(
```

Before the consolidate `logToConsole` (line 86), add a consolidate-start behavior:

```ts
    yield* logBehavior(char.name, "hippocampus", "reflection", { type: "reflection", stage: "consolidate", status: "start" })
    yield* logToConsole(char.name, "orchestrator", "Reflecting — consolidating diary...")
```

Before the dream `logToConsole` (line 95), add a dream-start behavior:

```ts
    yield* logBehavior(char.name, "hippocampus", "reflection", { type: "reflection", stage: "dream", status: "start" })
    yield* logToConsole(char.name, "orchestrator", "Reflecting — dreaming (cull)...")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/core/orchestrator/planned-action.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/orchestrator/planned-action.ts packages/core/src/core/orchestrator/planned-action.test.ts
git commit -m "feat(core): emit reflection behaviors; promote count always emitted (incl 0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: orchestrator emits session_start + provision behaviors

**Files:**
- Modify: `apps/roci/src/orchestrator.ts:1-15, :22-76, :84-160, :204-228`

**Interfaces:**
- Consumes: `logBehavior` from `@roci/core/logging/log-writer.js`; existing `provisionConsciousProvider`, `provisionMemoryCli`, `ensureContainer`.
- Produces:
  - `session_start{domain, character, gitSha, tickIntervalMs}` emitted per character inside the character loop (before `runPhases`).
  - `provision{component:"container", status:"ready"}` after a container is ensured.
  - `provision{component:"conscious_provider", status:"ready"|"failed", detail?}` — adds the success path (today only the failure logs).
  - `provision{component:"memory_cli", status:"ready"|"failed", detail?}` — adds the success path.
  - A module-local `gitSha` computed once via `execSync`.

This task is verified by `pnpm exec tsc -p apps/roci --noEmit` + `pnpm build` (it is 1:1 wiring of existing `logToConsole` provisioning sites to add structured `logBehavior` emits); the end-to-end emission is asserted by the Task 16 / live-proof. There is no isolated unit test because `runOrchestrator` requires Docker + OAuth + model-server layers.

- [ ] **Step 1: Add the import and compute gitSha**

In `apps/roci/src/orchestrator.ts`, update the log-writer import (line 4):

```ts
import { logToConsole, logBehavior, logSessionEnd } from "@roci/core/logging/log-writer.js"
```

Inside `runOrchestrator`, after `const docker = yield* Docker` (line 85), compute the gitSha once (reusing the already-imported `execSync`):

```ts
    const gitSha = yield* Effect.sync(() => {
      try {
        return execSync("git rev-parse --short HEAD", { stdio: "pipe" }).toString().trim()
      } catch {
        return "unknown"
      }
    })
```

- [ ] **Step 2: Emit provision{container} after ensureContainer**

In the `for (const rd of resolvedDomains)` container loop (lines 131-160), after `containerIds.set(rd.name, containerId)` (line 134) add:

```ts
      yield* logBehavior("orchestrator", "main", "provision", { type: "provision", component: "container", status: "ready", detail: containerName })
```

- [ ] **Step 3: Add success/failure provision emits to conscious-provider + memory-CLI**

Replace the `provisionConsciousProvider(...)` call (lines 139-143) with:

```ts
      yield* provisionConsciousProvider(containerId, DEFAULT_CORTEX_MODELS.conscious).pipe(
        Effect.tap(() => logBehavior("orchestrator", "main", "provision", { type: "provision", component: "conscious_provider", status: "ready" })),
        Effect.catchAll((e) =>
          logToConsole("orchestrator", "main", `conscious provider provisioning failed: ${e}`, "warn").pipe(
            Effect.zipRight(logBehavior("orchestrator", "main", "provision", { type: "provision", component: "conscious_provider", status: "failed", detail: String(e) })),
          ),
        ),
      )
```

Replace the `provisionMemoryCli(...)` call (lines 155-159) with:

```ts
      yield* provisionMemoryCli(containerId, { embedBaseUrl: DEFAULT_EMBED_BASE_URL }).pipe(
        Effect.tap(() => logBehavior("orchestrator", "main", "provision", { type: "provision", component: "memory_cli", status: "ready" })),
        Effect.catchAll((e) =>
          logToConsole("orchestrator", "main", `memory CLI provisioning failed (long-term memory unavailable): ${e}`, "warn").pipe(
            Effect.zipRight(logBehavior("orchestrator", "main", "provision", { type: "provision", component: "memory_cli", status: "failed", detail: String(e) })),
          ),
        ),
      )
```

- [ ] **Step 4: Emit session_start per character**

In the character-fiber loop, inside `loopEffect` (the `Effect.scoped(Effect.gen(...))` at lines 205-223), after the `Starting character loop...` log (line 207) add:

```ts
            yield* logToConsole(char.name, "orchestrator", "Starting character loop...")
            yield* logBehavior(char.name, "orchestrator", "main", {
              type: "session_start",
              domain: rd.name,
              character: char.name,
              gitSha,
              tickIntervalMs: tickIntervalSeconds * 1000,
            })
```

- [ ] **Step 5: Verify typecheck + build**

Run: `pnpm exec tsc -p apps/roci --noEmit`
Expected: no output.

Run: `pnpm build`
Expected: all 4 projects build (nx run-many -t build succeeds).

- [ ] **Step 6: Commit**

```bash
git add apps/roci/src/orchestrator.ts
git commit -m "feat(orchestrator): emit session_start and provision behaviors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: embed-server emits provision{embed_server}

**Files:**
- Modify: `apps/roci/src/embed-server.ts:306-323`

**Interfaces:**
- Consumes: `logBehavior` from `@roci/core/logging/log-writer.js`; existing `logToConsole`/`logError`.
- Produces: `provision{component:"embed_server", status:"ready"|"failed", detail?}` converted from the existing ready/not-ready/failed logs.

Verified by `pnpm exec tsc -p apps/roci --noEmit` + `pnpm build` (1:1 conversion alongside the retained `logToConsole` lines).

- [ ] **Step 1: Add the import**

In `apps/roci/src/embed-server.ts`, ensure `logBehavior` is imported from `@roci/core/logging/log-writer.js` (add it to the existing log-writer import; check the file's current import line for `logToConsole`/`logError` and append `logBehavior`).

- [ ] **Step 2: Emit provision on ready / not-ready / failed**

After the ready `logToConsole` (line 308) add:

```ts
      yield* logToConsole("embed", "cli", `embed server ready on 127.0.0.1:${EMBED_PORT} (${EMBED_MODEL})`)
      yield* logBehavior("embed", "cli", "provision", { type: "provision", component: "embed_server", status: "ready" })
```

After the not-ready `logToConsole` (lines 310-315) add:

```ts
      yield* logBehavior("embed", "cli", "provision", { type: "provision", component: "embed_server", status: "failed", detail: "launched but not ready yet" })
```

In the outer `catchAll` (lines 318-322), after the `logError` add a failed provision behavior:

```ts
    Effect.catchAll((e) =>
      logError("embed", "cli", `embed server launch failed (long-term memory unavailable): ${e}`).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.zipRight(logBehavior("embed", "cli", "provision", { type: "provision", component: "embed_server", status: "failed", detail: String(e) })),
      ),
    ),
```

- [ ] **Step 3: Verify typecheck + build**

Run: `pnpm exec tsc -p apps/roci --noEmit`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add apps/roci/src/embed-server.ts
git commit -m "feat(embed): emit provision{embed_server} ready/failed behaviors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: session_end wiring — exit-reason helper + signal capture + onExit

**Files:**
- Create: `apps/roci/src/session-end.ts`
- Create: `apps/roci/src/session-end.test.ts`
- Modify: `apps/roci/src/main.ts:24-35`
- Modify: `apps/roci/src/orchestrator.ts:1, :204-228`

**Interfaces:**
- Consumes: `Exit`, `Cause` from `effect`; `consumeShutdownSignal` from `@roci/core/logging/behavior-digest.js`; `logSessionEnd` from `@roci/core/logging/log-writer.js`; `recordShutdownSignal` (main.ts).
- Produces:
  - `sessionEndReasonForExit(exit: Exit.Exit<unknown, unknown>): { reason: "clean" | "signal" | "error"; signal?: string }` — pure mapping (interrupt → signal, other failure → error, success → clean).
  - `withSessionEnd(character, effect)` — wraps a character loop with an `Effect.onExit` that emits the per-character `session_end`.

> **Divergence flag (read before implementing):** The design names the `apps/roci/src/main.ts` signal handlers as a `session_end` emit seam. In the real code those handlers are *synchronous* `process.on` backstops (the SIGKILL reaper) with no Effect runtime or `CharacterLog` layer in scope, so they cannot emit a structured event. Instead: the signal handlers **capture the signal name** (`recordShutdownSignal`), and the orchestrator's per-character `Effect.onExit` emits `session_end` — an interrupt from `NodeRuntime.runMain` propagates to each forked fiber, whose `onExit` reads the captured signal to populate `session_end.signal`. This faithfully uses both seams (main.ts captures, orchestrator emits) while respecting the sync-handler constraint, and is more correct than the design's literal wording (per-character digests; reason discrimination via the real `Exit`).

- [ ] **Step 1: Write the failing test**

Create `apps/roci/src/session-end.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { Exit, Cause } from "effect"
import { sessionEndReasonForExit } from "./session-end.js"

describe("sessionEndReasonForExit", () => {
  it("maps a success exit to clean", () => {
    expect(sessionEndReasonForExit(Exit.succeed(undefined))).toEqual({ reason: "clean" })
  })

  it("maps an interrupt exit to signal", () => {
    const out = sessionEndReasonForExit(Exit.failCause(Cause.interrupt(Cause.empty as never)) as never)
    expect(out.reason).toBe("signal")
  })

  it("maps a defect/error exit to error", () => {
    expect(sessionEndReasonForExit(Exit.fail("boom")).reason).toBe("error")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/roci/src/session-end.test.ts`
Expected: FAIL — `Cannot find module './session-end.js'`.

- [ ] **Step 3: Implement session-end.ts**

Create `apps/roci/src/session-end.ts`:

```ts
import { Cause, Effect, Exit } from "effect"
import { logSessionEnd } from "@roci/core/logging/log-writer.js"
import { consumeShutdownSignal } from "@roci/core/logging/behavior-digest.js"

/**
 * Map a character loop's Effect Exit to a session_end reason. An interrupt
 * (SIGINT/SIGTERM propagated through runMain) is a "signal" stop; any other
 * failure is an "error"; a clean completion is "clean".
 */
export function sessionEndReasonForExit(
  exit: Exit.Exit<unknown, unknown>,
): { reason: "clean" | "signal" | "error"; signal?: string } {
  if (Exit.isSuccess(exit)) return { reason: "clean" }
  if (Cause.isInterruptedOnly(exit.cause)) {
    const signal = consumeShutdownSignal()
    return signal ? { reason: "signal", signal } : { reason: "signal" }
  }
  return { reason: "error" }
}

/**
 * Wrap a character loop so its terminal session_end is emitted on every exit
 * path (clean / signal / error). Idempotent via logSessionEnd's guard. The
 * onExit runs against the RAW loop exit, so place this INSIDE any catchAll that
 * would otherwise convert a failure to success.
 */
export const withSessionEnd = <A, E, R>(
  character: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.onExit((exit) => {
      const { reason, signal } = sessionEndReasonForExit(exit as Exit.Exit<unknown, unknown>)
      return logSessionEnd(character, reason, signal)
    }),
  )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/roci/src/session-end.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Capture the signal name in main.ts**

In `apps/roci/src/main.ts`, add the import and record the signal in the SIGTERM/SIGINT handlers (lines 24-31):

```ts
import { recordShutdownSignal } from "@roci/core/logging/behavior-digest.js"
```

```ts
process.on("SIGTERM", () => {
  recordShutdownSignal("SIGTERM")
  reapResidentServers()
  reapEmbedServers()
})
process.on("SIGINT", () => {
  recordShutdownSignal("SIGINT")
  reapResidentServers()
  reapEmbedServers()
})
```

- [ ] **Step 6: Wrap the character loop with withSessionEnd in the orchestrator**

In `apps/roci/src/orchestrator.ts`, add the import near the top:

```ts
import { withSessionEnd } from "./session-end.js"
```

Then wrap `loopEffect` so `onExit` sees the raw exit BEFORE the existing `catchAll` swallows failures. Replace the `loopEffect` construction (lines 205-228) — apply `withSessionEnd` to the scoped effect, then the existing `catchAll`:

```ts
        const loopEffect = withSessionEnd(
          char.name,
          Effect.scoped(
            Effect.gen(function* () {
              yield* logToConsole(char.name, "orchestrator", "Starting character loop...")
              yield* logBehavior(char.name, "orchestrator", "main", {
                type: "session_start",
                domain: rd.name,
                character: char.name,
                gitSha,
                tickIntervalMs: tickIntervalSeconds * 1000,
              })

              yield* runPhases(
                {
                  char,
                  containerId,
                  containerEnv,
                  containerAddDirs: rd.config.containerAddDirs,
                  domainBundle: rd.config.bundle,
                  phaseData: {
                    ...(manualApproval ? { manualApproval: true } : {}),
                    models,
                  },
                },
                rd.config.phaseRegistry,
              )
            }),
          ),
        ).pipe(
          Effect.catchAll((e) =>
            logToConsole(charName, "orchestrator", `Fatal error: ${e}`),
          ),
        )
```

(This merges Task 11 Step 4's `session_start` emit into the wrapped block; if Step 4 already added it, ensure it is not duplicated.)

- [ ] **Step 7: Verify typecheck + build + full test run**

Run: `pnpm exec tsc -p apps/roci --noEmit`
Expected: no output.

Run: `pnpm vitest run`
Expected: all test files PASS.

Run: `pnpm build`
Expected: all 4 projects build.

- [ ] **Step 8: Commit**

```bash
git add apps/roci/src/session-end.ts apps/roci/src/session-end.test.ts apps/roci/src/main.ts apps/roci/src/orchestrator.ts
git commit -m "feat(orchestrator): emit idempotent per-character session_end on every exit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Wave 1 acceptance gate

Before starting Wave 2, confirm:
- `pnpm vitest run` — all green.
- `pnpm build` — all 4 nx projects build.
- The cortex hot loop (`packages/core/src/cortex/loop.ts`, `tiers.ts`) is **untouched** (`git diff --stat HEAD~13 -- packages/core/src/cortex/` shows no changes).
- The `classifyEvent` string-regex shim (markers.ts lines 15-52 in the original) is **still present** (cognition still classified).

---

# WAVE 2 — Cognition + latency (the one hot-loop touch)

> **Hot-loop discipline (state verbatim in every Wave 2 task):** This is the ONLY wave that edits `cortex/loop.ts`. It is a **mechanical emit-call swap with NO control-flow change** — swap `logToConsole(...)` strings for `logBehavior(...)` structured emits at the existing call sites; do not move, add, or remove any branch, loop, `yield*` ordering, or early return. Wave 2 should be reviewed by an independent reviewer (per the established posture for moving memory-CLI provisioning out of the loop).

## Task 14: tier_call latency wrap in callTier

**Files:**
- Modify: `packages/core/src/cortex/tiers.ts:83-104, :23`
- Test: `packages/core/src/cortex/tier-outcome.test.ts` (pure outcome classifier)

**Interfaces:**
- Consumes: `logBehavior` from `../logging/log-writer.js`; existing `ModelService`, `ModelClient`, `logExchange`.
- Produces:
  - `classifyTierOutcome(error: unknown): "error" | "timeout"` — pure helper (a `ReadinessError` with `timedOut` or a timeout-tagged error → `"timeout"`, else `"error"`).
  - `callTier` wraps the `svc.withTier(...)` call with `Date.now()` timing and emits `tier_call{tier, latencyMs, outcome}` on both the success and failure paths (failure re-raises after emitting).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/cortex/tier-outcome.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { classifyTierOutcome } from "./tiers.js"
import { ReadinessError } from "../services/model-backend.js"

describe("classifyTierOutcome", () => {
  it("classifies a timed-out ReadinessError as timeout", () => {
    expect(classifyTierOutcome(new ReadinessError("forebrain", "m", "probe timed out", true))).toBe("timeout")
  })

  it("classifies a non-timeout ReadinessError as error", () => {
    expect(classifyTierOutcome(new ReadinessError("forebrain", "m", "dead", false))).toBe("error")
  })

  it("classifies an effect timeout-tagged error as timeout", () => {
    expect(classifyTierOutcome({ _tag: "TimeoutException" })).toBe("timeout")
  })

  it("classifies an arbitrary error as error", () => {
    expect(classifyTierOutcome(new Error("boom"))).toBe("error")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/cortex/tier-outcome.test.ts`
Expected: FAIL — `classifyTierOutcome` not exported.

- [ ] **Step 3: Add the classifier and wrap callTier**

In `packages/core/src/cortex/tiers.ts`, update the log-writer import (line 23) and ensure `Cause` is imported from `effect` (add it to the existing `import { ... } from "effect"` line — needed to extract the underlying error from a failure `Cause`):

```ts
import { CharacterLog, logToConsole, logExchange, logBehavior } from "../logging/log-writer.js"
```

```ts
// add Cause to the existing effect import, e.g.:
import { Cause, Effect /* …existing… */ } from "effect"
```

Add the exported classifier above `callTier` (before line 84):

```ts
/** Map a tier-call failure to a tier_call outcome. Pure. */
export function classifyTierOutcome(error: unknown): "error" | "timeout" {
  if (error instanceof ReadinessError && error.timedOut) return "timeout"
  const tag = (error as { _tag?: string })?._tag
  if (tag === "TimeoutException" || tag === "ReadinessError" && (error as ReadinessError).timedOut) return "timeout"
  return "error"
}
```

Replace the body of `callTier` (lines 90-104) with the timed version (control flow identical — same `svc.withTier` call, same `logExchange`, same return; only timing + the `tier_call` emit are added):

```ts
  Effect.gen(function* () {
    const svc = yield* ModelService
    const client = yield* ModelClient
    const handle = resolveHandle(config.models, tier)
    const startedAt = Date.now()
    const res = yield* svc
      .withTier(tier)(client.complete(handle, [{ role: "user", content: prompt }]))
      .pipe(
        Effect.tapErrorCause((cause) =>
          logBehavior(config.char.name, "cortex", "tier_call", {
            type: "tier_call",
            tier,
            latencyMs: Date.now() - startedAt,
            // Cause.squash extracts the underlying error (ReadinessError / TimeoutException)
            // from the failure Cause so classifyTierOutcome can inspect it. Do NOT use a
            // `.squash` property access — squash is a function, not a field.
            outcome: classifyTierOutcome(Cause.squash(cause)),
          }),
        ),
      )
    yield* logBehavior(config.char.name, "cortex", "tier_call", {
      type: "tier_call",
      tier,
      latencyMs: Date.now() - startedAt,
      outcome: "ok",
    })
    // Full prompt+response archive (debug level; jsonl-complete). Never crash the loop.
    yield* logExchange(config.char.name, "cortex", step, prompt, res.text, {
      tier,
      model: handle.model,
      usage: res.usage,
    }).pipe(Effect.catchAll(() => Effect.void))
    return res.text
  })
```

(Note: `Effect.tapErrorCause` emits the failure `tier_call` then re-raises the original error unchanged — preserving the existing failure propagation. `Cause.squash(cause)` returns the underlying error value, which `classifyTierOutcome` inspects for the timeout/error distinction.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/cortex/tier-outcome.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify the core package typechecks**

Run: `pnpm exec tsc -p packages/core --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/cortex/tiers.ts packages/core/src/cortex/tier-outcome.test.ts
git commit -m "feat(cortex): emit tier_call latency behaviors from callTier

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 15: migrate cortex/loop.ts cognitive emit sites to behavior events

**Files:**
- Modify: `packages/core/src/cortex/loop.ts:7, :248-252, :299-309, :326, :328, :420, :457, :459, :482-486, :568, :592`

**Interfaces:**
- Consumes: `logBehavior` from `../logging/log-writer.js`; existing loop locals (`esc`, `orient`, `decide`, `step`, `evalResult`, `criticals`, `sessionId`).
- Produces: structured behavior emits replacing the cognitive `logToConsole` strings. Each swap keeps the surrounding control flow byte-for-byte identical.

**Hot-loop discipline:** mechanical emit-call swap only; NO control-flow change. Independent reviewer required.

- [ ] **Step 1: Add the import**

In `packages/core/src/cortex/loop.ts`, update the log-writer import (line 7):

```ts
import { CharacterLog, logToConsole, logError, logBehavior } from "../logging/log-writer.js"
```

- [ ] **Step 2: Swap the per-tick hindbrain aggregate (line 302-304) for an appraisal behavior**

Replace the `logToConsole(... "hindbrain: rung=...")` call (lines 300-304) with:

```ts
        yield* logBehavior(config.char.name, "cortex", "hindbrain", {
          type: "appraisal",
          disposition: esc.rung,
          weight: esc.maxWeight,
          escalated: esc.escalate,
        })
```

- [ ] **Step 3: Swap the critical line (lines 248-252) for a note behavior**

Replace the `logToConsole(... "Critical: ...")` call with:

```ts
        yield* logBehavior(config.char.name, "cortex", "amygdala", {
          type: "note",
          label: "critical",
          severity: "warn",
          data: { messages: criticals.map((a) => a.message) },
        })
```

- [ ] **Step 4: Swap the idle-path forebrain + decision (lines 326, 328)**

Replace `logToConsole(config.char.name, "cortex", \`forebrain: ${orient.headline}\`)` (line 326) with:

```ts
          yield* logBehavior(config.char.name, "cortex", "forebrain", { type: "orient", headline: orient.headline })
```

Replace `logToConsole(config.char.name, "cortex", \`conscious: ${decide.decision}\`)` (line 328) with a decision behavior for the three known dispositions, falling back to a note (no-drop) for `discover`/`continue`:

```ts
          yield* (decide.decision === "plan" || decide.decision === "wait" || decide.decision === "terminate"
            ? logBehavior(config.char.name, "cortex", "conscious", { type: "decision", disposition: decide.decision })
            : logBehavior(config.char.name, "cortex", "conscious", { type: "note", label: `decision:${decide.decision}` }))
```

- [ ] **Step 5: Swap the in-session forebrain (line 420)**

Replace `logToConsole(config.char.name, "cortex", \`forebrain (in-session): ${orient.headline}\`)` (line 420) with:

```ts
          yield* logBehavior(config.char.name, "cortex", "forebrain", { type: "orient", headline: orient.headline })
```

- [ ] **Step 6: Swap the step done / salvage / evaluate emits (lines 457, 459, 482-486)**

Replace the done-marker `logToConsole(... "step done-marker detected; evaluating")` (line 457) with:

```ts
              yield* logBehavior(config.char.name, "cortex", "step", { type: "step", phase: "done", task: step.task })
```

Replace the salvage `logToConsole(... "step tick-budget elapsed ...")` (line 459) with:

```ts
              yield* logBehavior(config.char.name, "cortex", "step", { type: "step", phase: "salvage", task: step.task })
```

Replace the evaluate `logToConsole(... "evaluate: X → Y")` (lines 482-486) with a note (no `evaluate` behavior type exists; no-drop routes it):

```ts
            yield* logBehavior(config.char.name, "cortex", "conscious", {
              type: "note",
              label: "evaluate",
              data: { judgment: evalResult.judgment, transition: evalResult.transition.transition },
            })
```

- [ ] **Step 7: Swap the step-start (line 568) and steer (line 592) emits**

Replace `logToConsole(config.char.name, "orchestrator", \`conscious turn 1: ${step.task}\`)` (line 568) with:

```ts
              yield* logBehavior(config.char.name, "cortex", "step", { type: "step", phase: "start", turn: 1, task: step.task })
```

Replace `logToConsole(config.char.name, "orchestrator", \`conscious steer turn (session ${sessionId})\`)` (line 592) with:

```ts
              yield* logBehavior(config.char.name, "cortex", "conscious", { type: "note", label: "steer_turn", data: { sessionId } })
```

- [ ] **Step 8: Verify the core package typechecks and builds**

Run: `pnpm exec tsc -p packages/core --noEmit`
Expected: no output. If `logToConsole` is now unused in `loop.ts`, leave it — it is still used by many non-cognitive lines (state bar line 245, plan-dropped warn line 362, diary_entry_appended line 528, break-phase messages). Confirm with a quick grep that other `logToConsole(` calls remain.

Run: `pnpm build`
Expected: all 4 projects build.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/cortex/loop.ts
git commit -m "feat(cortex): migrate loop cognitive emit sites to structured behaviors

Mechanical emit-call swap only; no control-flow change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 16: retire the classifyEvent string shim + tick-count on appraisal + update QA fixtures

**Files:**
- Modify: `apps/roci/src/qa/markers.ts:15-52` (remove the system-message regex shim; keep the `tool_use` DELEGATION branch and the new behavior branch)
- Modify: `apps/roci/src/qa/feed.ts:33` (tick on `appraisal` behaviors instead of `hindbrain:` strings)
- Modify: `apps/roci/src/qa/feed.test.ts`, `apps/roci/src/qa/ingest.test.ts`, `apps/roci/src/qa/markers.test.ts` (replace string fixtures with behavior fixtures)

**Interfaces:**
- Consumes: the Task 5 behavior branch of `classifyEvent`; `UnifiedEvent` behavior variant.
- Produces: `classifyEvent` no longer matches cognition strings (Wave 2 emits are structured); `reduce` counts a tick per `appraisal` behavior.

> **Divergence flag:** Removing the system-message shim makes the `DEGRADED_TIER` detector in `feed.ts:78-93` (which keyed on `"<tier>: undefined"` strings) vestigial — Wave 2 hindbrain/forebrain emits are now structured `appraisal`/`orient` behaviors, so that string never appears. This is acceptable per the design's non-goal ("no new QA detectors"); leave the `DEGRADED_TIER` block in place (harmless dead branch) and note it for the backlog. The `ERROR`/`FATAL_ERROR` detectors stay live — they key on `kind:"error"` and `Fatal error:` system strings, which are NOT cognitive emit sites and remain emitted by `logError` / the orchestrator `catchAll`.

- [ ] **Step 1: Update the failing tests first (rewrite fixtures to behavior form)**

In `apps/roci/src/qa/markers.test.ts`, the string-based tests (`classifies an escalate hindbrain pass`, `returns null for discard/continue`, `distinguishes idle vs in-session forebrain`, `classifies conscious decision, step start, steer`, `classifies step done, salvage, evaluate, critical`) assert behavior the shim provided. Replace those `it(...)` blocks (lines 14-42's string cases — keep the DELEGATION-from-tool_use and the unrelated-null cases) with behavior-driven equivalents covered by the Task 5 `describe` block; delete the now-obsolete string `describe` cases. Keep only:
  - the `tool_use` → DELEGATION test (still valid; the frontier tool detection survives),
  - the unrelated-events null test, narrowed to non-cognition inputs:

```ts
  it("returns null for unrelated non-behavior events", () => {
    expect(classifyEvent({ ...sys("x"), kind: "thinking", text: "hmm" } as UnifiedEvent)).toBeNull()
  })
```

In `apps/roci/src/qa/feed.test.ts`, rewrite the tick-counting test to use `appraisal` behaviors:

```ts
  it("counts a tick per appraisal behavior and stamps transitions with it", () => {
    const beh = (b: import("@roci/core").Behavior): UnifiedEvent => ({ timestamp: "2026-06-21T00:00:00.000Z", character: "ada", system: "cortex", subsystem: "cortex", kind: "behavior", behavior: b })
    const { state, records } = run([
      beh({ type: "appraisal", disposition: "escalate", weight: 4, escalated: true }),
      beh({ type: "orient", headline: "regroup" }),
      beh({ type: "appraisal", disposition: "accumulate", weight: 1, escalated: false }),
    ])
    expect(state.tick).toBe(2)
    const forebrain = records.find((r) => r.type === "FOREBRAIN")
    expect(forebrain?.tick).toBe(1)
  })
```

Replace the remaining `hindbrain:`/`forebrain:`/`conscious:` string fixtures in `feed.test.ts` and `ingest.test.ts` with their behavior equivalents (e.g. the `ingest.test.ts` "parses whole lines" / "buffers a partial line" / "skips malformed JSON" cases switch their `line(...)` payloads from `{kind:"system",message:"..."}` to `{kind:"behavior",behavior:{...}}`; the `ESCALATE`/`FOREBRAIN`/`DECISION` expectations stay, now sourced from `appraisal{escalated:true}`/`orient`/`decision`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/roci/src/qa/markers.test.ts apps/roci/src/qa/feed.test.ts apps/roci/src/qa/ingest.test.ts`
Expected: FAIL — the shim still matches strings / `reduce` still ticks on `hindbrain:` strings (tick count mismatch), and removed string fixtures no longer classify.

- [ ] **Step 3: Remove the string shim from classifyEvent**

In `apps/roci/src/qa/markers.ts`, delete the system-message block (the original lines 15-52: from `if (ev.kind !== "system") return null` through the final `return null` of the regex cascade). Keep the `kind:"behavior"` branch (top) and the `kind:"tool_use"` DELEGATION branch. The function ends with `return null` after the tool_use branch:

```ts
export function classifyEvent(ev: UnifiedEvent): Marker | null {
  if (ev.kind === "behavior") {
    // ... (the Task 5 behavior branch, unchanged) ...
  }

  // Best-effort delegation detection: the conscious agent runs the in-container
  // `frontier` bash CLI as a tool.
  if (ev.kind === "tool_use") {
    const blob = JSON.stringify(ev.input ?? "")
    if (ev.tool === "frontier" || /frontier (start|poll|steer|wait)/.test(blob)) {
      return { type: "DELEGATION", summary: `delegation via ${ev.tool}`, fields: { tool: ev.tool } }
    }
    return null
  }

  return null
}
```

- [ ] **Step 4: Switch feed.ts tick counting to appraisal behaviors**

In `apps/roci/src/qa/feed.ts`, replace the tick increment (line 33):

```ts
  if (ev.kind === "behavior" && ev.behavior.type === "appraisal") {
    tick += 1
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run apps/roci/src/qa/markers.test.ts apps/roci/src/qa/feed.test.ts apps/roci/src/qa/ingest.test.ts`
Expected: PASS.

- [ ] **Step 6: Full verification across all projects**

Run: `pnpm vitest run`
Expected: all test files PASS.

Run: `pnpm build`
Expected: all 4 projects build.

- [ ] **Step 7: Commit**

```bash
git add apps/roci/src/qa/markers.ts apps/roci/src/qa/feed.ts apps/roci/src/qa/markers.test.ts apps/roci/src/qa/feed.test.ts apps/roci/src/qa/ingest.test.ts
git commit -m "refactor(qa): retire classifyEvent string shim; tick-count on appraisal behaviors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Live proof (post-Wave-2, manual — per proven-live discipline)

Not a code task. Before claiming done, run a real `vcarl`/spacemolt `roci start` (read the `roci-qa` `CALIBRATION.md` first — it holds prior-run root causes). From the resulting `players/vcarl/logs/events.jsonl`, confirm:
- a leading `behavior` `session_start` and a terminal `behavior` `session_end` with an inline `digest`;
- `provision` behaviors (container/embed_server/memory_cli/conscious_provider) with a `ready` status, not just failures;
- a `reflection` `promote` behavior carrying its count (including 0 on an empty-diary run);
- `tier_call` behaviors with `latencyMs`, and a non-null `digest.timings.firstForebrainMs` in `run-digest.json`;
- a clean stop vs a Ctrl-C stop produce distinguishable `session_end.reason` (`clean` vs `signal`) and `terminalCause`.

Regenerate the QA baseline if `run-digest.json`'s `counts`/`sequence` vocabulary changed (it now carries behavior-type keys from the authoritative `session_end` digest, not the legacy `TransitionType` fold).

---

## Self-Review (completed by the plan author)

**1. Spec coverage** — every design requirement maps to a task:
- Event model `kind:"behavior"` + `Behavior` union (machinery, cognition, note) → Task 1.
- No-drop rule (unclassifiable → note) → Task 5 (`default → NOTE`) + Task 15 (decision/steer/evaluate → note).
- Digest accumulator (counts / sequence / first-tier timings / terminal cause) on every emit → Task 2 + Task 3 (fold in `logBehavior`).
- Authoritative `session_end` snapshots the digest inline → Task 3 (`logSessionEnd`).
- `classifyEvent` `kind:"behavior"` branch + new `NOTE` transition → Task 5.
- Monitor reads `session_end` digest, fold as crash fallback → Task 7 (`finalizeDigest`, ingest surfacing) + Task 8 (wiring).
- Console rendering case → Task 4.
- Best-effort non-throwing emits → Task 3 (`catchAll`), Task 14 (`tapErrorCause` re-raise after emit).
- Idempotent `session_end` guard → Task 2 (`tryMarkEnded`) + Task 3 + Task 13.
- Wave 1 seams: session_start/provision (orchestrator) → Task 11; provision (embed) → Task 12; phase enter/exit → Task 9; reflection incl 0 → Task 10; session_end → Task 13.
- Wave 2: tier_call latency → Task 14; cognitive emit-site swaps → Task 15; retire shim + tick-count migration → Task 16.
- Interim shim stays through Wave 1 (feed/markers string tests untouched until Task 16) → Wave 1 acceptance gate explicitly checks this.

**2. Placeholder scan** — no "TBD"/"similar to Task N"/"add error handling"; every code step shows complete code.

**3. Type consistency** — `Behavior`/`BehaviorDigest` names are identical across Tasks 1-16; `logBehavior`/`logSessionEnd`/`recordBehavior`/`snapshotDigest`/`tryMarkEnded`/`consumeShutdownSignal`/`finalizeDigest`/`sessionEndReasonForExit`/`withSessionEnd`/`classifyTierOutcome` signatures are defined once and consumed unchanged. `firstForebrainMs`/`firstPlanMs` field names match `RunDigest`'s existing `timings` shape.

**Open items flagged for the reviewer** (also surfaced in the handoff): (a) `session_end` is emitted from the orchestrator's per-character `Effect.onExit`, not the literal main.ts signal handler (sync-handler constraint; main.ts only captures the signal name); (b) `run-digest.json` `counts`/`sequence` now use behavior-type keys (baseline regen needed); (c) `DEGRADED_TIER` becomes a vestigial dead branch after the shim is retired.
