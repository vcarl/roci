# Episode Log Implementation Plan (Stage 1 of agent cognition extensions)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two append-only JSONL episode streams per character under `players/<name>/logs/` — `episodes-tool.jsonl` (one low-fidelity record per OpenCode tool call) and `episodes-transition.jsonl` (full-fidelity OODA tier calls plus step-start/step-end boundary records) — rotated by reflection cycle, so retro turns can read what the agent actually did.

**Architecture:** A single new module `packages/core/src/logging/episodes.ts` owns the record types, a never-failing append writer (swallow-and-log, `Effect<void, never, never>` so no service-requirement churn), and a module-level per-character tick/step context (house precedent: `behavior-digest.ts`). Emitters hook three existing seams: the transport's per-line normalize loop (tool records), the four `tiers.ts` run functions (tier transition records, where the rendered prompt and parsed output both exist), and the cortex loop's step fork/evaluate sites (step boundaries). `runReflection` closes each cycle with a `cycle-boundary` marker and rewrites the files keeping the last `EPISODE_RETAIN_CYCLES` whole cycles.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Effect 3.x, vitest 3.x, pnpm + nx monorepo (`@roci/core` at `packages/core`, app `apps/roci`).

## Global Constraints

- **`argsSummary` is truncated to ~200 chars** — `ARGS_SUMMARY_MAX = 200`, a named exported constant; truncation appends a single `…`.
- **Full tool responses are never stored.** The tool-record builder never reads the normalizer's tool output; tests assert the output string is absent from the file.
- **JSONL under `players/<name>/logs/`, never sqlite.** The harness writes host-side; per-character sqlite is container-only (sqlite-vec bus-errors host-side on macOS). JSONL on the shared mount lets retro turns read in-container via the RW mount.
- **Episode writes are logging, not control flow: a failed append must never disturb the tick loop.** Every writer returns `Effect<void, never, never>` — errors are swallowed after a `console.error`. Writers are also a no-op until `setEpisodeLogRoot` is called (production calls it once at CLI startup), so tests that don't opt in write nothing.
- **Rotation retains the last N reflection cycles, N = `EPISODE_RETAIN_CYCLES` (5), a named constant.** Rotation drops only whole reflection cycles (verified by unit test).
- **Aggregates (per-skill success rates etc.) are computed at read time by retro turns, never maintained incrementally.** Stage 1 ships zero aggregate code.
- **Schema stability for later stages:** step-boundary records carry `skill` (§3 skill worn) and `wmDeltas` (§2 working-memory deltas) **now**, but Stage 1 always writes them as `null`.
- **SpaceMolt only.** The GitHub domain is stale and out of scope; all hooks are domain-agnostic core seams that SpaceMolt drives.
- **Verification:** run from the worktree root `/Users/vcarl/workspace/roci/.claude/worktrees/skills`. If `node_modules` is missing, run `pnpm install` once first. Tests: `pnpm vitest run <relative-test-path>`. Typecheck: `pnpm nx run-many -t typecheck --skip-nx-cache` — **always pass `--skip-nx-cache`** (nx caches typecheck and will happily replay a stale green result).
- Conventional-commit messages; end every commit body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Commit with `--no-verify` (worktree has no node_modules-backed hooks).

## File Structure

**New files:**
- `packages/core/src/logging/episodes.ts` — record types, `summarizeArgs`, per-character episode context, append writers, cycle rotation. One module; one responsibility: the episode substrate.
- `packages/core/src/logging/episodes.test.ts`

**Modified files:**
- `packages/core/src/logging/stream-normalizer.ts:6` (InternalEvent `tool_use` variant), `:81-89` (`normalizeOpenCode` tool branch) — extract `status`/`durationMs`.
- `packages/core/src/logging/stream-normalizer.test.ts:88-106` — existing opencode tool fixture gains `status`; new cases.
- `packages/core/src/core/limbic/hypothalamus/transport.ts:106-142` — tool-episode emission in the stdout normalize loop.
- `packages/core/src/core/limbic/hypothalamus/transport.test.ts` — new emission tests.
- `packages/core/src/cortex/tiers.ts:180-233, 236-266, 296-337, 347-361` — tier transition emission via `Effect.tap`.
- `packages/core/src/cortex/tiers.test.ts` — new emission tests.
- `packages/core/src/cortex/loop.ts:169-179, 186-195, 213, 557-561, 631-639, 641-659` — tick/step context + step-boundary records.
- `packages/core/src/cortex/loop.test.ts` — new step-boundary test.
- `packages/core/src/core/orchestrator/planned-action.ts:113-125` — `finishEpisodeCycle` at the end of `runReflection`.
- `packages/core/src/core/orchestrator/planned-action.test.ts` — cycle-boundary test.
- `apps/roci/src/cli.ts:33` — `setEpisodeLogRoot(PROJECT_ROOT)` production init.

---

## Task 1: Episode record types + append-writer module

**Files:**
- Create: `packages/core/src/logging/episodes.ts`
- Create: `packages/core/src/logging/episodes.test.ts`
- Modify: `apps/roci/src/cli.ts:33` (production init, one line after `const PROJECT_ROOT = process.cwd()`)

