# Runtime Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all agent runtime invocations through Docker and support both Claude Code and OpenCode as pluggable runtimes, so users can choose which models power each role (brain, body, orchestrator tasks) without any host-side CLI dependencies beyond Docker.

**Architecture:** A new `AgentRuntime` type in `types.ts` selects between `claude` and `opencode` binaries per-turn. `Claude.invoke` (host-side) is eliminated — all callers move to `runTurn` with `containerId` threaded through. `character-scaffold.ts` uses a temporary Docker container. A streaming normalizer in `log-demux.ts` converts both Claude Code and OpenCode JSON event formats into a shared `InternalEvent` type.

**Tech Stack:** Effect, @effect/platform (CommandExecutor), Docker CLI, Claude Code CLI, OpenCode CLI (`opencode-ai`)

---

## File Structure

### New files
- `packages/core/src/core/limbic/hypothalamus/runtime.ts` — `AgentRuntime` type, `runtimeBinary()` selector, `runtimeBaseArgs()` builder
- `packages/core/src/logging/stream-normalizer.ts` — `InternalEvent` type, `normalizeClaude()`, `normalizeOpenCode()` functions

### Modified files
- `packages/core/src/core/limbic/hypothalamus/types.ts` — Add `runtime` and `noTools` fields to `TurnConfig`
- `packages/core/src/core/limbic/hypothalamus/process-runner.ts` — Use runtime abstraction, handle `noTools`, support both binaries
- `packages/core/src/logging/log-demux.ts` — Refactor `demuxEvent` to consume `InternalEvent[]` via normalizer
- `packages/core/src/core/limbic/hippocampus/dream.ts` — Replace `Claude.invoke` with `runTurn`, add `containerId` to `DreamInput`
- `packages/core/src/core/limbic/hypothalamus/timeout-summarizer.ts` — Replace `Claude.invoke` with `runTurn`, accept turn config
- `packages/domain-spacemolt/src/dinner.ts` — Replace `Claude.invoke` with `runTurn`, add `containerId` to `DinnerInput`
- `packages/core/src/core/orchestrator/planned-action.ts` — Pass `containerId` through `runReflection`
- `packages/domain-spacemolt/src/phases.ts` — Pass `containerId` to `dinner.execute` and `runReflection`
- `packages/core/src/core/limbic/hypothalamus/cycle-runner.ts` — Pass config to `summarizeTimeout`
- `packages/core/src/core/character-scaffold.ts` — Use Docker container instead of host `execFileSync`
- `packages/core/src/services/Claude.ts` — Remove `ClaudeLive`; keep `ClaudeError`, `claudeBaseArgs`, type exports
- `.devcontainer/Dockerfile` — Install OpenCode alongside Claude Code
- `packages/domain-spacemolt/src/docker/Dockerfile` — Install OpenCode alongside Claude Code
- `packages/domain-github/src/docker/Dockerfile` — Install OpenCode alongside Claude Code

---

### Task 1: Add `AgentRuntime` type and runtime selector

**Files:**
- Create: `packages/core/src/core/limbic/hypothalamus/runtime.ts`
- Modify: `packages/core/src/core/limbic/hypothalamus/types.ts`

- [ ] **Step 1: Write failing test for runtime selector**

Create `packages/core/src/core/limbic/hypothalamus/runtime.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { runtimeBinary, runtimeBaseArgs } from "./runtime.js"

describe("runtimeBinary", () => {
  it("returns 'claude' for anthropic models", () => {
    expect(runtimeBinary("opus")).toBe("claude")
    expect(runtimeBinary("sonnet")).toBe("claude")
    expect(runtimeBinary("haiku")).toBe("claude")
  })

  it("returns 'opencode' for explicit opencode runtime", () => {
    expect(runtimeBinary("opencode")).toBe("opencode")
  })
})

describe("runtimeBaseArgs", () => {
  it("returns claude base args for claude runtime", () => {
    const args = runtimeBaseArgs("claude", "opus")
    expect(args).toContain("-p")
    expect(args).toContain("--bare")
    expect(args).toContain("--permission-mode")
    expect(args).toContain("bypassPermissions")
    expect(args).toContain("--model")
    expect(args).toContain("opus")
  })

  it("returns opencode base args for opencode runtime", () => {
    const args = runtimeBaseArgs("opencode", "openrouter/anthropic/claude-sonnet-4")
    expect(args).toContain("run")
    expect(args).toContain("--model")
    expect(args).toContain("openrouter/anthropic/claude-sonnet-4")
    expect(args).toContain("--format")
    expect(args).toContain("json")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/core/limbic/hypothalamus/runtime.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement runtime.ts**

Create `packages/core/src/core/limbic/hypothalamus/runtime.ts`:

```typescript
import type { ClaudeModel } from "../../../services/Claude.js"

