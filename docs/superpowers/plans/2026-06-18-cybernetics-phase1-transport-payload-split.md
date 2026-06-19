# Cybernetics Phase 1 — Transport/Payload Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `process-runner.ts` into a reusable execution **transport** plus swappable **payloads**, with zero change to observable behavior, so later phases can add an SDK-runner payload and a steering channel.

**Architecture:** Today `runTurn(config)` does everything in one function: builds the `docker exec` command for `claude -p`/`opencode`, attaches stdin, streams/normalizes stdout, and races process-exit vs timeout. This phase extracts two seams — (1) **payload** = the inner command + which normalizer to use (pure, per-runtime), and (2) **transport** = the `docker exec` + stream + race + kill mechanism (payload-agnostic). `runTurn` becomes a thin composition of the two and keeps its exact signature, so all eight existing callers are untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Effect-TS (`Effect`, `Stream`, `Fiber`, `Ref`, `Layer`), `@effect/platform` (`Command`, `CommandExecutor`), `@effect/platform-node` (`NodeContext` — for real-subprocess tests), Vitest.

## Global Constraints

- **Behavior-preserving phase.** No caller of `runTurn` changes; the full existing test suite stays green. `runTurn`'s signature and return type are unchanged: `(config: TurnConfig) => Effect.Effect<TurnResult, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken>`.
- **Preserve the existing `toUnifiedEvents` subsystem tag `"claude"`** even for the opencode runtime — this matches current behavior (process-runner hardcodes `"claude"` today). Correcting it is deferred to Phase 2; do NOT "fix" it here, or the refactor stops being behavior-preserving.
- **Never use `--bare` with `claude -p`** — it disables OAuth token resolution (documented in `runtime.ts`).
- **ESM imports use `.js` specifiers** (e.g. `import { x } from "./payload.js"`) even though the source is `.ts` — this is the repo convention.
- **Effect import style:** named imports from `"effect"` and `"@effect/platform"`, matching existing files.
- Commit messages: imperative mood, conventional-commit prefix (`refactor:`, `test:`). End each with a blank line then:

  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

## Phase Roadmap (context — only Phase 1 is detailed in this doc)

This plan implements **Phase 1** of the spec `docs/superpowers/specs/2026-06-18-cybernetics-agent-sdk-steering-design.md`. Each subsequent phase gets its own plan, written once its predecessor lands and its interfaces are stable:

1. **Phase 1 (this doc) — Transport/payload split.** Pure refactor; foundation for everything else.
2. **Phase 2 — SDK-runner payload + NDJSON wire protocol.** Add `@anthropic-ai/claude-agent-sdk`, write `sdk-runner.js`, add the streaming SDK payload + the host↔runner protocol (`task`/`steer`/`end` → `event`/`result`); frontier worker runs run-to-completion via the SDK. Builds on Phase 1's payload seam.
3. **Phase 3 — Steering channel.** Add the `Directive` type, the coalescing capacity-1 queue, `delegate(config, steering)`, `STEER_CADENCE_TICKS`; steering works on a live session. Builds on Phase 2's wire protocol.
4. **Phase 4 — Cortex loop rework.** Conscious tier as an OpenCode agent session; remove `!delegationFiber` gates on hindbrain/forebrain; cadence-throttled coalesced steering of the active session; escalation model (both triggers, sequential handoff, boundary evaluation); completion-marker detection. The behavioral integration. Builds on Phases 1–3.

---

## Phase 1 File Structure

**New files:**
- `packages/core/src/core/limbic/hypothalamus/payload.ts` — pure, per-runtime: `selectRuntime`, `buildInnerArgs`, `buildInnerCommand`, `normalizerFor`, `shellEscape`. The swappable part.
- `packages/core/src/core/limbic/hypothalamus/payload.test.ts` — unit tests for the above (pure, no process).
- `packages/core/src/core/limbic/hypothalamus/transport.ts` — `runTransport`, `parseStreamJson`, `isAuthError`. The payload-agnostic mechanism.
- `packages/core/src/core/limbic/hypothalamus/transport.test.ts` — exercises `runTransport` against a real local echo subprocess (no Docker).
- `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts` — unit test for the extracted `buildExecArgs` + a "retained `claude -p`" assertion.

**Modified files:**
- `packages/core/src/core/limbic/hypothalamus/process-runner.ts` — `runTurn` becomes payload+transport composition; gains exported `buildExecArgs`. All moved code is deleted from here.

