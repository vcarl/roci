# Unified Event Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 4-file logging pipeline with a single `emit()` call that writes to `events.jsonl` and renders to stdout, capturing all activity including subagent tool calls.

**Architecture:** New `UnifiedEvent` type flows through a rewritten `CharacterLog.emit()` method. `logToConsole` becomes a wrapper around emit. Stream-json events are adapted via `toUnifiedEvents`. A tail fiber reads activity.log from the mounted volume for subagent visibility.

**Tech Stack:** Effect, Node.js fs, existing ANSI rendering utilities

---

### Task 1: Create UnifiedEvent type and adapter

**Files:**
- Create: `packages/core/src/logging/events.ts`

- [ ] **Step 1: Create the UnifiedEvent type**

```typescript
// packages/core/src/logging/events.ts

import type { InternalEvent } from "./stream-normalizer.js"

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

/** Build an EventBase with current timestamp. */
export function eventBase(character: string, system: string, subsystem: string): EventBase {
  return { timestamp: new Date().toISOString(), character, system, subsystem }
}

/** Map InternalEvents (from stream-normalizer) to UnifiedEvents. */
export function toUnifiedEvents(
  events: InternalEvent[],
  character: string,
  system: string,
  subsystem: string,
): UnifiedEvent[] {
  const base = eventBase(character, system, subsystem)
  return events.map((e): UnifiedEvent => {
    switch (e.type) {
      case "system":
        return { ...base, kind: "system", message: e.model ? `init model=${e.model}` : "init" }
      case "thinking":
        return { ...base, kind: "thinking", text: e.text }
      case "text":
        return { ...base, kind: "text", text: e.text }
      case "tool_use":
        return { ...base, kind: "tool_use", tool: e.name, id: e.id, input: e.input }
      case "tool_result":
        return { ...base, kind: "tool_result", toolUseId: e.toolUseId, text: e.text }
      case "rate_limit":
        return { ...base, kind: "error", message: `rate_limit: ${e.status}` }
      case "error":
        return { ...base, kind: "error", message: e.message }
      case "passthrough":
        return { ...base, kind: "system", message: e.rawType }
    }
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/logging/events.ts
git commit -m "feat: add UnifiedEvent type and InternalEvent adapter"
```

---

### Task 2: Rewrite console-renderer with renderEvent

**Files:**
- Modify: `packages/core/src/logging/console-renderer.ts`

This task rewrites console-renderer to export a pure `renderEvent` function. The existing `tag`, `colorFor`, `name` helpers stay. Everything else is replaced.

- [ ] **Step 1: Rewrite console-renderer.ts**

Keep: `RESET`, `DIM`, `BOLD`, `PLAYER_COLORS`, `colorCache`, `nextColorIdx`, `colorFor`, `tag`, `name`.

Delete everything after `name()` and replace with:

```typescript
import type { UnifiedEvent } from "./events.js"

/** Tools whose results are suppressed from console (the tool_use line already shows the command). */
const SUPPRESS_RESULT_TOOLS = new Set(["Bash", "Read", "Glob", "Grep", "Write", "Edit"])

/** Track tool_use id → tool name so we can decide how to display results. */
const toolUseRegistry = new Map<string, string>()

const MAX_HEAD = 5
const MAX_TAIL = 3

/** Render a UnifiedEvent into console-ready lines (with ANSI codes). */
export function renderEvent(event: UnifiedEvent): string[] {
  const t = tag(event.character, event.subsystem)
  const n = name(event.character)

  switch (event.kind) {
    case "system":
      return event.message.split("\n").map(line => `${t} ${line}`)

    case "text": {
      const lines = event.text.split("\n").filter(l => l.trim().length > 0)
      return lines.map(line => `${n}: ${line.trim()}`)
    }

    case "thinking": {
      const lines = event.text.split("\n").filter(l => l.trim().length > 0)
      const prefix = tag(event.character, "thinking")
      return lines.map(line => `${prefix} ${DIM}${line.trim()}${RESET}`)
    }

    case "tool_use": {
      toolUseRegistry.set(event.id, event.tool)
      const desc = (event.input as Record<string, unknown>)?.description as string
        ?? (event.input as Record<string, unknown>)?.command as string
        ?? ""
      const summary = desc.length > 120 ? desc.slice(0, 120) + "..." : desc
      return [`${t} ${event.tool}: ${summary}`]
    }

    case "tool_result": {
      const toolName = toolUseRegistry.get(event.toolUseId)
      if (toolName && SUPPRESS_RESULT_TOOLS.has(toolName)) return []

      const lines = event.text.split("\n").filter(l => l.trim().length > 0)
      if (lines.length === 0) return []

      const c = colorFor(event.character)
      const prefix = `${c}  >${RESET}`

      if (lines.length <= MAX_HEAD + MAX_TAIL) {
        return lines.map(line => `${prefix} ${line}`)
      }
      return [
        ...lines.slice(0, MAX_HEAD).map(line => `${prefix} ${line}`),
        `${prefix} ${DIM}... (${lines.length - MAX_HEAD - MAX_TAIL} lines omitted)${RESET}`,
        ...lines.slice(-MAX_TAIL).map(line => `${prefix} ${line}`),
      ]
    }

    case "subagent_start": {
      const c = colorFor(event.character)
      return [`${c}>> subagent start${RESET} — ${event.description}`]
    }

    case "subagent_stop":
      return [`${colorFor(event.character)}<< subagent stop${RESET}`]

    case "error":
      return [`${t} ${DIM}error: ${event.message}${RESET}`]
  }
}

/** Convenience: build a system event and emit it. Requires CharacterLog in scope. */
export const logToConsole = (
  character: string,
  source: string,
  message: string,
) => {
  // Lazy import to avoid circular dependency — CharacterLog imports from this file for tag/renderEvent
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CharacterLog } = require("./log-writer.js") as typeof import("./log-writer.js")
  const { eventBase } = require("./events.js") as typeof import("./events.js")
  return Effect.gen(function* () {
    const log = yield* CharacterLog
    yield* log.emit(
      { name: character, dir: "" } as CharacterConfig,
      { ...eventBase(character, source, source), kind: "system", message },
    )
  })
}
```

Wait — there's a circular dependency problem. `logToConsole` needs `CharacterLog` (from log-writer), and `CharacterLog.emit` calls `renderEvent` (from console-renderer). Let me restructure.

The solution: `logToConsole` doesn't import CharacterLog. Instead, it stays as a direct console.log + file append. OR, we split differently: `renderEvent` lives in its own file with no imports from log-writer, and log-writer imports from it.

Let me revise. The clean split:
- `events.ts` — types + adapter (no dependencies on other logging files)
- `console-renderer.ts` — `renderEvent` pure function + `tag`/`colorFor` helpers (imports only events.ts)
- `log-writer.ts` — `CharacterLog.emit` (imports events.ts + console-renderer.ts)
- `logToConsole` lives in log-writer.ts as a convenience export (no circular dep)

- [ ] **Step 1: Rewrite console-renderer.ts**

Replace the entire file. Keep the ANSI color infrastructure, replace all the log functions with `renderEvent`:

```typescript
// packages/core/src/logging/console-renderer.ts

import type { UnifiedEvent } from "./events.js"

// ── Per-player ANSI colors ───────────────────────────────

const RESET = "\x1b[0m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"

const PLAYER_COLORS: string[] = [
  "\x1b[36m",  // cyan
  "\x1b[33m",  // yellow
  "\x1b[35m",  // magenta
  "\x1b[32m",  // green
  "\x1b[34m",  // blue
  "\x1b[91m",  // bright red
]

const colorCache = new Map<string, string>()
let nextColorIdx = 0

export function colorFor(character: string): string {
  let c = colorCache.get(character)
  if (!c) {
    c = PLAYER_COLORS[nextColorIdx % PLAYER_COLORS.length]
    nextColorIdx++
    colorCache.set(character, c)
  }
  return c
}

/** Colorized character tag: "[name:subsystem]" */
export function tag(character: string, subsystem: string): string {
  const c = colorFor(character)
  return `${c}[${character}:${subsystem}]${RESET}`
}

function charName(character: string): string {
  const c = colorFor(character)
  return `${c}${BOLD}${character}${RESET}`
}

// ── Rendering ────────────────────────────────────────────

const SUPPRESS_RESULT_TOOLS = new Set(["Bash", "Read", "Glob", "Grep", "Write", "Edit"])
const toolUseRegistry = new Map<string, string>()
const MAX_HEAD = 5
const MAX_TAIL = 3

/** Render a UnifiedEvent into ANSI-colored console lines. */
export function renderEvent(event: UnifiedEvent): string[] {
  const t = tag(event.character, event.subsystem)

  switch (event.kind) {
    case "system":
      return event.message.split("\n").map(line => `${t} ${line}`)

    case "text": {
      const lines = event.text.split("\n").filter(l => l.trim().length > 0)
      const prefix = `${charName(event.character)}:`
      return lines.map(line => `${prefix} ${line.trim()}`)
    }

    case "thinking": {
      const lines = event.text.split("\n").filter(l => l.trim().length > 0)
      const prefix = tag(event.character, "thinking")
      return lines.map(line => `${prefix} ${DIM}${line.trim()}${RESET}`)
    }

    case "tool_use": {
      toolUseRegistry.set(event.id, event.tool)
      const input = event.input as Record<string, unknown> | undefined
      const desc = (input?.description as string) ?? (input?.command as string) ?? ""
      const summary = desc.length > 120 ? desc.slice(0, 120) + "..." : desc
      return [`${t} ${event.tool}: ${summary}`]
    }

    case "tool_result": {
      const toolName = toolUseRegistry.get(event.toolUseId)
      if (toolName && SUPPRESS_RESULT_TOOLS.has(toolName)) return []
      const lines = event.text.split("\n").filter(l => l.trim().length > 0)
      if (lines.length === 0) return []
      const c = colorFor(event.character)
      const prefix = `${c}  >${RESET}`
      if (lines.length <= MAX_HEAD + MAX_TAIL) {
        return lines.map(line => `${prefix} ${line}`)
      }
      return [
        ...lines.slice(0, MAX_HEAD).map(line => `${prefix} ${line}`),
        `${prefix} ${DIM}... (${lines.length - MAX_HEAD - MAX_TAIL} lines omitted)${RESET}`,
        ...lines.slice(-MAX_TAIL).map(line => `${prefix} ${line}`),
      ]
    }

    case "subagent_start": {
      const c = colorFor(event.character)
      return [`${c}>> subagent start${RESET} — ${event.description}`]
    }

    case "subagent_stop":
      return [`${colorFor(event.character)}<< subagent stop${RESET}`]

    case "error":
      return [`${t} ${DIM}error: ${event.message}${RESET}`]
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/logging/console-renderer.ts
git commit -m "refactor: rewrite console-renderer with renderEvent pure function"
```

---

### Task 3: Rewrite log-writer with single emit + logToConsole

**Files:**
- Modify: `packages/core/src/logging/log-writer.ts`

- [ ] **Step 1: Rewrite log-writer.ts**

Replace the entire file:

```typescript
// packages/core/src/logging/log-writer.ts

import { Context, Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { ProjectRoot } from "../services/ProjectRoot.js"
import type { UnifiedEvent } from "./events.js"
import { eventBase } from "./events.js"
import { renderEvent } from "./console-renderer.js"

export class LogWriterError {
  readonly _tag = "LogWriterError"
  constructor(readonly message: string, readonly cause?: unknown) {}
  toString() { return this.message }
}

export class CharacterLog extends Context.Tag("CharacterLog")<
  CharacterLog,
  {
    readonly emit: (char: CharacterConfig, event: UnifiedEvent) => Effect.Effect<void, LogWriterError>
  }
>() {}

export const CharacterLogLive = Layer.effect(
  CharacterLog,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const projectRoot = yield* ProjectRoot

    return CharacterLog.of({
      emit: (char, event) =>
        Effect.gen(function* () {
          // 1. Render to console
          const lines = renderEvent(event)
          for (const line of lines) {
            console.log(line)
          }

          // 2. Append to events.jsonl
          const logDir = path.resolve(projectRoot, "players", char.name, "logs")
          yield* fs.makeDirectory(logDir, { recursive: true }).pipe(
            Effect.catchAll(() => Effect.void),
          )
          const filePath = path.join(logDir, "events.jsonl")
          const jsonLine = JSON.stringify(event) + "\n"
          yield* fs.writeFileString(filePath, jsonLine, { flag: "a" }).pipe(
            Effect.mapError((e) => new LogWriterError(`Failed to write to events.jsonl`, e)),
          )
        }),
    })
  }),
)

/**
 * Convenience: build a system event and emit it.
 * Drop-in replacement for the old logToConsole — same 3-arg signature.
 * The `source` arg maps to both `system` and `subsystem` for backward compat.
 * Call sites can be updated later to pass a more specific subsystem.
 */
export const logToConsole = (
  character: string,
  source: string,
  message: string,
) =>
  Effect.gen(function* () {
    const log = yield* CharacterLog
    yield* log.emit(
      { name: character, dir: "" } as CharacterConfig,
      { ...eventBase(character, source, source), kind: "system", message },
    )
  })
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/logging/log-writer.ts
git commit -m "refactor: rewrite log-writer with single emit method + logToConsole wrapper"
```