/** Which agent runtime binary to use inside Docker. */
export type AgentRuntime = "claude" | "opencode"

/** Model string — either a ClaudeModel alias or an OpenCode provider/model string. */
export type AnyModel = ClaudeModel | (string & {})

const CLAUDE_MODELS = new Set<string>(["opus", "sonnet", "haiku"])

/** Determine which runtime binary handles a given model string. */
export function runtimeBinary(model: AnyModel): AgentRuntime {
  return CLAUDE_MODELS.has(model) ? "claude" : "opencode"
}

/**
 * Base CLI args for the selected runtime.
 * Claude: `claude -p --bare --permission-mode bypassPermissions --model <model>`
 * OpenCode: `opencode run --format json --model <model>`
 */
export function runtimeBaseArgs(runtime: AgentRuntime, model: AnyModel): string[] {
  if (runtime === "claude") {
    return ["-p", "--bare", "--permission-mode", "bypassPermissions", "--model", model]
  }
  // OpenCode: permission config is via .opencode/config.json in the container,
  // not CLI flags. --format json gives us structured streaming.
  return ["run", "--format", "json", "--model", model]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/core/limbic/hypothalamus/runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Add runtime and noTools to TurnConfig**

Modify `packages/core/src/core/limbic/hypothalamus/types.ts` — replace the `ClaudeModel` import and `model` field:

```typescript
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import type { AgentRuntime, AnyModel } from "./runtime.js"

/** Configuration for a single brain or body turn. */
export interface TurnConfig {
  containerId: string
  playerName: string
  systemPrompt: string
  prompt: string
  model: AnyModel
  timeoutMs: number
  env?: Record<string, string>
  /** Container --add-dir paths for claude subagent. */
  addDirs?: string[]
  /** Character config for log routing. */
  char: CharacterConfig
  /** Label for console output (e.g. "brain", "body"). */
  role: "brain" | "body"
  /** If set, restrict available tools via --allowedTools. */
  allowedTools?: string[]
  /** If set, block these tools via --disallowedTools. */
  disallowedTools?: string[]
  /** If set, cap spend for this turn via --max-budget-usd. */
  maxBudgetUsd?: number
  /** Disable all tool access for this turn (text-in/text-out only). */
  noTools?: boolean
  /** Override runtime selection (auto-detected from model if omitted). */
  runtime?: AgentRuntime
}
```

Keep `CycleConfig`, `TurnResult`, `CycleResult` unchanged except updating `CycleConfig.brainModel` and `bodyModel` types from `ClaudeModel` to `AnyModel`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/runtime.ts packages/core/src/core/limbic/hypothalamus/runtime.test.ts packages/core/src/core/limbic/hypothalamus/types.ts
git commit -m "feat: add AgentRuntime type and runtime selector for multi-runtime support"
```

---

### Task 2: Build streaming normalizer

**Files:**
- Create: `packages/core/src/logging/stream-normalizer.ts`
- Create: `packages/core/src/logging/stream-normalizer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/logging/stream-normalizer.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { normalizeClaude, normalizeOpenCode, type InternalEvent } from "./stream-normalizer.js"

describe("normalizeClaude", () => {
  it("normalizes system event", () => {
    const events = normalizeClaude({ type: "system", model: "opus" })
    expect(events).toEqual([{ type: "system", model: "opus" }])
  })

  it("normalizes assistant text block", () => {
    const events = normalizeClaude({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    })
    expect(events).toEqual([{ type: "text", text: "hello" }])
  })

  it("normalizes assistant thinking block", () => {
    const events = normalizeClaude({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "hmm" }] },
    })
    expect(events).toEqual([{ type: "thinking", text: "hmm" }])
  })

  it("normalizes assistant tool_use block", () => {
    const events = normalizeClaude({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    })
    expect(events).toEqual([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ])
  })

  it("normalizes user tool_result block", () => {
    const events = normalizeClaude({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file.ts" }] },
    })
    expect(events).toEqual([
      { type: "tool_result", toolUseId: "t1", text: "file.ts" },
    ])
  })

  it("normalizes rate_limit_event", () => {
    const events = normalizeClaude({
      type: "rate_limit_event",
      rate_limit_info: { status: "throttled" },
    })
    expect(events).toEqual([{ type: "rate_limit", status: "throttled" }])
  })

  it("returns passthrough for unknown event types", () => {
    const events = normalizeClaude({ type: "result" })
    expect(events).toEqual([{ type: "passthrough", rawType: "result" }])
  })
})

