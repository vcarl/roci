# Leveled Logging + Live-View Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live stdout view a clean, level-filtered narrative of the four signals an operator cares about (cortex decisions, body/tool activity, lifecycle, errors), while keeping `events.jsonl` a complete archive — and fix the three bugs corrupting the view today.

**Architecture:** Every event carries an optional `level`; a pure classifier supplies a default and call sites override where they know better. `CharacterLog.emit` resolves the level once, threshold-filters the console (via `LOG_LEVEL`), and always writes the full event (with level) to JSONL. Three bug fixes underneath: OpenCode tool field paths, the rogue stderr status bar, and demoting lifecycle noise.

**Tech Stack:** TypeScript, Effect (Context/Layer services), Node, vitest.

## Global Constraints

- All edits target the worktree checkout: `/Users/vcarl/workspace/roci/.claude/worktrees/better-logging/`. Verify every path is under it before editing.
- Test runner: vitest. Run a single file from the worktree root with `pnpm exec vitest run <path>`; narrow to one case with `-t "<name>"`.
- Typecheck a package with `pnpm -C packages/core typecheck` (`tsc --noEmit`). Run `pnpm install --frozen-lockfile` first if `node_modules` is absent in the worktree.
- Log levels are exactly `"debug" | "info" | "warn" | "error"`, ranked `debug < info < warn < error`. Console default threshold is `info`. JSONL is never filtered.
- Follow existing file conventions: `.js` import specifiers for local TS modules (NodeNext), 2-space indent, no semicolons in `packages/core`/`packages/domain-*` (match the file you edit — `template-domain` uses tabs + semicolons; preserve per-file style).
- Commit messages: conventional-commit prefix, and end with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**Created:**
- `packages/core/src/logging/levels.ts` — pure level model: `LogLevel` re-export, `rank`, `classifyLevel`, `effectiveLevel`, `passesThreshold`, `resolveThreshold`.
- `packages/core/src/logging/levels.test.ts` — unit tests for the above.

**Modified:**
- `packages/core/src/logging/events.ts` — add `LogLevel` type + `level?` on `EventBase`; assign `level` for runtime-lifecycle events in `toUnifiedEvents`.
- `packages/core/src/logging/log-writer.ts` — resolve level, threshold-filter console, write level into JSONL; add `level?` arg to `logToConsole`.
- `packages/core/src/logging/console-renderer.ts` — visible warn/error marker; stop dimming errors.
- `packages/core/src/logging/stream-normalizer.ts` — fix OpenCode tool field paths.
- `packages/core/src/logging/stream-normalizer.test.ts` — replace fake OpenCode tool fixture with the real shape.
- `packages/core/src/core/limbic/hypothalamus/process-runner.ts` — docker-exec command logs at `debug`.
- `packages/core/src/core/limbic/hypothalamus/transport.ts` — heartbeat logs at `debug`.
- `packages/core/src/cortex/tiers.ts` — orient parse-failure logs at `warn`.
- `packages/core/src/core/state-renderer.ts` — `logStateBar(...)→formatStateBar(metrics): string`.
- `packages/domain-spacemolt/src/renderer.ts`, `packages/domain-github/src/renderer.ts`, `packages/core/src/template-domain/state-renderer.ts` — implement `formatStateBar` (return string, no stderr write).
- `packages/core/src/cortex/loop.ts` — emit the state bar via `logToConsole` at `info`.
- `packages/core/src/cortex/loop.test.ts` — update `StateRenderer` stubs.

---

## Task 1: Level model (pure)

**Files:**
- Create: `packages/core/src/logging/levels.ts`
- Modify: `packages/core/src/logging/events.ts` (add type + field)
- Test: `packages/core/src/logging/levels.test.ts`

**Interfaces:**
- Produces: `type LogLevel = "debug"|"info"|"warn"|"error"` (declared in `events.ts`, re-exported from `levels.ts`); `rank(l: LogLevel): number`; `classifyLevel(e: UnifiedEvent): LogLevel`; `effectiveLevel(e: UnifiedEvent): LogLevel`; `passesThreshold(level: LogLevel, threshold: LogLevel): boolean`; `resolveThreshold(raw: string|undefined): LogLevel`. `EventBase` gains `level?: LogLevel`.