**Interfaces:**
- Consumes: `Judgment` from `packages/core/src/skills/types.ts:92`.
- Produces (later stages and Tasks 2-5 consume these exact names):
  - `export const ARGS_SUMMARY_MAX = 200`
  - `export const EPISODE_RETAIN_CYCLES = 5`
  - `export const TOOL_EPISODE_FILE = "episodes-tool.jsonl"` / `export const TRANSITION_EPISODE_FILE = "episodes-transition.jsonl"`
  - `export interface ToolEpisode { ts: string; tick: number | null; stepId: string | null; tool: string; argsSummary: string; status: string; durationMs: number | null }`
  - `export interface TierTransitionEpisode { type: "tier"; ts: string; tick: number | null; stepId: string | null; phase: "orient" | "decide" | "evaluate" | "diary"; prompt: string; output: unknown }`
  - `export interface StepBoundaryEpisode { type: "step-start" | "step-end"; ts: string; tick: number; stepId: string; task: string; goal: string; verdict?: Judgment; transition?: "next_step" | "replan" | "wait" | "terminate"; skill: string | null; wmDeltas: unknown[] | null }`
  - `export interface CycleBoundaryEpisode { type: "cycle-boundary"; ts: string }`
  - `export type TransitionEpisode = TierTransitionEpisode | StepBoundaryEpisode | CycleBoundaryEpisode`
  - `export interface EpisodeContext { tick: number | null; stepId: string | null }`
  - `export function setEpisodeLogRoot(root: string | null): void` / `export function episodeContext(character: string): EpisodeContext` / `export function setEpisodeTick(character: string, tick: number): void` / `export function setEpisodeStep(character: string, stepId: string | null): void` / `export function resetEpisodeContext(character: string): void`
  - `export function summarizeArgs(input: unknown): string`
  - `export const appendToolEpisode: (character: string, record: ToolEpisode) => Effect.Effect<void>`
  - `export const appendTransitionEpisode: (character: string, record: TransitionEpisode) => Effect.Effect<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/logging/episodes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  ARGS_SUMMARY_MAX,
  TOOL_EPISODE_FILE,
  TRANSITION_EPISODE_FILE,
  summarizeArgs,
  setEpisodeLogRoot,
  setEpisodeTick,
  setEpisodeStep,
  episodeContext,
  resetEpisodeContext,
  appendToolEpisode,
  appendTransitionEpisode,
  type ToolEpisode,
} from "./episodes.js"

const toolRecord = (over: Partial<ToolEpisode> = {}): ToolEpisode => ({
  ts: "2026-07-02T00:00:00.000Z",
  tick: 3,
  stepId: "s3-0",
  tool: "bash",
  argsSummary: '{"command":"ls"}',
  status: "completed",
  durationMs: 42,
  ...over,
})

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-"))
  setEpisodeLogRoot(root)
  resetEpisodeContext("ada")
})
afterEach(() => {
  setEpisodeLogRoot(null)
  fs.rmSync(root, { recursive: true, force: true })
})

const logsPath = (file: string) => path.join(root, "players", "ada", "logs", file)
const readLines = (file: string): string[] =>
  fs.readFileSync(logsPath(file), "utf8").split("\n").filter((l) => l.trim().length > 0)

describe("summarizeArgs", () => {
  it("passes short args through as compact JSON", () => {
    expect(summarizeArgs({ command: "ls" })).toBe('{"command":"ls"}')
  })

  it("truncates to ARGS_SUMMARY_MAX chars plus a single ellipsis", () => {
    const s = summarizeArgs({ command: "x".repeat(1000) })
    expect(s.length).toBe(ARGS_SUMMARY_MAX + 1)
    expect(s.endsWith("…")).toBe(true)
    expect(ARGS_SUMMARY_MAX).toBe(200)
  })

  it("never throws on unserializable input", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(summarizeArgs(circular)).toBe("[unserializable args]")
  })
})

describe("episode context", () => {
  it("defaults to null tick and stepId", () => {
    expect(episodeContext("ada")).toEqual({ tick: null, stepId: null })
  })

  it("tracks tick and stepId independently and resets", () => {
    setEpisodeTick("ada", 7)
    setEpisodeStep("ada", "s7-1")
    expect(episodeContext("ada")).toEqual({ tick: 7, stepId: "s7-1" })
    setEpisodeStep("ada", null)
    expect(episodeContext("ada")).toEqual({ tick: 7, stepId: null })
    resetEpisodeContext("ada")
    expect(episodeContext("ada")).toEqual({ tick: null, stepId: null })
  })
})

describe("append writers", () => {
  it("appends tool records as one JSON line each, creating the logs dir", async () => {
    await Effect.runPromise(appendToolEpisode("ada", toolRecord()))
    await Effect.runPromise(appendToolEpisode("ada", toolRecord({ tool: "read", durationMs: null })))
    const lines = readLines(TOOL_EPISODE_FILE)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual(toolRecord())
    expect(JSON.parse(lines[1]).durationMs).toBeNull()
  })

  it("appends transition records to the transition stream", async () => {
    await Effect.runPromise(
      appendTransitionEpisode("ada", {
        type: "step-start",
        ts: "2026-07-02T00:00:00.000Z",
        tick: 3,
        stepId: "s3-0",
        task: "act",
        goal: "do the thing",
        skill: null,
        wmDeltas: null,
      }),
    )
    const [rec] = readLines(TRANSITION_EPISODE_FILE).map((l) => JSON.parse(l))
    expect(rec).toMatchObject({ type: "step-start", stepId: "s3-0", skill: null, wmDeltas: null })
  })

  it("is a no-op when no root is configured (tests and non-harness callers write nothing)", async () => {
    setEpisodeLogRoot(null)
    await Effect.runPromise(appendToolEpisode("ada", toolRecord()))
    expect(fs.existsSync(logsPath(TOOL_EPISODE_FILE))).toBe(false)
  })

  it("swallows write failures — never fails the effect (logging, not control flow)", async () => {
    // Make players/ a regular FILE so mkdir -p under it fails.
    fs.writeFileSync(path.join(root, "players"), "not a directory")
    await expect(Effect.runPromise(appendToolEpisode("ada", toolRecord()))).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/logging/episodes.test.ts
```

Expected failure: `Error: Failed to resolve import "./episodes.js" from "packages/core/src/logging/episodes.test.ts". Does the file exist?`

- [ ] **Step 3: Minimal implementation**

Create `packages/core/src/logging/episodes.ts`:

```ts
/**
 * Episode log substrate (agent-cognition Stage 1, spec §1).
 *
 * Two append-only JSONL streams per character under players/<name>/logs/:
 *   - episodes-tool.jsonl        high cadence, low fidelity (one record per OpenCode tool call)
 *   - episodes-transition.jsonl  low cadence, full fidelity (OODA tier calls + step boundaries)
 *
 * Episode writes are logging, not control flow: every writer is
 * Effect<void, never, never> — failures are swallowed after a console.error and
 * can never disturb the tick loop. Writers are a no-op until setEpisodeLogRoot
 * is called (apps/roci/src/cli.ts does this once at startup with PROJECT_ROOT).
 *
 * Module-level per-character context (tick/stepId) mirrors behavior-digest.ts:
 * the cortex loop stamps it; the transport and tier emitters read it.
 */
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import type { Judgment } from "../skills/types.js"

export const ARGS_SUMMARY_MAX = 200
/** Rotation: retain the last N reflection cycles (spec §1 "Rotation"). */
export const EPISODE_RETAIN_CYCLES = 5
export const TOOL_EPISODE_FILE = "episodes-tool.jsonl"
export const TRANSITION_EPISODE_FILE = "episodes-transition.jsonl"

/** One record per OpenCode tool call. Full tool responses are never stored. */
export interface ToolEpisode {
  ts: string
  tick: number | null
  stepId: string | null
  tool: string
  /** JSON of the tool input, truncated to ARGS_SUMMARY_MAX chars. */
  argsSummary: string
  /** Terminal tool state, e.g. "completed" | "error". */
  status: string
  durationMs: number | null
}

/** One record per OODA tier call: full rendered prompt + parsed output. */
export interface TierTransitionEpisode {
  type: "tier"
  ts: string
  tick: number | null
  stepId: string | null
  phase: "orient" | "decide" | "evaluate" | "diary"
  prompt: string
  output: unknown
}

/**
 * Step boundary records. `skill` (worn skill, spec §3) and `wmDeltas`
 * (working-memory deltas, spec §2) exist NOW for schema stability; Stage 1
 * always writes them as null — Stages 2/3 populate them.
 */
export interface StepBoundaryEpisode {
  type: "step-start" | "step-end"
  ts: string
  tick: number
  stepId: string
  task: string
  goal: string
  /** step-end only: the evaluate verdict. */
  verdict?: Judgment
  /** step-end only: the evaluate transition. */
  transition?: "next_step" | "replan" | "wait" | "terminate"
  skill: string | null
  wmDeltas: unknown[] | null
}

/** Marks the end of one reflection cycle in both streams (rotation unit). */
export interface CycleBoundaryEpisode {
  type: "cycle-boundary"
  ts: string
}

export type TransitionEpisode = TierTransitionEpisode | StepBoundaryEpisode | CycleBoundaryEpisode

// ── Root config ──────────────────────────────────────────────
let episodeRoot: string | null = null

/** Enable episode writes rooted at `root` (the harness project root); null disables. */
export function setEpisodeLogRoot(root: string | null): void {
  episodeRoot = root
}

function logsDir(root: string, character: string): string {
  return path.resolve(root, "players", character, "logs")
}

// ── Per-character tick/step context ──────────────────────────
export interface EpisodeContext {
  tick: number | null
  stepId: string | null
}

const contexts = new Map<string, EpisodeContext>()

export function episodeContext(character: string): EpisodeContext {
  return contexts.get(character) ?? { tick: null, stepId: null }
}

export function setEpisodeTick(character: string, tick: number): void {
  contexts.set(character, { ...episodeContext(character), tick })
}

export function setEpisodeStep(character: string, stepId: string | null): void {
  contexts.set(character, { ...episodeContext(character), stepId })
}

/** Test/lifecycle reset. */
export function resetEpisodeContext(character: string): void {
  contexts.delete(character)
}

// ── Record helpers ───────────────────────────────────────────
/** Compact-JSON a tool input, truncated to ARGS_SUMMARY_MAX chars. Never throws. */
export function summarizeArgs(input: unknown): string {
  let s: string
  try {
    s = JSON.stringify(input) ?? String(input)
  } catch {
    s = "[unserializable args]"
  }
  return s.length <= ARGS_SUMMARY_MAX ? s : `${s.slice(0, ARGS_SUMMARY_MAX)}…`
}

// ── Append writers (swallow-and-log; never fail) ─────────────
const append = (character: string, file: string, record: unknown): Effect.Effect<void> => {
  const root = episodeRoot
  if (root === null) return Effect.void
  return Effect.tryPromise({
    try: async () => {
      const line = `${JSON.stringify(record)}\n`
      const dir = logsDir(root, character)
      await fsp.mkdir(dir, { recursive: true })
      await fsp.appendFile(path.join(dir, file), line, "utf8")
    },
    catch: (e) => e,
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => console.error(`[episodes] append to ${file} failed for ${character}: ${e}`)),
    ),
  )
}

export const appendToolEpisode = (character: string, record: ToolEpisode): Effect.Effect<void> =>
  append(character, TOOL_EPISODE_FILE, record)

export const appendTransitionEpisode = (
  character: string,
  record: TransitionEpisode,
): Effect.Effect<void> => append(character, TRANSITION_EPISODE_FILE, record)
```

- [ ] **Step 4: Run it, expect pass**

```
pnpm vitest run packages/core/src/logging/episodes.test.ts
```

Expected: `Test Files  1 passed (1)` with 8 tests passed.

- [ ] **Step 5: Production init in the CLI**

Modify `apps/roci/src/cli.ts`. After line 33 (`const PROJECT_ROOT = process.cwd()`) add:

```ts
setEpisodeLogRoot(PROJECT_ROOT)
```

and add to the import block:

```ts
import { setEpisodeLogRoot } from "@roci/core/logging/episodes.js"
```

- [ ] **Step 6: Typecheck + commit**