describe("normalizeOpenCode", () => {
  it("normalizes text event", () => {
    const events = normalizeOpenCode({ type: "text", part: { text: "hello" } })
    expect(events).toEqual([{ type: "text", text: "hello" }])
  })

  it("normalizes reasoning event", () => {
    const events = normalizeOpenCode({ type: "reasoning", part: { text: "thinking..." } })
    expect(events).toEqual([{ type: "thinking", text: "thinking..." }])
  })

  it("normalizes tool_use event", () => {
    const events = normalizeOpenCode({
      type: "tool_use",
      part: { id: "t1", name: "bash", input: { command: "ls" } },
    })
    expect(events).toEqual([
      { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
    ])
  })

  it("normalizes error event", () => {
    const events = normalizeOpenCode({ type: "error", error: { message: "boom" } })
    expect(events).toEqual([{ type: "error", message: "boom" }])
  })

  it("normalizes step_start as system", () => {
    const events = normalizeOpenCode({ type: "step_start", part: { model: "gpt-4" } })
    expect(events).toEqual([{ type: "system", model: "gpt-4" }])
  })

  it("ignores step_finish", () => {
    const events = normalizeOpenCode({ type: "step_finish" })
    expect(events).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/logging/stream-normalizer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement stream-normalizer.ts**

Create `packages/core/src/logging/stream-normalizer.ts`:

```typescript
/** Normalized event type consumed by log-demux, runtime-agnostic. */
export type InternalEvent =
  | { type: "system"; model?: string }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; text: string }
  | { type: "rate_limit"; status: string }
  | { type: "error"; message: string }
  | { type: "passthrough"; rawType: string }

type RawEvent = Record<string, unknown>

/** Normalize a Claude Code stream-json event into InternalEvents. */
export function normalizeClaude(raw: RawEvent): InternalEvent[] {
  const type = raw.type as string | undefined

  if (type === "system") {
    return [{ type: "system", model: raw.model as string | undefined }]
  }

  if (type === "rate_limit_event") {
    const info = raw.rate_limit_info as RawEvent | undefined
    return [{ type: "rate_limit", status: String(info?.status ?? "unknown") }]
  }

  if (type === "assistant") {
    const message = raw.message as RawEvent | undefined
    const content = message?.content as RawEvent[] | undefined
    if (!content) return []

    return content.map((block): InternalEvent => {
      if (block.type === "thinking") {
        return { type: "thinking", text: block.thinking as string }
      }
      if (block.type === "text") {
        return { type: "text", text: block.text as string }
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id as string,
          name: block.name as string,
          input: (block.input as Record<string, unknown>) ?? {},
        }
      }
      return { type: "passthrough", rawType: String(block.type ?? "unknown") }
    })
  }

  if (type === "user") {
    const message = raw.message as RawEvent | undefined
    const content = message?.content as RawEvent[] | undefined
    if (!content) return []

    return content
      .filter((block) => block.type === "tool_result")
      .map((block): InternalEvent => ({
        type: "tool_result",
        toolUseId: block.tool_use_id as string,
        text: (block.content as string) ?? "",
      }))
  }

  return [{ type: "passthrough", rawType: type ?? "unknown" }]
}

/** Normalize an OpenCode JSON stream event into InternalEvents. */
export function normalizeOpenCode(raw: RawEvent): InternalEvent[] {
  const type = raw.type as string | undefined
  const part = raw.part as RawEvent | undefined

  if (type === "text") {
    return [{ type: "text", text: (part?.text as string) ?? "" }]
  }

  if (type === "reasoning") {
    return [{ type: "thinking", text: (part?.text as string) ?? "" }]
  }

  if (type === "tool_use") {
    return [{
      type: "tool_use",
      id: (part?.id as string) ?? "",
      name: (part?.name as string) ?? "",
      input: (part?.input as Record<string, unknown>) ?? {},
    }]
  }

  if (type === "error") {
    const error = raw.error as RawEvent | undefined
    return [{ type: "error", message: (error?.message as string) ?? "unknown error" }]
  }

  if (type === "step_start") {
    return [{ type: "system", model: part?.model as string | undefined }]
  }

  if (type === "step_finish") {
    return []
  }

  return [{ type: "passthrough", rawType: type ?? "unknown" }]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/logging/stream-normalizer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/logging/stream-normalizer.ts packages/core/src/logging/stream-normalizer.test.ts
git commit -m "feat: add stream normalizer for Claude Code and OpenCode event formats"
```

---

### Task 3: Refactor log-demux to use InternalEvent

**Files:**
- Modify: `packages/core/src/logging/log-demux.ts`

- [ ] **Step 1: Write failing test for refactored demuxEvent**

Create `packages/core/src/logging/log-demux.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest"
import { Effect, Ref, Layer } from "effect"
import { demuxEvents } from "./log-demux.js"
import type { InternalEvent } from "./stream-normalizer.js"
import { CharacterLog } from "./log-writer.js"

// Minimal mock CharacterLog that captures calls
const mockLog = {
  raw: vi.fn(() => Effect.void),
  thought: vi.fn(() => Effect.void),
  action: vi.fn(() => Effect.void),
  word: vi.fn(() => Effect.void),
}
const TestCharacterLog = Layer.succeed(CharacterLog, mockLog as any)

const testChar = { name: "test", dir: "/tmp/test" } as any

describe("demuxEvents", () => {
  it("accumulates text events into textAccumulator", async () => {
    const events: InternalEvent[] = [{ type: "text", text: "hello world" }]
    const acc = Ref.unsafeMake<string[]>([])

    await Effect.runPromise(
      demuxEvents(testChar, events, "brain", acc).pipe(Effect.provide(TestCharacterLog)),
    )

    expect(Ref.unsafeGet(acc)).toEqual(["hello world"])
  })

  it("logs tool_use to action log", async () => {
    const events: InternalEvent[] = [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ]

    await Effect.runPromise(
      demuxEvents(testChar, events, "brain").pipe(Effect.provide(TestCharacterLog)),
    )

    expect(mockLog.action).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/logging/log-demux.test.ts`
Expected: FAIL — `demuxEvents` not exported

- [ ] **Step 3: Refactor log-demux.ts**

Modify `packages/core/src/logging/log-demux.ts` to:

1. Import `InternalEvent` from `./stream-normalizer.js`
2. Add a new `demuxEvents` function that takes `InternalEvent[]` and routes them (replacing the raw-event-based logic in the current `demuxEvent`)
3. Keep the existing `demuxEvent` function but have it call through to `demuxEvents` after normalizing with `normalizeClaude` — this avoids breaking `process-runner.ts` before Task 5 updates it

The key change: extract the routing logic from `demuxEvent` into `demuxEvents(char, events: InternalEvent[], source, textAccumulator?)`, and update `printEvent` to work with `InternalEvent` instead of raw Claude Code events.

The full implementation should:
- Move `toolUseRegistry`, `SUPPRESS_RESULT_TOOLS`, `SOCIAL_COMMAND_PATTERN` constants into the new function's scope or keep as module-level
- Route `InternalEvent` types to the same log destinations as before:
  - `text` → `log.thought` + `textAccumulator` + `logCharThought`
  - `thinking` → `logThinking`
  - `tool_use` → `log.action` + console + `log.word` (if social command)
  - `tool_result` → `log.action` + `logCharResult` (unless suppressed)
  - `system` → console only (dim init line)
  - `rate_limit` → console only (dim rate_limit line)
  - `error` → console only (error line)
  - `passthrough` → console only (dim type label)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/logging/log-demux.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/logging/log-demux.ts packages/core/src/logging/log-demux.test.ts
git commit -m "refactor: make log-demux consume InternalEvent for runtime-agnostic streaming"
```

---

### Task 4: Update process-runner to use runtime abstraction

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/process-runner.ts`

- [ ] **Step 1: Update process-runner.ts imports and arg building**

Replace the `claudeBaseArgs` import with `runtimeBinary` and `runtimeBaseArgs` from `./runtime.js`. Import `normalizeClaude`, `normalizeOpenCode` from the stream normalizer. Import `demuxEvents` from the log demux.

Update the arg-building section (currently lines 77–110) to:

```typescript
const runtime = config.runtime ?? runtimeBinary(config.model)
const baseArgs = runtimeBaseArgs(runtime, config.model)

const claudeArgs: string[] = [...baseArgs]

if (runtime === "claude") {
  claudeArgs.push("--fallback-model", "sonnet")
  claudeArgs.push("--output-format", "stream-json")
  claudeArgs.push("--verbose")

  // Brain (opus) uses full effort; body needs normal effort for multi-step
  // workflows; only apply low effort to non-body, non-opus roles
  if (config.model !== "opus" && config.role !== "body") {
    claudeArgs.push("--effort", "low")
  }

  if (config.maxBudgetUsd) {
    claudeArgs.push("--max-budget-usd", String(config.maxBudgetUsd))
  }
}

if (config.noTools) {
  if (runtime === "claude") {
    claudeArgs.push("--allowedTools", "")
  }
  // OpenCode: omit tools from config — default is no tools in run mode
} else {
  if (config.allowedTools && config.allowedTools.length > 0) {
    claudeArgs.push("--allowedTools", config.allowedTools.join(","))
  }
  if (config.disallowedTools && config.disallowedTools.length > 0) {
    claudeArgs.push("--disallowedTools", config.disallowedTools.join(","))
  }
}

if (config.addDirs) {
  for (const dir of config.addDirs) {
    claudeArgs.push("--add-dir", dir)
  }
}

if (config.systemPrompt) {
  if (runtime === "claude") {
    claudeArgs.push("--system-prompt", shellEscape(config.systemPrompt))
  } else {
    // OpenCode doesn't have --system-prompt; prepend to prompt instead
  }
}

const binary = runtime === "claude" ? "claude" : "opencode"
const innerCmd = `${binary} ${claudeArgs.join(" ")}`
```

- [ ] **Step 2: Update stream parsing to use normalizer**

In the stdout processing section (currently lines 153–171), replace the direct `demuxEvent` call:

```typescript
const normalize = runtime === "opencode" ? normalizeOpenCode : normalizeClaude

const streamFiber = yield* process.stdout.pipe(
  Stream.decodeText(),
  Stream.splitLines,
  Stream.filter((line) => line.trim().length > 0),
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
  Stream.runDrain,
).pipe(Effect.fork)
```

- [ ] **Step 3: Verify build passes**

Run: `pnpm nx run @roci/core:build --skip-nx-cache`
Expected: Success

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/process-runner.ts
git commit -m "feat: process-runner supports claude and opencode runtimes with stream normalization"
```

---

### Task 5: Migrate dream.ts from Claude.invoke to runTurn

**Files:**
- Modify: `packages/core/src/core/limbic/hippocampus/dream.ts`
- Modify: `packages/core/src/core/orchestrator/planned-action.ts`
- Modify: `packages/domain-spacemolt/src/phases.ts`

- [ ] **Step 1: Add containerId to DreamInput and update dream.ts**

Modify `packages/core/src/core/limbic/hippocampus/dream.ts`:

```typescript
import * as path from "node:path"
import { Effect } from "effect"
import { CommandExecutor } from "@effect/platform"
import { CharacterFs, type CharacterConfig } from "../../../services/CharacterFs.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { ClaudeError } from "../../../services/Claude.js"
import { runTurn } from "../hypothalamus/process-runner.js"
import { loadTemplate } from "../../template.js"

export interface DreamInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  addDirs?: string[]
  env?: Record<string, string>
}
```

Replace both `claude.invoke(...)` calls with `runTurn(...)`:

```typescript
const compressedDiary = yield* runTurn({
  containerId: input.containerId,
  playerName: input.playerName,
  char: input.char,
  prompt: diaryInput,
  systemPrompt: "",
  model: "opus",
  timeoutMs: 120_000,
  role: "brain",
  noTools: true,
  addDirs: input.addDirs,
  env: input.env,
}).pipe(Effect.map((r) => r.output))
```

Same pattern for the secrets compression call. Remove the `Claude` import and `yield* Claude` line.

Update the Effect service requirements — the return type changes from depending on `Claude` to depending on `CommandExecutor.CommandExecutor | CharacterLog | OAuthToken`.

- [ ] **Step 2: Update runReflection in planned-action.ts**

Modify `packages/core/src/core/orchestrator/planned-action.ts`:

```typescript
export const runReflection = (
  char: CharacterConfig,
  dreamThreshold: number,
  containerId: string,
  addDirs?: string[],
  env?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const charFs = yield* CharacterFs
    const diary = yield* charFs.readDiary(char)
    const diaryLines = diary.split("\n").length

    if (diaryLines > dreamThreshold) {
      yield* logToConsole(char.name, "orchestrator", `Diary is ${diaryLines} lines — dreaming...`)
      yield* dream.execute({ char, containerId, playerName: char.name, addDirs, env }).pipe(
        Effect.catchAll((e) =>
          logToConsole(char.name, "error", `Dream failed: ${e}`),
        ),
      )
    }
  })
```

Remove the `Claude` import from `planned-action.ts` if it was only used for dream's transitive dependency.

- [ ] **Step 3: Update phases.ts call sites**

In `packages/domain-spacemolt/src/phases.ts`, update every `runReflection` call to pass `context.containerId`, `context.containerAddDirs`, `context.containerEnv`:

In `startupPhase` (two call sites):
```typescript
yield* runReflection(context.char, DIARY_COMPRESSION_THRESHOLD, context.containerId, context.containerAddDirs, context.containerEnv)
```

In `reflectionPhase`:
```typescript
yield* runReflection(context.char, DIARY_COMPRESSION_THRESHOLD, context.containerId, context.containerAddDirs, context.containerEnv)
```

- [ ] **Step 4: Verify build passes**

Run: `pnpm nx run @roci/core:build --skip-nx-cache`
Expected: Success

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hippocampus/dream.ts packages/core/src/core/orchestrator/planned-action.ts packages/domain-spacemolt/src/phases.ts
git commit -m "refactor: migrate dream.ts from Claude.invoke to runTurn"
```

---

### Task 6: Migrate timeout-summarizer.ts from Claude.invoke to runTurn

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/timeout-summarizer.ts`
- Modify: `packages/core/src/core/limbic/hypothalamus/cycle-runner.ts`

- [ ] **Step 1: Rewrite timeout-summarizer.ts to use runTurn**

```typescript
import { Effect } from "effect"
import { CommandExecutor } from "@effect/platform"
import { ClaudeError } from "../../../services/Claude.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { runTurn } from "./process-runner.js"
import type { CharacterConfig } from "../../../services/CharacterFs.js"

export const summarizeTimeout = (
  partialOutput: string,
  role: "brain" | "body",
  turnContext: {
    containerId: string
    playerName: string
    char: CharacterConfig
    addDirs?: string[]
    env?: Record<string, string>
  },
): Effect.Effect<string, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken> =>
  Effect.gen(function* () {
    const truncated = partialOutput.length > 8000
      ? partialOutput.slice(0, 4000) + "\n\n... (truncated) ...\n\n" + partialOutput.slice(-4000)
      : partialOutput

    const prompt = [
      `The ${role} was interrupted after reaching its time limit.`,
      `Here is its partial output:`,
      ``,
      `---`,
      truncated,
      `---`,
      ``,
      `Summarize in 2-3 sentences: what was accomplished, what was in progress, and what remains to be done.`,
    ].join("\n")

    const result = yield* runTurn({
      containerId: turnContext.containerId,
      playerName: turnContext.playerName,
      char: turnContext.char,
      prompt,
      systemPrompt: "",
      model: "haiku",
      timeoutMs: 30_000,
      role: "brain",
      noTools: true,
      addDirs: turnContext.addDirs,
      env: turnContext.env,
    })

    return result.output.trim()
  })
```

- [ ] **Step 2: Update cycle-runner.ts to pass context to summarizeTimeout**

In `packages/core/src/core/limbic/hypothalamus/cycle-runner.ts`, update both `summarizeTimeout` calls:

```typescript
brainSummary = yield* summarizeTimeout(brainOutput, "brain", {
  containerId: config.containerId,
  playerName: config.playerName,
  char: config.char,
  addDirs: config.addDirs,
  env: config.env,
}).pipe(
  Effect.catchAll((e) => {
    return Effect.logWarning(`Brain summary failed: ${e.message}`).pipe(
      Effect.map(() => "(brain timed out, summary unavailable)"),
    )
  }),
)
```

Same for the body timeout summary. Remove the `Claude` import from `cycle-runner.ts`.

- [ ] **Step 3: Verify build passes**

Run: `pnpm nx run @roci/core:build --skip-nx-cache`
Expected: Success

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/timeout-summarizer.ts packages/core/src/core/limbic/hypothalamus/cycle-runner.ts
git commit -m "refactor: migrate timeout-summarizer from Claude.invoke to runTurn"
```

---

### Task 7: Migrate dinner.ts from Claude.invoke to runTurn

**Files:**
- Modify: `packages/domain-spacemolt/src/dinner.ts`
- Modify: `packages/domain-spacemolt/src/phases.ts`

- [ ] **Step 1: Rewrite dinner.ts to use runTurn**

Add `containerId`, `playerName`, `addDirs`, `env` to `DinnerInput`. Replace `claude.invoke(...)` with `runTurn(...)`. Remove `Claude` import and service dependency.

```typescript
import * as path from "node:path"
import { Effect } from "effect"
import { FileSystem, CommandExecutor } from "@effect/platform"
import { ClaudeError } from "@roci/core/services/Claude.js"
import { CharacterFs, type CharacterConfig } from "@roci/core/services/CharacterFs.js"
import { CharacterLog } from "@roci/core/logging/log-writer.js"
import { OAuthToken } from "@roci/core/services/OAuthToken.js"
import { ProjectRoot } from "@roci/core/services/ProjectRoot.js"
import { renderTemplate, loadTemplate } from "@roci/core/core/template.js"
import { runTurn } from "@roci/core/core/limbic/hypothalamus/process-runner.js"

export interface DinnerInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  addDirs?: string[]
  env?: Record<string, string>
}
```

Replace the `claude.invoke(...)` call:

```typescript
const result = yield* runTurn({
  containerId: input.containerId,
  playerName: input.playerName,
  char: input.char,
  prompt,
  systemPrompt: "",
  model: "opus",
  timeoutMs: 120_000,
  role: "brain",
  noTools: true,
  addDirs: input.addDirs,
  env: input.env,
})
const updatedDiary = result.output
```

- [ ] **Step 2: Update socialPhase in phases.ts**

```typescript
yield* dinner.execute({
  char: context.char,
  containerId: context.containerId,
  playerName: context.char.name,
  addDirs: context.containerAddDirs,
  env: context.containerEnv,
}).pipe(
  Effect.catchAll((e) =>
    logToConsole(context.char.name, "orchestrator", `Dinner failed: ${e}`),
  ),
)
```

- [ ] **Step 3: Verify build passes**

Run: `pnpm nx run @roci/domain-spacemolt:build --skip-nx-cache`
Expected: Success (may fail on the pre-existing DomainBundle type error — that's unrelated)

- [ ] **Step 4: Commit**

```bash
git add packages/domain-spacemolt/src/dinner.ts packages/domain-spacemolt/src/phases.ts
git commit -m "refactor: migrate dinner.ts from Claude.invoke to runTurn"
```

---

### Task 8: Clean up Claude.ts — remove ClaudeLive

**Files:**
- Modify: `packages/core/src/services/Claude.ts`
- Modify: any remaining imports of `Claude`, `ClaudeLive`

- [ ] **Step 1: Search for remaining Claude.invoke consumers**

Run: `grep -r "Claude\." packages/ --include="*.ts" | grep -v node_modules | grep -v ".d.ts" | grep -v "ClaudeError\|ClaudeModel\|claudeBaseArgs\|Claude\.ts"`

If any callers remain, migrate them first. If none remain, proceed.

- [ ] **Step 2: Remove ClaudeLive and the Claude service tag**

In `packages/core/src/services/Claude.ts`, remove:
- The `Claude` Context.Tag class and its interface
- The `ClaudeLive` Layer
- The `writeTempFile`, `cleanupTempFile`, `shellEscape` helper functions
- The `OAuthToken` import (if only used by ClaudeLive)

Keep:
- `ClaudeModel` type export
- `claudeBaseArgs` function export
- `ClaudeError` class export

- [ ] **Step 3: Update any files that import Claude or ClaudeLive**

Search for imports: `grep -r "from.*Claude.js" packages/ --include="*.ts" | grep -v node_modules`

Remove `Claude` and `ClaudeLive` from import statements. Keep `ClaudeError`, `ClaudeModel`, `claudeBaseArgs` imports.

Check the main orchestrator entry point and any Layer composition that provides `ClaudeLive` — remove it from the Layer stack.

- [ ] **Step 4: Verify build passes**

Run: `pnpm nx run @roci/core:build --skip-nx-cache`
Expected: Success

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/Claude.ts
git add -u  # stage any files with updated imports
git commit -m "refactor: remove ClaudeLive — all invocations now go through runTurn"
```

---

### Task 9: Move character-scaffold to use Docker

**Files:**
- Modify: `packages/core/src/core/character-scaffold.ts`
- Modify: `packages/core/src/services/Docker.ts` (if a convenience method is needed)

- [ ] **Step 1: Update scaffoldCharacter to accept containerId**

Add `containerId` to the `scaffoldCharacter` opts. Change `generateIdentityWithClaude` and `generateSummaryWithClaude` from using `execFileSync("claude", ...)` to using `execFileSync("docker", ["exec", "-i", containerId, "claude", ...])`.

```typescript
function generateIdentityWithClaude(opts: {
  characterName: string
  characterDescription: string
  identityTemplate?: { backgroundHints: string; valuesHints: string }
  containerId: string
}): { background: string; values: string } | null {
  const { characterName, characterDescription, identityTemplate, containerId } = opts

  // ... prompt building stays the same ...

  try {
    const output = execFileSync("docker", [
      "exec", "-i", containerId,
      "claude", ...claudeBaseArgs("sonnet"),
    ], {
      encoding: "utf-8",
      input: prompt,
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    })
    // ... parsing stays the same ...
  }
}
```

Same pattern for `generateSummaryWithClaude`.

- [ ] **Step 2: Update scaffoldCharacter callers**

Search for `scaffoldCharacter` callers and pass the container ID. The setup CLI flow will need to either:
- Accept a `containerId` parameter (if a container is already running)
- Spin up a temporary container using `Docker.create` + `Docker.start`, scaffold, then `Docker.stop` + `Docker.remove`

Check `apps/roci/src/cli.ts` or wherever `scaffoldCharacter` is called to determine which approach fits. The temporary container approach is likely needed since setup runs before the orchestrator starts.

- [ ] **Step 3: Verify build passes**

Run: `pnpm nx run @roci/core:build --skip-nx-cache`
Expected: Success

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/core/character-scaffold.ts
git add -u
git commit -m "refactor: character scaffolding runs through Docker container"
```

---

### Task 10: Install OpenCode in Dockerfiles

**Files:**
- Modify: `.devcontainer/Dockerfile`
- Modify: `packages/domain-spacemolt/src/docker/Dockerfile`
- Modify: `packages/domain-github/src/docker/Dockerfile`

- [ ] **Step 1: Add OpenCode installation to .devcontainer/Dockerfile**

After the Claude Code installation line (`RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`), add:

```dockerfile
# Install OpenCode
ARG OPENCODE_VERSION=latest
RUN npm install -g opencode-ai@${OPENCODE_VERSION}

# Pre-seed opencode config for permission bypass
RUN mkdir -p /home/node/.opencode && \
    echo '{"permission":{"*":"allow"}}' > /home/node/.opencode/config.json
```

- [ ] **Step 2: Add OpenCode to domain-spacemolt Dockerfile**

After the Claude Code installation line in `packages/domain-spacemolt/src/docker/Dockerfile`, add the same OpenCode block.

- [ ] **Step 3: Add OpenCode to domain-github Dockerfile**

After the Claude Code installation line in `packages/domain-github/src/docker/Dockerfile`, add the same OpenCode block.

- [ ] **Step 4: Verify Docker builds**

Run: `docker build -t roci-test-devcontainer .devcontainer/`
Expected: Success (may take a few minutes for npm install)

- [ ] **Step 5: Commit**

```bash
git add .devcontainer/Dockerfile packages/domain-spacemolt/src/docker/Dockerfile packages/domain-github/src/docker/Dockerfile
git commit -m "feat: install OpenCode alongside Claude Code in Docker images"
```

---

### Task 11: Add firewall allowlist entries for OpenRouter/provider APIs

**Files:**
- Modify: `.devcontainer/init-firewall.sh`
- Modify: `packages/domain-spacemolt/src/docker/init-firewall.sh`
- Modify: `packages/domain-github/src/docker/init-firewall.sh` (if it exists)

- [ ] **Step 1: Add provider API domains to firewall allowlists**

In each `init-firewall.sh`, add these domains to the allowlist (alongside existing entries for `api.anthropic.com`):

```bash
# LLM provider APIs (for OpenCode/OpenRouter)
"openrouter.ai"
"api.openai.com"
"generativelanguage.googleapis.com"
```

Only add `openrouter.ai` as the minimum — OpenRouter proxies to all providers, so individual provider domains are only needed for direct provider access. Check the existing allowlist format and follow it.

- [ ] **Step 2: Commit**

```bash
git add .devcontainer/init-firewall.sh packages/domain-spacemolt/src/docker/init-firewall.sh
git commit -m "feat: add OpenRouter to firewall allowlist for multi-model support"
```

---

Plan complete and saved to `docs/superpowers/plans/2026-04-01-runtime-abstraction.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?