---

### Task 4: Update session-runner to use emit

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/session-runner.ts`

- [ ] **Step 1: Update imports**

Replace:
```typescript
import { normalizeClaude } from "../../../logging/stream-normalizer.js"
import { demuxEvents, printRaw } from "../../../logging/log-demux.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { logToConsole } from "../../../logging/console-renderer.js"
```

With:
```typescript
import { normalizeClaude } from "../../../logging/stream-normalizer.js"
import { toUnifiedEvents, eventBase } from "../../../logging/events.js"
import { CharacterLog, logToConsole } from "../../../logging/log-writer.js"
```

- [ ] **Step 2: Update the streamFiber**

Replace the stdout stream processing (the `Stream.mapEffect` block inside the streamFiber) from:
```typescript
Stream.mapEffect((line) =>
  Effect.gen(function* () {
    yield* log.raw(config.char, line).pipe(Effect.catchAll(() => Effect.void))
    const raw = parseStreamJson(line)
    if (raw) {
      const events = normalizeClaude(raw)
      yield* demuxEvents(config.char, events, "body")
    } else {
      printRaw(config.char.name, "session", line)
    }
  }),
),
```

With:
```typescript
Stream.mapEffect((line) =>
  Effect.gen(function* () {
    const raw = parseStreamJson(line)
    if (raw) {
      const internal = normalizeClaude(raw)
      const unified = toUnifiedEvents(internal, config.char.name, "session", "claude")
      for (const event of unified) {
        yield* log.emit(config.char, event).pipe(Effect.catchAll(() => Effect.void))
      }
    } else if (line.trim()) {
      yield* log.emit(config.char, {
        ...eventBase(config.char.name, "session", "claude"),
        kind: "system",
        message: line,
      }).pipe(Effect.catchAll(() => Effect.void))
    }
  }),
),
```

- [ ] **Step 3: Update logToConsole calls**

Update the `logToConsole` calls in this file. The import now comes from `log-writer.ts` instead of `console-renderer.ts`. The signature is the same — no call site changes needed beyond the import.

- [ ] **Step 4: Verify it compiles**

Run: `cd packages/core && npx tsc --noEmit`
Expected: type errors in files that still import old APIs (log-demux, old CharacterLog methods), but session-runner itself should be clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/session-runner.ts
git commit -m "refactor: session-runner uses unified emit instead of demuxEvents"
```

---