```
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/logging/episodes.ts packages/core/src/logging/episodes.test.ts apps/roci/src/cli.ts
git commit --no-verify -m "feat(episodes): episode record types + append-only JSONL writer

Two per-character episode streams under players/<name>/logs/ (spec §1 Stage 1).
Writers are Effect<void, never, never> — swallow-and-log, no-op until the CLI
sets the root. Step records carry skill/wmDeltas as null for schema stability.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: episodes-tool.jsonl from the stream normalizer + transport

**Files:**
- Modify: `packages/core/src/logging/stream-normalizer.ts:6` (InternalEvent), `:81-89` (`normalizeOpenCode` tool_use branch)
- Modify: `packages/core/src/core/limbic/hypothalamus/transport.ts:8` (import), `:123-131` (emission)
- Test: `packages/core/src/logging/stream-normalizer.test.ts`, `packages/core/src/core/limbic/hypothalamus/transport.test.ts`

**Interfaces:**
- Consumes: `appendToolEpisode`, `episodeContext`, `summarizeArgs` (Task 1).
- Produces: extended `InternalEvent` tool_use variant — `{ type: "tool_use"; id: string; name: string; input: Record<string, unknown>; status?: string; durationMs?: number }`. Consumed by the transport's emission and (unchanged) by `toUnifiedEvents` (extra fields never reach `events.jsonl`).

- [ ] **Step 1: Write the failing normalizer tests**

In `packages/core/src/logging/stream-normalizer.test.ts`, update the existing fixture test at lines 88-106 — its `state` already carries `status: "completed"`, so its expectation gains the new field:

```ts
    expect(events).toEqual([
      { type: "tool_use", id: "prt_abc", name: "bash", input: { command: "ls", description: "list" }, status: "completed" },
    ])
```

and append inside `describe("normalizeOpenCode", ...)`:

```ts
  it("extracts status and durationMs from a completed tool state", () => {
    const events = normalizeOpenCode({
      type: "tool_use",
      part: {
        id: "prt_1",
        tool: "bash",
        state: { status: "completed", input: { command: "ls" }, output: "...", time: { start: 100, end: 350 } },
      },
    })
    expect(events).toEqual([
      { type: "tool_use", id: "prt_1", name: "bash", input: { command: "ls" }, status: "completed", durationMs: 250 },
    ])
  })

  it("omits status/durationMs when the tool state carries none", () => {
    const events = normalizeOpenCode({ type: "tool_use", part: { id: "p", tool: "read", state: { input: {} } } })
    expect(events).toEqual([{ type: "tool_use", id: "p", name: "read", input: {} }])
  })
```

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/logging/stream-normalizer.test.ts
```

Expected: 3 failures, e.g. `AssertionError: expected [ { type: 'tool_use', … } ] to deeply equal [ { type: 'tool_use', …, status: 'completed' } ]` (received objects lack `status`/`durationMs`).

- [ ] **Step 3: Implement the normalizer extraction**

In `packages/core/src/logging/stream-normalizer.ts`, change the `tool_use` member of `InternalEvent` (line 6) to:

```ts
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; status?: string; durationMs?: number }
```

and replace the `normalizeOpenCode` tool_use branch (lines 81-89) with:

```ts
  if (type === "tool_use") {
    const state = part?.state as RawEvent | undefined
    const time = state?.time as RawEvent | undefined
    const start = typeof time?.start === "number" ? time.start : undefined
    const end = typeof time?.end === "number" ? time.end : undefined
    return [{
      type: "tool_use",
      id: (part?.id as string) ?? "",
      name: (part?.tool as string) ?? "",
      input: (state?.input as Record<string, unknown>) ?? {},
      ...(typeof state?.status === "string" ? { status: state.status } : {}),
      ...(start !== undefined && end !== undefined ? { durationMs: end - start } : {}),
    }]
  }
```

- [ ] **Step 4: Run it, expect pass**

```
pnpm vitest run packages/core/src/logging/stream-normalizer.test.ts
```

Expected: `Test Files  1 passed`, all tests green.

- [ ] **Step 5: Write the failing transport test**

In `packages/core/src/core/limbic/hypothalamus/transport.test.ts`, add imports at the top:

```ts
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ARGS_SUMMARY_MAX, setEpisodeLogRoot, resetEpisodeContext } from "../../../logging/episodes.js"
```

and append a new describe block:

```ts
describe("runTransport tool episodes", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-transport-"))
    setEpisodeLogRoot(root)
    resetEpisodeContext("ada")
  })
  afterEach(() => {
    setEpisodeLogRoot(null)
    fs.rmSync(root, { recursive: true, force: true })
  })

  const toolFile = () => path.join(root, "players", "ada", "logs", "episodes-tool.jsonl")

  const toolLine = (status: string) =>
    JSON.stringify({
      type: "tool_use",
      part: {
        id: "prt_1",
        tool: "bash",
        state: {
          status,
          input: { command: "x".repeat(500) },
          output: "SECRET_TOOL_OUTPUT",
          time: { start: 1000, end: 1450 },
        },
      },
    })

  it("appends one truncated tool episode per completed opencode tool call — never the output", async () => {
    const command = Command.make("bash", "-c", `printf '%s\\n' '${toolLine("completed")}'`)
    await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeOpenCode, runtimeTag: "opencode", char, role: "body", timeoutMs: 5000 }),
        deps,
      ),
    )
    const text = fs.readFileSync(toolFile(), "utf8")
    const records = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ tool: "bash", status: "completed", durationMs: 450, tick: null, stepId: null })
    expect(records[0].argsSummary.length).toBe(ARGS_SUMMARY_MAX + 1)
    expect(text).not.toContain("SECRET_TOOL_OUTPUT")
  })

  it("does NOT append for a non-terminal tool state", async () => {
    const command = Command.make("bash", "-c", `printf '%s\\n' '${toolLine("running")}'`)
    await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeOpenCode, runtimeTag: "opencode", char, role: "body", timeoutMs: 5000 }),
        deps,
      ),
    )
    expect(fs.existsSync(toolFile())).toBe(false)
  })
})
```

(Also extend the vitest import on line 1 with `beforeEach, afterEach`.)

- [ ] **Step 6: Run it, expect failure**

```
pnpm vitest run packages/core/src/core/limbic/hypothalamus/transport.test.ts
```

Expected: `ENOENT: no such file or directory, open '<tmp>/players/ada/logs/episodes-tool.jsonl'` in the first new test.

