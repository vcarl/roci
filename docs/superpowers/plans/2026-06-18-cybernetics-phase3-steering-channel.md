# Cybernetics Phase 3 — Steering Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a single delegated SDK session *steerable* — directives pushed onto a coalescing, capacity-1 queue become `steer` lines fed into the live runner's stdin between turns (soft queue-and-finish), with run-to-completion as the degenerate case.

**Architecture:** Phase 2 gave us a run-to-completion SDK session: `runSdkTurn` builds a static `task`+`end` stdin and runs it through the shared transport. Phase 3 adds the *dynamic* path. A new coalescing steering queue (`Queue.sliding(1)`) carries `Directive`s; a new `buildSteeredStdinStream` turns `(task, queue)` into a byte stream of NDJSON lines that emits the `task`, then one `steer` line per directive pulled from the queue, then `end` when the queue is shut down. A new `runSdkSession(config, stdin)` runs that dynamic stdin through the *unchanged* Phase-1 transport. Finally `delegate` gains an optional `steering` channel that routes to `runSdkSession` when present and to the existing `runTurn` path when absent — so every current caller is untouched. The cortex loop that *produces* directives (cadence, hindbrain/forebrain during a session, escalation, completion-marker detection) is **Phase 4**; this phase only builds the channel and proves it carries steer lines.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Effect-TS (`Effect`, `Stream`, `Queue`, `Chunk`, `Layer`, `Context`), `@effect/platform` (`Command`, `CommandExecutor`), `@effect/platform-node` (`NodeContext` — for real-subprocess tests), Vitest.

## Global Constraints

- **Behavior-preserving for every existing caller.** The new `steering` parameter on `delegate` and the new `onSteer` parameter on `CyberneticsTest` are **both optional**. The single production caller (`packages/core/src/cortex/loop.ts:103`, which passes no steering) and all existing tests (`delegate.test.ts`, `delegate.smoke.test.ts`, `loop.test.ts`) stay green, untouched. The full suite stays green.
- **Reuse Phase-1/2 pieces unchanged:** `runTransport`, `buildExecArgs`, `runTurn`, `normalizeSdk`, `normalizeClaude`/`normalizeOpenCode`, `buildSdkInnerCommand`, `sdkEnv`. `runSdkTurn`'s exported signature and observable behavior are unchanged (it is refactored to share a private helper, but its 9 Phase-2 tests must stay green).
- **Steering is soft queue-and-finish.** A pushed directive becomes the *next user turn after the current turn completes* — never a mid-turn preempt (the TS Agent SDK has no mid-turn interrupt). The runner already implements this (Phase 2): each `task`/`steer` line is one user turn. Hard preemption remains the kill path (`Fiber.interrupt` → SIGKILL) and is out of scope here.
- **Coalescing, capacity 1.** The steering queue is `Queue.sliding(1)`: a newer directive fully **supersedes** an un-consumed older one (each payload is a complete, self-contained synthesis). `task` and `end` are control messages and are **not** subject to coalescing (they are emitted directly by the stdin stream, never offered onto the steering queue).
- **Directives MUST be model-generated (laundered) — never raw inbound text** (threat model §3). The `Directive` type's doc comment states this; the Phase-4 producer enforces it. Phase 3 carries whatever text it is given.
- **Wire protocol is unchanged from Phase 2** (versioned NDJSON, `v:1`): host→runner `task`/`steer`/`end`; runner→host `event`/`result`. `task` and `steer` are structurally identical (one user turn each).
- **Out of scope (Phase 4):** the cortex loop rework, removing the `!delegationFiber` gates, cadence-throttled production of directives, the conscious/OpenCode session, the escalation model, and completion-marker detection. `DEFAULT_STEER_CADENCE_TICKS` is **defined** in Phase 3 (Task 1) but **consumed** only in Phase 4.
- **ESM imports use `.js` specifiers** even though source is `.ts` (repo convention). **Effect import style:** named imports from `"effect"` / `"@effect/platform"`.
- **Commit messages:** imperative, conventional-commit prefix (`feat:`, `test:`, `refactor:`, `docs:`); blank line; then exactly:

  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

  Code commits run the pre-commit `pnpm build` hook (it passes). Docs-only commits use `git commit --no-verify`. If a build/commit fails with a `@roci/core` missing-`dist/` resolution error, run `pnpm build` once and retry — known stale-dist quirk.

---

## Phase Roadmap (context — only Phase 3 is detailed here)

This plan implements **Phase 3** of the spec `docs/superpowers/specs/2026-06-18-cybernetics-agent-sdk-steering-design.md`.