**Unchanged (verify, don't edit):** `types.ts`, `runtime.ts`, all eight `runTurn` callers (`delegate.ts`, `dinner.ts`, `character-scaffold.ts` ×2, `dream.ts` ×2, `timeout-summarizer.ts`).

---

## Task 1: Establish a green baseline

**Files:** none (environment setup).

- [ ] **Step 1: Install dependencies in this worktree**

The worktree has no `node_modules` (the pre-commit hook fails with `nx: command not found` without this).

Run: `pnpm install`
Expected: completes; `node_modules/` populated at repo root.

- [ ] **Step 2: Run the full test suite to confirm a green baseline**

Run: `pnpm test`
Expected: PASS (all existing tests green). If anything fails before any change, stop and report — do not start the refactor on a red baseline.

- [ ] **Step 3: Confirm `runTurn` has no dedicated test today**

Run: `ls packages/core/src/core/limbic/hypothalamus/`
Expected: `process-runner.ts` exists but there is **no** `process-runner.test.ts` yet (only `runtime.test.ts`). This confirms the refactor is currently covered only indirectly — the new tests in this plan add direct coverage.

---

## Task 2: Extract the payload module (`payload.ts`)

Move the per-runtime command construction and normalizer selection out of `runTurn` into pure functions.

**Files:**
- Create: `packages/core/src/core/limbic/hypothalamus/payload.ts`
- Test: `packages/core/src/core/limbic/hypothalamus/payload.test.ts`

**Interfaces:**
- Consumes: `TurnConfig` (`./types.js`); `runtimeBinary`, `runtimeBaseArgs`, `AgentRuntime` (`./runtime.js`); `normalizeClaude`, `normalizeOpenCode`, `InternalEvent` (`../../../logging/stream-normalizer.js`).
- Produces:
  - `selectRuntime(config: TurnConfig): AgentRuntime`
  - `buildInnerArgs(config: TurnConfig, runtime: AgentRuntime): string[]` — args after the binary name (includes the base args from `runtimeBaseArgs`).
  - `buildInnerCommand(config: TurnConfig, runtime: AgentRuntime): string` — `"<binary> <args joined>"`.
  - `normalizerFor(runtime: AgentRuntime): (raw: Record<string, unknown>) => InternalEvent[]`
  - `shellEscape(s: string): string`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/core/limbic/hypothalamus/payload.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { selectRuntime, buildInnerArgs, buildInnerCommand, normalizerFor, shellEscape } from "./payload.js"
import { normalizeClaude, normalizeOpenCode } from "../../../logging/stream-normalizer.js"
import type { TurnConfig } from "./types.js"

const base: TurnConfig = {
  containerId: "c1",
  playerName: "ada",
  systemPrompt: "be good",
  prompt: "do it",
  model: "opus",
  timeoutMs: 1000,
  char: { name: "ada", dir: "/work/players/ada/me" },
  role: "body",
}

describe("selectRuntime", () => {
  it("derives the runtime from the model when no override", () => {
    expect(selectRuntime(base)).toBe("claude")
    expect(selectRuntime({ ...base, model: "gpt-4o" })).toBe("opencode")
  })
  it("honors an explicit runtime override", () => {
    expect(selectRuntime({ ...base, model: "gpt-4o", runtime: "claude" })).toBe("claude")
  })
})

describe("buildInnerArgs (claude)", () => {
  const args = buildInnerArgs(base, "claude")
  it("includes the base claude flags and model", () => {
    expect(args).toContain("-p")
    expect(args).toContain("--model")
    expect(args).toContain("opus")
    expect(args).toContain("--output-format")
    expect(args).toContain("stream-json")
    expect(args).toContain("--verbose")
  })
  it("adds --fallback-model sonnet for non-sonnet models", () => {
    expect(args).toContain("--fallback-model")
    expect(args).toContain("sonnet")
  })
  it("does NOT add --effort low for a body role", () => {
    expect(args).not.toContain("--effort")
  })
  it("escapes and passes the system prompt", () => {
    expect(args).toContain("--system-prompt")
    expect(args).toContain("$'be good'")
  })
})

describe("buildInnerArgs (claude) tool gating", () => {
  it("passes --allowedTools \"\" when noTools", () => {
    const args = buildInnerArgs({ ...base, noTools: true }, "claude")
    const i = args.indexOf("--allowedTools")
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe("")
  })
  it("joins allowedTools when provided", () => {
    const args = buildInnerArgs({ ...base, allowedTools: ["Bash", "Read"] }, "claude")
    const i = args.indexOf("--allowedTools")
    expect(args[i + 1]).toBe("Bash,Read")
  })
  it("adds --effort low for non-body non-opus roles", () => {
    const args = buildInnerArgs({ ...base, model: "haiku", role: "brain" }, "claude")
    expect(args).toContain("--effort")
    expect(args).toContain("low")
  })
})

describe("buildInnerArgs (opencode)", () => {
  const cfg: TurnConfig = { ...base, model: "openrouter/anthropic/claude-sonnet-4" }
  const args = buildInnerArgs(cfg, "opencode")
  it("uses the opencode base args and omits claude-only flags", () => {
    expect(args).toContain("run")
    expect(args).toContain("--model")
    expect(args).toContain("--format")
    expect(args).toContain("json")
    expect(args).not.toContain("--output-format")
    expect(args).not.toContain("--system-prompt")
  })
})

describe("buildInnerCommand", () => {
  it("prefixes the claude binary name", () => {
    expect(buildInnerCommand(base, "claude").startsWith("claude -p")).toBe(true)
  })
  it("prefixes the opencode binary name", () => {
    const cfg: TurnConfig = { ...base, model: "gpt-4o" }
    expect(buildInnerCommand(cfg, "opencode").startsWith("opencode run")).toBe(true)
  })
})

describe("normalizerFor", () => {
  it("maps runtimes to their normalizer", () => {
    expect(normalizerFor("claude")).toBe(normalizeClaude)
    expect(normalizerFor("opencode")).toBe(normalizeOpenCode)
  })
})

describe("shellEscape", () => {
  it("wraps in ANSI-C quoting and escapes newlines", () => {
    expect(shellEscape("a\nb")).toBe("$'a\\nb'")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/payload.test.ts`
Expected: FAIL — cannot resolve `./payload.js` (module does not exist yet).

- [ ] **Step 3: Create `payload.ts` by moving logic out of `process-runner.ts`**

Create `packages/core/src/core/limbic/hypothalamus/payload.ts`:

```ts
import type { TurnConfig } from "./types.js"
import { runtimeBinary, runtimeBaseArgs, type AgentRuntime } from "./runtime.js"
import {
  normalizeClaude,
  normalizeOpenCode,
  type InternalEvent,
} from "../../../logging/stream-normalizer.js"

/** Shell-safe literal using $'...' ANSI-C quoting. */
export function shellEscape(s: string): string {
  let escaped = ""
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (ch === "\\") escaped += "\\\\"
    else if (ch === "'") escaped += "\\'"
    else if (ch === "\n") escaped += "\\n"
    else if (ch === "\r") escaped += "\\r"
    else if (ch === "\t") escaped += "\\t"
    else if (code < 0x20 || code === 0x7f) escaped += `\\x${code.toString(16).padStart(2, "0")}`
    else escaped += ch
  }
  return `$'${escaped}'`
}

/** Which runtime this turn uses: explicit override, else model-derived. */
export function selectRuntime(config: TurnConfig): AgentRuntime {
  return config.runtime ?? runtimeBinary(config.model)
}

/** The normalizer matching a runtime's stdout format. */
export function normalizerFor(
  runtime: AgentRuntime,
): (raw: Record<string, unknown>) => InternalEvent[] {
  return runtime === "opencode" ? normalizeOpenCode : normalizeClaude
}

/**
 * Build the args (after the binary name) for the inner command run *inside* the
 * container. This is the swappable "payload" — the transport (docker exec) is
 * identical regardless of which payload runs.
 */
export function buildInnerArgs(config: TurnConfig, runtime: AgentRuntime): string[] {
  const args: string[] = [...runtimeBaseArgs(runtime, config.model)]

  if (runtime === "claude") {
    if (config.model !== "sonnet") {
      args.push("--fallback-model", "sonnet")
    }
    args.push("--output-format", "stream-json")
    args.push("--verbose")

    // Brain (opus) uses full effort; body needs normal effort for multi-step
    // workflows; only apply low effort to non-body, non-opus roles.
    if (config.model !== "opus" && config.role !== "body") {
      args.push("--effort", "low")
    }

    if (config.maxBudgetUsd) {
      args.push("--max-budget-usd", String(config.maxBudgetUsd))
    }
  }

  // Tool access control
  if (config.noTools) {
    if (runtime === "claude") {
      args.push("--allowedTools", "")
    }
    // OpenCode: no tools by default in run mode unless explicitly declared.
  } else {
    if (config.allowedTools && config.allowedTools.length > 0) {
      args.push("--allowedTools", config.allowedTools.join(","))
    }
    if (config.disallowedTools && config.disallowedTools.length > 0) {
      args.push("--disallowedTools", config.disallowedTools.join(","))
    }
  }

  if (config.addDirs) {
    for (const dir of config.addDirs) {
      args.push("--add-dir", dir)
    }
  }

  if (config.systemPrompt) {
    if (runtime === "claude") {
      args.push("--system-prompt", shellEscape(config.systemPrompt))
    }
    // OpenCode: system prompt handling TBD — prepend to prompt (future).
  }

  return args
}

/** The full inner command string: `<binary> <args>`. */
export function buildInnerCommand(config: TurnConfig, runtime: AgentRuntime): string {
  const binary = runtime === "claude" ? "claude" : "opencode"
  return `${binary} ${buildInnerArgs(config, runtime).join(" ")}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/payload.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/payload.ts packages/core/src/core/limbic/hypothalamus/payload.test.ts
git commit -m "refactor: extract per-runtime payload builders from process-runner"
```

---

## Task 3: Extract the transport module (`transport.ts`)

Move the start/stream/normalize/race/kill mechanism out of `runTurn` into a payload-agnostic `runTransport`. The command is built by the caller and passed in (stdin already attached), which is what makes it testable without Docker.

**Files:**
- Create: `packages/core/src/core/limbic/hypothalamus/transport.ts`
- Test: `packages/core/src/core/limbic/hypothalamus/transport.test.ts`

**Interfaces:**
- Consumes: `Command.Command`, `CommandExecutor.CommandExecutor` (`@effect/platform`); `CharacterConfig` (`../../../services/CharacterFs.js`); `TurnResult` (`./types.js`); `InternalEvent` (`../../../logging/stream-normalizer.js`); `ClaudeError` (`../../../services/Claude.js`); `toUnifiedEvents`, `eventBase` (`../../../logging/events.js`); `CharacterLog`, `logToConsole` (`../../../logging/log-writer.js`).
- Produces:
  - `parseStreamJson(line: string): Record<string, unknown> | null`
  - `isAuthError(text: string): boolean`
  - `interface TransportInput { command: Command.Command; normalize: (raw: Record<string, unknown>) => InternalEvent[]; runtimeTag: string; char: CharacterConfig; role: "brain" | "body"; timeoutMs: number }`
  - `runTransport(input: TransportInput): Effect.Effect<TurnResult, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog>` — note: **no `OAuthToken` dependency** (the token is baked into `command` by the caller).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/core/limbic/hypothalamus/transport.test.ts`. Uses a real local `bash` subprocess as the "fake echo runner" — no Docker:

```ts
import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { Command } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { runTransport, parseStreamJson, isAuthError } from "./transport.js"
import { normalizeClaude } from "../../../logging/stream-normalizer.js"
import { CharacterLog } from "../../../logging/log-writer.js"

const StubCharacterLog = Layer.succeed(
  CharacterLog,
  CharacterLog.of({ emit: () => Effect.void }),
)
// NodeContext.layer provides a real CommandExecutor (runs actual subprocesses).
const deps = Layer.merge(NodeContext.layer, StubCharacterLog)

const char = { name: "ada", dir: "/work/players/ada/me" }

describe("parseStreamJson", () => {
  it("returns the object for valid JSON, null otherwise", () => {
    expect(parseStreamJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseStreamJson("not json")).toBeNull()
  })
})

describe("isAuthError", () => {
  it("detects auth failures", () => {
    expect(isAuthError("Error 401 Unauthorized")).toBe(true)
    expect(isAuthError("invalid bearer token")).toBe(true)
    expect(isAuthError("everything fine")).toBe(false)
  })
})

describe("runTransport", () => {
  it("accumulates text from streamed assistant events", async () => {
    // A real subprocess that prints one claude stream-json assistant line.
    const line =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}'
    const command = Command.make("bash", "-c", `printf '%s\\n' '${line}'`)

    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({
          command,
          normalize: normalizeClaude,
          runtimeTag: "claude",
          char,
          role: "body",
          timeoutMs: 5000,
        }),
        deps,
      ),
    )
    expect(result.timedOut).toBe(false)
    expect(result.output).toContain("hello")
  })

  it("times out a long-running process and reports timedOut", async () => {
    const command = Command.make("bash", "-c", "sleep 5")
    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({
          command,
          normalize: normalizeClaude,
          runtimeTag: "claude",
          char,
          role: "body",
          timeoutMs: 50,
        }),
        deps,
      ),
    )
    expect(result.timedOut).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/transport.test.ts`
Expected: FAIL — cannot resolve `./transport.js`.

- [ ] **Step 3: Create `transport.ts` by moving the mechanism out of `process-runner.ts`**

Create `packages/core/src/core/limbic/hypothalamus/transport.ts`:

```ts
import { Effect, Stream, Chunk, Fiber, Ref } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import type { TurnResult } from "./types.js"
import type { InternalEvent } from "../../../logging/stream-normalizer.js"
import { ClaudeError } from "../../../services/Claude.js"
import { toUnifiedEvents, eventBase } from "../../../logging/events.js"
import { CharacterLog, logToConsole } from "../../../logging/log-writer.js"

/** Parse a stream-json line, returning the parsed object or null. */
export function parseStreamJson(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
}

export function isAuthError(text: string): boolean {
  return /401|[Uu]nauthorized|[Aa]uthentication.*(error|fail)|[Ii]nvalid bearer token/i.test(text)
}

export interface TransportInput {
  /** Fully-built command to execute (e.g. `docker exec ...`), stdin already attached. */
  command: Command.Command
  /** Normalizer for this payload's stdout format. */
  normalize: (raw: Record<string, unknown>) => InternalEvent[]
  /** Subsystem tag for unified events (currently always "claude" — see Phase 1 constraints). */
  runtimeTag: string
  char: CharacterConfig
  role: "brain" | "body"
  timeoutMs: number
}

/**
 * Reusable execution transport. Starts a command, streams + normalizes +
 * accumulates its stdout, races process-exit vs timeout, interrupts on timeout,
 * and surfaces auth errors. Payload-agnostic: the same mechanism runs `claude -p`,
 * `opencode`, or (Phase 2) the SDK runner. The OAuth token is baked into `command`
 * by the caller, so this has no OAuthToken dependency.
 */
export const runTransport = (input: TransportInput): Effect.Effect<
  TurnResult,
  ClaudeError,
  CommandExecutor.CommandExecutor | CharacterLog
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor
      const start = Date.now()
      const textAccumulator = yield* Ref.make<string[]>([])
      const log = yield* CharacterLog

      const process = yield* executor.start(input.command)

      // Fork stderr drain.
      const stderrFiber = yield* process.stderr.pipe(
        Stream.decodeText(),
        Stream.runCollect,
        Effect.map(Chunk.join("")),
      ).pipe(Effect.fork)

      // Process stdout: split into lines, normalize each, accumulate text blocks.
      const streamFiber = yield* process.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
        Stream.mapEffect((line) =>
          Effect.gen(function* () {
            const raw = parseStreamJson(line)
            if (raw) {
              const internal = input.normalize(raw)
              const system = input.role === "brain" ? "brain" : input.role
              const unified = toUnifiedEvents(internal, input.char.name, system, input.runtimeTag)
              for (const event of unified) {
                yield* log.emit(input.char, event)
                if (event.kind === "text") {
                  yield* Ref.update(textAccumulator, (arr) => [...arr, event.text])
                }
              }
            } else if (line.trim()) {
              yield* log.emit(input.char, {
                ...eventBase(input.char.name, input.role, input.runtimeTag),
                kind: "system",
                message: line,
              })
            }
          }),
        ),
        Stream.runDrain,
      ).pipe(Effect.fork)

      // Wait for the process to actually exit (not just stdout to drain).
      const exitFiber = yield* process.exitCode.pipe(Effect.fork)

      const timeoutEffect = Effect.sleep(input.timeoutMs).pipe(
        Effect.map(() => ({ timedOut: true as const })),
      )
      const completionEffect = Fiber.join(exitFiber).pipe(
        Effect.map((exitCode) => ({ timedOut: false as const, exitCode: Number(exitCode) })),
      )

      const raceResult = yield* Effect.race(completionEffect, timeoutEffect)

      let timedOut: boolean
      if (raceResult.timedOut) {
        timedOut = true
        yield* Fiber.interrupt(exitFiber).pipe(Effect.catchAll(() => Effect.void))
        yield* Fiber.interrupt(streamFiber).pipe(Effect.catchAll(() => Effect.void))
        yield* Fiber.interrupt(stderrFiber).pipe(Effect.catchAll(() => Effect.void))
        yield* logToConsole(input.char.name, input.role, "TIMED OUT — interrupting")
      } else {
        timedOut = false
        const exitCode = "exitCode" in raceResult ? (raceResult as { exitCode: number }).exitCode : -1
        const elapsed = Math.round((Date.now() - start) / 1000)
        yield* logToConsole(input.char.name, input.role, `Process exited (code=${exitCode}) after ${elapsed}s`)
        yield* Fiber.join(streamFiber).pipe(Effect.catchAll(() => Effect.void))
        const stderr = yield* Fiber.join(stderrFiber).pipe(Effect.catchAll(() => Effect.succeed("")))
        if (stderr && stderr.trim()) {
          yield* logToConsole(input.char.name, input.role, `stderr: ${stderr.trim().slice(0, 500)}`)
        }
        if (exitCode !== 0 && isAuthError(stderr)) {
          yield* logToConsole(input.char.name, input.role, "Auth error — token is invalid. Run 'claude setup-token' and update .oauth-token")
          return yield* Effect.fail(new ClaudeError("OAuth token rejected by Claude. Run 'claude setup-token' and update .oauth-token"))
        }
      }

      const textParts = yield* Ref.get(textAccumulator)
      const output = textParts.join("\n")
      const durationMs = Date.now() - start
      return { output, timedOut, durationMs }
    }),
  ).pipe(
    Effect.mapError((e) =>
      e instanceof ClaudeError ? e : new ClaudeError("Process runner failed", e),
    ),
  )
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/transport.test.ts`
Expected: PASS — first case `output` contains `"hello"` and `timedOut` is `false`; second case `timedOut` is `true`.

If the first case fails on `output`, confirm `toUnifiedEvents` maps a `{type:"text"}` `InternalEvent` to a unified event with `kind: "text"` and a `.text` field (it must, since `runTurn` accumulates exactly that today). Do not change behavior — fix the test's expectation only if the mapping genuinely differs.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/transport.ts packages/core/src/core/limbic/hypothalamus/transport.test.ts
git commit -m "refactor: extract payload-agnostic runTransport from process-runner"
```

