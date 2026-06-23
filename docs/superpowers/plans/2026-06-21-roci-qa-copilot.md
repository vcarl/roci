# Roci QA Co-pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic `qa-monitor` subprocess that filters a Roci session's `events.jsonl` into a signal-only feed (phase transitions + a generic anomaly net) plus a regression fingerprint, and a `roci-qa` Claude Code skill that orchestrates the tag-team QA session.

**Architecture:** Pure, unit-tested parsing/reduction logic lives in `apps/roci/src/qa/` (classify events → transitions, reduce into feed records, ingest tailing chunks, fold a run digest, compare to a baseline). A thin plain-Node entrypoint (`monitor.ts`) tails the file, applies the pure logic, runs time/process-based liveness checks, and appends a `qa-feed.jsonl` while printing one-liners to stdout (the wake signal). The `roci-qa` skill is Claude's playbook for preflight → launch → narrate → human-handoff → calibration retro.

**Tech Stack:** TypeScript (ESM/NodeNext), vitest, plain Node (`node:fs/promises`) for the entrypoint, Biome for formatting. Pure logic is plain TS (no Effect). Reference spec: `docs/superpowers/specs/2026-06-21-roci-qa-copilot-design.md`.

## Global Constraints

- **Module system:** ESM with NodeNext resolution — all relative imports use the `.js` extension (e.g. `import { reduce } from "./feed.js"`), matching the existing codebase.
- **Event type source:** `UnifiedEvent` is defined at `packages/core/src/logging/events.ts`; import it **type-only** from `@roci/core` (`import type { UnifiedEvent } from "@roci/core"`) so there is no runtime build dependency.
- **Test framework:** vitest with `import { describe, it, expect } from "vitest"`. Tests are colocated as `*.test.ts`.
- **Pure logic stays pure:** no filesystem, timers, or `process` access in `types.ts` / `markers.ts` / `feed.ts` / `ingest.ts` / `render.ts` / `digest.ts` / `baseline.ts`. All I/O lives in `monitor.ts`.
- **Commit trailer:** every commit message ends with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Run a single test file:** `npx vitest --run apps/roci/src/qa/<file>.test.ts`
- **Run all tests:** `pnpm test`
- **Branch:** work on `roci-qa-copilot` (already created; the spec commit is its HEAD).

### Verbatim facts this plan depends on (from the codebase)

Marker strings emitted by `packages/core/src/cortex/loop.ts` via `logToConsole(name, source, message)`, which writes a `UnifiedEvent` of `kind: "system"` with that `message` to `players/<char>/logs/events.jsonl`:

- `` `hindbrain: ${disposition} ${emotionalWeight}` `` — disposition ∈ {`escalate`, `discard`, `continue`}; weight is an emoji/string
- `` `forebrain: ${headline}` ``
- `` `forebrain (in-session): ${headline}` ``
- `` `conscious: ${decision}` `` — decision ∈ {`plan`, `wait`, `terminate`}
- `` `conscious turn 1: ${task}` `` (step start)
- `` `conscious steer turn (session ${sessionId})` ``
- `step done-marker detected; evaluating` (exact, no interpolation)
- `` `step tick-budget elapsed (${consumed}/${budget}); salvage evaluate` ``
- `` `evaluate: ${judgment} → ${transition}` `` (note: literal Unicode arrow `→`)
- `` `Critical: ${messages}` ``

`UnifiedEvent` shape (discriminated union on `kind`), verbatim:

```typescript
export interface EventBase {
  timestamp: string
  character: string
  system: string
  subsystem: string
}
export type UnifiedEvent = EventBase & (
  | { kind: "system"; message: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; tool: string; id: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; text: string }
  | { kind: "subagent_start"; description: string; data: unknown }
  | { kind: "subagent_stop"; data: unknown }
  | { kind: "error"; message: string }
)
```

`events.jsonl` on disk = one `JSON.stringify(event)` per line (append mode). The `start` command does **not** write a separate `session.log`; `events.jsonl` is the structured record and the monitor's primary input.

---

## Layer 1 — usable co-pilot (Tasks 1–5)

### Task 1: vitest project, shared types, and the marker classifier

**Files:**
- Create: `apps/roci/vitest.config.ts`
- Create: `apps/roci/src/qa/types.ts`
- Create: `apps/roci/src/qa/markers.ts`
- Test: `apps/roci/src/qa/markers.test.ts`

**Interfaces:**
- Consumes: `UnifiedEvent` (type-only) from `@roci/core`.
- Produces:
  - `type TransitionType = "SESSION_START" | "ESCALATE" | "FOREBRAIN" | "DECISION" | "STEER" | "STEP_START" | "STEP_DONE" | "STEP_SALVAGE" | "EVALUATE" | "DELEGATION" | "CRITICAL" | "SESSION_END"`
  - `type AnomalyType = "PROCESS_DIED" | "STALL" | "ERROR"`
  - `type Severity = "info" | "warn" | "error"`
  - `interface FeedRecord { ts: string; kind: "transition" | "anomaly"; type: TransitionType | AnomalyType; severity: Severity; tick: number; summary: string; refs?: Record<string, string> }`
  - `interface Marker { type: TransitionType; summary: string; fields: Record<string, string> }`
  - `function classifyEvent(ev: UnifiedEvent): Marker | null`

- [ ] **Step 1: Create the vitest project config**

```typescript
// apps/roci/vitest.config.ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
})
```

- [ ] **Step 2: Create the shared types**

```typescript
// apps/roci/src/qa/types.ts
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

export type AnomalyType = "PROCESS_DIED" | "STALL" | "ERROR"

export type Severity = "info" | "warn" | "error"

export interface FeedRecord {
  ts: string
  kind: "transition" | "anomaly"
  type: TransitionType | AnomalyType
  severity: Severity
  tick: number
  summary: string
  refs?: Record<string, string>
}

export interface Marker {
  type: TransitionType
  summary: string
  fields: Record<string, string>
}
```

- [ ] **Step 3: Write the failing test**