1. **Phase 1 — Transport/payload split.** ✅ Complete (merged-ready).
2. **Phase 2 — SDK-runner payload + NDJSON wire protocol.** ✅ Complete (run-to-completion; container smoke passed).
3. **Phase 3 (this doc) — Steering channel.** `Directive` type, coalescing capacity-1 queue, `buildSteeredStdinStream`, `runSdkSession`, `delegate(config, steering)`, `DEFAULT_STEER_CADENCE_TICKS`. Steering works on a live session. Builds on Phase 2's wire protocol.
4. **Phase 4 — Cortex loop rework.** Conscious tier as an OpenCode agent session; remove `!delegationFiber` gates; cadence-throttled coalesced steering of the active session; escalation model; completion-marker detection. The behavioral integration. Builds on Phases 1–3.

---

## Phase 3 File Structure

**New files:**
- `packages/core/src/cybernetics/steering.ts` — `makeSteeringQueue()` (the coalescing queue) and `buildSteeredStdinStream(task, steering)` (the dynamic NDJSON stdin). Lives in `cybernetics` (which already depends on the hypothalamus layer), so it can import the NDJSON line builders without creating an import cycle.
- `packages/core/src/cybernetics/steering.test.ts` — coalescing + stdin-stream tests.

**Modified files:**
- `packages/core/src/cybernetics/types.ts` — add the `Directive` interface.
- `packages/core/src/core/limbic/hypothalamus/sdk-payload.ts` — add `taskLine`/`steerLine`/`endLine` builders; refactor `buildSdkStdin` to use them.
- `packages/core/src/core/limbic/hypothalamus/sdk-payload.test.ts` — line-builder tests.
- `packages/core/src/core/limbic/hypothalamus/process-runner.ts` — add private `runSdkWithStdin` + exported `runSdkSession`; refactor `runSdkTurn` to use the helper.
- `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts` — `runSdkSession` export check + steered-stdin composition test.
- `packages/core/src/cybernetics/delegate.ts` — optional `steering` on `delegate`; `runSdkSession` routing; `CyberneticsTest` steer capture.
- `packages/core/src/cybernetics/delegate.test.ts` — steer-capture test.
- `packages/core/src/cortex/loop.ts` — add `DEFAULT_STEER_CADENCE_TICKS` constant.
- `docs/cortex-smoke.md` — Phase 3 steering subsection.

---

## Task 1: Steering primitives — `Directive`, coalescing queue, cadence constant

**Files:**
- Modify: `packages/core/src/cybernetics/types.ts`
- Create: `packages/core/src/cybernetics/steering.ts`
- Modify: `packages/core/src/cortex/loop.ts:54-56` (add a constant after the existing defaults)
- Create: `packages/core/src/cybernetics/steering.test.ts`

**Interfaces:**
- Consumes: nothing from earlier Phase-3 tasks. `Queue` from `"effect"`.
- Produces:
  - `Directive` (`packages/core/src/cybernetics/types.ts`) — `interface Directive { text: string }`.
  - `makeSteeringQueue(): Effect.Effect<Queue.Queue<Directive>>` (`packages/core/src/cybernetics/steering.ts`) — a `Queue.sliding(1)`.
  - `DEFAULT_STEER_CADENCE_TICKS: number` (exported from `packages/core/src/cortex/loop.ts`) — value `3`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/cybernetics/steering.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { Effect, Queue, Chunk } from "effect"
import { makeSteeringQueue } from "./steering.js"
import { DEFAULT_STEER_CADENCE_TICKS } from "../cortex/loop.js"

describe("makeSteeringQueue", () => {
  it("coalesces: a newer directive supersedes an un-consumed older one", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* makeSteeringQueue()
        yield* Queue.offer(q, { text: "first" })
        yield* Queue.offer(q, { text: "second" })
        const items = yield* Queue.takeAll(q)
        return Chunk.toReadonlyArray(items)
      }),
    )
    expect(result).toEqual([{ text: "second" }])
  })
})