---

## Task 4: Extract `buildExecArgs` (docker-exec command builder)

Pull the `docker exec` argument construction into a pure, exported, testable function.

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/process-runner.ts`
- Test: `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`

**Interfaces:**
- Produces: `buildExecArgs(config: TurnConfig, innerCmd: string, token: string): string[]` — the args to `docker` (starting with `"exec"`).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { buildExecArgs } from "./process-runner.js"
import { buildInnerCommand } from "./payload.js"
import type { TurnConfig } from "./types.js"

const base: TurnConfig = {
  containerId: "cabc",
  playerName: "ada",
  systemPrompt: "be good",
  prompt: "do it",
  model: "opus",
  timeoutMs: 1000,
  char: { name: "ada", dir: "/work/players/ada/me" },
  role: "body",
}

describe("buildExecArgs", () => {
  const args = buildExecArgs(base, "claude -p --model opus", "tok123")

  it("scopes the working directory to the player", () => {
    const i = args.indexOf("-w")
    expect(args[i + 1]).toBe("/work/players/ada")
  })
  it("injects the OAuth token as an env var", () => {
    expect(args).toContain("-e")
    expect(args).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok123")
  })
  it("ends with containerId, bash -c, and the inner command", () => {
    expect(args.slice(-4)).toEqual(["cabc", "bash", "-c", "claude -p --model opus"])
  })
  it("starts with exec -i", () => {
    expect(args.slice(0, 2)).toEqual(["exec", "-i"])
  })
  it("passes custom env but never re-passes the OAuth key", () => {
    const withEnv = buildExecArgs(
      { ...base, env: { FOO: "bar", CLAUDE_CODE_OAUTH_TOKEN: "should-be-ignored" } },
      "claude -p",
      "realtok",
    )
    expect(withEnv).toContain("FOO=bar")
    expect(withEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN=realtok")
    expect(withEnv).not.toContain("CLAUDE_CODE_OAUTH_TOKEN=should-be-ignored")
  })

  it("retained claude -p capability: a claude-model turn still builds a claude -p payload", () => {
    // Proves the dormant raw `claude -p` path remains wired through the shared
    // transport even though the SDK runner (Phase 2) becomes the frontier default.
    const inner = buildInnerCommand(base, "claude")
    expect(inner.startsWith("claude -p")).toBe(true)
    const full = buildExecArgs(base, inner, "tok")
    expect(full[full.length - 1]).toBe(inner)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`