### Task 5: Update process-runner to use emit

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/process-runner.ts`

- [ ] **Step 1: Update imports**

Replace:
```typescript
import { normalizeClaude, normalizeOpenCode } from "../../../logging/stream-normalizer.js"
import { demuxEvents, printRaw } from "../../../logging/log-demux.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { logToConsole } from "../../../logging/console-renderer.js"
```

With:
```typescript
import { normalizeClaude, normalizeOpenCode } from "../../../logging/stream-normalizer.js"
import { toUnifiedEvents, eventBase } from "../../../logging/events.js"
import { CharacterLog, logToConsole } from "../../../logging/log-writer.js"
```

- [ ] **Step 2: Update the streamFiber**

Replace the stdout stream processing from:
```typescript
Stream.mapEffect((line) =>
  Effect.gen(function* () {
    yield* log.raw(config.char, line)

    const raw = parseStreamJson(line)
    if (raw) {
      const events = normalize(raw)
      yield* demuxEvents(config.char, events, source, textAccumulator)
    } else {
      printRaw(config.char.name, "raw", line)
    }
  }),
),
```

With:
```typescript
Stream.mapEffect((line) =>
  Effect.gen(function* () {
    const raw = parseStreamJson(line)
    if (raw) {
      const internal = normalize(raw)
      const system = config.role === "brain" ? "brain" : config.role
      const unified = toUnifiedEvents(internal, config.char.name, system, "claude")
      for (const event of unified) {
        yield* log.emit(config.char, event)
        if (textAccumulator && event.kind === "text") {
          yield* Ref.update(textAccumulator, (arr) => [...arr, event.text])
        }
      }
    } else if (line.trim()) {
      yield* log.emit(config.char, {
        ...eventBase(config.char.name, config.role, "claude"),
        kind: "system",
        message: line,
      })
    }
  }),
),
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/process-runner.ts
git commit -m "refactor: process-runner uses unified emit instead of demuxEvents"
```

---

### Task 6: Update all logToConsole import sites

**Files:**
- Modify: every file that imports `logToConsole` from `console-renderer.ts`

The import path changes from `console-renderer.js` to `log-writer.js`. The function signature is identical — no call site logic changes.

- [ ] **Step 1: Update imports in core package**

Files to update (change `import { logToConsole } from "...console-renderer.js"` to `import { logToConsole } from "...log-writer.js"`):

- `packages/core/src/core/phase-runner.ts` — `import { logToConsole } from "../logging/log-writer.js"`
- `packages/core/src/core/orchestrator/channel-session.ts` — `import { logToConsole } from "../../logging/log-writer.js"` (also remove `CharacterLog` import if it came from log-writer already, merge into one)
- `packages/core/src/core/orchestrator/planned-action.ts` — `import { logToConsole } from "../../logging/log-writer.js"`
- `packages/core/src/services/OAuthToken.ts` — `import { logToConsole } from "../logging/log-writer.js"`

- [ ] **Step 2: Update imports in domain packages**

- `packages/domain-spacemolt/src/phases.ts` — `import { logToConsole } from "@roci/core/logging/log-writer.js"`
- `packages/domain-github/src/phases.ts` — `import { logToConsole } from "@roci/core/logging/log-writer.js"`

- [ ] **Step 3: Update channel-session.ts CharacterLog usage**

`channel-session.ts` imports `CharacterLog` for `log.action()` calls. These need to change to `log.emit()`. Find the one call at line 90:

Replace:
```typescript
import { CharacterLog } from "../../logging/log-writer.js"
import { logToConsole } from "../../logging/console-renderer.js"
```
With:
```typescript
import { CharacterLog, logToConsole } from "../../logging/log-writer.js"
```

The `CharacterLog` is yielded but only used for the `log` variable in channel-session — and that variable is only used inside `demuxEvents` calls that no longer exist. Remove the `const log = yield* CharacterLog` line if it's no longer referenced.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/core/phase-runner.ts packages/core/src/core/orchestrator/channel-session.ts packages/core/src/core/orchestrator/planned-action.ts packages/core/src/services/OAuthToken.ts packages/domain-spacemolt/src/phases.ts packages/domain-github/src/phases.ts
git commit -m "refactor: update logToConsole imports to use log-writer"
```

---

### Task 7: Update direct CharacterLog consumers

**Files:**
- Modify: `packages/domain-spacemolt/src/dinner.ts`
- Modify: `packages/core/src/core/limbic/hippocampus/dream.ts`
- Modify: `packages/domain-spacemolt/src/phases.ts`
- Modify: `packages/domain-github/src/phases.ts`
- Modify: `packages/core/src/core/character-scaffold.ts`
- Modify: `packages/core/src/core/limbic/hypothalamus/timeout-summarizer.ts`

These files call `log.thought()`, `log.action()`, or `log.word()` directly. Each needs to change to `log.emit()` with a `UnifiedEvent`.

- [ ] **Step 1: Update dinner.ts**

Replace `log.thought(input.char, { timestamp, source, character, type: "text", text })` calls with:

```typescript
import { eventBase } from "@roci/core/logging/events.js"

// Replace each log.thought call:
yield* log.emit(input.char, {
  ...eventBase(input.char.name, "orchestrator", "dinner"),
  kind: "text",
  text: responseText,
})
```

- [ ] **Step 2: Update dream.ts**

Same pattern — replace `log.thought()` with `log.emit()`:

```typescript
import { eventBase } from "../../../logging/events.js"

// Each log.thought call becomes:
yield* log.emit(input.char, {
  ...eventBase(input.char.name, "orchestrator", "dream"),
  kind: "text",
  text: dreamText,
})
```

- [ ] **Step 3: Update phases.ts (SpaceMolt)**

Replace the `log.action()` call with `log.emit()`:

```typescript
import { eventBase } from "@roci/core/logging/events.js"

yield* log.emit(context.char, {
  ...eventBase(context.char.name, "orchestrator", "channel-session"),
  kind: "system",
  message: "loop_start",
})
```

- [ ] **Step 4: Update phases.ts (GitHub)**

Same pattern as SpaceMolt phases — replace `log.action()` with `log.emit()`.

- [ ] **Step 5: Verify character-scaffold.ts and timeout-summarizer.ts**

Both files import `CharacterLog` but never call `log.thought/action/word/raw` — they only pass `CharacterLog` as an Effect requirement to `runTurn`. No code changes needed. The import resolves because `CharacterLog` is still exported from `log-writer.ts` (with `emit` instead of the old methods). Verify with: `npx tsc --noEmit` from `packages/core`.

- [ ] **Step 6: Commit**

```bash
git add packages/domain-spacemolt/src/dinner.ts packages/core/src/core/limbic/hippocampus/dream.ts packages/domain-spacemolt/src/phases.ts packages/domain-github/src/phases.ts packages/core/src/core/character-scaffold.ts packages/core/src/core/limbic/hypothalamus/timeout-summarizer.ts
git commit -m "refactor: update direct CharacterLog consumers to use emit"
```

---

### Task 8: Update game-socket-impl.ts

**Files:**
- Modify: `packages/domain-spacemolt/src/game-socket-impl.ts`

The WS handlers use `console.log` and `console.error` directly from sync callbacks. These need to emit through the captured runtime (already captured as `rt`/`runFork`/`runSync`).

- [ ] **Step 1: Add CharacterLog to the connect scope**

The `connect` method is inside `Effect.gen`, so we can yield `CharacterLog`. Add near the top of the gen block (after `const rt = yield* Effect.runtime<never>()`):

```typescript
const log = yield* CharacterLog
```

Note: `CharacterLog` needs to be in the `R` type of the connect effect. Since it's already provided at the top level via `CharacterLogLive`, this should work. The `GameSocket` service layer needs to include `CharacterLog` in its requirements — check and add if needed.

- [ ] **Step 2: Replace console.log/error calls with runFork emit**

Each `console.log(tag(...))` call becomes a `runFork(log.emit(...))`. Example for "Connecting to...":

Replace:
```typescript
yield* Effect.sync(() =>
  console.log(`${tag(characterName, "ws")} Connecting to ${WS_URL}...`),
)
```
With:
```typescript
yield* log.emit(
  { name: characterName, dir: "" } as CharacterConfig,
  { ...eventBase(characterName, "orchestrator", "ws"), kind: "system", message: `Connecting to ${WS_URL}...` },
)
```

For sync callbacks (inside `socket.on("close", ...)` etc.), use `runFork`:
```typescript
runFork(
  log.emit(
    { name: characterName, dir: "" } as CharacterConfig,
    { ...eventBase(characterName, "orchestrator", "ws"), kind: "system", message: `Connection closed (code=${code}${reasonStr})` },
  )
)
```

Update all ~12 console.log/warn/error calls in this file following this pattern.

- [ ] **Step 3: Update imports**

Add:
```typescript
import { CharacterLog } from "@roci/core/logging/log-writer.js"
import { eventBase } from "@roci/core/logging/events.js"
import type { CharacterConfig } from "@roci/core/services/CharacterFs.js"
```

Keep the `tag` import for any remaining uses, or remove if fully replaced.

- [ ] **Step 4: Commit**