describe("DEFAULT_STEER_CADENCE_TICKS", () => {
  it("is a positive tick count", () => {
    expect(DEFAULT_STEER_CADENCE_TICKS).toBe(3)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/cybernetics/steering.test.ts`
Expected: FAIL — cannot resolve `./steering.js` and `DEFAULT_STEER_CADENCE_TICKS` is not exported.

- [ ] **Step 3: Add the `Directive` type**

In `packages/core/src/cybernetics/types.ts`, append:

```ts
/**
 * A single steering directive pushed to a live tool-using session. The text is a
 * laundered (model-generated) forebrain synthesis — never raw inbound text (threat
 * model §3). It becomes the *next* user turn after the current turn completes
 * (soft queue-and-finish; the SDK has no mid-turn interrupt).
 */
export interface Directive {
  text: string
}
```

- [ ] **Step 4: Create the steering queue constructor**

Create `packages/core/src/cybernetics/steering.ts`:

```ts
import { Effect, Queue } from "effect"
import type { Directive } from "./types.js"

/**
 * Create the host-side steering queue: coalescing, capacity 1. A newer directive
 * fully supersedes an un-consumed older one (each payload is a complete,
 * self-contained forebrain synthesis), so `Queue.sliding(1)` — which drops the
 * oldest to admit the newest — is exactly the "newest wins" backpressure the
 * design calls for (§7). Run-to-completion is the degenerate case: the caller
 * never offers, then shuts the queue down.
 */
export const makeSteeringQueue = (): Effect.Effect<Queue.Queue<Directive>> =>
  Queue.sliding<Directive>(1)
```

- [ ] **Step 5: Add the cadence constant**

In `packages/core/src/cortex/loop.ts`, immediately after `const DEFAULT_WORKER_TIMEOUT_MS = 60 * 60 * 1000` (line 56), add:

```ts
/**
 * Push a `steer` line to the active session at most once every this-many ticks
 * (§7) — a knob alongside DEFAULT_ORIENT_INTERVAL. Defined here in Phase 3;
 * CONSUMED by the cortex loop in Phase 4. Exported so it is not an unused local.
 * Tunable per cadence profile (spec §11 open question).
 */
export const DEFAULT_STEER_CADENCE_TICKS = 3
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/cybernetics/steering.test.ts`
Expected: PASS (both describe blocks).

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm exec tsc -p packages/core --noEmit`
Expected: no errors.

```bash
git add packages/core/src/cybernetics/types.ts packages/core/src/cybernetics/steering.ts packages/core/src/cybernetics/steering.test.ts packages/core/src/cortex/loop.ts
git commit -m "feat: add Directive type, coalescing steering queue, cadence constant"
```
(Add the Co-Authored-By trailer per Global Constraints.)

---

## Task 2: NDJSON line builders + the steerable stdin stream

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/sdk-payload.ts`
- Modify: `packages/core/src/core/limbic/hypothalamus/sdk-payload.test.ts`
- Modify: `packages/core/src/cybernetics/steering.ts`
- Modify: `packages/core/src/cybernetics/steering.test.ts`

**Interfaces:**
- Consumes: `makeSteeringQueue` and `Directive` (Task 1).
- Produces:
  - `taskLine(text: string): string`, `steerLine(text: string): string`, `endLine(): string` (`sdk-payload.ts`) — one NDJSON line each, **no** trailing newline. Shapes: `{"v":1,"type":"task","text":…}`, `{"v":1,"type":"steer","text":…}`, `{"v":1,"type":"end"}`.
  - `buildSteeredStdinStream(task: string, steering: Queue.Queue<Directive>): Stream.Stream<Uint8Array>` (`cybernetics/steering.ts`) — the dynamic stdin: a `task` line, then a `steer` line per directive pulled from the queue, then an `end` line once the queue is shut down.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/core/limbic/hypothalamus/sdk-payload.test.ts` (the existing `import` line already imports from `./sdk-payload.js` — add the three builders to it):

```ts
// add to the existing import: taskLine, steerLine, endLine
describe("NDJSON line builders", () => {
  it("produce the host→runner wire shapes (no trailing newline)", () => {
    expect(JSON.parse(taskLine("do it"))).toEqual({ v: 1, type: "task", text: "do it" })
    expect(JSON.parse(steerLine("redirect"))).toEqual({ v: 1, type: "steer", text: "redirect" })
    expect(JSON.parse(endLine())).toEqual({ v: 1, type: "end" })
  })
})
```

Append to `packages/core/src/cybernetics/steering.test.ts`:

```ts
// add to the existing imports: Stream from "effect"; buildSteeredStdinStream from "./steering.js"
describe("buildSteeredStdinStream", () => {
  it("emits the task line first, then a steer line per directive (ordering)", async () => {
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* makeSteeringQueue()
        yield* Queue.offer(q, { text: "go left" })
        // Take exactly task + first steer, without ending the session, so the
        // assertion is deterministic (no shutdown timing involved).
        const collected = yield* buildSteeredStdinStream("start", q).pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.take(2),
          Stream.runCollect,
        )
        return Chunk.toReadonlyArray(collected)
      }),
    )
    expect(JSON.parse(lines[0])).toEqual({ v: 1, type: "task", text: "start" })
    expect(JSON.parse(lines[1])).toEqual({ v: 1, type: "steer", text: "go left" })
  })

  it("run-to-completion degenerate case: shut down with nothing offered → task then end", async () => {
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* makeSteeringQueue()
        yield* Queue.shutdown(q)
        const collected = yield* buildSteeredStdinStream("start", q).pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runCollect,
        )
        return Chunk.toReadonlyArray(collected)
      }),
    )
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { v: 1, type: "task", text: "start" },
      { v: 1, type: "end" },
    ])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/sdk-payload.test.ts packages/core/src/cybernetics/steering.test.ts`
Expected: FAIL — `taskLine`/`steerLine`/`endLine` and `buildSteeredStdinStream` are not exported.

- [ ] **Step 3: Add the line builders and refactor `buildSdkStdin`**

In `packages/core/src/core/limbic/hypothalamus/sdk-payload.ts`, add the three builders and rewrite `buildSdkStdin` to use them (the existing `buildSdkStdin` tests parse `lines[0]`/`lines[1]` and stay green):

```ts
/** A single host→runner `task` NDJSON line (no trailing newline). */
export function taskLine(text: string): string {
  return JSON.stringify({ v: 1, type: "task", text })
}

/** A single host→runner `steer` NDJSON line (no trailing newline). */
export function steerLine(text: string): string {
  return JSON.stringify({ v: 1, type: "steer", text })
}

/** The host→runner `end` control NDJSON line (no trailing newline). */
export function endLine(): string {
  return JSON.stringify({ v: 1, type: "end" })
}
```

Replace the body of `buildSdkStdin` with:

```ts
export function buildSdkStdin(task: string): string {
  return `${taskLine(task)}\n${endLine()}\n`
}
```

- [ ] **Step 4: Add `buildSteeredStdinStream`**

In `packages/core/src/cybernetics/steering.ts`, extend the imports and add the stream builder:

```ts
import { Effect, Queue, Stream } from "effect"
import type { Directive } from "./types.js"
import { taskLine, steerLine, endLine } from "../core/limbic/hypothalamus/sdk-payload.js"
```

```ts
/**
 * Build the dynamic stdin for a steerable SDK session as a byte stream of NDJSON
 * lines: the initial `task`, then one `steer` line per directive pulled from the
 * (coalescing) queue, then the terminal `end` line once the queue is shut down.
 * Shutting the queue down ends the session (the runner's generator returns →
 * query() completes). Run-to-completion is the degenerate case: shut the queue
 * down with nothing offered → `task` then `end`.
 */
export const buildSteeredStdinStream = (
  task: string,
  steering: Queue.Queue<Directive>,
): Stream.Stream<Uint8Array> =>
  Stream.make(`${taskLine(task)}\n`).pipe(
    Stream.concat(Stream.fromQueue(steering).pipe(Stream.map((d) => `${steerLine(d.text)}\n`))),
    Stream.concat(Stream.make(`${endLine()}\n`)),
    Stream.encodeText,
  )
```

Note: `Stream.fromQueue(steering)` ends gracefully when the queue is shut down (Effect 3 behavior); the degenerate-case test in Step 1 is the proof. If — and only if — that test goes RED because the shutdown surfaces as a stream defect instead of a graceful end, wrap the queue stream as `Stream.fromQueue(steering).pipe(Stream.catchAllCause(() => Stream.empty), Stream.map(...))` and re-run; do not change anything else.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/sdk-payload.test.ts packages/core/src/cybernetics/steering.test.ts`
Expected: PASS (including the unchanged `buildSdkStdin` tests).

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm exec tsc -p packages/core --noEmit`
Expected: no errors.

```bash
git add packages/core/src/core/limbic/hypothalamus/sdk-payload.ts packages/core/src/core/limbic/hypothalamus/sdk-payload.test.ts packages/core/src/cybernetics/steering.ts packages/core/src/cybernetics/steering.test.ts
git commit -m "feat: add NDJSON line builders and the steerable stdin stream"
```
(Add the Co-Authored-By trailer.)

---

## Task 3: `runSdkSession` — run a dynamic stdin through the transport

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/process-runner.ts`
- Modify: `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`

**Interfaces:**
- Consumes: `buildExecArgs`, `runTransport`, `normalizeSdk`, `buildSdkInnerCommand`, `sdkEnv`, `buildSdkStdin` (all existing); `taskLine`/`steerLine`/`endLine` (Task 2, for the test only).
- Produces:
  - `runSdkSession(config: TurnConfig, stdin: Stream.Stream<Uint8Array>): Effect.Effect<TurnResult, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken>` — runs the SDK runner with a caller-supplied dynamic stdin byte stream. Same R/E/A channels as `runTurn`/`runSdkTurn`.
  - (private) `runSdkWithStdin(config, stdin)` — the shared SDK transport composition; `runSdkTurn` is refactored to call it with a static `task`+`end` stdin.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`. The file already has the Phase-2 scaffolding (`char`, `sdkDeps`, `StubCharacterLog`, `NodeContext`, `runTransport`, `normalizeSdk`) and imports `buildExecArgs, runSdkTurn` from `./process-runner.js` and `buildSdkStdin` from `./sdk-payload.js` — extend those imports with `runSdkSession` and `taskLine, steerLine, endLine`:

```ts
// extend "./process-runner.js" import to include runSdkSession
// extend "./sdk-payload.js" import to include taskLine, steerLine, endLine

describe("runSdkSession", () => {
  it("is exported as a function", () => {
    expect(typeof runSdkSession).toBe("function")
  })

  it("delivers task + steer lines from a static steered stdin and accumulates both turns", async () => {
    // runSdkSession hardcodes Command.make("docker", …) so it cannot run host-side;
    // prove the seam (steered stdin → transport → normalizeSdk) via runTransport with
    // a fake runner, exactly as the Phase-2 composition tests do. The stdin here is a
    // STATIC task+steer+end stream (the live queue→stream mapping is covered in Task 2).
    const stdinText = `${taskLine("do the thing")}\n${steerLine("now do the other thing")}\n${endLine()}\n`
    const stdin = Stream.encodeText(Stream.make(stdinText))
    // Fake runner: read every stdin line; echo each task/steer line's text as an
    // assistant event; emit a terminal result on stdin EOF.
    const script =
      `node -e 'const rl=require("readline").createInterface({input:process.stdin});` +
      `rl.on("line",l=>{try{const o=JSON.parse(l);if(o.type==="task"||o.type==="steer")` +
      `process.stdout.write(JSON.stringify({v:1,type:"event",event:{type:"assistant",message:{content:[{type:"text",text:o.text}]}}})+"\\n")}catch{}});` +
      `rl.on("close",()=>process.stdout.write(JSON.stringify({v:1,type:"result",status:"completed",output:"done"})+"\\n"))'`
    const command = Command.make("bash", "-c", script).pipe(Command.stdin(stdin))

    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeSdk, runtimeTag: "sdk", char, role: "body", timeoutMs: 5000 }),
        sdkDeps,
      ),
    )
    expect(result.timedOut).toBe(false)
    expect(result.output).toBe("do the thing\nnow do the other thing")
  }, 10000)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`
Expected: FAIL — `runSdkSession` is not exported (the composition test may already pass since it only uses `runTransport`; the export-existence test is the red).

- [ ] **Step 3: Refactor `runSdkTurn` and add `runSdkSession`**

In `packages/core/src/core/limbic/hypothalamus/process-runner.ts`, replace the existing `runSdkTurn` definition with a shared private helper plus the two exports. (The imports `buildSdkInnerCommand, buildSdkStdin, sdkEnv` from `./sdk-payload.js` and `normalizeSdk` from `../../../logging/stream-normalizer.js`, plus `Stream`, `Command`, `OAuthToken`, etc., are already present from Phase 2.)

```ts
/** Shared SDK transport composition given a prebuilt stdin byte stream. */
const runSdkWithStdin = (
  config: TurnConfig,
  stdin: Stream.Stream<Uint8Array>,
): Effect.Effect<TurnResult, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken> =>
  Effect.gen(function* () {
    const oauthToken = yield* OAuthToken
    const { token } = yield* oauthToken.getToken

    const innerCmd = buildSdkInnerCommand()
    const execArgs = buildExecArgs({ ...config, env: sdkEnv(config) }, innerCmd, token)

    const redactedArgs = execArgs.map((a) =>
      a.includes("CLAUDE_CODE_OAUTH_TOKEN=") ? "CLAUDE_CODE_OAUTH_TOKEN=<redacted>" : a,
    )
    yield* logToConsole(config.char.name, config.role, `docker ${redactedArgs.join(" ")}`)

    const command = Command.make("docker", ...execArgs).pipe(Command.stdin(stdin))

    return yield* runTransport({
      command,
      normalize: normalizeSdk,
      runtimeTag: "sdk",
      char: config.char,
      role: config.role,
      timeoutMs: config.timeoutMs,
    })
  }).pipe(
    Effect.mapError((e) => (e instanceof ClaudeError ? e : new ClaudeError("SDK runner failed", e))),
  )