Expected: FAIL — `buildExecArgs` is not exported (does not exist yet).

- [ ] **Step 3: Add `buildExecArgs` to `process-runner.ts`**

Add this exported function to `packages/core/src/core/limbic/hypothalamus/process-runner.ts` (full file is rewritten in Task 5; for now just add the function so the test passes — it will be used by `runTurn` in Task 5):

```ts
/** Build the `docker exec` args: working dir, env (incl. OAuth token), inner command. */
export function buildExecArgs(config: TurnConfig, innerCmd: string, token: string): string[] {
  const execArgs: string[] = ["exec", "-i", "-w", `/work/players/${config.playerName}`]
  if (config.env) {
    for (const [key, val] of Object.entries(config.env)) {
      if (key === "CLAUDE_CODE_OAUTH_TOKEN") continue
      execArgs.push("-e", `${key}=${val}`)
    }
  }
  execArgs.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${token}`)
  execArgs.push(config.containerId, "bash", "-c", innerCmd)
  return execArgs
}
```

Ensure `TurnConfig` is imported in `process-runner.ts` (it already is).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`
Expected: PASS (including the retained `claude -p` case).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/process-runner.ts packages/core/src/core/limbic/hypothalamus/process-runner.test.ts
git commit -m "refactor: extract buildExecArgs and add retained claude -p test"
```

---

## Task 5: Rewrite `runTurn` to compose payload + transport

Replace the body of `runTurn` so it builds the payload, injects OAuth, builds the `docker exec` command, and delegates to `runTransport`. Delete all the now-moved code from `process-runner.ts`. The signature and behavior are unchanged.

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/process-runner.ts`