```bash
git add packages/domain-spacemolt/src/game-socket-impl.ts
git commit -m "refactor: game-socket-impl routes WS events through unified emit"
```

---

### Task 9: Add activity.log tail fiber to session-runner

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/session-runner.ts`

- [ ] **Step 1: Add the tail fiber after spawning the claude process**

After the `streamFiber` fork (around line 184), add a fiber that watches the host-side `activity.log`:

```typescript
// ── Activity.log tail — captures subagent tool calls from hooks ──
const activityLogPath = path.resolve(
  projectRoot,
  "players",
  config.playerName,
  "logs",
  "activity.log",
)

// Clear any stale activity.log from previous sessions
yield* Effect.try(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs")
  nodeFs.writeFileSync(activityLogPath, "")
}).pipe(Effect.catchAll(() => Effect.void))

let activityOffset = 0

const activityFiber = yield* Effect.gen(function* () {
  const nodeFs = yield* Effect.sync(() => require("node:fs") as typeof import("node:fs"))
  while (true) {
    yield* Effect.sleep("2 seconds")
    yield* Effect.try(() => {
      const stat = nodeFs.statSync(activityLogPath)
      if (stat.size <= activityOffset) return

      const fd = nodeFs.openSync(activityLogPath, "r")
      const buf = Buffer.alloc(stat.size - activityOffset)
      nodeFs.readSync(fd, buf, 0, buf.length, activityOffset)
      nodeFs.closeSync(fd)
      activityOffset = stat.size

      const lines = buf.toString("utf-8").split("\n").filter(l => l.trim())
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>
          let event: UnifiedEvent

          if (parsed.event === "subagent_start") {
            event = {
              ...eventBase(config.playerName, "session", "claude"),
              kind: "subagent_start",
              description: String((parsed.data as Record<string, unknown>)?.description ?? ""),
              data: parsed.data,
            }
          } else if (parsed.event === "subagent_stop") {
            event = {
              ...eventBase(config.playerName, "session", "claude"),
              kind: "subagent_stop",
              data: parsed.data,
            }
          } else {
            // PreToolUse hook event — tool call from main or subagent
            event = {
              ...eventBase(config.playerName, "subagent", "claude"),
              kind: "tool_use",
              tool: String(parsed.tool ?? "unknown"),
              id: "",
              input: parsed.input ?? {},
            }
          }

          // Use runFork since we're inside Effect.try
          // Actually we're in Effect.gen, so just yield*
        } catch {
          // Skip unparseable lines
        }
      }
    }).pipe(Effect.catchAll(() => Effect.void))
  }
}).pipe(Effect.catchAll(() => Effect.void), Effect.fork)
```

Actually, this needs to emit inside the loop. Let me restructure to properly yield* the emit calls:

```typescript
const activityFiber = yield* Effect.gen(function* () {
  const nodeFs = yield* Effect.sync(() => require("node:fs") as typeof import("node:fs"))

  while (true) {
    yield* Effect.sleep("2 seconds")

    const newLines = yield* Effect.try(() => {
      const stat = nodeFs.statSync(activityLogPath)
      if (stat.size <= activityOffset) return []

      const fd = nodeFs.openSync(activityLogPath, "r")
      const buf = Buffer.alloc(stat.size - activityOffset)
      nodeFs.readSync(fd, buf, 0, buf.length, activityOffset)
      nodeFs.closeSync(fd)
      activityOffset = stat.size

      return buf.toString("utf-8").split("\n").filter(l => l.trim())
    }).pipe(Effect.catchAll(() => Effect.succeed([] as string[])))

    for (const line of newLines) {
      const parsed = yield* Effect.try(() => JSON.parse(line) as Record<string, unknown>).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )
      if (!parsed) continue

      let event: UnifiedEvent
      if (parsed.event === "subagent_start") {
        event = {
          ...eventBase(config.playerName, "session", "claude"),
          kind: "subagent_start",
          description: String((parsed.data as Record<string, unknown>)?.description ?? ""),
          data: parsed.data,
        }
      } else if (parsed.event === "subagent_stop") {
        event = {
          ...eventBase(config.playerName, "session", "claude"),
          kind: "subagent_stop",
          data: parsed.data,
        }
      } else {
        event = {
          ...eventBase(config.playerName, "subagent", "claude"),
          kind: "tool_use",
          tool: String(parsed.tool ?? "unknown"),
          id: "",
          input: parsed.input ?? {},
        }
      }

      yield* log.emit(config.char, event).pipe(Effect.catchAll(() => Effect.void))
    }
  }
}).pipe(Effect.catchAll(() => Effect.void), Effect.fork)
```

- [ ] **Step 2: Add projectRoot to the session-runner scope**

The session-runner needs access to `ProjectRoot` to resolve the host-side path. Add it to the imports and yield it:

```typescript
import { ProjectRoot } from "../../../services/ProjectRoot.js"