```typescript
// apps/roci/src/qa/markers.test.ts
import { describe, it, expect } from "vitest"
import type { UnifiedEvent } from "@roci/core"
import { classifyEvent } from "./markers.js"

const sys = (message: string): UnifiedEvent => ({
  timestamp: "2026-06-21T00:00:00.000Z",
  character: "ada",
  system: "cortex",
  subsystem: "cortex",
  kind: "system",
  message,
})

describe("classifyEvent", () => {
  it("classifies an escalate hindbrain pass as ESCALATE", () => {
    const m = classifyEvent(sys("hindbrain: escalate 😰"))
    expect(m?.type).toBe("ESCALATE")
    expect(m?.fields.disposition).toBe("escalate")
  })

  it("returns null for discard/continue hindbrain passes (silent)", () => {
    expect(classifyEvent(sys("hindbrain: discard 😐"))).toBeNull()
    expect(classifyEvent(sys("hindbrain: continue 🙂"))).toBeNull()
  })

  it("distinguishes idle vs in-session forebrain", () => {
    expect(classifyEvent(sys("forebrain: hold position"))?.fields.inSession).toBe("false")
    expect(classifyEvent(sys("forebrain (in-session): re-route"))?.fields.inSession).toBe("true")
  })

  it("classifies conscious decision, step start, steer", () => {
    expect(classifyEvent(sys("conscious: plan"))?.type).toBe("DECISION")
    expect(classifyEvent(sys("conscious turn 1: scout the ridge"))?.type).toBe("STEP_START")
    expect(classifyEvent(sys("conscious steer turn (session ses_001)"))?.type).toBe("STEER")
  })

  it("classifies step done, salvage, evaluate, critical", () => {
    expect(classifyEvent(sys("step done-marker detected; evaluating"))?.type).toBe("STEP_DONE")
    expect(classifyEvent(sys("step tick-budget elapsed (5/3); salvage evaluate"))?.type).toBe("STEP_SALVAGE")
    expect(classifyEvent(sys("evaluate: succeeded → next_step"))?.type).toBe("EVALUATE")
    expect(classifyEvent(sys("Critical: hull breach"))?.type).toBe("CRITICAL")
  })

  it("best-effort DELEGATION from a frontier tool_use", () => {
    const ev: UnifiedEvent = {
      timestamp: "2026-06-21T00:00:00.000Z",
      character: "ada",
      system: "cortex",
      subsystem: "conscious",
      kind: "tool_use",
      tool: "bash",
      id: "t1",
      input: { command: "frontier start 'refactor the parser'" },
    }
    expect(classifyEvent(ev)?.type).toBe("DELEGATION")
  })

  it("returns null for unrelated events", () => {
    expect(classifyEvent(sys("forebrain unrelated chatter without colon"))).toBeNull()
    expect(classifyEvent({ ...sys("x"), kind: "thinking", text: "hmm" } as UnifiedEvent)).toBeNull()
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest --run apps/roci/src/qa/markers.test.ts`
Expected: FAIL — cannot find module `./markers.js`.

- [ ] **Step 5: Implement the classifier**

```typescript
// apps/roci/src/qa/markers.ts
import type { UnifiedEvent } from "@roci/core"
import type { Marker } from "./types.js"

export function classifyEvent(ev: UnifiedEvent): Marker | null {
  // Best-effort delegation detection: the conscious agent runs the in-container
  // `frontier` bash CLI as a tool. Sharpen this in the calibration retro.
  if (ev.kind === "tool_use") {
    const blob = JSON.stringify(ev.input ?? "")
    if (ev.tool === "frontier" || /frontier (start|poll|steer|wait)/.test(blob)) {
      return { type: "DELEGATION", summary: `delegation via ${ev.tool}`, fields: { tool: ev.tool } }
    }
    return null
  }

  if (ev.kind !== "system") return null
  const m = ev.message
  let g: RegExpMatchArray | null

  if ((g = m.match(/^hindbrain: (\S+) (.+)$/))) {
    if (g[1] === "escalate") {
      return { type: "ESCALATE", summary: `hindbrain escalate (${g[2]})`, fields: { disposition: g[1], weight: g[2] } }
    }
    return null
  }
  if ((g = m.match(/^forebrain \(in-session\): (.+)$/))) {
    return { type: "FOREBRAIN", summary: `forebrain (in-session): ${g[1]}`, fields: { headline: g[1], inSession: "true" } }
  }
  if ((g = m.match(/^forebrain: (.+)$/))) {
    return { type: "FOREBRAIN", summary: `forebrain: ${g[1]}`, fields: { headline: g[1], inSession: "false" } }
  }
  if ((g = m.match(/^conscious: (plan|wait|terminate)$/))) {
    return { type: "DECISION", summary: `conscious decision: ${g[1]}`, fields: { decision: g[1] } }
  }
  if ((g = m.match(/^conscious turn 1: (.+)$/))) {
    return { type: "STEP_START", summary: `step start: ${g[1]}`, fields: { task: g[1] } }
  }
  if ((g = m.match(/^conscious steer turn \(session (.+)\)$/))) {
    return { type: "STEER", summary: `steer turn (session ${g[1]})`, fields: { sessionId: g[1] } }
  }
  if (m === "step done-marker detected; evaluating") {
    return { type: "STEP_DONE", summary: "step done-marker detected", fields: {} }
  }
  if ((g = m.match(/^step tick-budget elapsed \((\d+)\/(\d+)\); salvage evaluate$/))) {
    return { type: "STEP_SALVAGE", summary: `step salvage (${g[1]}/${g[2]} ticks)`, fields: { consumed: g[1], budget: g[2] } }
  }
  if ((g = m.match(/^evaluate: (\S+) → (\S+)$/))) {
    return { type: "EVALUATE", summary: `evaluate: ${g[1]} → ${g[2]}`, fields: { judgment: g[1], transition: g[2] } }
  }
  if ((g = m.match(/^Critical: (.+)$/))) {
    return { type: "CRITICAL", summary: `critical: ${g[1]}`, fields: { message: g[1] } }
  }
  return null
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest --run apps/roci/src/qa/markers.test.ts`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
git add apps/roci/vitest.config.ts apps/roci/src/qa/types.ts apps/roci/src/qa/markers.ts apps/roci/src/qa/markers.test.ts
git commit -m "feat(qa): event marker classifier for the QA monitor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Feed reducer (transitions + tick counting + ERROR anomaly)