- [ ] **Step 1: Add `LogLevel` + `level?` to the event model**

In `packages/core/src/logging/events.ts`, add the type above `EventBase` and the optional field inside it:

```typescript
export type LogLevel = "debug" | "info" | "warn" | "error"

export interface EventBase {
  timestamp: string
  character: string
  system: string
  subsystem: string
  /** Optional explicit level; when absent, classifyLevel() supplies a default. */
  level?: LogLevel
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/logging/levels.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import type { UnifiedEvent } from "./events.js"
import { rank, classifyLevel, effectiveLevel, passesThreshold, resolveThreshold } from "./levels.js"

const base = { timestamp: "t", character: "c", system: "s", subsystem: "s" }

describe("rank", () => {
  it("orders debug < info < warn < error", () => {
    expect(rank("debug")).toBeLessThan(rank("info"))
    expect(rank("info")).toBeLessThan(rank("warn"))
    expect(rank("warn")).toBeLessThan(rank("error"))
  })
})

describe("classifyLevel", () => {
  it("maps error kind to error", () => {
    expect(classifyLevel({ ...base, kind: "error", message: "x" })).toBe("error")
  })
  it("maps thinking to debug", () => {
    expect(classifyLevel({ ...base, kind: "thinking", text: "x" })).toBe("debug")
  })
  it("maps system/text/tool to info", () => {
    expect(classifyLevel({ ...base, kind: "system", message: "x" })).toBe("info")
    expect(classifyLevel({ ...base, kind: "text", text: "x" })).toBe("info")
    expect(classifyLevel({ ...base, kind: "tool_use", tool: "bash", id: "1", input: {} })).toBe("info")
  })
})

describe("effectiveLevel", () => {
  it("prefers an explicit level over the classifier", () => {
    const e: UnifiedEvent = { ...base, kind: "system", message: "x", level: "debug" }
    expect(effectiveLevel(e)).toBe("debug")
  })
  it("falls back to classifyLevel when no level set", () => {
    expect(effectiveLevel({ ...base, kind: "system", message: "x" })).toBe("info")
  })
})

describe("passesThreshold", () => {
  it("passes when level >= threshold", () => {
    expect(passesThreshold("info", "info")).toBe(true)
    expect(passesThreshold("warn", "info")).toBe(true)
  })
  it("blocks when level < threshold", () => {
    expect(passesThreshold("debug", "info")).toBe(false)
  })
})

describe("resolveThreshold", () => {
  it("defaults to info for missing/invalid", () => {
    expect(resolveThreshold(undefined)).toBe("info")
    expect(resolveThreshold("loud")).toBe("info")
  })
  it("accepts valid levels case-insensitively", () => {
    expect(resolveThreshold("DEBUG")).toBe("debug")
    expect(resolveThreshold(" warn ")).toBe("warn")
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/logging/levels.test.ts`
Expected: FAIL — `Cannot find module './levels.js'`.

- [ ] **Step 4: Implement `levels.ts`**

Create `packages/core/src/logging/levels.ts`:

```typescript
import type { LogLevel, UnifiedEvent } from "./events.js"

export type { LogLevel }

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function rank(level: LogLevel): number {
  return RANK[level]
}

/** Default level for an event when no explicit level was set. */
export function classifyLevel(event: UnifiedEvent): LogLevel {
  switch (event.kind) {
    case "error":
      return "error"
    case "thinking":
      return "debug"
    case "system":
    case "text":
    case "tool_use":
    case "tool_result":
    case "subagent_start":
    case "subagent_stop":
      return "info"
  }
}

/** Resolve the effective level: an explicit override wins, else classify. */
export function effectiveLevel(event: UnifiedEvent): LogLevel {
  return event.level ?? classifyLevel(event)
}

/** True if an event at `level` should appear given the console `threshold`. */
export function passesThreshold(level: LogLevel, threshold: LogLevel): boolean {
  return rank(level) >= rank(threshold)
}

const VALID = new Set<string>(["debug", "info", "warn", "error"])

/** Parse a LOG_LEVEL env value into a console threshold; defaults to "info". */
export function resolveThreshold(raw: string | undefined): LogLevel {
  const v = raw?.trim().toLowerCase()
  return v && VALID.has(v) ? (v as LogLevel) : "info"
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/logging/levels.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm -C packages/core typecheck`
Expected: exit 0.