**Interfaces:**
- Consumes: `selectRuntime`, `buildInnerCommand`, `normalizerFor` (`./payload.js`); `runTransport` (`./transport.js`); `buildExecArgs` (local).
- Produces: `runTurn(config: TurnConfig): Effect.Effect<TurnResult, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken>` (unchanged signature).

- [ ] **Step 1: Rewrite `process-runner.ts` to the composed form**

Replace the entire contents of `packages/core/src/core/limbic/hypothalamus/process-runner.ts` with:

```ts
/**
 * Primary execution path for all domain-level agent invocations.
 *
 * `runTurn` composes a *payload* (the inner command + normalizer, per runtime —
 * see `payload.ts`) with the reusable *transport* (`docker exec` + stream + race
 * + kill — see `transport.ts`). It runs the agent inside the Docker container
 * with full tool access, streaming output, and a timeout, returning the
 * accumulated text.
 *
 * For orchestrator-internal tasks that don't need tool access, use
 * `Claude.invoke` from `services/Claude.ts` instead — that runs on the host.
 */

import { Effect, Stream } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import type { TurnConfig, TurnResult } from "./types.js"
import { ClaudeError } from "../../../services/Claude.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { CharacterLog, logToConsole } from "../../../logging/log-writer.js"
import { selectRuntime, buildInnerCommand, normalizerFor } from "./payload.js"
import { runTransport } from "./transport.js"

/** Build the `docker exec` args: working dir, env (incl. OAuth token), inner command. */
export function buildExecArgs(config: TurnConfig, innerCmd: string, token: string): string[] {
  const execArgs: string[] = ["exec", "-i", "-w", `/work/players/${config.playerName}`]
  if (config.env) {
    for (const [key, val] of Object.entries(config.env)) {
      if (key === "CLAUDE_CODE_OAUTH_TOKEN") continue
      execArgs.push("-e", `${key}=${val}`)
    }
  }
  execArgs.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${token}`)
  execArgs.push(config.containerId, "bash", "-c", innerCmd)
  return execArgs
}