/**
 * Run a frontier-worker SDK turn run-to-completion. Builds the static NDJSON stdin
 * (`task` then `end`) and delegates to the shared transport composition.
 */
export const runSdkTurn = (config: TurnConfig): Effect.Effect<
  TurnResult,
  ClaudeError,
  CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
> => runSdkWithStdin(config, Stream.encodeText(Stream.make(buildSdkStdin(config.prompt))))

/**
 * Run a steerable frontier-worker SDK session. The caller supplies the dynamic
 * stdin byte stream (typically buildSteeredStdinStream over a steering queue):
 * directives become `steer` lines mid-session, and shutting the queue down ends
 * it. Run-to-completion is the degenerate case (a stdin that is just task+end).
 */
export const runSdkSession = (
  config: TurnConfig,
  stdin: Stream.Stream<Uint8Array>,
): Effect.Effect<TurnResult, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken> =>
  runSdkWithStdin(config, stdin)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`
Then typecheck: `pnpm exec tsc -p packages/core --noEmit`
Expected: PASS (all Phase-2 tests plus the two new `runSdkSession` tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/process-runner.ts packages/core/src/core/limbic/hypothalamus/process-runner.test.ts
git commit -m "feat: add runSdkSession for a dynamic steerable stdin"
```
(Add the Co-Authored-By trailer.)