**Files:**
- Create: `apps/roci/src/qa/feed.ts`
- Test: `apps/roci/src/qa/feed.test.ts`

**Interfaces:**
- Consumes: `classifyEvent` (Task 1); `FeedRecord`, `Severity` (Task 1); `UnifiedEvent` (type-only).
- Produces:
  - `interface ReducerState { tick: number; started: boolean }`
  - `const initialState: ReducerState`
  - `function reduce(state: ReducerState, ev: UnifiedEvent): { state: ReducerState; records: FeedRecord[] }`

Behavior: the first event ever emits a synthetic `SESSION_START`. Each `hindbrain:` system event increments `tick` (a hindbrain pass = a new cortex tick). `kind: "error"` events emit an `ERROR` anomaly. Otherwise, `classifyEvent` markers become transition records stamped with the current tick.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/roci/src/qa/feed.test.ts
import { describe, it, expect } from "vitest"
import type { UnifiedEvent } from "@roci/core"
import { initialState, reduce } from "./feed.js"

const ev = (over: Partial<UnifiedEvent> & Pick<UnifiedEvent, "kind">): UnifiedEvent =>
  ({ timestamp: "2026-06-21T00:00:00.000Z", character: "ada", system: "cortex", subsystem: "cortex", ...over } as UnifiedEvent)

const run = (events: UnifiedEvent[]) => {
  let s = initialState
  const all = []
  for (const e of events) {
    const out = reduce(s, e)
    s = out.state
    all.push(...out.records)
  }
  return { state: s, records: all }
}