```bash
git add packages/core/src/logging/levels.ts packages/core/src/logging/levels.test.ts packages/core/src/logging/events.ts
git commit -m "feat(logging): add pure log-level model and classifier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire leveling into emit (threshold filter + JSONL level)

**Files:**
- Modify: `packages/core/src/logging/log-writer.ts`
- Test: `packages/core/src/logging/log-writer.test.ts` (create)

**Interfaces:**
- Consumes: `effectiveLevel`, `passesThreshold`, `resolveThreshold` from `./levels.js`.
- Produces: `logToConsole(character, source, message, level?: LogLevel)` (4th arg optional, backward compatible); emitted events written to JSONL now include a resolved `level` field; console output is suppressed for events below `LOG_LEVEL`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/logging/log-writer.test.ts`. It exercises the layer against a temp dir and spies on `console.log`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FileSystem } from "@effect/platform"
import * as os from "node:os"
import * as path from "node:path"
import { CharacterLog, CharacterLogLive, logToConsole } from "./log-writer.js"
import { ProjectRoot } from "../services/ProjectRoot.js"

let tmp: string
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmp = path.join(os.tmpdir(), `logtest-${process.hrtime.bigint()}`)
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  logSpy.mockRestore()
  delete process.env.LOG_LEVEL
})

const run = (eff: Effect.Effect<unknown, unknown, CharacterLog>) => {
  const layer = CharacterLogLive.pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, Layer.succeed(ProjectRoot, tmp))),
  )
  return Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<unknown, unknown, never>)
}

const readJsonl = (eff: Effect.Effect<unknown, unknown, CharacterLog>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* eff
      const fs = yield* FileSystem.FileSystem
      return yield* fs.readFileString(path.join(tmp, "players", "c", "logs", "events.jsonl"))
    }).pipe(
      Effect.provide(
        CharacterLogLive.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, Layer.succeed(ProjectRoot, tmp)))),
      ),
      Effect.provide(NodeFileSystem.layer),
    ) as Effect.Effect<string, unknown, never>,
  )

describe("CharacterLog emit", () => {
  it("writes the resolved level into the jsonl line", async () => {
    const contents = await readJsonl(logToConsole("c", "cortex", "hello"))
    const line = JSON.parse(contents.trim().split("\n").pop() as string)
    expect(line.level).toBe("info")
  })

  it("suppresses below-threshold events from console but still writes jsonl", async () => {
    process.env.LOG_LEVEL = "info"
    const contents = await readJsonl(logToConsole("c", "body", "docker ...", "debug"))
    const line = JSON.parse(contents.trim().split("\n").pop() as string)
    expect(line.level).toBe("debug")
    // a debug event must not have produced a console line under the info threshold
    expect(logSpy.mock.calls.flat().some((a) => String(a).includes("docker ..."))).toBe(false)
  })

  it("renders at-or-above-threshold events to console", async () => {
    process.env.LOG_LEVEL = "info"
    await run(logToConsole("c", "cortex", "decided"))
    expect(logSpy.mock.calls.flat().some((a) => String(a).includes("decided"))).toBe(true)
  })
})
```

> Note: `LOG_LEVEL` is read at layer construction, and `run`/`readJsonl` build a fresh layer per call, so setting `process.env.LOG_LEVEL` before the call takes effect.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/logging/log-writer.test.ts`
Expected: FAIL — `logToConsole` rejects a 4th arg / `line.level` is `undefined`.

- [ ] **Step 3: Implement the wiring**

In `packages/core/src/logging/log-writer.ts`, add the import and rewrite `emit` + `logToConsole`. Replace lines 6-8 imports block to add levels, and update the `emit` body and `logToConsole`:

```typescript
import type { LogLevel, UnifiedEvent } from "./events.js"
import { eventBase } from "./events.js"
import { renderEvent } from "./console-renderer.js"
import { effectiveLevel, passesThreshold, resolveThreshold } from "./levels.js"
```

Inside `CharacterLogLive`'s `Effect.gen`, after `const projectRoot = yield* ProjectRoot`, add:

```typescript
    const threshold = resolveThreshold(process.env.LOG_LEVEL)
```

Replace the `emit` implementation body (the `Effect.gen` from "1. Render to console" through the JSONL write) with:

```typescript
      emit: (char, event) =>
        Effect.gen(function* () {
          const level = effectiveLevel(event)
          const leveled = { ...event, level } as UnifiedEvent

          // 1. Render to console, threshold-filtered
          if (passesThreshold(level, threshold)) {
            const lines = renderEvent(leveled)
            for (const line of lines) {
              console.log(line)
            }
          }

          // 2. Append the full event (with resolved level) to events.jsonl
          const logDir = path.resolve(projectRoot, "players", char.name, "logs")
          yield* fs.makeDirectory(logDir, { recursive: true }).pipe(
            Effect.catchAll(() => Effect.void),
          )
          const filePath = path.join(logDir, "events.jsonl")
          const jsonLine = JSON.stringify(leveled) + "\n"
          yield* fs.writeFileString(filePath, jsonLine, { flag: "a" }).pipe(
            Effect.mapError((e) => new LogWriterError("Failed to write to events.jsonl", e)),
          )
        }),
```

Update `logToConsole` to accept an optional level:

```typescript
export const logToConsole = (
  character: string,
  source: string,
  message: string,
  level?: LogLevel,
) =>
  Effect.gen(function* () {
    const log = yield* CharacterLog
    yield* log.emit(
      { name: character, dir: "" } as CharacterConfig,
      { ...eventBase(character, source, source), kind: "system", message, ...(level ? { level } : {}) },
    )
  })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/logging/log-writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm -C packages/core typecheck`
Expected: exit 0.

```bash
git add packages/core/src/logging/log-writer.ts packages/core/src/logging/log-writer.test.ts
git commit -m "feat(logging): level-filter console and record level in jsonl

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Fix OpenCode tool field paths + replace the fake fixture

**Files:**
- Modify: `packages/core/src/logging/stream-normalizer.ts:81-88`
- Test: `packages/core/src/logging/stream-normalizer.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `normalizeOpenCode` now reads the real OpenCode Part shape (`part.tool`, `part.state.input`).

- [ ] **Step 1: Replace the fake fixture with the real shape (failing test)**

In `packages/core/src/logging/stream-normalizer.test.ts`, find the OpenCode `tool_use` test (around line 88, feeding `part: { id, name, input }`) and replace that input object with the real shape, asserting extracted name/input:

```typescript
  it("extracts tool name and input from the real opencode part shape", () => {
    const events = normalizeOpenCode({
      type: "tool_use",
      part: {
        type: "tool",
        id: "prt_abc",
        tool: "bash",
        callID: "4edb9b0f",
        state: {
          status: "completed",
          input: { command: "ls", description: "list" },
          output: "...",
        },
      },
    })
    expect(events).toEqual([
      { type: "tool_use", id: "prt_abc", name: "bash", input: { command: "ls", description: "list" } },
    ])
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/logging/stream-normalizer.test.ts -t "real opencode part"`
Expected: FAIL — `name` is `""` and `input` is `{}` (current code reads `part.name`/`part.input`).

- [ ] **Step 3: Fix the normalizer**

In `packages/core/src/logging/stream-normalizer.ts`, replace the `tool_use` branch in `normalizeOpenCode` (lines 81-88) with:

```typescript
  if (type === "tool_use") {
    const state = part?.state as RawEvent | undefined
    return [{
      type: "tool_use",
      id: (part?.id as string) ?? "",
      name: (part?.tool as string) ?? "",
      input: (state?.input as Record<string, unknown>) ?? {},
    }]
  }
```

- [ ] **Step 4: Run the full normalizer test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/logging/stream-normalizer.test.ts`
Expected: PASS (new case green; no regressions).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm -C packages/core typecheck`
Expected: exit 0.