// Inside the gen block:
const projectRoot = yield* ProjectRoot
```

Update the function's return type to include `ProjectRoot` in its requirements.

- [ ] **Step 3: Interrupt the activity fiber on finalization**

In the session lifecycle fiber (where exitFiber, streamFiber, stderrFiber are interrupted), add:

```typescript
yield* Fiber.interrupt(activityFiber).pipe(Effect.catchAll(() => Effect.void))
```

- [ ] **Step 4: Add imports**

```typescript
import { toUnifiedEvents, eventBase, type UnifiedEvent } from "../../../logging/events.js"
import { ProjectRoot } from "../../../services/ProjectRoot.js"
import * as path from "node:path"
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/session-runner.ts
git commit -m "feat: tail activity.log for subagent visibility in unified event stream"
```

---

### Task 10: Delete log-demux.ts and update exports

**Files:**
- Delete: `packages/core/src/logging/log-demux.ts`
- Delete: `packages/core/src/logging/log-demux.test.ts`
- Modify: any barrel exports that re-export from log-demux

- [ ] **Step 1: Check for barrel exports**

Search for re-exports of log-demux in index.ts or similar files. Remove them.

- [ ] **Step 2: Delete the files**

```bash
rm packages/core/src/logging/log-demux.ts packages/core/src/logging/log-demux.test.ts
```

- [ ] **Step 3: Remove old exports from console-renderer.ts**

The old console-renderer exported `logToConsole`, `logPlanTransition`, `logStepResult`, `logStreamEvent`, `logStderr`, `logCharThought`, `logThinking`, `logCharAction`, `logCharResult`, `logTickReceived`, `formatError`. 

After the rewrite (Task 2), only `tag`, `colorFor`, `renderEvent` should be exported. Check that no remaining files import the deleted exports. If `formatError` is used elsewhere, keep it or move it.

- [ ] **Step 4: Verify full build**

Run: `cd /Users/vcarl/workspace/roci && npx nx run-many -t build`
Expected: clean build with no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete log-demux.ts, clean up old logging exports"
```

---

### Task 11: Verify end-to-end

- [ ] **Step 1: Run the orchestrator for ~2 minutes**

```bash
cd /Users/vcarl/workspace/testbench/roci-testing
npx tsx /Users/vcarl/workspace/roci/apps/roci/src/main.ts start --domain spacemolt kvothe
```

Observe:
- Console output looks correct (colored tags, tool summaries, text output)
- No crashes or unhandled errors

- [ ] **Step 2: Verify events.jsonl is being written**

```bash
wc -l /Users/vcarl/workspace/testbench/roci-testing/players/kvothe/logs/events.jsonl
tail -5 /Users/vcarl/workspace/testbench/roci-testing/players/kvothe/logs/events.jsonl | jq .
```

Verify events have `timestamp`, `character`, `system`, `subsystem`, `kind` fields.

- [ ] **Step 3: Verify activity.log events appear in events.jsonl**

After the session has spawned at least one subagent or run some tools:

```bash
grep '"subagent"' /Users/vcarl/workspace/testbench/roci-testing/players/kvothe/logs/events.jsonl | head -3
```

Should show events with `system: "subagent"` from the activity.log tail fiber.

- [ ] **Step 4: Verify old log files are not created**

```bash
ls /Users/vcarl/workspace/testbench/roci-testing/players/kvothe/logs/
```

Should show only `events.jsonl` and `activity.log` (written by container hooks). No `stream.jsonl`, `thoughts.jsonl`, `actions.jsonl`, `words.jsonl`.