- [ ] **Step 7: Implement the transport emission**

In `packages/core/src/core/limbic/hypothalamus/transport.ts`, add to the imports (near line 8):

```ts
import { appendToolEpisode, episodeContext, summarizeArgs } from "../../../logging/episodes.js"
```

Inside the stdout `Stream.mapEffect` (the `if (raw) { ... }` block, after the `for (const event of unified)` loop ending at line 131), add:

```ts
              // Episode substrate (spec §1): one low-fidelity record per OpenCode
              // tool call that reached a terminal state. Only normalizeOpenCode
              // sets `status`, so claude-runtime brain turns are naturally
              // excluded. Never store the tool output. appendToolEpisode is
              // swallow-and-log — it can never disturb the transport.
              for (const ie of internal) {
                if (ie.type === "tool_use" && (ie.status === "completed" || ie.status === "error")) {
                  const ctx = episodeContext(input.char.name)
                  yield* appendToolEpisode(input.char.name, {
                    ts: new Date().toISOString(),
                    tick: ctx.tick,
                    stepId: ctx.stepId,
                    tool: ie.name,
                    argsSummary: summarizeArgs(ie.input),
                    status: ie.status,
                    durationMs: ie.durationMs ?? null,
                  })
                }
              }
```

- [ ] **Step 8: Run it, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/core/limbic/hypothalamus/transport.test.ts packages/core/src/logging/stream-normalizer.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/logging/stream-normalizer.ts packages/core/src/logging/stream-normalizer.test.ts packages/core/src/core/limbic/hypothalamus/transport.ts packages/core/src/core/limbic/hypothalamus/transport.test.ts
git commit --no-verify -m "feat(episodes): emit tool episodes from the opencode stream

normalizeOpenCode now extracts terminal tool status + durationMs; the transport
appends one ~200-char-argsSummary record per completed/errored tool call to
episodes-tool.jsonl. Tool outputs are never stored.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: episodes-transition.jsonl for OODA tier calls

**Files:**
- Modify: `packages/core/src/cortex/tiers.ts` — import (~line 23), new `emitTier` helper after `callTier` (~line 119), `runForebrain` return pipe (lines 200-232), `runConsciousDecide` (261-265), `runConsciousEvaluate` (324-336), `runDiaryTurn` (360)
- Test: `packages/core/src/cortex/tiers.test.ts`

**Interfaces:**
- Consumes: `appendTransitionEpisode`, `episodeContext`, `TierTransitionEpisode` (Task 1); the existing parsed results (`OrientResult`, `DecideResult`, `EvaluateResult`, diary string).
- Produces: `TierTransitionEpisode` records with `phase` ∈ orient/decide/evaluate/diary. **Observe (hindbrain) is deliberately excluded** — spec §1 lists only the four. No signature changes to any `run*` function (the emitter is `Effect<void, never, never>`, added via `Effect.tap`).

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/cortex/tiers.test.ts`: extend the vitest import (line 1) to `{ describe, it, expect, afterEach, beforeEach }`, add `runDiaryTurn` to the `./tiers.js` import, and add file imports:

```ts
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setEpisodeLogRoot, setEpisodeTick, resetEpisodeContext } from "../logging/episodes.js"
```

Append:

```ts
describe("transition episodes — OODA tier calls", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-tiers-"))
    setEpisodeLogRoot(root)
    resetEpisodeContext("ada")
    setEpisodeTick("ada", 7)
  })
  afterEach(() => {
    setEpisodeLogRoot(null)
    fs.rmSync(root, { recursive: true, force: true })
  })

  const transitionFile = () => path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
  const readTransitions = () =>
    fs.readFileSync(transitionFile(), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))

  const orientFixture: OrientResult = {
    headline: "h", sections: [], whatChanged: "w", emotionalState: "😐", confidence: "low", metrics: {},
  }

  it("orient appends a full-fidelity tier record: rendered prompt, parsed output, tick", async () => {
    await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["combat happened"], "{}", { background: "", values: "", diary: "" }, "😰"),
        Layer.mergeAll(
          fixedClient('{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","confidence":"high","metrics":{}}'),
          recordingService([]),
          silentLog,
        ),
      ),
    )
    const [rec] = readTransitions()
    expect(rec).toMatchObject({ type: "tier", phase: "orient", tick: 7, stepId: null })
    expect(rec.prompt).toContain("combat happened")
    expect(rec.output.headline).toBe("act now")
  })

  it("decide, evaluate, and diary each append their phase; observe never does", async () => {
    const layersFor = (text: string) => Layer.mergeAll(fixedClient(text), recordingService([]), silentLog)

    await Effect.runPromise(
      Effect.provide(runHindbrain(config, "type: noise\n{}", null),
        layersFor('{"disposition":"discard","emotionalWeight":"😐","drive":null,"weight":0,"reason":"x"}')),
    )
    expect(fs.existsSync(transitionFile())).toBe(false) // observe excluded

    await Effect.runPromise(
      Effect.provide(runConsciousDecide(config, orientFixture, "No active plan.", "actions"),
        layersFor('{"decision":"continue","reasoning":"r"}')),
    )
    await Effect.runPromise(
      Effect.provide(
        runConsciousEvaluate(config, {
          task: "t", goal: "g", successCondition: "s", ticksBudgeted: 2, ticksConsumed: 1,
          executionReport: "r", stateDiff: "", conditionCheck: "c", emotionalState: "😐", remainingSteps: "None.",
        }),
        layersFor('{"judgment":"succeeded","reasoning":"done","transition":{"transition":"next_step"}}'),
      ),
    )
    await Effect.runPromise(
      Effect.provide(
        runDiaryTurn(config, {
          charName: "ada", task: "t", goal: "g", judgment: "succeeded",
          reasoning: "r", executionReport: "e", emotionalState: "😐",
        }),
        layersFor("Dear diary, it went fine."),
      ),
    )

    const phases = readTransitions().map((r) => r.phase)
    expect(phases).toEqual(["decide", "evaluate", "diary"])
    const diary = readTransitions()[2]
    expect(diary.output).toBe("Dear diary, it went fine.")
  })
})
```

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/cortex/tiers.test.ts
```