/**
 * Run one turn: build the payload, inject OAuth, exec inside the container,
 * stream the result through the transport. Signature/behavior unchanged from the
 * pre-split version — all existing callers are untouched.
 */
export const runTurn = (config: TurnConfig): Effect.Effect<
  TurnResult,
  ClaudeError,
  CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
> =>
  Effect.gen(function* () {
    const oauthToken = yield* OAuthToken
    const { token } = yield* oauthToken.getToken

    const runtime = selectRuntime(config)
    const innerCmd = buildInnerCommand(config, runtime)
    const execArgs = buildExecArgs(config, innerCmd, token)

    // Diagnostic: token prefix/suffix to verify it matches the saved file.
    yield* logToConsole(
      config.char.name,
      config.role,
      `token len=${token.length} prefix=${token.slice(0, 15)}... suffix=...${token.slice(-10)}`,
    )
    // Log the full docker exec command (redact token values).
    const redactedArgs = execArgs.map((a) =>
      a.includes("CLAUDE_CODE_OAUTH_TOKEN=") ? "CLAUDE_CODE_OAUTH_TOKEN=<redacted>" : a,
    )
    yield* logToConsole(config.char.name, config.role, `docker ${redactedArgs.join(" ")}`)

    const promptStream = Stream.encodeText(Stream.make(config.prompt))
    const command = Command.make("docker", ...execArgs).pipe(Command.stdin(promptStream))

    // NOTE: runtimeTag is intentionally "claude" for both runtimes here, matching
    // pre-split behavior (Phase 1 is behavior-preserving). Phase 2 corrects the
    // tag for the opencode payload.
    return yield* runTransport({
      command,
      normalize: normalizerFor(runtime),
      runtimeTag: "claude",
      char: config.char,
      role: config.role,
      timeoutMs: config.timeoutMs,
    })
  })