```bash
git add packages/core/src/logging/stream-normalizer.ts packages/core/src/logging/stream-normalizer.test.ts
git commit -m "fix(logging): read opencode tool name/input from real part shape

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Mapper level assignments + visible warn/error rendering

**Files:**
- Modify: `packages/core/src/logging/events.ts` (`toUnifiedEvents`)
- Modify: `packages/core/src/logging/console-renderer.ts`
- Test: `packages/core/src/logging/events.test.ts` (create), and extend `console-renderer` coverage inline in that file.

**Interfaces:**
- Consumes: `effectiveLevel` from `./levels.js` (in the renderer).
- Produces: runtime-lifecycle events (`init`, `passthrough`) carry `level: "debug"`; `rate_limit` carries `level: "warn"`. `renderEvent` prefixes warn/error lines with a marker and no longer dims errors.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/logging/events.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { toUnifiedEvents } from "./events.js"
import { renderEvent } from "./console-renderer.js"

describe("toUnifiedEvents level assignment", () => {
  it("marks opencode init (system) as debug", () => {
    const [e] = toUnifiedEvents([{ type: "system" }], "c", "body", "opencode")
    expect(e.level).toBe("debug")
  })
  it("marks passthrough as debug", () => {
    const [e] = toUnifiedEvents([{ type: "passthrough", rawType: "weird" }], "c", "body", "opencode")
    expect(e.level).toBe("debug")
  })
  it("marks rate_limit as warn", () => {
    const [e] = toUnifiedEvents([{ type: "rate_limit", status: "throttled" }], "c", "body", "claude")
    expect(e.level).toBe("warn")
  })
})

describe("renderEvent visibility", () => {
  const base = { timestamp: "t", character: "c", system: "s", subsystem: "s" }
  it("does not dim errors and adds an error marker", () => {
    const out = renderEvent({ ...base, kind: "error", message: "boom" }).join("")
    expect(out).toContain("✖")
    expect(out).not.toContain("\x1b[2m") // no DIM
  })
  it("adds a warn marker for warn-level events", () => {
    const out = renderEvent({ ...base, kind: "system", message: "parse failure", level: "warn" }).join("")
    expect(out).toContain("⚠")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/logging/events.test.ts`
Expected: FAIL — `level` undefined on mapped events; no markers; error line still contains DIM.

- [ ] **Step 3: Assign levels in the mapper**

In `packages/core/src/logging/events.ts`, update the three cases in `toUnifiedEvents`:

```typescript
      case "system":
        return { ...base, kind: "system", message: e.model ? `init model=${e.model}` : "init", level: "debug" }
```
```typescript
      case "rate_limit":
        return { ...base, kind: "error", message: `rate_limit: ${e.status}`, level: "warn" }
```
```typescript
      case "passthrough":
        return { ...base, kind: "system", message: e.rawType, level: "debug" }
```

- [ ] **Step 4: Add the marker + undim errors in the renderer**

In `packages/core/src/logging/console-renderer.ts`, add the import at the top (after the existing `import type { UnifiedEvent }`):

```typescript
import { effectiveLevel } from "./levels.js"
```

Add a helper above `renderEvent`:

```typescript
function levelMarker(event: UnifiedEvent): string {
  const lvl = effectiveLevel(event)
  if (lvl === "error") return "✖ "
  if (lvl === "warn") return "⚠ "
  return ""
}
```

Update the `system` case to prefix the marker:

```typescript
    case "system":
      return event.message.split("\n").map(line => `${t} ${levelMarker(event)}${line}`)
```

Replace the `error` case (drop `DIM`, add marker):

```typescript
    case "error":
      return [`${t} ${levelMarker(event)}error: ${event.message}`]
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/logging/events.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm -C packages/core typecheck`
Expected: exit 0.

```bash
git add packages/core/src/logging/events.ts packages/core/src/logging/console-renderer.ts packages/core/src/logging/events.test.ts
git commit -m "feat(logging): demote lifecycle noise to debug, surface warn/error

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Call-site level overrides (body→debug, parse-failure→warn)

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/process-runner.ts` (docker-exec command logs, ~lines 63-67, 101-104, 180-183)
- Modify: `packages/core/src/core/limbic/hypothalamus/transport.ts:147-153` (heartbeat)
- Modify: `packages/core/src/cortex/tiers.ts:153-161` (orient parse failure)

**Interfaces:**
- Consumes: `logToConsole(..., level?)` from Task 2.
- Produces: behavior change only — these events now classify below/above default visibility.