---

## Task 4: Steering channel on `delegate` + `CyberneticsTest` capture

**Files:**
- Modify: `packages/core/src/cybernetics/delegate.ts`
- Modify: `packages/core/src/cybernetics/delegate.test.ts`

**Interfaces:**
- Consumes: `runSdkSession` (Task 3), `buildSteeredStdinStream` (Task 2), `makeSteeringQueue`/`Directive` (Task 1), `runTurn`/`toDelegationResult` (existing).
- Produces:
  - `Cybernetics` tag's `delegate: (config: DelegationConfig, steering?: Queue.Queue<Directive>) => Effect.Effect<DelegationResult, never, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken>` — when `steering` is provided, routes to `runSdkSession` with a steered stdin; otherwise the existing `runTurn` path (unchanged behavior).
  - `CyberneticsTest(impl, onSteer?)` — second optional callback receives each captured `Directive`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/cybernetics/delegate.test.ts`. (`cfg` is already defined in this file; extend imports with `CyberneticsTest` already imported, plus `Queue` from `"effect"`, `makeSteeringQueue` from `./steering.js`, and the `Directive` type from `./types.js`.)

```ts
// extend imports: Queue from "effect"; makeSteeringQueue from "./steering.js"; type Directive from "./types.js"
it("CyberneticsTest captures steer directives offered before delegation", async () => {
  const captured: Directive[] = []
  const program = Effect.gen(function* () {
    const cyb = yield* Cybernetics
    const q = yield* makeSteeringQueue()
    yield* Queue.offer(q, { text: "steer A" })
    return yield* cyb.delegate(cfg, q)
  })
  const result = await Effect.runPromise(
    Effect.provide(
      program,
      CyberneticsTest(
        () => ({ status: "completed", output: "ok", durationMs: 1 }),
        (d) => captured.push(d),
      ),
    ),
  )
  expect(result.status).toBe("completed")
  expect(captured).toEqual([{ text: "steer A" }])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/cybernetics/delegate.test.ts`
Expected: FAIL — `CyberneticsTest` does not accept a second argument / `delegate` does not accept a steering queue.

- [ ] **Step 3: Add the steering channel to `delegate.ts`**

Rewrite `packages/core/src/cybernetics/delegate.ts`:

```ts
import { Context, Effect, Layer, Queue, Chunk } from "effect"
import { CommandExecutor } from "@effect/platform"
import { runTurn, runSdkSession } from "../core/limbic/hypothalamus/process-runner.js"
import { ClaudeError } from "../services/Claude.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { CharacterLog } from "../logging/log-writer.js"
import type { DelegationConfig, DelegationResult, Directive } from "./types.js"
import { buildSteeredStdinStream } from "./steering.js"
import { toDelegationResult } from "./result.js"

export class Cybernetics extends Context.Tag("Cybernetics")<
  Cybernetics,
  {
    readonly delegate: (
      config: DelegationConfig,
      steering?: Queue.Queue<Directive>,
    ) => Effect.Effect<
      DelegationResult,
      never,
      CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
    >
  }
>() {}

/** Map a DelegationConfig to the TurnConfig both payload paths consume. */
const toTurnConfig = (config: DelegationConfig) => ({
  containerId: config.containerId,
  playerName: config.playerName,
  char: config.char,
  prompt: config.task,
  systemPrompt: config.systemPrompt,
  model: config.model,
  timeoutMs: config.timeoutMs,
  role: "body" as const,
  noTools: false,
  allowedTools: config.allowedTools,
  addDirs: config.addDirs,
  env: config.env,
})

const delegate = (
  config: DelegationConfig,
  steering?: Queue.Queue<Directive>,
): Effect.Effect<DelegationResult, never, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken> => {
  // With a steering queue → the steerable SDK session (only it speaks the wire
  // protocol). Without → the existing run-to-completion path (unchanged behavior).
  const turn = steering
    ? runSdkSession(toTurnConfig(config), buildSteeredStdinStream(config.task, steering))
    : runTurn(toTurnConfig(config))
  return turn.pipe(
    Effect.map(toDelegationResult),
    // A failed invocation (e.g. auth) is captured, not thrown.
    Effect.catchAll((e: ClaudeError) =>
      Effect.succeed<DelegationResult>({ status: "failed", output: e.message, durationMs: 0 }),
    ),
  )
}

/** Production layer — spawns the worker in the container via the transport. */
export const CyberneticsLive = Layer.succeed(Cybernetics, Cybernetics.of({ delegate }))

/**
 * Test layer — returns canned results without touching Docker. When a steering
 * queue is provided and `onSteer` is set, every directive currently buffered on
 * the queue (point-in-time, non-blocking) is reported for assertions.
 */
export const CyberneticsTest = (
  impl: (config: DelegationConfig) => DelegationResult,
  onSteer?: (directive: Directive) => void,
): Layer.Layer<Cybernetics> =>
  Layer.succeed(
    Cybernetics,
    Cybernetics.of({
      delegate: (config, steering) =>
        Effect.gen(function* () {
          if (steering && onSteer) {
            const pending = yield* Queue.takeAll(steering)
            for (const d of Chunk.toReadonlyArray(pending)) onSteer(d)
          }
          return impl(config)
        }),
    }),
  )
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm exec vitest run packages/core/src/cybernetics/delegate.test.ts`
Expected: PASS — the two existing tests (canned result, failed status) plus the new capture test.

- [ ] **Step 5: Verify existing callers still typecheck and pass**

Run: `pnpm exec tsc -p packages/core --noEmit`
Run: `pnpm exec vitest run packages/core/src/cortex/loop.test.ts`
Expected: no type errors; `loop.test.ts` green (its `delegate(config)` calls and `CyberneticsTest(impl)` / `Cybernetics.of({ delegate: () => … })` usages remain valid because both new parameters are optional and a narrower function is assignable to the wider tag type).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/cybernetics/delegate.ts packages/core/src/cybernetics/delegate.test.ts
git commit -m "feat: add optional steering channel to delegate and CyberneticsTest capture"
```
(Add the Co-Authored-By trailer.)

---

## Task 5: Document the steering channel

**Files:**
- Modify: `docs/cortex-smoke.md`

- [ ] **Step 1: Add a Phase 3 steering subsection**

In `docs/cortex-smoke.md`, inside the existing `## Phase 2: SDK Frontier-Worker Runner` section (after its content, before `## Debugging & Observability`), add a `### Steering Channel (Phase 3)` subsection in the file's existing prose+code-fence style, documenting:
- The `steer` wire message is now actually sent host-side (Phase 2 parsed-but-never-sent → Phase 3 sends it). The wire protocol itself is unchanged.
- The host-side steering queue is **coalescing, capacity 1** (`makeSteeringQueue` = `Queue.sliding(1)`): a newer directive supersedes an un-consumed older one. `task`/`end` are control messages, exempt from coalescing.
- `buildSteeredStdinStream(task, queue)` produces the dynamic stdin: `task`, then one `steer` line per directive, then `end` when the queue is shut down. `runSdkSession(config, stdin)` runs it through the shared transport.
- `delegate(config, steering)` routes to the steerable SDK session when a queue is given; **run-to-completion is the degenerate case** (no queue, or a queue shut down with nothing offered).
- Steering is **soft queue-and-finish**: a directive becomes the next user turn after the current one completes — never a mid-turn preempt.
- How to exercise it without a container: `pnpm exec vitest run packages/core/src/cybernetics/steering.test.ts packages/core/src/cybernetics/delegate.test.ts packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`.
- A note that **cadence-throttled production of directives, hindbrain/forebrain running during a session, escalation, completion-marker detection, and an end-to-end steered/real-container smoke are Phase 4** (`DEFAULT_STEER_CADENCE_TICKS` is defined now but consumed in Phase 4).

- [ ] **Step 2: Commit**

```bash
git add docs/cortex-smoke.md
git commit --no-verify -m "docs: document the Phase 3 steering channel"
```
(Add the Co-Authored-By trailer.)

---

## Self-Review

Checked against the spec (`docs/superpowers/specs/2026-06-18-cybernetics-agent-sdk-steering-design.md` §5(3), §6, §7) and the Phase-1 roadmap's Phase-3 line.

**1. Spec coverage:**
- "`delegate(config, steering: Queue<Directive>)`; run-to-completion = degenerate case" → Task 4 (optional `steering`; degenerate = no queue / immediately-shut queue). ✓
- "`Directive` is a new type to add in `cybernetics/types.ts`" → Task 1. ✓
- "coalescing, capacity 1; newer supersedes; `task`/`end` exempt" → Task 1 (`Queue.sliding(1)`) + Task 2 (`task`/`end` emitted by the stream, never queued). ✓
- "`steer` wire message; structurally identical to `task`; one user turn" → Tasks 2–3 (`steerLine`; runner already treats them identically, Phase 2). ✓
- "`CyberneticsTest` extended to capture steer directives" → Task 4 (`onSteer`). ✓
- "`STEER_CADENCE_TICKS` new knob alongside `orientInterval`" → Task 1 (`DEFAULT_STEER_CADENCE_TICKS`, defined; consumed Phase 4). ✓
- "soft queue-and-finish; no mid-turn preempt" → Global Constraints + carried by the Phase-2 runner; no preempt code added. ✓
- "same `delegate` + transport drives both payloads" → Task 3 `runSdkSession` reuses `runTransport`/`buildExecArgs` unchanged; the steered path is the SDK payload (the OpenCode conscious session is Phase 4). ✓
- Explicitly deferred (Phase 4), with no half-wired code that could fire: loop rework, `!delegationFiber` gate removal, cadence production, escalation, completion-marker detection, conscious/OpenCode session. ✓

**2. Placeholder scan:** No "TBD/handle errors/etc." The only conditional instruction is the `Stream.fromQueue` shutdown fallback in Task 2 Step 4 — it is concrete (exact wrapper code, gated on a specific RED), not a vague placeholder, and the degenerate-case test decides it.

**3. Type consistency:** `Directive = { text: string }` is used identically in `makeSteeringQueue` (`Queue.Queue<Directive>`), `buildSteeredStdinStream(task, steering: Queue.Queue<Directive>)`, the `Cybernetics` tag's `delegate(config, steering?: Queue.Queue<Directive>)`, and `CyberneticsTest`'s `onSteer: (directive: Directive) => void`. `runSdkSession(config: TurnConfig, stdin: Stream.Stream<Uint8Array>)` matches the call in `delegate` (`runSdkSession(toTurnConfig(config), buildSteeredStdinStream(config.task, steering))`). The line builders (`taskLine`/`steerLine`/`endLine`) return `string`; `buildSteeredStdinStream` wraps them in `Stream.encodeText` → `Stream.Stream<Uint8Array>`, matching `runSdkSession`'s `stdin` parameter and `Command.stdin`'s expectation. `runSdkTurn` keeps its exact exported signature. ✓

**Risk callouts for the executor:**
- (a) **`Stream.fromQueue` on shutdown** — the one behavior to confirm empirically (Task 2 degenerate test). The fallback is specified.
- (b) **Optional-parameter compatibility** — adding `steering?`/`onSteer?` must not change any existing caller. Task 4 Step 5 explicitly re-runs `loop.test.ts` and the typecheck to prove it.
- (c) **Coalescing vs. ordering tests** — both are made deterministic by design (queue-level `takeAll` for coalescing; `Stream.take(2)` for ordering; immediate shutdown for the degenerate case). Do NOT write a "offer two, then `runCollect` the whole stream" test — it races coalescing against consumption and is flaky.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-18-cybernetics-phase3-steering-channel.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute in this session with executing-plans, batch checkpoints.

**Which approach?**