```

- [ ] **Step 2: Typecheck the core package**

Run: `pnpm exec tsc -p packages/core --noEmit`
Expected: PASS — no type errors. (Confirms `runTurn`'s `R` channel still resolves to `CommandExecutor | CharacterLog | OAuthToken` and no dangling imports remain.)

- [ ] **Step 3: Run the hypothalamus tests**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/`
Expected: PASS — `runtime.test.ts`, `payload.test.ts`, `transport.test.ts`, `process-runner.test.ts` all green.

- [ ] **Step 4: Run the FULL suite to confirm no regression in callers**

Run: `pnpm test`
Expected: PASS — same green baseline as Task 1, Step 2. Pay attention to `delegate.test.ts` and `loop.test.ts` (the `runTurn` consumers via `Cybernetics`). They use stub/canned layers and must remain green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/process-runner.ts
git commit -m "refactor: compose runTurn from payload + transport"
```

---

## Self-Review

Run this checklist against the spec (`§5 (1)` — "Split the process-runner into transport + payloads") and Phase 1 scope:

**1. Spec coverage:**
- "One reusable transport (`docker exec` + stream + timeout race + OAuth/credential injection + critical-kill)" → `runTransport` (Task 3) handles stream + timeout race + kill; OAuth injection is built into the command by `runTurn`/`buildExecArgs` (Tasks 4–5) and passed in — covered, with the OAuth split noted explicitly.
- "Swappable payloads: (a) OpenCode, (c) dormant `claude -p`" → `payload.ts` builds both via `selectRuntime`/`buildInnerCommand` (Task 2); the dormant `claude -p` path is asserted by the retained-capability test (Task 4, Step 1). Payload **(b) SDK-runner** is explicitly **out of Phase 1 scope** → Phase 2.
- "Retained `claude -p` test proving isolation is retained even if unused" → Task 4 retained-capability test. ✓
- "Transport test against a fake echo runner — no real container" → `transport.test.ts` uses a real local `bash` subprocess, not Docker. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Every code step shows complete code. The only forward-references ("Phase 2 corrects…") are scope markers, not missing work.

**3. Type consistency:** `buildInnerArgs`/`buildInnerCommand`/`selectRuntime`/`normalizerFor`/`shellEscape` (Task 2) match their uses in `runTurn` (Task 5). `buildExecArgs(config, innerCmd, token)` signature is identical in Task 4 and Task 5. `TransportInput` fields used in `transport.test.ts` (Task 3) match the interface and `runTurn`'s call site (Task 5). `runtimeTag: "claude"` is consistent across the transport default and the behavior-preserving constraint.

**Known acceptable carry-over:** the hardcoded `runtimeTag: "claude"` for the opencode runtime preserves current behavior and is flagged for Phase 2 — intentional, not a bug introduced here.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-18-cybernetics-phase1-transport-payload-split.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