describe("reduce", () => {
  it("emits SESSION_START on the very first event", () => {
    const { records } = run([ev({ kind: "system", message: "hindbrain: discard 😐" })])
    expect(records[0].type).toBe("SESSION_START")
  })

  it("counts a tick per hindbrain pass and stamps transitions with it", () => {
    const { state, records } = run([
      ev({ kind: "system", message: "hindbrain: escalate 😰" }),
      ev({ kind: "system", message: "forebrain: regroup" }),
      ev({ kind: "system", message: "hindbrain: continue 🙂" }),
    ])
    expect(state.tick).toBe(2)
    const escalate = records.find((r) => r.type === "ESCALATE")
    expect(escalate?.tick).toBe(1)
    const forebrain = records.find((r) => r.type === "FOREBRAIN")
    expect(forebrain?.tick).toBe(1)
  })

  it("emits an ERROR anomaly for kind:error events", () => {
    const { records } = run([
      ev({ kind: "system", message: "hindbrain: discard 😐" }),
      ev({ kind: "error", message: "event error: boom" } as Partial<UnifiedEvent> & { kind: "error" }),
    ])
    const err = records.find((r) => r.kind === "anomaly")
    expect(err?.type).toBe("ERROR")
    expect(err?.severity).toBe("error")
    expect(err?.summary).toContain("boom")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --run apps/roci/src/qa/feed.test.ts`
Expected: FAIL — cannot find module `./feed.js`.

- [ ] **Step 3: Implement the reducer**

```typescript
// apps/roci/src/qa/feed.ts
import type { UnifiedEvent } from "@roci/core"
import type { FeedRecord, Severity } from "./types.js"
import { classifyEvent } from "./markers.js"

export interface ReducerState {
  tick: number
  started: boolean
}

export const initialState: ReducerState = { tick: 0, started: false }

const severityFor = (type: string): Severity => (type === "CRITICAL" ? "warn" : "info")

export function reduce(
  state: ReducerState,
  ev: UnifiedEvent,
): { state: ReducerState; records: FeedRecord[] } {
  const records: FeedRecord[] = []
  let { tick, started } = state

  if (!started) {
    started = true
    records.push({
      ts: ev.timestamp,
      kind: "transition",
      type: "SESSION_START",
      severity: "info",
      tick,
      summary: `session start (${ev.character})`,
    })
  }

  if (ev.kind === "system" && /^hindbrain: /.test(ev.message)) {
    tick += 1
  }

  if (ev.kind === "error") {
    records.push({
      ts: ev.timestamp,
      kind: "anomaly",
      type: "ERROR",
      severity: "error",
      tick,
      summary: `error: ${ev.message}`,
    })
    return { state: { tick, started }, records }
  }

  const marker = classifyEvent(ev)
  if (marker) {
    records.push({
      ts: ev.timestamp,
      kind: "transition",
      type: marker.type,
      severity: severityFor(marker.type),
      tick,
      summary: marker.summary,
      refs: Object.keys(marker.fields).length ? marker.fields : undefined,
    })
  }

  return { state: { tick, started }, records }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --run apps/roci/src/qa/feed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/roci/src/qa/feed.ts apps/roci/src/qa/feed.test.ts
git commit -m "feat(qa): feed reducer with tick counting and error anomalies

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Chunk ingest (tail-safe line splitting) + feed-line renderer

**Files:**
- Create: `apps/roci/src/qa/ingest.ts`
- Test: `apps/roci/src/qa/ingest.test.ts`
- Create: `apps/roci/src/qa/render.ts`
- Test: `apps/roci/src/qa/render.test.ts`

**Interfaces:**
- Consumes: `reduce`, `initialState`, `ReducerState` (Task 2); `FeedRecord` (Task 1).
- Produces:
  - `interface IngestState { reducer: ReducerState; remainder: string }`
  - `const initialIngestState: IngestState`
  - `function ingestChunk(state: IngestState, chunk: string): { state: IngestState; records: FeedRecord[] }`
  - `function renderFeedLine(r: FeedRecord): string`

`ingestChunk` buffers a partial trailing line (`remainder`) so a record split across two reads is not lost, and skips blank/malformed lines.

- [ ] **Step 1: Write the failing ingest test**

```typescript
// apps/roci/src/qa/ingest.test.ts
import { describe, it, expect } from "vitest"
import { ingestChunk, initialIngestState } from "./ingest.js"

const line = (message: string) =>
  JSON.stringify({ timestamp: "2026-06-21T00:00:00.000Z", character: "ada", system: "cortex", subsystem: "cortex", kind: "system", message })

describe("ingestChunk", () => {
  it("parses whole lines and ignores blanks", () => {
    const { records } = ingestChunk(initialIngestState, line("hindbrain: escalate 😰") + "\n\n")
    expect(records.map((r) => r.type)).toEqual(["SESSION_START", "ESCALATE"])
  })

  it("buffers a partial line across two chunks", () => {
    const full = line("forebrain: hold")
    const a = ingestChunk(initialIngestState, full.slice(0, 10))
    expect(a.records).toEqual([])
    const b = ingestChunk(a.state, full.slice(10) + "\n")
    expect(b.records.some((r) => r.type === "FOREBRAIN")).toBe(true)
  })

  it("skips malformed JSON lines without throwing", () => {
    const { records } = ingestChunk(initialIngestState, "not json\n" + line("conscious: plan") + "\n")
    expect(records.some((r) => r.type === "DECISION")).toBe(true)
  })
})
```

- [ ] **Step 2: Run the ingest test to verify it fails**

Run: `npx vitest --run apps/roci/src/qa/ingest.test.ts`
Expected: FAIL — cannot find module `./ingest.js`.

- [ ] **Step 3: Implement ingest**

```typescript
// apps/roci/src/qa/ingest.ts
import type { UnifiedEvent } from "@roci/core"
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
): { state: IngestState; records: FeedRecord[] } {
  const text = state.remainder + chunk
  const parts = text.split("\n")
  const remainder = parts.pop() ?? ""
  let reducer = state.reducer
  const records: FeedRecord[] = []
  for (const lineStr of parts) {
    if (lineStr.trim() === "") continue
    let ev: UnifiedEvent
    try {
      ev = JSON.parse(lineStr) as UnifiedEvent
    } catch {
      continue
    }
    const out = reduce(reducer, ev)
    reducer = out.state
    records.push(...out.records)
  }
  return { state: { reducer, remainder }, records }
}
```

- [ ] **Step 4: Run the ingest test to verify it passes**

Run: `npx vitest --run apps/roci/src/qa/ingest.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing renderer test**

```typescript
// apps/roci/src/qa/render.test.ts
import { describe, it, expect } from "vitest"
import type { FeedRecord } from "./types.js"
import { renderFeedLine } from "./render.js"

const rec = (over: Partial<FeedRecord>): FeedRecord =>
  ({ ts: "2026-06-21T00:00:00.000Z", kind: "transition", type: "FOREBRAIN", severity: "info", tick: 3, summary: "forebrain: hold", ...over } as FeedRecord)

describe("renderFeedLine", () => {
  it("renders a transition with a bullet and tick", () => {
    expect(renderFeedLine(rec({}))).toBe("• [t3] FOREBRAIN: forebrain: hold")
  })
  it("renders an anomaly with a warning glyph", () => {
    const out = renderFeedLine(rec({ kind: "anomaly", type: "STALL", severity: "warn", summary: "stall — no event in 70s" }))
    expect(out).toBe("⚠ [t3] STALL: stall — no event in 70s")
  })
})
```

- [ ] **Step 6: Run the renderer test to verify it fails**

Run: `npx vitest --run apps/roci/src/qa/render.test.ts`
Expected: FAIL — cannot find module `./render.js`.

- [ ] **Step 7: Implement the renderer**

```typescript
// apps/roci/src/qa/render.ts
import type { FeedRecord } from "./types.js"

export function renderFeedLine(r: FeedRecord): string {
  const glyph = r.kind === "anomaly" ? "⚠" : "•"
  return `${glyph} [t${r.tick}] ${r.type}: ${r.summary}`
}
```

- [ ] **Step 8: Run both Task-3 tests to verify they pass**

Run: `npx vitest --run apps/roci/src/qa/ingest.test.ts apps/roci/src/qa/render.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/roci/src/qa/ingest.ts apps/roci/src/qa/ingest.test.ts apps/roci/src/qa/render.ts apps/roci/src/qa/render.test.ts
git commit -m "feat(qa): tail-safe chunk ingest and feed-line renderer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Monitor entrypoint (tail loop + liveness watchdog)

**Files:**
- Create: `apps/roci/src/qa/monitor.ts`
- Modify: `apps/roci/package.json` (add a `qa-monitor` script)

**Interfaces:**
- Consumes: `ingestChunk`, `initialIngestState`, `IngestState` (Task 3); `renderFeedLine` (Task 3).
- Produces: a runnable CLI. No exports consumed by later tasks except via Task 8, which edits this file.

This task is verified by a manual smoke run, not a unit test (it is pure I/O + timers).

- [ ] **Step 1: Implement the entrypoint**

```typescript
// apps/roci/src/qa/monitor.ts
import { appendFile, open } from "node:fs/promises"
import process from "node:process"
import { type IngestState, ingestChunk, initialIngestState } from "./ingest.js"
import { renderFeedLine } from "./render.js"
import type { AnomalyType, FeedRecord, Severity } from "./types.js"

interface Args {
  events: string
  feed: string
  tickIntervalMs: number
  stallMultiple: number
  pollMs: number
  sessionPid: number | null
}

function parseArgs(raw: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = raw.indexOf(`--${name}`)
    return i >= 0 ? raw[i + 1] : undefined
  }
  const events = get("events")
  if (!events) {
    console.error(
      "usage: monitor --events <events.jsonl> [--feed <feed.jsonl>] [--tick-interval-ms N] [--stall-multiple N] [--poll-ms N] [--session-pid N]",
    )
    process.exit(2)
  }
  return {
    events,
    feed: get("feed") ?? events.replace(/events\.jsonl$/, "qa-feed.jsonl"),
    tickIntervalMs: Number(get("tick-interval-ms") ?? 30000),
    stallMultiple: Number(get("stall-multiple") ?? 2),
    pollMs: Number(get("poll-ms") ?? 1000),
    sessionPid: get("session-pid") ? Number(get("session-pid")) : null,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  let ingest: IngestState = initialIngestState
  let offset = 0
  let lastActivity = Date.now()
  let stalled = false
  let ended = false

  const write = async (r: FeedRecord): Promise<void> => {
    console.log(renderFeedLine(r))
    await appendFile(args.feed, `${JSON.stringify(r)}\n`)
  }

  const anomaly = (type: AnomalyType, severity: Severity, summary: string): FeedRecord => ({
    ts: new Date().toISOString(),
    kind: "anomaly",
    type,
    severity,
    tick: ingest.reducer.tick,
    summary,
  })

  const poll = async (): Promise<void> => {
    try {
      const fh = await open(args.events, "r")
      try {
        const { size } = await fh.stat()
        if (size > offset) {
          const buf = Buffer.alloc(size - offset)
          await fh.read(buf, 0, buf.length, offset)
          offset = size
          const out = ingestChunk(ingest, buf.toString("utf8"))
          ingest = out.state
          if (out.records.length > 0) {
            lastActivity = Date.now()
            stalled = false
            for (const r of out.records) await write(r)
          }
        }
      } finally {
        await fh.close()
      }
    } catch (e: unknown) {
      if ((e as { code?: string }).code !== "ENOENT") {
        console.error(`monitor read error: ${String(e)}`)
      }
    }
  }

  const checkStall = async (): Promise<void> => {
    if (ended || stalled) return
    const idleMs = Date.now() - lastActivity
    if (idleMs > args.stallMultiple * args.tickIntervalMs) {
      stalled = true
      await write(anomaly("STALL", "warn", `stall — no event in ${Math.round(idleMs / 1000)}s`))
    }
  }

  const checkProcess = async (): Promise<void> => {
    if (ended || args.sessionPid === null) return
    try {
      process.kill(args.sessionPid, 0) // signal 0 = liveness probe; throws if gone
    } catch {
      ended = true
      await write(anomaly("PROCESS_DIED", "error", `session process ${args.sessionPid} exited`))
    }
  }

  setInterval(() => void poll(), args.pollMs)
  setInterval(() => void checkStall(), args.pollMs)
  setInterval(() => void checkProcess(), args.pollMs)
  await poll()
}

void main()
```

- [ ] **Step 2: Add the run script to `apps/roci/package.json`**

In the `"scripts"` block (currently containing `build`, `pack`, `typecheck`, `start`, `roci`), add:

```json
    "qa-monitor": "tsx src/qa/monitor.ts"
```

- [ ] **Step 3: Typecheck the new code**

Run: `npx nx run roci:typecheck` (or `cd apps/roci && npx tsc --noEmit`)
Expected: no errors.

- [ ] **Step 4: Smoke-test against a synthetic event stream**

Create a scratch file and append lines while the monitor watches:

```bash
mkdir -p /tmp/qa-smoke
: > /tmp/qa-smoke/events.jsonl
: > /tmp/qa-smoke/qa-feed.jsonl
npx tsx apps/roci/src/qa/monitor.ts --events /tmp/qa-smoke/events.jsonl --tick-interval-ms 2000 --poll-ms 300 &
MON=$!
sleep 1
printf '%s\n' '{"timestamp":"2026-06-21T00:00:00.000Z","character":"ada","system":"cortex","subsystem":"cortex","kind":"system","message":"hindbrain: escalate 😰"}' >> /tmp/qa-smoke/events.jsonl
printf '%s\n' '{"timestamp":"2026-06-21T00:00:01.000Z","character":"ada","system":"cortex","subsystem":"cortex","kind":"system","message":"forebrain: regroup"}' >> /tmp/qa-smoke/events.jsonl
sleep 6   # exceeds 2 * 2000ms with no new events -> STALL
kill $MON
cat /tmp/qa-smoke/qa-feed.jsonl
```

Expected stdout from the monitor includes `• [t0] SESSION_START`, `• [t1] ESCALATE`, `• [t1] FOREBRAIN`, then `⚠ [t1] STALL: stall — no event in …s`. `qa-feed.jsonl` contains those records as JSON lines.

- [ ] **Step 5: Commit**

```bash
git add apps/roci/src/qa/monitor.ts apps/roci/package.json
git commit -m "feat(qa): qa-monitor entrypoint with tail loop and liveness watchdog

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The `roci-qa` skill (playbook + calibration log)

**Files:**
- Create: `.claude/skills/roci-qa/SKILL.md`
- Create: `.claude/skills/roci-qa/CALIBRATION.md`

**Interfaces:**
- Consumes: the `qa-monitor` script and its flags (Task 4).
- Produces: a Claude Code skill Claude invokes to run a tag-team QA session. No code consumers.

This task has no unit test; verification is a structural read-through (Step 3).

- [ ] **Step 1: Write the skill playbook**

````markdown
<!-- .claude/skills/roci-qa/SKILL.md -->
---
name: roci-qa
description: Use when running a tag-team live QA session on a Roci character session — launches the session under the qa-monitor, narrates phase-transitions and anomalies, hands off human-only steps, and runs a calibration retro. Reference for monitoring the cortex loop end-to-end.
---

# Roci QA Co-pilot

You are the automated half of a tag-team QA session. You run everything scriptable and
monitor all log signal; the human takes only the irreducibly-manual steps. Narrate
**phase-transitions and anomalies only** — stay quiet through routine same-state ticks.

Design reference: `docs/superpowers/specs/2026-06-21-roci-qa-copilot-design.md`.

## 1. Preflight (you act)

- `docker ps` — confirm the daemon is up and note any existing `roci-*` containers.
- Health-check the three local model servers: `curl -s http://127.0.0.1:8081/v1/models`,
  `:8082`, `:8083`. Any non-200 / connection refused → **ACTION NEEDED** (the human starts it).
- Ensure the build is current: `pnpm build` (nx is cached, so this is fast).
- Run the tier connectivity smoke per the runbook in `docs/cortex-smoke.md` (step 1) if servers
  are reachable.
- If anything fails, emit an ACTION NEEDED block (format below) and wait.

## 2. Launch (you act)

Pick `<char>`, `<domain>`, and `<tick-interval-ms>` with the human. Then, in the background:

```bash
npx tsx apps/roci/src/main.ts start <char> --domain <domain> --tick-interval <ms> 2>&1 | tee players/<char>/logs/session.log &
```

Capture the session PID. Start the monitor in the background pointed at the character's
events file:

```bash
npx tsx apps/roci/src/qa/monitor.ts \
  --events players/<char>/logs/events.jsonl \
  --tick-interval-ms <ms> --session-pid <pid>
```

The monitor's stdout one-liners are your **wake signal**; `players/<char>/logs/qa-feed.jsonl`
is the durable record you read deltas from.

## 3. Monitor loop

- On a `transition` line, narrate the beat in one short sentence.
- On an `anomaly` line (`STALL` / `PROCESS_DIED` / `ERROR`), stop and raise it via ACTION
  NEEDED with your read of the cause and the exact fix command.
- Self-schedule a slow fallback check (~2× tick-interval) as a dead-man's-switch in case the
  monitor itself goes silent.

## 4. Behaviour-quality checkpoints

On a `DECISION` beat, on `SESSION_END`, or when the human asks, surface the artifacts for the
human's judgment (you present, they grade):

- the conscious prompt vs. the raw inbound event (laundering check — no raw event text should
  appear verbatim in the prompt),
- the decision + plan,
- the diary delta (`players/<char>/me/DIARY.md`).

## 5. Human-handoff protocol

Whenever you need the human, emit exactly this block so it is never buried in narration:

```
⚠ ACTION NEEDED
  What:    <the action>
  Why:     <the signal that prompted it>
  Command: <exact command, or "none — manual">
  After:   <what you will confirm once they are done>
```

Handoff categories: start/restart a model server; trigger a domain critical event; judge a
surfaced artifact; decide continue/stop.

## 6. Wind-down

When the session ends (`PROCESS_DIED`, or the human stops it), summarise the run from
`qa-feed.jsonl`. (Layer 2 adds: finalise the run digest and, if a baseline exists, report drift.)

## 7. Calibration retro (the dogfood loop)

Always run a short retro and append the outcome to `.claude/skills/roci-qa/CALIBRATION.md`.
Ask the human three questions and turn each answer into a concrete change:

- **Misses** — "what did you notice that the monitor didn't flag?" → candidate new named
  anomaly detector in `apps/roci/src/qa/` (this is how the anomaly vocabulary grows).
- **False positives / chattiness** — "what fired or got narrated that was noise?" → threshold
  tweak or promote/demote a narrated beat.
- **Blind spots in the record** — "what did we wish the digest had captured?" → new fingerprint
  field.

Record each as an entry. Treat resulting code changes with normal discipline (TDD new
detectors, review before merge).
````

- [ ] **Step 2: Seed the calibration log**

```markdown
<!-- .claude/skills/roci-qa/CALIBRATION.md -->
# roci-qa calibration log

Each QA session appends one dated entry: observations → decided changes → applied/queued.
New named anomaly detectors and threshold changes are born here (the dogfood loop).

<!-- template:
## YYYY-MM-DD — <char>/<domain>

**Observations:** ...
**Misses → new detector:** ...
**False positives → threshold/narration change:** ...
**Digest blind spots → new field:** ...
**Status:** applied | queued
-->
```

- [ ] **Step 3: Verify structure**

Run: `ls .claude/skills/roci-qa/ && head -5 .claude/skills/roci-qa/SKILL.md`
Expected: both files present; SKILL.md frontmatter has `name: roci-qa` and a `description:`.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/roci-qa/SKILL.md .claude/skills/roci-qa/CALIBRATION.md
git commit -m "feat(qa): roci-qa skill playbook and calibration log

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Layer 2 — regression (Tasks 6–8)

### Task 6: Run-digest fingerprint accumulator

**Files:**
- Create: `apps/roci/src/qa/digest.ts`
- Test: `apps/roci/src/qa/digest.test.ts`

**Interfaces:**
- Consumes: `FeedRecord`, `TransitionType` (Task 1).
- Produces:
  - `interface RunDigest { env: { character: string; domain: string; tickIntervalMs: number; gitSha: string }; counts: Record<string, number>; sequence: TransitionType[]; timings: { firstForebrainMs: number | null; firstPlanMs: number | null }; startTs: string | null }`
  - `function emptyDigest(env: RunDigest["env"]): RunDigest`
  - `function foldDigest(d: RunDigest, r: FeedRecord): RunDigest`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/roci/src/qa/digest.test.ts
import { describe, it, expect } from "vitest"
import type { FeedRecord } from "./types.js"
import { emptyDigest, foldDigest } from "./digest.js"

const env = { character: "ada", domain: "spacemolt", tickIntervalMs: 30000, gitSha: "abc1234" }
const rec = (over: Partial<FeedRecord>): FeedRecord =>
  ({ ts: "2026-06-21T00:00:00.000Z", kind: "transition", type: "SESSION_START", severity: "info", tick: 0, summary: "", ...over } as FeedRecord)

const fold = (recs: FeedRecord[]) => recs.reduce(foldDigest, emptyDigest(env))

describe("foldDigest", () => {
  it("counts records by type and records the transition sequence", () => {
    const d = fold([
      rec({ type: "SESSION_START" }),
      rec({ type: "ESCALATE" }),
      rec({ type: "FOREBRAIN" }),
    ])
    expect(d.counts.ESCALATE).toBe(1)
    expect(d.sequence).toEqual(["SESSION_START", "ESCALATE", "FOREBRAIN"])
  })

  it("captures time-to-first-forebrain and first-plan from SESSION_START", () => {
    const d = fold([
      rec({ type: "SESSION_START", ts: "2026-06-21T00:00:00.000Z" }),
      rec({ type: "FOREBRAIN", ts: "2026-06-21T00:00:02.000Z" }),
      rec({ type: "DECISION", summary: "conscious decision: plan", ts: "2026-06-21T00:00:05.000Z" }),
    ])
    expect(d.timings.firstForebrainMs).toBe(2000)
    expect(d.timings.firstPlanMs).toBe(5000)
  })

  it("does not add anomalies to the transition sequence", () => {
    const d = fold([rec({ type: "SESSION_START" }), rec({ kind: "anomaly", type: "ERROR" })])
    expect(d.sequence).toEqual(["SESSION_START"])
    expect(d.counts.ERROR).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --run apps/roci/src/qa/digest.test.ts`
Expected: FAIL — cannot find module `./digest.js`.

- [ ] **Step 3: Implement the digest**

```typescript
// apps/roci/src/qa/digest.ts
import type { FeedRecord, TransitionType } from "./types.js"

export interface RunDigest {
  env: { character: string; domain: string; tickIntervalMs: number; gitSha: string }
  counts: Record<string, number>
  sequence: TransitionType[]
  timings: { firstForebrainMs: number | null; firstPlanMs: number | null }
  startTs: string | null
}

export function emptyDigest(env: RunDigest["env"]): RunDigest {
  return {
    env,
    counts: {},
    sequence: [],
    timings: { firstForebrainMs: null, firstPlanMs: null },
    startTs: null,
  }
}

export function foldDigest(d: RunDigest, r: FeedRecord): RunDigest {
  const counts = { ...d.counts, [r.type]: (d.counts[r.type] ?? 0) + 1 }
  const sequence =
    r.kind === "transition" ? [...d.sequence, r.type as TransitionType] : d.sequence
  const startTs = d.startTs ?? (r.type === "SESSION_START" ? r.ts : null)
  const sinceStart = startTs ? Date.parse(r.ts) - Date.parse(startTs) : null
  const timings = { ...d.timings }
  if (timings.firstForebrainMs === null && r.type === "FOREBRAIN") {
    timings.firstForebrainMs = sinceStart
  }
  if (timings.firstPlanMs === null && r.type === "DECISION" && r.summary.includes("plan")) {
    timings.firstPlanMs = sinceStart
  }
  return { ...d, counts, sequence, timings, startTs }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --run apps/roci/src/qa/digest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/roci/src/qa/digest.ts apps/roci/src/qa/digest.test.ts
git commit -m "feat(qa): run-digest fingerprint accumulator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Baseline compare

**Files:**
- Create: `apps/roci/src/qa/baseline.ts`
- Test: `apps/roci/src/qa/baseline.test.ts`

**Interfaces:**
- Consumes: `RunDigest` (Task 6).
- Produces:
  - `interface Drift { field: string; baseline: number; run: number; note: string }`
  - `interface DriftReport { drifts: Drift[]; ok: boolean }`
  - `function compareBaseline(run: RunDigest, baseline: RunDigest, countTolerance?: number): DriftReport`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/roci/src/qa/baseline.test.ts
import { describe, it, expect } from "vitest"
import type { RunDigest } from "./digest.js"
import { compareBaseline } from "./baseline.js"

const digest = (counts: Record<string, number>): RunDigest => ({
  env: { character: "ada", domain: "spacemolt", tickIntervalMs: 30000, gitSha: "x" },
  counts,
  sequence: [],
  timings: { firstForebrainMs: null, firstPlanMs: null },
  startTs: null,
})

describe("compareBaseline", () => {
  it("reports ok when counts match within tolerance", () => {
    const r = compareBaseline(digest({ FOREBRAIN: 3 }), digest({ FOREBRAIN: 3 }))
    expect(r.ok).toBe(true)
    expect(r.drifts).toEqual([])
  })

  it("flags a missing event class as drift", () => {
    const r = compareBaseline(digest({ DELEGATION: 0 }), digest({ DELEGATION: 2 }))
    expect(r.ok).toBe(false)
    expect(r.drifts[0]).toMatchObject({ field: "count.DELEGATION", baseline: 2, run: 0, note: "missing vs baseline" })
  })

  it("flags a new event class not in the baseline", () => {
    const r = compareBaseline(digest({ CRITICAL: 1 }), digest({}))
    expect(r.drifts[0]).toMatchObject({ field: "count.CRITICAL", note: "new event class" })
  })

  it("respects countTolerance", () => {
    expect(compareBaseline(digest({ ESCALATE: 5 }), digest({ ESCALATE: 6 }), 1).ok).toBe(true)
    expect(compareBaseline(digest({ ESCALATE: 5 }), digest({ ESCALATE: 8 }), 1).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --run apps/roci/src/qa/baseline.test.ts`
Expected: FAIL — cannot find module `./baseline.js`.

- [ ] **Step 3: Implement the compare**

```typescript
// apps/roci/src/qa/baseline.ts
import type { RunDigest } from "./digest.js"

export interface Drift {
  field: string
  baseline: number
  run: number
  note: string
}

export interface DriftReport {
  drifts: Drift[]
  ok: boolean
}

export function compareBaseline(
  run: RunDigest,
  baseline: RunDigest,
  countTolerance = 0,
): DriftReport {
  const drifts: Drift[] = []
  const types = new Set([...Object.keys(baseline.counts), ...Object.keys(run.counts)])
  for (const t of [...types].sort()) {
    const b = baseline.counts[t] ?? 0
    const r = run.counts[t] ?? 0
    if (Math.abs(b - r) > countTolerance) {
      const note = b === 0 ? "new event class" : r === 0 ? "missing vs baseline" : "count delta"
      drifts.push({ field: `count.${t}`, baseline: b, run: r, note })
    }
  }
  return { drifts, ok: drifts.length === 0 }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --run apps/roci/src/qa/baseline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/roci/src/qa/baseline.ts apps/roci/src/qa/baseline.test.ts
git commit -m "feat(qa): baseline drift comparison

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Wire digest + baseline into the monitor and skill

**Files:**
- Modify: `apps/roci/src/qa/monitor.ts`
- Modify: `.claude/skills/roci-qa/SKILL.md` (wind-down section)

**Interfaces:**
- Consumes: `emptyDigest`, `foldDigest`, `RunDigest` (Task 6); `compareBaseline` (Task 7).
- Produces: monitor writes `run-digest.json` on exit and prints a drift report when `--baseline` is given.

- [ ] **Step 1: Add digest/baseline flags and folding to the monitor**

In `apps/roci/src/qa/monitor.ts`, add imports under the existing ones:

```typescript
import { readFile, writeFile } from "node:fs/promises"
import { emptyDigest, foldDigest, type RunDigest } from "./digest.js"
import { compareBaseline } from "./baseline.js"
```

Extend `Args` with three fields:

```typescript
  digestOut: string | null
  baseline: string | null
  env: RunDigest["env"]
```

In `parseArgs`, before the `return`, build the env and read the new flags:

```typescript
  const character = get("char") ?? "unknown"
  const domain = get("domain") ?? "unknown"
  const env: RunDigest["env"] = {
    character,
    domain,
    tickIntervalMs: Number(get("tick-interval-ms") ?? 30000),
    gitSha: get("git-sha") ?? "unknown",
  }
```

and add to the returned object:

```typescript
    digestOut: get("digest-out") ?? events.replace(/events\.jsonl$/, "run-digest.json"),
    baseline: get("baseline") ?? null,
    env,
```

In `main`, initialise the digest after `let ingest`:

```typescript
  let digest = emptyDigest(args.env)
```

In the `poll` function, fold every emitted record (inside the `for (const r of out.records)` loop, alongside `await write(r)`):

```typescript
            digest = foldDigest(digest, r)
```

Add a finaliser that writes the digest and (optionally) prints drift, and call it on the session-ended path and on `SIGINT`. Replace the `checkProcess` "ended" branch body and add a handler:

```typescript
  const finalise = async (): Promise<void> => {
    await writeFile(args.digestOut, `${JSON.stringify(digest, null, 2)}\n`)
    console.log(`run-digest written to ${args.digestOut}`)
    if (args.baseline) {
      try {
        const base = JSON.parse(await readFile(args.baseline, "utf8")) as RunDigest
        const report = compareBaseline(digest, base)
        console.log(
          report.ok
            ? "baseline drift: none"
            : `baseline drift:\n${report.drifts.map((d) => `  ${d.field}: base=${d.baseline} run=${d.run} (${d.note})`).join("\n")}`,
        )
      } catch (e) {
        console.error(`baseline compare failed: ${String(e)}`)
      }
    }
  }

  process.on("SIGINT", () => {
    void finalise().then(() => process.exit(0))
  })
```

In `checkProcess`, after writing the `PROCESS_DIED` anomaly, call `await finalise()`.

- [ ] **Step 2: Typecheck**

Run: `npx nx run roci:typecheck`
Expected: no errors.

- [ ] **Step 3: Smoke-test digest + baseline**

```bash
mkdir -p /tmp/qa-smoke2
: > /tmp/qa-smoke2/events.jsonl
npx tsx apps/roci/src/qa/monitor.ts --events /tmp/qa-smoke2/events.jsonl --char ada --domain spacemolt --tick-interval-ms 60000 --poll-ms 300 &
MON=$!
sleep 1
printf '%s\n' '{"timestamp":"2026-06-21T00:00:00.000Z","character":"ada","system":"cortex","subsystem":"cortex","kind":"system","message":"hindbrain: escalate 😰"}' >> /tmp/qa-smoke2/events.jsonl
printf '%s\n' '{"timestamp":"2026-06-21T00:00:01.000Z","character":"ada","system":"cortex","subsystem":"cortex","kind":"system","message":"conscious: plan"}' >> /tmp/qa-smoke2/events.jsonl
sleep 2
kill -INT $MON
sleep 1
cat /tmp/qa-smoke2/run-digest.json
```

Expected: `run-digest.json` exists with `counts` including `ESCALATE: 1` and `DECISION: 1`, a `sequence` array, and `env.character` = `ada`. Re-running with `--baseline /tmp/qa-smoke2/run-digest.json` against an identical stream prints `baseline drift: none`.

- [ ] **Step 4: Update the skill wind-down section**

In `.claude/skills/roci-qa/SKILL.md`, replace the Layer-1 wind-down parenthetical with the real instruction:

```markdown
## 6. Wind-down

When the session ends, the monitor writes `players/<char>/logs/run-digest.json` and (if you
launched it with `--baseline players/<char>/qa/baselines/<name>.json`) prints a drift report.
Relay the drift report. If the run was good and you want it as a new reference, copy the digest:
`cp players/<char>/logs/run-digest.json players/<char>/qa/baselines/<name>.json`.
```

Also update the launch command in section 2 to pass `--char <char> --domain <domain>` (and optionally `--baseline ...`) to the monitor.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm test`
Expected: all QA tests pass alongside the existing suite.

- [ ] **Step 6: Commit**

```bash
git add apps/roci/src/qa/monitor.ts .claude/skills/roci-qa/SKILL.md
git commit -m "feat(qa): wire run-digest and baseline drift into monitor + skill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review (coverage against the spec)

- **Live-session co-pilot engine** → Tasks 4 (monitor) + 5 (skill). ✓
- **Phase-transition + anomaly-only interaction** → `classifyEvent` narrates beats; `reduce` + monitor emit only on transitions/anomalies; skill §3. ✓
- **Two artifacts (subprocess + skill), no MCP** → `monitor.ts` is plain Node; `roci-qa` is a skill. ✓
- **Event-driven, signal-only feed; wake-vs-read** → monitor stdout one-liners (wake) + `qa-feed.jsonl` (durable record); skill §2. ✓
- **Minimal generic anomaly net (process-died / stall / raw-error), grown via retro** → `PROCESS_DIED`/`STALL` in monitor, `ERROR` in `reduce`; no curated taxonomy; skill §7 grows it. ✓
- **Behaviour-quality artifact surfacing for human judgment** → skill §4. ✓
- **Run-digest fingerprint + baseline compare (regression)** → Tasks 6–8. ✓
- **ACTION NEEDED handoff protocol** → skill §5. ✓
- **Calibration retro (dogfood loop) as first-class** → Task 5 + `CALIBRATION.md`; skill §7. ✓
- **Layer-1-then-Layer-2 sequencing; fixture-based TDD** → Tasks 1–5 then 6–8; all pure modules unit-tested against fixtures. ✓

Deferred per spec (YAGNI): heuristic `LAUNDERING_LEAK` detector; richer named anomaly detectors (both grow through the retro). Best-effort `DELEGATION` detection is flagged in `markers.ts` as a retro-tuning candidate.