Expected: `ENOENT: no such file or directory, open '<tmp>/players/ada/logs/episodes-transition.jsonl'` in the first new test.

- [ ] **Step 3: Implement the tier emitters**

In `packages/core/src/cortex/tiers.ts`, add to the imports (near line 23):

```ts
import { appendTransitionEpisode, episodeContext } from "../logging/episodes.js"
```

After `callTier` (below line 119), add:

```ts
/**
 * Full-fidelity transition record for one OODA tier call (spec §1): the rendered
 * prompt and the PARSED output. Observe is excluded (per-event, high cadence).
 * Never fails; never disturbs the tier call.
 */
const emitTier = (
  character: string,
  phase: "orient" | "decide" | "evaluate" | "diary",
  prompt: string,
  output: unknown,
): Effect.Effect<void> => {
  const ctx = episodeContext(character)
  return appendTransitionEpisode(character, {
    type: "tier",
    ts: new Date().toISOString(),
    tick: ctx.tick,
    stepId: ctx.stepId,
    phase,
    prompt,
    output,
  })
}
```

Then add one `Effect.tap` per run function, after its existing parse stage:

- `runForebrain` (line 200): `return callTier(config, "forebrain", "orient", prompt).pipe(Effect.flatMap((text) => { ... }), Effect.tap((result) => emitTier(config.char.name, "orient", prompt, result)))`
- `runConsciousDecide` (line 261): `.pipe(Effect.map((text) => parseOr<DecideResult>(...)), Effect.tap((result) => emitTier(config.char.name, "decide", prompt, result)))`
- `runConsciousEvaluate` (line 324): `.pipe(Effect.map((text) => { ... return { ...result, transition: normalizeTransition(result.transition) } }), Effect.tap((result) => emitTier(config.char.name, "evaluate", prompt, result)))`
- `runDiaryTurn` (line 360): `return callTier(config, "forebrain", "diary", prompt).pipe(Effect.map((text) => text.trim()), Effect.tap((entry) => emitTier(config.char.name, "diary", prompt, entry)))`

- [ ] **Step 4: Run it, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/cortex/tiers.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/cortex/tiers.ts packages/core/src/cortex/tiers.test.ts
git commit --no-verify -m "feat(episodes): record OODA tier transitions

orient/decide/evaluate/diary each append a full-fidelity record (rendered
prompt + parsed output) to episodes-transition.jsonl via Effect.tap — no
signature changes, observe excluded per spec §1.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Step-boundary records in the cortex loop

**Files:**
- Modify: `packages/core/src/cortex/loop.ts` — import (~line 61), tick stamp after `tick++` (line 213), `resetPlanState` (lines 186-195), step-end after the evaluate `logBehavior` (lines 557-561), per-step reset (lines 631-639), turn-1 fork (lines 641-659)
- Test: `packages/core/src/cortex/loop.test.ts`