> These are level-tagging changes on existing log calls; their effect (suppressed/surfaced) is already covered by Task 2's threshold test. No new unit test is added; verification is by typecheck + a targeted grep that the 4th arg is present.

- [ ] **Step 1: Tag the docker-exec command logs as debug**

In `process-runner.ts`, each of the three `logToConsole(config.char.name, config.role, \`docker ${redactedArgs.join(" ")}\`)` calls (around lines 63-67, 101-104, 180-183) gains a `, "debug"` final argument. Example:

```typescript
yield* logToConsole(config.char.name, config.role, `docker ${redactedArgs.join(" ")}`, "debug")
```

Apply the identical 4th-arg addition to all three call sites (the surrounding code differs slightly — SDK runner / OpenCode session runner — but each ends with the same `logToConsole(... )` shape).

- [ ] **Step 2: Tag the heartbeat as debug**

In `transport.ts` (around lines 147-153), the heartbeat log:

```typescript
      const heartbeatFiber = yield* runHeartbeat(lastActivityAt, heartbeatMs, (silentSeconds) =>
        logToConsole(
          input.char.name,
          input.role,
          `still running — no output for ${silentSeconds}s (awaiting model/tool)`,
          "debug",
        ),
      ).pipe(Effect.fork)
```

- [ ] **Step 3: Tag the orient parse failure as warn**

In `tiers.ts` (around lines 153-161), the parse-failure log:

```typescript
    return logToConsole(
      config.char.name,
      "cortex",
      `tier=forebrain step=orient parse failure; raw output: ${truncated}`,
      "warn",
    ).pipe(
      Effect.catchAll(() => Effect.void),
      Effect.as<OrientResult>(fallback),
    )
```

- [ ] **Step 4: Verify the edits and typecheck**

Run: `grep -n "\"debug\")" packages/core/src/core/limbic/hypothalamus/process-runner.ts packages/core/src/core/limbic/hypothalamus/transport.ts`
Expected: the docker-command and heartbeat calls show the `"debug"` argument (4 matches total: 3 in process-runner, 1 in transport).

Run: `pnpm -C packages/core typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/process-runner.ts packages/core/src/core/limbic/hypothalamus/transport.ts packages/core/src/cortex/tiers.ts
git commit -m "feat(logging): demote docker/heartbeat to debug, raise parse failure to warn

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Status bar → leveled info line (kill the stderr collision)

**Files:**
- Modify: `packages/core/src/core/state-renderer.ts:17` (interface)
- Modify: `packages/domain-spacemolt/src/renderer.ts:24-34`
- Modify: `packages/domain-github/src/renderer.ts:136-159`
- Modify: `packages/core/src/template-domain/state-renderer.ts:133-142`
- Modify: `packages/core/src/cortex/loop.ts:163`
- Modify: `packages/core/src/cortex/loop.test.ts` (stubs at ~127, 512, 569)

**Interfaces:**
- Consumes: `logToConsole` (existing) at the loop call site.
- Produces: `StateRenderer.formatStateBar(metrics: Record<string, string | number | boolean>): string` replacing `logStateBar(name, metrics): void`. Returns the joined metric body (no `[name]` prefix — the log tag adds the character); empty string when there are no parts.

- [ ] **Step 1: Change the interface (failing typecheck drives the rest)**

In `packages/core/src/core/state-renderer.ts`, replace line 17:

```typescript
  formatStateBar(metrics: Record<string, string | number | boolean>): string
```

- [ ] **Step 2: Run typecheck to see the breakage surface**

Run: `pnpm -C packages/core typecheck`
Expected: FAIL across the three implementors, `loop.ts`, and `loop.test.ts` (missing/renamed member). This is the worklist for the remaining steps.

- [ ] **Step 3: Implement spacemolt**

In `packages/domain-spacemolt/src/renderer.ts`, replace the `logStateBar` method (lines 24-34) with:

```typescript
  formatStateBar(metrics) {
    const parts: string[] = []
    if (metrics.situationType) parts.push(`${metrics.situationType}`)
    if (metrics.inCombat) parts.push("COMBAT")
    if (typeof metrics.fuel === "number") parts.push(`fuel:${Math.round(metrics.fuel * 100)}%`)
    if (typeof metrics.hull === "number") parts.push(`hull:${Math.round(metrics.hull * 100)}%`)
    if (metrics.cargoUsed !== undefined) parts.push(`cargo:${metrics.cargoUsed}/${metrics.cargoCapacity}`)
    return parts.join(" ")
  },