**Interfaces:**
- Consumes: `appendTransitionEpisode`, `episodeContext`, `setEpisodeTick`, `setEpisodeStep`, `StepBoundaryEpisode` (Task 1); `evalResult.judgment` / `evalResult.transition.transition` (`EvaluateResult`, `skills/types.ts:106-110`).
- Produces: `step-start` / `step-end` records with `stepId = "s<stepStartTick>-<stepIndex>"`; `skill: null`, `wmDeltas: null` in Stage 1 (Stages 2/3 fill them). No control-flow changes — inserts are emit-only.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/cortex/loop.test.ts`, add imports:

```ts
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setEpisodeLogRoot, resetEpisodeContext } from "../logging/episodes.js"
```

Append inside `describe("runCortex (conscious-session executor)", ...)`:

```ts
  it("emits step-start and step-end transition episodes (verdict, null skill/wm fields)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-loop-"))
    setEpisodeLogRoot(root)
    resetEpisodeContext("ada")
    try {
      const ctLayer = ConsciousThoughtTest((config) => ({
        result: successTurnResult(config.prompt),
        sessionId: "ses_ep",
      }))
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" })
        return yield* runCortex({
          char: { name: "ada", dir: "/work/players/ada/me" },
          containerId: "c1",
          events,
          initialState: {},
          cadence: "real-time",
          orientInterval: 1,
          tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(scriptedClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
      })
      const result = await Effect.runPromise(program)
      expect(result._tag).toBe("Completed")

      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const records = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      const start = records.find((r) => r.type === "step-start")
      const end = records.find((r) => r.type === "step-end")
      expect(start).toMatchObject({ task: "act", goal: "do the thing", skill: null, wmDeltas: null })
      expect(typeof start.tick).toBe("number")
      expect(start.stepId).toMatch(/^s\d+-0$/)
      expect(end).toMatchObject({
        stepId: start.stepId,
        task: "act",
        verdict: "succeeded",
        transition: "terminate",
        skill: null,
        wmDeltas: null,
      })
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
```

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/cortex/loop.test.ts -t "step-start and step-end"
```

Expected: the tier records exist (Task 3) but no boundaries — `AssertionError: expected undefined to deeply match { task: 'act', … }` (`records.find((r) => r.type === "step-start")` is undefined).

- [ ] **Step 3: Implement the loop hooks**

In `packages/core/src/cortex/loop.ts`:

1. Import (after the `./state.js` import block ending line 61):

```ts
import { appendTransitionEpisode, episodeContext, setEpisodeStep, setEpisodeTick } from "../logging/episodes.js"
```

2. After `tick++` (line 213):

```ts
      // Stamp the episode context so tool/tier records carry the current tick.
      setEpisodeTick(config.char.name, tick)
```

3. In `resetPlanState` (lines 186-195), add as the last line of the closure:

```ts
      setEpisodeStep(config.char.name, null)
```

4. Step-end — after the evaluate `logBehavior` (line 561, before `for (const w of evaluateMemories...)`):

```ts
            // Episode substrate (spec §1): step-end with the evaluate verdict.
            // skill/wmDeltas are schema-stable placeholders — Stage 2/3 fill them.
            yield* appendTransitionEpisode(config.char.name, {
              type: "step-end",
              ts: new Date().toISOString(),
              tick,
              stepId: episodeContext(config.char.name).stepId ?? `s${stepStartTick}-${stepIdx}`,
              task: step.task,
              goal: step.goal,
              verdict: evalResult.judgment,
              transition: evalResult.transition.transition,
              skill: null,
              wmDeltas: null,
            })
```

5. Per-step reset (the block at lines 631-639, after `bypassSteerCadence = false`):

```ts
            setEpisodeStep(config.char.name, null)
```

6. Step-start — turn-1 fork branch (line 642 `if (sessionId === null) {`), after `stepStartSnapshot = ...` (line 645) and before the `logBehavior` step start (line 646):

```ts
              const episodeStepId = `s${tick}-${cortex.currentStepIndex}`
              setEpisodeStep(config.char.name, episodeStepId)
              yield* appendTransitionEpisode(config.char.name, {
                type: "step-start",
                ts: new Date().toISOString(),
                tick,
                stepId: episodeStepId,
                task: step.task,
                goal: step.goal,
                skill: null,
                wmDeltas: null,
              })
```

- [ ] **Step 4: Run the full loop suite, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/cortex/loop.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/cortex/loop.ts packages/core/src/cortex/loop.test.ts
git commit --no-verify -m "feat(episodes): step-boundary records in the cortex loop

step-start at turn-1 fork, step-end with the evaluate verdict/transition;
tick/step context stamped for the tool and tier emitters. Emit-only inserts —
no control-flow change; skill/wmDeltas written as null (Stage 2/3 fill them).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Rotation by reflection cycle

**Files:**
- Modify: `packages/core/src/logging/episodes.ts` (add `retainLastCycles`, `finishEpisodeCycle`)
- Modify: `packages/core/src/core/orchestrator/planned-action.ts:113-125` (hook at end of `runReflection`)
- Test: `packages/core/src/logging/episodes.test.ts`, `packages/core/src/core/orchestrator/planned-action.test.ts`

**Interfaces:**
- Consumes: `EPISODE_RETAIN_CYCLES`, `CycleBoundaryEpisode`, file constants (Task 1).
- Produces:
  - `export function retainLastCycles(lines: readonly string[], retain: number): string[]` — pure; keeps the last `retain` completed cycles (each cycle ends at its `cycle-boundary` line, which is kept) plus any in-progress tail; drops only whole cycles.
  - `export const finishEpisodeCycle: (character: string) => Effect.Effect<void>` — appends a `cycle-boundary` to both streams, then rotates each via write-tmp-then-rename. Swallow-and-log; never fails. Stage 4's meso retrospect will read the cycle windows these boundaries delimit.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/logging/episodes.test.ts` (extend the import from `./episodes.js` with `EPISODE_RETAIN_CYCLES, retainLastCycles, finishEpisodeCycle`):

```ts
describe("retainLastCycles (pure rotation)", () => {
  const boundary = JSON.stringify({ type: "cycle-boundary", ts: "t" })
  const rec = (n: number) => JSON.stringify({ ts: `t${n}`, tool: "bash" })

  it("keeps everything when there are at most N completed cycles", () => {
    const lines = [rec(1), boundary, rec(2), boundary]
    expect(retainLastCycles(lines, 2)).toEqual(lines)
  })

  it("drops only whole cycles, keeping the last N with their boundaries", () => {
    const lines = [rec(1), boundary, rec(2), boundary, rec(3), boundary]
    expect(retainLastCycles(lines, 2)).toEqual([rec(2), boundary, rec(3), boundary])
  })

  it("keeps the in-progress tail after the last boundary", () => {
    const lines = [rec(1), boundary, rec(2), boundary, rec(3)]
    expect(retainLastCycles(lines, 1)).toEqual([rec(2), boundary, rec(3)])
  })

  it("preserves unparseable lines (they are never boundaries, never dropped alone)", () => {
    const lines = ["not json", boundary, rec(2), boundary]
    expect(retainLastCycles(lines, 1)).toEqual([rec(2), boundary])
  })
})

describe("finishEpisodeCycle", () => {
  it("appends a cycle-boundary to both streams and rotates whole cycles beyond EPISODE_RETAIN_CYCLES", async () => {
    for (let c = 1; c <= EPISODE_RETAIN_CYCLES + 2; c++) {
      await Effect.runPromise(appendToolEpisode("ada", toolRecord({ tick: c })))
      await Effect.runPromise(finishEpisodeCycle("ada"))
    }
    const records = readLines(TOOL_EPISODE_FILE).map((l) => JSON.parse(l))
    const ticks = records.filter((r) => r.tool === "bash").map((r) => r.tick)
    expect(ticks).toEqual([3, 4, 5, 6, 7]) // cycles 1-2 dropped whole
    expect(records.filter((r) => r.type === "cycle-boundary")).toHaveLength(EPISODE_RETAIN_CYCLES)
    // Transition stream got boundaries too (created even when otherwise empty).
    const transitions = readLines(TRANSITION_EPISODE_FILE).map((l) => JSON.parse(l))
    expect(transitions.every((r) => r.type === "cycle-boundary")).toBe(true)
  })

  it("never fails, even when the logs path is unwritable", async () => {
    fs.writeFileSync(path.join(root, "players"), "not a directory")
    await expect(Effect.runPromise(finishEpisodeCycle("ada"))).resolves.toBeUndefined()
  })
})
```

And append to `packages/core/src/core/orchestrator/planned-action.test.ts` (add imports `import * as fs from "node:fs"`, `import * as os from "node:os"`, `import * as path from "node:path"`, and `import { setEpisodeLogRoot, appendToolEpisode } from "../../logging/episodes.js"`):

```ts
describe("runReflection — episode cycle rotation", () => {
  it("closes the episode cycle: cycle-boundary appended to both streams, best-effort", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-reflect-"))
    setEpisodeLogRoot(root)
    try {
      await Effect.runPromise(
        appendToolEpisode("ada", {
          ts: "t", tick: 1, stepId: "s1-0", tool: "bash", argsSummary: "{}", status: "completed", durationMs: 1,
        }),
      )
      const fsx = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") })
      runTurnMock.mockImplementation(() => Effect.succeed({ output: "x", timedOut: false, durationMs: 1 }))
      await run(
        runReflection(char, "c1", DEFAULT_MODEL_CONFIG).pipe(
          Effect.provide(Layer.mergeAll(fsx.layer, makeStore().layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
        ) as Effect.Effect<unknown, unknown, never>,
      )
      for (const file of ["episodes-tool.jsonl", "episodes-transition.jsonl"]) {
        const text = fs.readFileSync(path.join(root, "players", "ada", "logs", file), "utf8")
        const recs = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
        expect(recs.some((r) => r.type === "cycle-boundary")).toBe(true)
      }
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run them, expect failure**

```
pnpm vitest run packages/core/src/logging/episodes.test.ts
```

Expected: `SyntaxError: The requested module './episodes.js' does not provide an export named 'retainLastCycles'`.

- [ ] **Step 3: Implement rotation**

Append to `packages/core/src/logging/episodes.ts`:

```ts
// ── Rotation: retain the last N reflection cycles ────────────
function lineType(line: string): string | undefined {
  try {
    const rec = JSON.parse(line) as { type?: unknown }
    return typeof rec?.type === "string" ? rec.type : undefined
  } catch {
    return undefined
  }
}

/**
 * Pure. A cycle is the lines up to and including its `cycle-boundary` marker.
 * Keeps the last `retain` completed cycles (boundaries included) plus the
 * in-progress tail — drops only whole cycles, never a partial one.
 */
export function retainLastCycles(lines: readonly string[], retain: number): string[] {
  const boundaries: number[] = []
  lines.forEach((line, i) => {
    if (lineType(line) === "cycle-boundary") boundaries.push(i)
  })
  if (boundaries.length <= retain) return [...lines]
  const cut = boundaries[boundaries.length - retain - 1]
  return lines.slice(cut + 1)
}

/**
 * Close the current reflection cycle: append a cycle-boundary marker to both
 * episode streams, then rotate each to the last EPISODE_RETAIN_CYCLES cycles
 * (write-to-tmp + rename, so a concurrent reader never sees a torn file).
 * Swallow-and-log: a rotation failure must never disturb reflection.
 */
export const finishEpisodeCycle = (character: string): Effect.Effect<void> => {
  const root = episodeRoot
  if (root === null) return Effect.void
  return Effect.tryPromise({
    try: async () => {
      const boundary: CycleBoundaryEpisode = { type: "cycle-boundary", ts: new Date().toISOString() }
      const line = `${JSON.stringify(boundary)}\n`
      const dir = logsDir(root, character)
      await fsp.mkdir(dir, { recursive: true })
      for (const file of [TOOL_EPISODE_FILE, TRANSITION_EPISODE_FILE]) {
        const filePath = path.join(dir, file)
        await fsp.appendFile(filePath, line, "utf8")
        const text = await fsp.readFile(filePath, "utf8")
        const lines = text.split("\n").filter((l) => l.trim().length > 0)
        const kept = retainLastCycles(lines, EPISODE_RETAIN_CYCLES)
        if (kept.length < lines.length) {
          const tmp = `${filePath}.tmp`
          await fsp.writeFile(tmp, kept.map((l) => `${l}\n`).join(""), "utf8")
          await fsp.rename(tmp, filePath)
        }
      }
    },
    catch: (e) => e,
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => console.error(`[episodes] cycle rotation failed for ${character}: ${e}`)),
    ),
  )
}
```

In `packages/core/src/core/orchestrator/planned-action.ts`, add the import:

```ts
import { finishEpisodeCycle } from "../../logging/episodes.js"
```

and at the very end of `runReflection` (after the mark re-baseline block ending line 124, still inside the outer `Effect.gen`):

```ts
    // Close this reflection cycle's episode window and rotate (spec §1):
    // retain the last EPISODE_RETAIN_CYCLES cycles, dropping only whole
    // cycles. finishEpisodeCycle is swallow-and-log — it can never fail
    // reflection, mirroring the best-effort stages above.
    yield* finishEpisodeCycle(char.name)
```

- [ ] **Step 4: Run everything, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/logging/episodes.test.ts packages/core/src/core/orchestrator/planned-action.test.ts
pnpm vitest --run
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/logging/episodes.ts packages/core/src/logging/episodes.test.ts packages/core/src/core/orchestrator/planned-action.ts packages/core/src/core/orchestrator/planned-action.test.ts
git commit --no-verify -m "feat(episodes): rotate episode logs by reflection cycle

runReflection appends a cycle-boundary to both streams and rewrites them
keeping the last EPISODE_RETAIN_CYCLES whole cycles (tmp+rename). Best-effort;
a rotation failure never disturbs promote/consolidate/dream.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Spec §1 coverage checklist

- `episodes-tool.jsonl` `{ts, tick, stepId, tool, argsSummary, status, durationMs}` — Task 2 (tick/stepId via episode context; nullable when no step is active).
- ~200-char `argsSummary`, full tool responses never stored — Tasks 1-2 (constant + negative assertion).
- `episodes-transition.jsonl` tier records (rendered prompt + parsed output for orient/decide/evaluate/diary) — Task 3.
- Step-boundary records with evaluate verdict, worn skill, wm deltas — Task 4 (`skill`/`wmDeltas` present as `null` in Stage 1).
- JSONL not sqlite, host-side writes under `players/<name>/logs/` — Task 1.
- Failed append never disturbs the tick loop — Tasks 1/5 swallow tests.
- Rotation retains last N reflection cycles, drops only whole cycles — Task 5.
- Aggregates at read time only — no aggregate code anywhere (constraint).