```

- [ ] **Step 4: Implement github**

In `packages/domain-github/src/renderer.ts`, replace the module function `logStateBar` (lines 136-144) and the object method (lines 156-158). Delete the standalone `logStateBar` function and make the method self-contained:

```typescript
  formatStateBar(metrics) {
    const parts: string[] = []
    if (metrics.totalRepos !== undefined) parts.push(`repos:${metrics.totalRepos}`)
    if (metrics.openIssues !== undefined) parts.push(`issues:${metrics.openIssues}`)
    if (metrics.openPRs !== undefined) parts.push(`PRs:${metrics.openPRs}`)
    if (metrics.ciFailingRepos !== undefined && Number(metrics.ciFailingRepos) > 0) parts.push(`CI-fail:${metrics.ciFailingRepos}`)
    return parts.join(" ")
  },
```

- [ ] **Step 5: Implement template-domain**

In `packages/core/src/template-domain/state-renderer.ts`, replace the `logStateBar` method (lines 133-142) — preserve this file's tabs+semicolons style:

```typescript
	formatStateBar(metrics) {
		const parts: string[] = [];
		if (metrics.situationType) parts.push(`${metrics.situationType}`);
		if (typeof metrics.pendingCount === "number") parts.push(`pending:${metrics.pendingCount}`);
		if (typeof metrics.completedThisSession === "number")
			parts.push(`done:${metrics.completedThisSession}`);
		if (metrics.hasUrgentDeadline) parts.push("URGENT");
		if (metrics.isOverloaded) parts.push("OVERLOADED");
		return parts.join(" | ");
	},
```

- [ ] **Step 6: Emit the bar through the pipeline at the loop**

In `packages/core/src/cortex/loop.ts`, replace line 163:

```typescript
      const bar = renderer.formatStateBar(summary.metrics)
      if (bar) yield* logToConsole(config.char.name, "state", bar)
```

(`logToConsole` is already imported in this file.)

- [ ] **Step 7: Update the test stubs**

In `packages/core/src/cortex/loop.test.ts`, replace each `logStateBar: () => {},` stub (around lines 127, 512, 569) with:

```typescript
        formatStateBar: () => "",
```

- [ ] **Step 8: Run typecheck + the loop tests**

Run: `pnpm -C packages/core typecheck`
Expected: exit 0 (all implementors + loop + stubs updated).

Run: `pnpm exec vitest run packages/core/src/cortex/loop.test.ts`
Expected: PASS.

Run: `grep -rn "process.stderr.write" packages/domain-spacemolt/src/renderer.ts packages/domain-github/src/renderer.ts packages/core/src/template-domain/state-renderer.ts`
Expected: no matches (the `\r` stderr writes are gone).

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/core/state-renderer.ts packages/domain-spacemolt/src/renderer.ts packages/domain-github/src/renderer.ts packages/core/src/template-domain/state-renderer.ts packages/core/src/cortex/loop.ts packages/core/src/cortex/loop.test.ts
git commit -m "fix(logging): route state bar through the leveled pipeline, drop stderr \\r

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run: `pnpm exec vitest run`
Expected: PASS, except the two **pre-existing** `handles.test.ts` failures unrelated to logging (conscious tier model = `gemma-4-31b-it-8bit` vs the test's expected `Qwen3.5-122B-A10B-4bit`, and `isReasoningModel` mismatch). Confirm no *new* failures were introduced; if any logging-related test fails, fix it before proceeding.

- [ ] **Step 2: Smoke-check the level filter end to end (optional, manual)**

If a live run is convenient: `LOG_LEVEL=debug` shows docker commands + heartbeats + init; default (unset/`info`) shows the cortex/tool/lifecycle narrative with real tool names and no `init` flood; `LOG_LEVEL=warn` shows only warnings/errors. JSONL contains every event with a `level` field regardless.

- [ ] **Step 3: Final commit (if any verification fixups were made)**

```bash
git add -A
git commit -m "test(logging): verify full suite after leveled-logging changes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
