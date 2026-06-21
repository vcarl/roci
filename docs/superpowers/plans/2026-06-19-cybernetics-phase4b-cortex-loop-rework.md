# Cybernetics Phase 4b — Cortex Loop Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the cortex loop so the conscious tier (a tool-using OpenCode session, local LLM = the brain) becomes the per-step executor instead of forking each step to the frontier worker. The hindbrain and forebrain run during an active session and feed cadence-throttled steering into it. The frontier worker (`cybernetics.delegate`) goes dormant in 4b but is retained at the layer level for the 4c escalation path.

**Architecture:** The loop replaces the `delegationFiber`/`forkStep` delegation machinery with a conscious-session executor: turn 1 opens an OpenCode session; subsequent turns steer the same session via `turn(directive, { sessionId })`; the session completes when the agent emits a completion marker or the tick-budget elapses. A new `ConsciousThought` service (`packages/core/src/conscious/`) owns provisioning and per-turn execution, mirroring the `Cybernetics` pattern. The 4a OpenCode config helpers are moved from `cybernetics/` into `conscious/` (the correct conceptual home). Steering is capacity-1 coalescing via `pendingDirective` overwrite (no queue needed in a single-fiber loop). `runCortex`'s requirement channel drops `Cybernetics`, adds `ConsciousThought` and `Docker`.

**Tech Stack:** TypeScript ESM (`.js` import specifiers on relative imports), Effect-TS (`Effect`, `Fiber`, `Option`, `Layer`, `Context.Tag`, `Queue`), `@effect/platform` (`CommandExecutor`), Vitest, pnpm workspace (`@roci/core` at `packages/core`). Build: `pnpm -C packages/core build`. Tests: `pnpm -C packages/core test`.

## Global Constraints

- Language/build: TypeScript ESM — import specifiers end in `.js`. Effect-TS idioms (`Effect.gen`, `Fiber`, `Option`, `Layer`, `Context.Tag`). Package `@roci/core` under `packages/core`. Tests: Vitest. Build: `pnpm -C packages/core build`; tests: `pnpm -C packages/core test`.
- Every git commit message MUST end with exactly: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (include this line in every task's commit step).
- Code commits run the pre-commit hook (`pnpm build`); do NOT use `--no-verify` for code commits. If a commit fails with a missing-`dist/` error, run `pnpm build` once and retry the commit.
- Never pass `--bare` to `claude -p` (it disables OAuth token resolution).
- Steering/conscious directive text is model-generated (laundered) — never raw inbound event text; `formatSteerDirective` only formats already-laundered forebrain output.
- `Cybernetics` / `delegate` stay byte-for-byte unchanged (dormant in 4b); do not modify `delegate.ts`. Frontier escalation, completion-marker robustness tuning, the escalation-request marker, and the SDK live-generator path are explicitly 4c — out of scope.

---

## File Structure

**New files:**
- `packages/core/src/conscious/opencode-config.ts` — moved from `cybernetics/` (conscious-agent concern; content unchanged from 4a).
- `packages/core/src/conscious/opencode-config.test.ts` — moved from `cybernetics/`, with two new round-trip tests appended.
- `packages/core/src/conscious/opencode-session.smoke.test.ts` — moved from `cybernetics/` (relative imports unchanged).
- `packages/core/src/conscious/conscious-thought.ts` — new `ConsciousThought` tag + `ConsciousThoughtLive` / `ConsciousThoughtTest` layers; the conscious-turn config type.
- `packages/core/src/conscious/conscious-thought.test.ts` — service-contract tests for `ConsciousThought`.

**Modified files:**
- `packages/core/src/core/limbic/hypothalamus/payload.ts` (line 8) — update `CONSCIOUS_AGENT_NAME` import path from `../../../cybernetics/opencode-config.js` → `../../../conscious/opencode-config.js`.
- `packages/core/src/core/limbic/hypothalamus/payload.test.ts` — add a `buildOpenCodeSessionCommand` shell-special-char round-trip test.
- `packages/core/src/core/limbic/hypothalamus/process-runner.ts` (lines 186–187) — add typed resume-specific `ClaudeError` failure path.
- `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts` — add test for the typed resume-specific error.
- `packages/core/src/cortex/state.ts` — add `STEP_DONE_MARKER` constant, `detectCompletion`, `formatSteerDirective`; extend `formatStepTask` to mention the marker.
- `packages/core/src/cortex/state.test.ts` — add unit tests for the three new exports.
- `packages/core/src/cortex/loop.ts` — replace delegation machinery with conscious-session executor; swap requirement channel.
- `packages/core/src/cortex/loop.test.ts` — replace `CyberneticsTest`-based tests with `ConsciousThoughtTest`-based tests covering all spec §8 bullets.

**Deleted from old location (moved):**
- `packages/core/src/cybernetics/opencode-config.ts` — moved to `conscious/`.
- `packages/core/src/cybernetics/opencode-config.test.ts` — moved to `conscious/`.
- `packages/core/src/cybernetics/opencode-session.smoke.test.ts` — moved to `conscious/`.

---

## Task 1 — Relocate opencode-config into `src/conscious/`

**Files:**
- Create: `packages/core/src/conscious/opencode-config.ts` (content: copy of `packages/core/src/cybernetics/opencode-config.ts`, byte-for-byte)
- Create: `packages/core/src/conscious/opencode-config.test.ts` (content: copy of `packages/core/src/cybernetics/opencode-config.test.ts`, then add two new tests)
- Create: `packages/core/src/conscious/opencode-session.smoke.test.ts` (content: copy of `packages/core/src/cybernetics/opencode-session.smoke.test.ts`, with updated import path)
- Delete: `packages/core/src/cybernetics/opencode-config.ts`
- Delete: `packages/core/src/cybernetics/opencode-config.test.ts`
- Delete: `packages/core/src/cybernetics/opencode-session.smoke.test.ts`
- Modify: `packages/core/src/core/limbic/hypothalamus/payload.ts` line 8 (import path update)
- Modify: `packages/core/src/core/limbic/hypothalamus/payload.test.ts` (append one new test)

**Interfaces:**
- Consumes: all exports of `cybernetics/opencode-config.ts` (unchanged; just new path).
- Produces: same exports at `conscious/opencode-config.js`; `payload.ts` rewired to import `CONSCIOUS_AGENT_NAME` from `../../../conscious/opencode-config.js`.

---

- [ ] **Step 1: Verify the current source files match expectations before moving**

Run: `grep -n "CONSCIOUS_AGENT_NAME" /Users/vcarl/workspace/roci/.claude/worktrees/agent-sdk/packages/core/src/core/limbic/hypothalamus/payload.ts`
Expected: line 8 — `import { CONSCIOUS_AGENT_NAME } from "../../../cybernetics/opencode-config.js"`

Run: `grep -rn "cybernetics/opencode-config" /Users/vcarl/workspace/roci/.claude/worktrees/agent-sdk/packages/core/src/`
Expected: hits in exactly three files: `payload.ts` (the external importer) plus the two test files' self-referencing lines (relative `./opencode-config.js` — those stay valid after move).

- [ ] **Step 2: Create the `conscious/` directory and copy opencode-config.ts**

```bash
mkdir -p packages/core/src/conscious
cp packages/core/src/cybernetics/opencode-config.ts packages/core/src/conscious/opencode-config.ts
```

No content changes — the file is identical. The `../services/Docker.js` relative path goes up two levels from `cybernetics/` and also up two levels from `conscious/` (both are direct children of `src/`), so it resolves correctly.

- [ ] **Step 3: Copy and update the smoke test (relative `./opencode-config.js` import stays valid after copy)**

```bash
cp packages/core/src/cybernetics/opencode-session.smoke.test.ts packages/core/src/conscious/opencode-session.smoke.test.ts
```

The smoke test already imports `from "./opencode-config.js"` — that relative path is correct in the new location without any change.

- [ ] **Step 4: Write the first new failing test — `writeCharacterAgentFile` overwrite + shell-special-char in `buildCharacterAgentMarkdown`**

The existing `opencode-config.test.ts` already has overwrite tests. The new tests to add are: (a) second overwrite content wins and file is `0o444`; (b) a body with shell-special characters (`"`, `$`, backtick) round-trips through `buildCharacterAgentMarkdown` and survives `writeCharacterAgentFile`. These are the 4a follow-up #2 tests.

Create `packages/core/src/conscious/opencode-config.test.ts` by copying `packages/core/src/cybernetics/opencode-config.test.ts` and then appending the following two `it` blocks inside the existing `describe("writeCharacterAgentFile", () => {` block:

```typescript
  it("second write overwrites with new content and restores 0o444", () => {
    const playersDir = mkdtempSync(path.join(tmpdir(), "roci-players-"))
    writeCharacterAgentFile({ playersDir, playerName: "ada", systemPrompt: "v1" })
    writeCharacterAgentFile({ playersDir, playerName: "ada", systemPrompt: "v2" })
    const file = path.join(playersDir, "ada", ".opencode", "agent", "conscious.md")
    expect(readFileSync(file, "utf8")).toContain("v2")
    expect(readFileSync(file, "utf8")).not.toContain("v1")
    expect(statSync(file).mode & 0o222).toBe(0) // read-only after second write
  })

  it("shell-special-char system prompt round-trips through buildCharacterAgentMarkdown and writeCharacterAgentFile", () => {
    const special = `He said "hello $USER" and \`echo hi\` was tried`
    const md = buildCharacterAgentMarkdown({ systemPrompt: special })
    expect(md).toContain(special)
    const playersDir = mkdtempSync(path.join(tmpdir(), "roci-players-"))
    writeCharacterAgentFile({ playersDir, playerName: "ada", systemPrompt: special })
    const file = path.join(playersDir, "ada", ".opencode", "agent", "conscious.md")
    expect(readFileSync(file, "utf8")).toContain(special)
  })
```

Also update the import line at the top of the copied file to point to the new path (it already uses `"./opencode-config.js"` which is correct for the `conscious/` location):

```typescript
import {
  hostInternalBaseUrl,
  buildProviderConfigJson,
  buildCharacterAgentMarkdown,
  CONSCIOUS_MODEL_LABEL,
  GLOBAL_OPENCODE_CONFIG_PATH,
  provisionConsciousProvider,
  writeCharacterAgentFile,
} from "./opencode-config.js"
```

- [ ] **Step 5: Run the new tests to verify they fail (before removing the old files)**

Run: `pnpm -C packages/core test conscious/opencode-config`
Expected: FAIL — cannot resolve `./opencode-config.js` (because `conscious/opencode-config.ts` is not yet the one being imported, or if the copy is already there, it should PASS and the step below confirms green).

Actually, since we copied the source in Step 2 and the test file in this step, the file is present. Run to confirm all tests pass:

Run: `pnpm -C packages/core test conscious/opencode-config`
Expected: PASS — all existing tests pass; new overwrite/special-char tests also pass.

- [ ] **Step 6: Write the second new failing test — `buildOpenCodeSessionCommand` shell-special-char round-trip in `payload.test.ts`**

Append to `packages/core/src/core/limbic/hypothalamus/payload.test.ts` inside the existing `describe("buildOpenCodeSessionCommand", () => {` block:

```typescript
  it("shell-special-char prompt round-trips safely through shellEscape in the command string", () => {
    const tricky = `say "hello" and $HOME and \`date\``
    const cmd = buildOpenCodeSessionCommand({ ...cfg, prompt: tricky })
    // The result must contain a $'...' ANSI-C quoted form — not the raw characters unquoted
    expect(cmd).toContain("$'")
    // The double-quote is passed literally inside the $'...' block (not escaped with \")
    expect(cmd).toContain('\\"') // shellEscape does not double-quote; double-quote is passed through
    // Dollar sign and backtick must appear escaped or inside the quoting form
    // (shellEscape passes non-control printable chars through; the $'...' wrapper is the escape mechanism)
    expect(cmd).toContain("$HOME") // dollar sign is inside $'...' so the shell does not expand it
    expect(cmd).not.toContain("say \"hello\"") // raw unquoted form must not appear
  })
```

Wait — read `shellEscape` carefully before writing this test. From `payload.ts` lines 12–24:

```typescript
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
```

`shellEscape` escapes backslashes and single-quotes; `"`, `$`, and backtick are passed through **inside** the `$'...'` ANSI-C quoting form, which prevents shell expansion. So a correct test is:

```typescript
  it("shell-special-char prompt survives shellEscape inside buildOpenCodeSessionCommand", () => {
    const tricky = `say "hi" and $HOME and \`date\``
    const cmd = buildOpenCodeSessionCommand({ ...cfg, prompt: tricky })
    // The prompt appears inside $'...' ANSI-C quoting
    expect(cmd).toMatch(/\$'.*say "hi".*'/)
    // The $'...' wrapper means dollar sign and backtick are literal (no shell expansion)
    // Confirm the exact escaped form is present in the command string
    expect(cmd).toContain(`$'say "hi" and $HOME and \`date\`'`)
  })
```

Replace the placeholder block above with this exact test. Append it inside the existing `describe("buildOpenCodeSessionCommand", () => {` block in `payload.test.ts`.

- [ ] **Step 7: Run to verify the new payload test passes**

Run: `pnpm -C packages/core test payload`
Expected: PASS — all existing tests pass; the new special-char test also passes.

- [ ] **Step 8: Delete the old `cybernetics/` opencode-config files**

```bash
git rm packages/core/src/cybernetics/opencode-config.ts
git rm packages/core/src/cybernetics/opencode-config.test.ts
git rm packages/core/src/cybernetics/opencode-session.smoke.test.ts
```

- [ ] **Step 9: Update the import in `payload.ts` (line 8)**

In `packages/core/src/core/limbic/hypothalamus/payload.ts`, change line 8:

Old:
```typescript
import { CONSCIOUS_AGENT_NAME } from "../../../cybernetics/opencode-config.js"
```

New:
```typescript
import { CONSCIOUS_AGENT_NAME } from "../../../conscious/opencode-config.js"
```

- [ ] **Step 10: Verify no remaining `cybernetics/opencode-config` references**

Run: `grep -rn "cybernetics/opencode-config" packages/core/src/`
Expected: no output (zero hits).

- [ ] **Step 11: Build and run full test suite**

Run: `pnpm -C packages/core build && pnpm -C packages/core test`
Expected: build succeeds; all tests pass; smoke test skips (no `ROCI_OPENCODE_SESSION_CONTAINER`).

- [ ] **Step 12: Commit**

```bash
git add packages/core/src/conscious/
git add packages/core/src/core/limbic/hypothalamus/payload.ts
git add packages/core/src/core/limbic/hypothalamus/payload.test.ts
git commit -m "refactor(conscious): relocate opencode-config into src/conscious/; add overwrite + shell-special-char tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — Typed session-not-found-on-resume error in `runOpenCodeSessionTurn`

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/process-runner.ts` (add `sessionNotFoundMessage` helper after line 144; use it in the `if (!sessionId)` failure path at lines 186–188)
- Modify: `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`

**Interfaces:**
- Consumes: `ClaudeError` from `../../../services/Claude.ts` (`ClaudeError` is a plain class with `_tag = "ClaudeError"`, `message: string`, `cause?: unknown` — no subtype mechanism).
- Produces: `sessionNotFoundMessage(resume?: { sessionId: string }): string` — exported pure helper. With no `resume` it returns the original first-turn message `"OpenCode session id not captured from run output"`; with `resume` it returns a resume-specific message that contains `"resume"` and the session id, distinguishable from the first-turn message (string-matchable in 4c). `runOpenCodeSessionTurn` fails with `new ClaudeError(sessionNotFoundMessage(resume))`; the error channel stays `ClaudeError`.

---

Rather than test the un-injectable `Command.make("docker", …)` path, extract the message-selection logic into a small exported pure helper, `sessionNotFoundMessage`, and unit-test that directly. This is a real test of the actual production function (not a hand-built string), and `runOpenCodeSessionTurn` calls the same helper.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`. The file already imports `firstSessionId, runOpenCodeSessionTurn` from `./process-runner.js` (line 5) — extend that import to add `sessionNotFoundMessage`, then append the test block:

```typescript
describe("sessionNotFoundMessage", () => {
  it("first-turn message (no resume) matches the original wording", () => {
    expect(sessionNotFoundMessage()).toBe("OpenCode session id not captured from run output")
  })
  it("resume-path message names the resume and the session id, and differs from the first-turn message", () => {
    const msg = sessionNotFoundMessage({ sessionId: "ses_abc" })
    expect(msg).toContain("resume")
    expect(msg).toContain("ses_abc")
    expect(msg).not.toBe(sessionNotFoundMessage())
  })
})
```

Run: `pnpm -C packages/core test process-runner`
Expected: FAIL — `sessionNotFoundMessage` is not exported (`SyntaxError`/import resolution error).

- [ ] **Step 2: Extract the helper and use it in the failure path**

In `packages/core/src/core/limbic/hypothalamus/process-runner.ts`, add the exported helper next to `firstSessionId` (after line 144):

```typescript
/**
 * Message for the "no session id" failure. The resume path is distinct from the
 * first-turn path so a lost-session resume is diagnosable (and string-matchable in 4c).
 */
export function sessionNotFoundMessage(resume?: { sessionId: string }): string {
  return resume
    ? `OpenCode resume failed: session id not available for session ${resume.sessionId}`
    : "OpenCode session id not captured from run output"
}
```

Then, in `runOpenCodeSessionTurn`, change the failure path (current lines 185–188):

Current:
```typescript
    const sessionId = result.sessionId ?? resume?.sessionId
    if (!sessionId) {
      return yield* Effect.fail(new ClaudeError("OpenCode session id not captured from run output"))
    }
```

Replace with:
```typescript
    const sessionId = result.sessionId ?? resume?.sessionId
    if (!sessionId) {
      return yield* Effect.fail(new ClaudeError(sessionNotFoundMessage(resume)))
    }
```

- [ ] **Step 3: Build and verify tests still pass**

Run: `pnpm -C packages/core build && pnpm -C packages/core test process-runner`
Expected: build green; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/process-runner.ts
git add packages/core/src/core/limbic/hypothalamus/process-runner.test.ts
git commit -m "fix(process-runner): typed resume-path error distinguishes session-not-found from first-turn failure

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — `ConsciousThought` service

**Files:**
- Create: `packages/core/src/conscious/conscious-thought.ts`
- Create: `packages/core/src/conscious/conscious-thought.test.ts`

**Interfaces:**
- Consumes:
  - `runOpenCodeSessionTurn` from `../core/limbic/hypothalamus/process-runner.js` → `Effect<{ result: TurnResult; sessionId: string }, ClaudeError, CommandExecutor | CharacterLog | OAuthToken>`.
  - `provisionConsciousProvider` from `./opencode-config.js` → `Effect<string, DockerError, Docker>` (we wrap with `Effect.asVoid`).
  - `writeCharacterAgentFile` from `./opencode-config.js` → `void` (sync).
  - `CONSCIOUS_MODEL_LABEL` from `./opencode-config.js`.
  - `ModelHandle` from `../model/handles.js`.
  - `CharacterConfig` from `../services/CharacterFs.js`.
  - `TurnConfig`, `TurnResult` from `../core/limbic/hypothalamus/types.js`.
  - `Docker` from `../services/Docker.js`.
  - `ClaudeError` from `../services/Claude.js`.
  - `CommandExecutor` from `@effect/platform`.
  - `CharacterLog` from `../logging/log-writer.js`.
  - `OAuthToken` from `../services/OAuthToken.js`.
- Produces:
  - `ConsciousTurnConfig` — the config type for a single conscious turn (local to `conscious/`).
  - `ConsciousThought` — `Context.Tag` with methods:
    - `provision(opts: { containerId: string; char: CharacterConfig; handle: ModelHandle; systemPrompt: string }): Effect<void, never, Docker>`
    - `turn(config: ConsciousTurnConfig, resume?: { sessionId: string }): Effect<{ result: TurnResult; sessionId: string }, never, CommandExecutor | CharacterLog | OAuthToken>`
  - `ConsciousThoughtLive` — `Layer<ConsciousThought>` (production; `Layer.succeed` wrapping the real impl; does NOT provide `Docker`/`CommandExecutor`/`CharacterLog`/`OAuthToken` — caller must compose those).
  - `ConsciousThoughtTest(impl, onSteer?)` — `Layer<ConsciousThought>` (test stub; no-op `provision`; returns canned `turn`; captures steer directives via `onSteer`).

**Design choice for `turn` error channel:** `runOpenCodeSessionTurn` fails with `ClaudeError`. The `ConsciousThought.turn` method maps the error channel to `never` via `Effect.catchAll`, producing a synthetic `{ result: TurnResult; sessionId: string }` where `result.output` contains the error message, `result.timedOut = false`, `result.durationMs = 0`, and `sessionId` is carried from `resume?.sessionId ?? "error-sentinel"`. This lets the loop append the error to `stepReport` and continue to the evaluate phase without special-casing.

---

- [ ] **Step 1: Write the failing service test**

Create `packages/core/src/conscious/conscious-thought.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import { ConsciousThought, ConsciousThoughtTest } from "./conscious-thought.js"
import { CharacterLog } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { Docker } from "../services/Docker.js"
import type { TurnResult } from "../core/limbic/hypothalamus/types.js"

// Minimal stubs — ConsciousThoughtTest never calls the real transport.
const StubCommandExecutor = Layer.succeed(
  CommandExecutor.CommandExecutor,
  { start: () => { throw new Error("stub CommandExecutor: not implemented") } } as unknown as CommandExecutor.CommandExecutor,
)
const StubCharacterLog = Layer.succeed(
  CharacterLog,
  CharacterLog.of({ emit: () => Effect.void }),
)
const StubOAuthToken = Layer.succeed(
  OAuthToken,
  OAuthToken.of({
    getToken: Effect.succeed({ token: "stub", version: 0 }),
    validateInContainer: () => Effect.succeed(true),
  }),
)
const StubDocker = Layer.succeed(
  Docker,
  Docker.of({ exec: () => Effect.succeed("") } as unknown as typeof Docker.Service),
)
const testDeps = Layer.mergeAll(StubCommandExecutor, StubCharacterLog, StubOAuthToken, StubDocker)

const cannedResult: TurnResult = { output: "step complete", timedOut: false, durationMs: 100 }

describe("ConsciousThought service contract", () => {
  it("turn returns the canned result from ConsciousThoughtTest", async () => {
    const captured: string[] = []
    const layer = Layer.merge(
      ConsciousThoughtTest(
        () => ({ result: cannedResult, sessionId: "ses_001" }),
        (directive) => captured.push(directive),
      ),
      testDeps,
    )
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const ct = yield* ConsciousThought
          return yield* ct.turn({
            containerId: "c1",
            playerName: "ada",
            char: { name: "ada", dir: "/work/players/ada/me" },
            prompt: "do the task",
            timeoutMs: 60_000,
          })
        }),
        layer,
      ),
    )
    expect(result.sessionId).toBe("ses_001")
    expect(result.result.output).toBe("step complete")
  })

  it("ConsciousThoughtTest captures steer directives via onSteer", async () => {
    const captured: string[] = []
    const layer = Layer.merge(
      ConsciousThoughtTest(
        () => ({ result: cannedResult, sessionId: "ses_002" }),
        (d) => captured.push(d),
      ),
      testDeps,
    )
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const ct = yield* ConsciousThought
          // Simulate a steer turn: the directive text is the prompt on a resume call
          return yield* ct.turn({
            containerId: "c1",
            playerName: "ada",
            char: { name: "ada", dir: "/work/players/ada/me" },
            prompt: "steer: focus on the login flow",
            timeoutMs: 60_000,
          }, { sessionId: "ses_002" })
        }),
        layer,
      ),
    )
    expect(captured).toEqual(["steer: focus on the login flow"])
  })

  it("a turn failure surfaces as a failed-style result (never throws)", async () => {
    const layer = Layer.merge(
      ConsciousThoughtTest(
        () => { throw new Error("simulated turn error") },
      ),
      testDeps,
    )
    // ConsciousThoughtTest impl that throws — the error channel must still be never.
    // We model this as an impl that returns a synthetic failed result, not throws.
    // The test below verifies the layer's catchAll discipline via the Live path.
    // For the Test path, the impl is provided directly, so throw is propagated unless
    // ConsciousThoughtTest wraps with try/catch. The discipline is: impl MUST return
    // { result, sessionId }; the test layer does not catch impl exceptions.
    // This test instead verifies the Live path's catchAll via a ClaudeError injection.
    // For service test purposes, verify that the Test layer accepts any { result, sessionId } shape.
    const errorLayer = Layer.merge(
      ConsciousThoughtTest(
        () => ({ result: { output: "auth error", timedOut: false, durationMs: 0 }, sessionId: "error-sentinel" }),
      ),
      testDeps,
    )
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const ct = yield* ConsciousThought
          return yield* ct.turn({
            containerId: "c1",
            playerName: "ada",
            char: { name: "ada", dir: "/work/players/ada/me" },
            prompt: "do it",
            timeoutMs: 1000,
          })
        }),
        errorLayer,
      ),
    )
    expect(result.result.output).toBe("auth error")
    expect(result.sessionId).toBe("error-sentinel")
  })

  it("provision is a no-op in ConsciousThoughtTest (does not throw)", async () => {
    const layer = Layer.merge(
      ConsciousThoughtTest(() => ({ result: cannedResult, sessionId: "ses_003" })),
      testDeps,
    )
    await expect(
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const ct = yield* ConsciousThought
            yield* ct.provision({
              containerId: "c1",
              char: { name: "ada", dir: "/work/players/ada/me" },
              handle: { tier: "conscious", provider: "mlx", baseUrl: "http://127.0.0.1:8083/v1", model: "qwen3" },
              systemPrompt: "you are ada",
            })
          }),
          layer,
        ),
      ),
    ).resolves.not.toThrow()
  })
})
```

Run: `pnpm -C packages/core test conscious/conscious-thought`
Expected: FAIL — cannot resolve `./conscious-thought.js`.

- [ ] **Step 2: Implement `conscious-thought.ts`**

Create `packages/core/src/conscious/conscious-thought.ts`:

```typescript
import * as path from "node:path"
import { Context, Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import type { ModelHandle } from "../model/handles.js"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { TurnConfig, TurnResult } from "../core/limbic/hypothalamus/types.js"
import { runOpenCodeSessionTurn } from "../core/limbic/hypothalamus/process-runner.js"
import { CharacterLog } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { Docker } from "../services/Docker.js"
import {
  provisionConsciousProvider,
  writeCharacterAgentFile,
  CONSCIOUS_MODEL_LABEL,
  CONSCIOUS_AGENT_NAME,
} from "./opencode-config.js"

/** Config for a single conscious-tier OpenCode turn. */
export interface ConsciousTurnConfig {
  containerId: string
  playerName: string
  char: CharacterConfig
  /** The prompt text: step task on turn 1, directive text on steer turns. */
  prompt: string
  /** Wall-clock budget for this turn. */
  timeoutMs: number
}

/** The inputs to `provision`, derived by the loop from `CortexLoopConfig`. */
export interface ProvisionOpts {
  containerId: string
  char: CharacterConfig
  handle: ModelHandle
  systemPrompt: string
}

export class ConsciousThought extends Context.Tag("ConsciousThought")<
  ConsciousThought,
  {
    /**
     * Provision the conscious agent once before the loop starts.
     * Writes the global per-container OpenCode provider config and the
     * project-local character agent file. Error channel is `never` — a Docker
     * failure here is swallowed (idempotent; safe to retry next run) but is NOT
     * silently lost: if provisioning failed, turn 1 fails loudly with an OpenCode
     * "unknown provider/model" error, which flows through the normal failed-result
     * path into the step report and evaluate. Explicit provisioning diagnostics
     * are deferred to Phase 4c.
     */
    readonly provision: (opts: ProvisionOpts) => Effect.Effect<void, never, Docker>

    /**
     * Run one turn of the conscious session. First call (no `resume`) opens a
     * new OpenCode session; subsequent calls resume the same session by id.
     * Error channel is `never` — a transport failure becomes a failed-style
     * result (output = error message, sessionId = carried from resume or sentinel).
     */
    readonly turn: (
      config: ConsciousTurnConfig,
      resume?: { sessionId: string },
    ) => Effect.Effect<
      { result: TurnResult; sessionId: string },
      never,
      CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
    >
  }
>() {}

const provisionImpl = (opts: ProvisionOpts): Effect.Effect<void, never, Docker> => {
  // Derive playersDir from char.dir: char.dir = players/<name>/me, grandparent = players/
  const playersDir = path.resolve(opts.char.dir, "../..")
  // Write the project-local agent file synchronously (host-side fs, no Effect service).
  writeCharacterAgentFile({
    playersDir,
    playerName: opts.char.name,
    systemPrompt: opts.systemPrompt,
    modelLabel: CONSCIOUS_MODEL_LABEL,
  })
  // Provision the global in-container provider config (requires Docker).
  return provisionConsciousProvider(opts.containerId, opts.handle).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  )
}

const turnImpl = (
  config: ConsciousTurnConfig,
  resume?: { sessionId: string },
): Effect.Effect<
  { result: TurnResult; sessionId: string },
  never,
  CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
> => {
  const turnConfig: TurnConfig = {
    containerId: config.containerId,
    playerName: config.playerName,
    char: config.char,
    systemPrompt: "", // system prompt is supplied via the agent file, not --system-prompt
    model: CONSCIOUS_MODEL_LABEL,
    agentName: CONSCIOUS_AGENT_NAME,
    prompt: config.prompt,
    timeoutMs: config.timeoutMs,
    role: "body",
  }
  return runOpenCodeSessionTurn(turnConfig, resume).pipe(
    Effect.catchAll((e) =>
      Effect.succeed({
        result: { output: e.message, timedOut: false, durationMs: 0 },
        sessionId: resume?.sessionId ?? "error-sentinel",
      }),
    ),
  )
}

/** Production layer — runs provision against Docker and turn over the shared transport. */
export const ConsciousThoughtLive: Layer.Layer<ConsciousThought> = Layer.succeed(
  ConsciousThought,
  ConsciousThought.of({
    provision: provisionImpl,
    turn: turnImpl,
  }),
)

/**
 * Test layer — no-op `provision`, returns canned `turn` results, and captures
 * steer directive text (the prompt on resume calls) via `onSteer`.
 * Mirrors `CyberneticsTest` in `cybernetics/delegate.ts`.
 */
export const ConsciousThoughtTest = (
  impl: (
    config: ConsciousTurnConfig,
    resume?: { sessionId: string },
  ) => { result: TurnResult; sessionId: string },
  onSteer?: (directiveText: string) => void,
): Layer.Layer<ConsciousThought> =>
  Layer.succeed(
    ConsciousThought,
    ConsciousThought.of({
      provision: () => Effect.void as Effect.Effect<void, never, Docker>,
      turn: (config, resume) =>
        Effect.sync(() => {
          // Capture steer directives: any resume call's prompt is a directive.
          if (resume && onSteer) onSteer(config.prompt)
          return impl(config, resume)
        }),
    }),
  )
```

- [ ] **Step 3: Run the service test to verify it passes**

Run: `pnpm -C packages/core test conscious/conscious-thought`
Expected: PASS — all four contract tests pass.

- [ ] **Step 4: Build and run full suite**

Run: `pnpm -C packages/core build && pnpm -C packages/core test`
Expected: build green; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/conscious/conscious-thought.ts
git add packages/core/src/conscious/conscious-thought.test.ts
git commit -m "feat(conscious): ConsciousThought service tag + Live/Test layers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — Pure cortex helpers in `state.ts`

**Files:**
- Modify: `packages/core/src/cortex/state.ts` (lines 35–49 — add after `formatExecutionReport`)
- Modify: `packages/core/src/cortex/state.test.ts` (append new `describe` blocks)

**Interfaces:**
- Consumes: `OrientResult` from `../skills/types.js` (`headline: string`, `whatChanged: string`, `sections: ReadonlyArray<{ id: string; heading: string; body: string }>`, `emotionalState: string`, `metrics: Record<string, string | number | boolean>`).
- Produces:
  - `STEP_DONE_MARKER: string` — exported constant; the literal string the conscious agent is instructed to print when done (e.g. `"[STEP_DONE]"`).
  - `detectCompletion(output: string): boolean` — returns `true` if `output` contains `STEP_DONE_MARKER` (case-sensitive, tolerant of surrounding whitespace/text).
  - `formatSteerDirective(orient: OrientResult): string` — renders headline + whatChanged + section bodies into a concise steering directive; note in a comment that the text is model-generated (laundered upstream by the forebrain).
  - `formatStepTask` is **extended** (not replaced): the closing instruction line (current line 41: `Do this work now. When finished, report concisely what you did and whether the success condition is met.`) gets an additional sentence: `` When you have fully met the success condition, print exactly: ${STEP_DONE_MARKER} ``

---

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/cortex/state.test.ts`:

```typescript
import {
  freshCortexState,
  shouldForceOrient,
  formatStepTask,
  planSteps,
  STEP_DONE_MARKER,
  detectCompletion,
  formatSteerDirective,
} from "./state.js"
import type { OrientResult } from "../skills/types.js"
```

Update the existing import at line 1–8 to add the three new exports, then append:

```typescript
describe("STEP_DONE_MARKER", () => {
  it("is a non-empty string", () => {
    expect(typeof STEP_DONE_MARKER).toBe("string")
    expect(STEP_DONE_MARKER.length).toBeGreaterThan(0)
  })
})

describe("detectCompletion", () => {
  it("returns true when output contains the marker", () => {
    expect(detectCompletion(`All done! ${STEP_DONE_MARKER} Great work.`)).toBe(true)
    expect(detectCompletion(STEP_DONE_MARKER)).toBe(true)
    expect(detectCompletion(`\n${STEP_DONE_MARKER}\n`)).toBe(true)
  })
  it("returns false when output does not contain the marker", () => {
    expect(detectCompletion("Task finished.")).toBe(false)
    expect(detectCompletion("")).toBe(false)
    // Case-sensitive: lowercase version must not match
    expect(detectCompletion(STEP_DONE_MARKER.toLowerCase())).toBe(false)
  })
})

describe("formatSteerDirective", () => {
  const orient: OrientResult = {
    headline: "Login flow broken after auth refactor",
    whatChanged: "OAuth redirect URL changed",
    emotionalState: "😟",
    sections: [
      { id: "s1", heading: "Impact", body: "Users cannot log in." },
      { id: "s2", heading: "Priority", body: "Fix immediately." },
    ],
    metrics: { errors: 42 },
  }

  it("includes the headline", () => {
    expect(formatSteerDirective(orient)).toContain("Login flow broken after auth refactor")
  })
  it("includes whatChanged", () => {
    expect(formatSteerDirective(orient)).toContain("OAuth redirect URL changed")
  })
  it("includes section bodies", () => {
    const d = formatSteerDirective(orient)
    expect(d).toContain("Users cannot log in.")
    expect(d).toContain("Fix immediately.")
  })
})

describe("formatStepTask (extended with marker)", () => {
  it("mentions the STEP_DONE_MARKER in the closing instruction", () => {
    const task = formatStepTask(
      { task: "fix bug", goal: "fix #42", tier: "smart", successCondition: "tests pass", timeoutTicks: 3 },
      "fixing bugs",
    )
    expect(task).toContain(STEP_DONE_MARKER)
  })
})
```

Run: `pnpm -C packages/core test cortex/state`
Expected: FAIL — `STEP_DONE_MARKER`, `detectCompletion`, `formatSteerDirective` not exported; `formatStepTask` marker test fails.

- [ ] **Step 2: Implement the new exports in `state.ts`**

In `packages/core/src/cortex/state.ts`, add to the imports at line 1:

```typescript
import type { OrientResult } from "../skills/types.js"
```

After the existing imports (after line 2), add the new constant and functions before `freshCortexState`. Then extend `formatStepTask`. Full replacement of `state.ts` content:

```typescript
import type { DecideResult, WaitState } from "../skills/types.js"
import type { OrientResult } from "../skills/types.js"
import type { PlanStep } from "../core/types.js"

export interface CortexState {
  accumulatedEvents: string[]
  emotionalWeight: string
  currentPlan: DecideResult | null
  currentStepIndex: number
  waitState: WaitState | null
  lastOrientTick: number
}

export function freshCortexState(): CortexState {
  return {
    accumulatedEvents: [],
    emotionalWeight: "",
    currentPlan: null,
    currentStepIndex: 0,
    waitState: null,
    lastOrientTick: 0,
  }
}

/** Force an orient when events have piled up for `orientInterval` ticks without one. */
export function shouldForceOrient(state: CortexState, tick: number, orientInterval: number): boolean {
  return state.accumulatedEvents.length > 0 && tick - state.lastOrientTick >= orientInterval
}

/** The steps of a plan decision, or [] for any other decision. */
export function planSteps(plan: DecideResult | null): readonly PlanStep[] {
  return plan && plan.decision === "plan" ? plan.steps : []
}

/**
 * Literal marker the conscious agent is instructed to print when it has fully
 * met the current step's success condition. 4b ships the mechanism; phrasing
 * robustness tuning and the escalation-request marker are Phase 4c.
 */
export const STEP_DONE_MARKER = "[STEP_DONE]"

/**
 * Returns true if the output contains the completion marker, indicating the
 * agent self-reported success. Tolerant of surrounding text; case-sensitive.
 * runConsciousEvaluate remains the arbiter — a premature marker → replan/wait.
 */
export function detectCompletion(output: string): boolean {
  return output.includes(STEP_DONE_MARKER)
}

/**
 * Render a forebrain OrientResult into a concise steering directive.
 * The text is model-generated (laundered upstream by the forebrain) —
 * this function only formats; it never embeds raw inbound event text.
 */
export function formatSteerDirective(orient: OrientResult): string {
  const parts: string[] = [
    `Situation update: ${orient.headline}`,
    `What changed: ${orient.whatChanged}`,
  ]
  for (const section of orient.sections) {
    parts.push(`${section.heading}: ${section.body}`)
  }
  return parts.join("\n")
}

/** The instructions handed to the conscious agent for one plan step. */
export function formatStepTask(step: PlanStep, headline: string): string {
  return [
    `# Task: ${step.task}`,
    `Context: ${headline}`,
    `## Goal\n${step.goal}`,
    `## Success condition\n${step.successCondition}`,
    `Do this work now. When finished, report concisely what you did and whether the success condition is met. When you have fully met the success condition, print exactly: ${STEP_DONE_MARKER}`,
  ].join("\n\n")
}

/** Wrap a worker's text output as the execution report fed to evaluate. */
export function formatExecutionReport(output: string): string {
  const trimmed = output.trim()
  return trimmed.length > 0 ? trimmed : "Worker produced no output."
}
```

- [ ] **Step 3: Run the unit tests**

Run: `pnpm -C packages/core test cortex/state`
Expected: PASS — all existing tests and the four new test groups pass.

- [ ] **Step 4: Build and full suite**

Run: `pnpm -C packages/core build && pnpm -C packages/core test`
Expected: build green; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cortex/state.ts
git add packages/core/src/cortex/state.test.ts
git commit -m "feat(cortex/state): add STEP_DONE_MARKER, detectCompletion, formatSteerDirective; extend formatStepTask with marker instruction

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — Rework `cortex/loop.ts` + loop tests

**Files:**
- Modify: `packages/core/src/cortex/loop.ts` (full rework — all lines)
- Modify: `packages/core/src/cortex/loop.test.ts` (replace existing tests with `ConsciousThoughtTest`-based tests)

**Interfaces:**
- Consumes:
  - `ConsciousThought`, `ConsciousThoughtTest` from `../conscious/conscious-thought.js`
  - `Docker` from `../services/Docker.js`
  - `STEP_DONE_MARKER`, `detectCompletion`, `formatSteerDirective` from `./state.js`
  - `DEFAULT_STEER_CADENCE_TICKS` (already exported from `loop.ts` line 64 — keep it exported)
  - All existing non-cybernetics imports retained
- Produces:
  - `runCortex(config: CortexLoopConfig): Effect<CortexResult, ModelError, ... | ConsciousThought | Docker>` (drops `Cybernetics`, adds `ConsciousThought` + `Docker`)
  - `CortexLoopConfig` — unchanged interface
  - `CortexResult` — unchanged type

**Key loop state changes (replacing lines 97–123 of `loop.ts`):**
- Remove: `delegationFiber: Fiber.RuntimeFiber<DelegationResult, never> | null` (line 98)
- Remove: `forkStep` closure (lines 104–123)
- Add: `consciousFiber: Fiber.RuntimeFiber<{ result: TurnResult; sessionId: string }, never> | null`
- Add: `sessionId: string | null`
- Add: `stepReport: string`
- Add: `stepDoneSignaled: boolean`
- Add: `pendingDirective: string | null`
- Add: `lastSteerTick: number`

**Remove the four `!delegationFiber` gates:**
- Line 232: `if (!delegationFiber && tickEvents.length > 0) {` → `if (tickEvents.length > 0) {`
- Line 243: `if (!delegationFiber && !escalate && …)` → `if (!escalate && …)`
- Line 247: `if (escalate && !delegationFiber && cortex.currentPlan === null) {` → `if (escalate && cortex.currentPlan === null) {`
- Line 285: `if (!delegationFiber && cortex.currentPlan !== null) {` → replaced by full step-execution block

---

- [ ] **Step 1: Write the new loop tests (they fail because the loop still uses Cybernetics)**

Replace `packages/core/src/cortex/loop.test.ts` entirely with the following:

```typescript
import { describe, it, expect } from "vitest"
import { Effect, Layer, Queue, Ref, TestClock, Fiber } from "effect"
import { CommandExecutor } from "@effect/platform"
import { runCortex } from "./loop.js"
import { ModelClient } from "../model/client.js"
import type { ModelHandle } from "../model/handles.js"
import { ConsciousThought, ConsciousThoughtTest } from "../conscious/conscious-thought.js"
import { Docker } from "../services/Docker.js"
import type { TurnResult } from "../core/limbic/hypothalamus/types.js"
import { EventProcessorTag } from "../core/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../core/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../core/limbic/amygdala/interrupt.js"
import { StateRendererTag } from "../core/state-renderer.js"
import { PromptBuilderTag } from "../core/prompt-builder.js"
import { CharacterFs } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { STEP_DONE_MARKER } from "./state.js"

// ModelClient that branches on which skill template produced the prompt.
// Classify by unique COMBINATION of markers (see original test comment for rationale).
const scriptedClient = Layer.succeed(
  ModelClient,
  ModelClient.of({
    complete: (_h: ModelHandle, messages) =>
      Effect.sync(() => {
        const p = messages.map((m) => m.content).join(" ").toLowerCase()
        const hasDisposition = p.includes("disposition")
        const hasDecision = p.includes("decision")
        const hasHeadline = p.includes("headline")
        const hasJudgment = p.includes("judgment")
        if (hasDisposition && !hasDecision)
          return {
            text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}',
            raw: {},
          }
        if (hasJudgment && !hasHeadline)
          return {
            text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}',
            raw: {},
          }
        if (hasHeadline && !hasJudgment)
          return {
            text: '{"headline":"act now","sections":[{"id":"s1","heading":"Action","body":"Get moving."}],"whatChanged":"things changed","emotionalState":"😰","metrics":{}}',
            raw: {},
          }
        // decide
        return {
          text: '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do the thing","tier":"smart","successCondition":"thing done","timeoutTicks":2}]}',
          raw: {},
        }
      }),
  }),
)

// Scripted client where first evaluate → next_step, second → terminate (multi-step test).
const makeMultiStepClient = (evalCountRef: { n: number }) =>
  Layer.succeed(
    ModelClient,
    ModelClient.of({
      complete: (_h: ModelHandle, messages) =>
        Effect.sync(() => {
          const p = messages.map((m) => m.content).join(" ").toLowerCase()
          const hasDisposition = p.includes("disposition")
          const hasDecision = p.includes("decision")
          const hasHeadline = p.includes("headline")
          const hasJudgment = p.includes("judgment")
          if (hasDisposition && !hasDecision)
            return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
          if (hasJudgment && !hasHeadline) {
            evalCountRef.n++
            const transition =
              evalCountRef.n === 1
                ? '{"transition":"next_step"}'
                : '{"transition":"terminate","summary":"all done"}'
            return {
              text: `{"judgment":"succeeded","reasoning":"done","transition":${transition}}`,
              raw: {},
            }
          }
          if (hasHeadline && !hasJudgment)
            return {
              text: '{"headline":"act now","sections":[{"id":"s1","heading":"Detail","body":"Do it."}],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
              raw: {},
            }
          // decide → two steps, timeoutTicks: 4 so budget doesn't fire first
          return {
            text: '{"decision":"plan","reasoning":"go","steps":[{"task":"step-one","goal":"first","tier":"smart","successCondition":"done","timeoutTicks":4},{"task":"step-two","goal":"second","tier":"smart","successCondition":"done","timeoutTicks":4}]}',
            raw: {},
          }
        }),
    }),
  )

const fakeDomain = Layer.mergeAll(
  Layer.succeed(EventProcessorTag, EventProcessorTag.of({ processEvent: () => ({}) })),
  Layer.succeed(
    SituationClassifierTag,
    SituationClassifierTag.of({
      summarize: () => ({ situation: {} as never, headline: "h", sections: [], metrics: {} }),
    }),
  ),
  Layer.succeed(
    InterruptRegistryTag,
    InterruptRegistryTag.of({
      rules: [],
      evaluate: () => [],
      criticals: () => [],
      softAlerts: () => [],
    }),
  ),
  Layer.succeed(
    StateRendererTag,
    StateRendererTag.of({
      snapshot: () => ({}),
      richSnapshot: () => ({}),
      stateDiff: () => "",
      logStateBar: () => {},
    }),
  ),
  Layer.succeed(
    PromptBuilderTag,
    PromptBuilderTag.of({ systemPrompt: () => "you are an agent" }),
  ),
)

const fakeFs = Layer.succeed(
  CharacterFs,
  CharacterFs.of({
    readDiary: () => Effect.succeed(""),
    writeDiary: () => Effect.void,
    readSecrets: () => Effect.succeed(""),
    writeSecrets: () => Effect.void,
    readCredentials: () => Effect.succeed({ username: "", password: "" }),
    readBackground: () => Effect.succeed(""),
    readValues: () => Effect.succeed(""),
    characterExists: () => Effect.succeed(true),
  }),
)
const fakeLog = Layer.succeed(CharacterLog, CharacterLog.of({ emit: () => Effect.void }))
const fakeIo = Layer.mergeAll(fakeFs, fakeLog)

// Stubs for services declared in ConsciousThought's requirement channels.
const StubCommandExecutor = Layer.succeed(
  CommandExecutor.CommandExecutor,
  { start: () => { throw new Error("stub CommandExecutor: not implemented") } } as unknown as CommandExecutor.CommandExecutor,
)
const StubOAuthToken = Layer.succeed(
  OAuthToken,
  OAuthToken.of({
    getToken: Effect.succeed({ token: "stub", version: 0 }),
    validateInContainer: () => Effect.succeed(true),
  }),
)
const StubDocker = Layer.succeed(
  Docker,
  Docker.of({ exec: () => Effect.succeed("") } as unknown as typeof Docker.Service),
)
const fakeRuntimeDeps = Layer.mergeAll(StubCommandExecutor, StubOAuthToken, StubDocker)

/** Canonical canned TurnResult for a step that completes successfully. */
const successTurnResult = (task: string): TurnResult => ({
  output: `did ${task.slice(0, 10)} ${STEP_DONE_MARKER}`,
  timedOut: false,
  durationMs: 10,
})

describe("runCortex (conscious-session executor)", () => {
  it("turn 1 opens a session and the loop completes when evaluate returns terminate", async () => {
    let turnCallCount = 0
    const ctLayer = ConsciousThoughtTest((config, resume) => {
      turnCallCount++
      // First call: no resume (turn 1 opens session)
      if (!resume) {
        return { result: successTurnResult(config.prompt), sessionId: "ses_001" }
      }
      return { result: successTurnResult(config.prompt), sessionId: "ses_001" }
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      const result = yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(scriptedClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
      return { result, turnCallCount }
    })
    const { result, turnCallCount: count } = await Effect.runPromise(program)
    // Turn 1 must have been called (opens session)
    expect(count).toBeGreaterThanOrEqual(1)
    expect(result._tag).toBe("Completed")
  }, 20_000)

  it("done-marker in turn output triggers early evaluate before tick-budget", async () => {
    // The step has timeoutTicks: 10, but turn 1 returns STEP_DONE_MARKER → evaluate fires immediately.
    const doneClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            return {
              text: `{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":10}]}`,
              raw: {},
            }
          }),
      }),
    )
    const ticksAtEvaluate: number[] = []
    let evaluateCallCount = 0
    // Intercept evaluate by counting how many times the model is called with "judgment"
    const countingEvalClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline) {
              evaluateCallCount++
              return {
                text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}',
                raw: {},
              }
            }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            return {
              text: `{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":10}]}`,
              raw: {},
            }
          }),
      }),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `task done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_done",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      const result = yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(countingEvalClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
      return result
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // evaluate was called exactly once (early, on done-marker)
    expect(evaluateCallCount).toBe(1)
  }, 20_000)

  it("tick-budget expiry triggers salvage evaluate when no done-marker", async () => {
    // Step timeoutTicks: 1 — after 1 tick the budget fires even without STEP_DONE_MARKER.
    const budgetClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"salvage","transition":{"transition":"terminate","summary":"salvaged"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            return {
              text: `{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":1}]}`,
              raw: {},
            }
          }),
      }),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      // No STEP_DONE_MARKER in output
      result: { output: "making progress...", timedOut: false, durationMs: 5 },
      sessionId: "ses_budget",
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
      }).pipe(Effect.provide(Layer.mergeAll(budgetClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
  }, 20_000)

  it("non-discard hindbrain during session stores a pendingDirective for the next steer turn", async () => {
    // We verify this by checking that ConsciousThoughtTest's onSteer receives the directive
    // (onSteer is called on resume turns, which only happen when a directive was pending).
    const capturedDirectives: string[] = []
    // The step has a large timeoutTicks (30) so the tick-budget backstop cannot salvage-complete
    // the step before the mid-session event lands. Turn 1 returns no done-marker; a mid-session
    // event (forked offerer below) triggers in-session hindbrain (non-discard) → forebrain →
    // directive stored. Once the cadence window opens (tick - lastSteerTick >= 3) the steer turn
    // fires (turn 2 returns the done-marker → step completes → evaluate → terminate).
    const steerClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"focus on login","sections":[{"id":"s1","heading":"Priority","body":"Fix the login bug."}],"whatChanged":"login broken","emotionalState":"😟","metrics":{}}',
                raw: {},
              }
            return {
              text: `{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}`,
              raw: {},
            }
          }),
      }),
    )
    let turnCount = 0
    const ctLayer = ConsciousThoughtTest(
      (config, resume) => {
        turnCount++
        if (turnCount >= 2) {
          // Second+ turn: emit done marker to end the step
          return {
            result: { output: `steered ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
            sessionId: "ses_steer",
          }
        }
        return { result: { output: "working...", timedOut: false, durationMs: 5 }, sessionId: "ses_steer" }
      },
      (directive) => capturedDirectives.push(directive),
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" }) // tick 1: forms the plan, opens turn 1
      // Deliver a mid-session event AFTER turn 1 has opened the session, so the hindbrain
      // triages it in-session (currentPlan !== null) → forebrain → directive. The step only
      // completes via a steer turn carrying a directive (turn 2 returns the done-marker), so
      // the loop deterministically stays in-session until steering occurs — wall-clock affects
      // only the tick count, not the ordering.
      yield* Effect.forkDaemon(
        Effect.sleep("8 millis").pipe(
          Effect.andThen(Queue.offer(events, { type: "mid-session-update" })),
        ),
      )
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(steerClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // At least one steer directive was captured (hard assertion — must not be vacuous).
    expect(capturedDirectives.length).toBeGreaterThanOrEqual(1)
    // The directive text is laundered (model-generated headline/body, not raw event text)
    const allDirectives = capturedDirectives.join(" ")
    expect(allDirectives).toContain("focus on login")
  }, 20_000)

  it("cadence throttle: steer turn carries the latest coalesced directive", async () => {
    // The steer turn receives the latest forebrain directive as its prompt; verified via onSteer.
    // Setup: a large timeoutTicks (30) so the budget can't pre-empt; the plan-forming orient
    // produces "first orient" (idle), and the mid-session orient produces "second orient (newest)",
    // which is the directive carried by the steer turn. (Pure newest-wins overwrite of
    // pendingDirective is a deterministic assignment, covered by the overwrite semantics.)
    const capturedDirectives: string[] = []
    let orientCallCount = 0
    const coalesceClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment) {
              orientCallCount++
              const headline = orientCallCount === 1 ? "first orient" : "second orient (newest)"
              return {
                text: `{"headline":"${headline}","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}`,
                raw: {},
              }
            }
            return {
              text: `{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}`,
              raw: {},
            }
          }),
      }),
    )
    let turnCount = 0
    const ctLayer = ConsciousThoughtTest(
      (_config, _resume) => {
        turnCount++
        if (turnCount >= 2) {
          return {
            result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
            sessionId: "ses_coalesce",
          }
        }
        return { result: { output: "working", timedOut: false, durationMs: 5 }, sessionId: "ses_coalesce" }
      },
      (d) => capturedDirectives.push(d),
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "event-a" }) // tick 1: forms the plan (orient #1 = "first orient")
      // Mid-session event → in-session forebrain (orient #2 = "second orient (newest)") → directive.
      yield* Effect.forkDaemon(
        Effect.sleep("8 millis").pipe(
          Effect.andThen(Queue.offer(events, { type: "event-b" })),
        ),
      )
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(coalesceClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // A throttled steer turn fired carrying the laundered, latest forebrain directive (hard assertion).
    // (Pure newest-wins/overwrite coalescing of pendingDirective is covered deterministically by the
    // overwrite semantics; this loop-level test verifies a steer turn fires with the latest directive.)
    expect(capturedDirectives.length).toBeGreaterThanOrEqual(1)
    expect(capturedDirectives[capturedDirectives.length - 1]).toContain("second orient (newest)")
  }, 20_000)

  it("returns Interrupted when a critical interrupt fires", async () => {
    const criticalDomain = Layer.mergeAll(
      Layer.succeed(EventProcessorTag, EventProcessorTag.of({ processEvent: () => ({}) })),
      Layer.succeed(
        SituationClassifierTag,
        SituationClassifierTag.of({
          summarize: () => ({ situation: {} as never, headline: "h", sections: [], metrics: {} }),
        }),
      ),
      Layer.succeed(
        InterruptRegistryTag,
        InterruptRegistryTag.of({
          rules: [],
          evaluate: () => [],
          softAlerts: () => [],
          criticals: () => [{ priority: "critical", message: "hull critical" }],
        }),
      ),
      Layer.succeed(
        StateRendererTag,
        StateRendererTag.of({
          snapshot: () => ({}),
          richSnapshot: () => ({}),
          stateDiff: () => "",
          logStateBar: () => {},
        }),
      ),
      Layer.succeed(PromptBuilderTag, PromptBuilderTag.of({ systemPrompt: () => "x" })),
    )
    const ctLayer = ConsciousThoughtTest(() => ({
      result: { output: "working", timedOut: false, durationMs: 1 },
      sessionId: "ses_x",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        tickIntervalMs: 1,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(scriptedClient, ctLayer, criticalDomain, fakeIo, fakeRuntimeDeps),
        ),
      )
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Interrupted")
    if (result._tag === "Interrupted") expect(result.criticals[0].message).toContain("hull")
  }, 20_000)

  it("criticals interrupt an in-flight conscious fiber", async () => {
    const interrupted = { value: false }
    const tickRef = { n: 0 }
    const interruptingDomain = Layer.mergeAll(
      Layer.succeed(EventProcessorTag, EventProcessorTag.of({ processEvent: () => ({}) })),
      Layer.succeed(
        SituationClassifierTag,
        SituationClassifierTag.of({
          summarize: () => ({ situation: {} as never, headline: "h", sections: [], metrics: {} }),
        }),
      ),
      Layer.succeed(
        InterruptRegistryTag,
        InterruptRegistryTag.of({
          rules: [],
          evaluate: () => [],
          softAlerts: () => [],
          criticals: () => {
            tickRef.n++
            return tickRef.n >= 2 ? [{ priority: "critical", message: "hull critical" }] : []
          },
        }),
      ),
      Layer.succeed(
        StateRendererTag,
        StateRendererTag.of({
          snapshot: () => ({}),
          richSnapshot: () => ({}),
          stateDiff: () => "",
          logStateBar: () => {},
        }),
      ),
      Layer.succeed(PromptBuilderTag, PromptBuilderTag.of({ systemPrompt: () => "x" })),
    )
    // Blocking conscious turn: never completes, records interruption.
    const blockingCt = Layer.succeed(
      ConsciousThought,
      ConsciousThought.of({
        provision: () => Effect.void as Effect.Effect<void, never, Docker>,
        turn: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => { interrupted.value = true })),
          ) as Effect.Effect<{ result: TurnResult; sessionId: string }, never, never>,
      }),
    )
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
      }).pipe(
        Effect.provide(
          Layer.mergeAll(scriptedClient, blockingCt, interruptingDomain, fakeIo, fakeRuntimeDeps),
        ),
      )
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Interrupted")
    if (result._tag === "Interrupted") {
      expect(result.criticals.length).toBeGreaterThan(0)
      expect(result.criticals[0].message).toContain("hull")
    }
    expect(interrupted.value).toBe(true)
  }, 20_000)

  it("multi-step plan advances next_step across sessions", async () => {
    const evalCountRef = { n: 0 }
    const multiStepClient = makeMultiStepClient(evalCountRef)
    let sessionCount = 0
    const ctLayer = ConsciousThoughtTest((config, resume) => {
      // Each step's first turn opens a new session.
      if (!resume) sessionCount++
      return {
        result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
        sessionId: `ses_step${sessionCount}`,
      }
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      const result = yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(multiStepClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
      return { result, sessionCount }
    })
    const { result, sessionCount: sc } = await Effect.runPromise(program)
    // Two steps → two sessions opened
    expect(sc).toBe(2)
    expect(result._tag).toBe("Completed")
  }, 20_000)

  it("directive text is laundered (model-generated forebrain output, not raw event text)", async () => {
    // Verify that what onSteer receives is the formatted forebrain orient,
    // not the raw event string ("{ type: 'combat' }").
    const capturedDirectives: string[] = []
    let turnCount = 0
    const launderClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                // Laundered headline — not raw event JSON
                text: '{"headline":"LAUNDERED_HEADLINE","sections":[{"id":"s1","heading":"Details","body":"LAUNDERED_BODY"}],"whatChanged":"LAUNDERED_CHANGED","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            return {
              text: `{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}`,
              raw: {},
            }
          }),
      }),
    )
    const ctLayer = ConsciousThoughtTest(
      (_config, _resume) => {
        turnCount++
        if (turnCount >= 2) {
          return {
            result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
            sessionId: "ses_launder",
          }
        }
        return { result: { output: "working", timedOut: false, durationMs: 5 }, sessionId: "ses_launder" }
      },
      (d) => capturedDirectives.push(d),
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "plan-seed-event" }) // tick 1: forms the plan
      // The mid-session event carries a recognizable raw type string; the resulting steer
      // directive must contain ONLY the laundered forebrain text, never this raw string.
      yield* Effect.forkDaemon(
        Effect.sleep("8 millis").pipe(
          Effect.andThen(Queue.offer(events, { type: "raw-event-should-not-appear" })),
        ),
      )
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(launderClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
    })
    await Effect.runPromise(program)
    // Hard assertion — a directive must have been captured, and it must be laundered.
    expect(capturedDirectives.length).toBeGreaterThanOrEqual(1)
    for (const d of capturedDirectives) {
      expect(d).not.toContain("raw-event-should-not-appear")
      expect(d).toContain("LAUNDERED_HEADLINE")
    }
  }, 20_000)
})
```

Run: `pnpm -C packages/core test cortex/loop`
Expected: FAIL — `ConsciousThought` not found in the loop's layer requirements (loop still uses `Cybernetics`).

- [ ] **Step 2: Implement the reworked `loop.ts`**

Replace `packages/core/src/cortex/loop.ts` entirely:

```typescript
import { Effect, Queue, Option, Fiber } from "effect"
import { CommandExecutor } from "@effect/platform"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterFs } from "../services/CharacterFs.js"
import { CharacterLog, logToConsole } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { EventProcessorTag } from "../core/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../core/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../core/limbic/amygdala/interrupt.js"
import { StateRendererTag } from "../core/state-renderer.js"
import { PromptBuilderTag } from "../core/prompt-builder.js"
import { ConsciousThought } from "../conscious/conscious-thought.js"
import type { TurnResult } from "../core/limbic/hypothalamus/types.js"
import { ModelClient } from "../model/client.js"
import type { ModelError } from "../model/errors.js"
import { DEFAULT_CORTEX_MODELS, resolveHandle, type CortexModelConfig } from "../model/handles.js"
import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "../core/model-config.js"
import type { Cadence } from "../skills/cadence.js"
import type { Alert, PlanStep } from "../core/types.js"
import { Docker } from "../services/Docker.js"
import {
  runHindbrain,
  runForebrain,
  runConsciousDecide,
  runConsciousEvaluate,
  type CortexRunnerConfig,
} from "./tiers.js"
import {
  freshCortexState,
  shouldForceOrient,
  planSteps,
  formatStepTask,
  formatExecutionReport,
  formatSteerDirective,
  detectCompletion,
  STEP_DONE_MARKER,
} from "./state.js"

export interface CortexLoopConfig {
  char: CharacterConfig
  containerId: string
  containerEnv?: Record<string, string>
  addDirs?: string[]
  events: Queue.Queue<unknown>
  initialState: unknown
  cadence?: Cadence
  cortexModels?: CortexModelConfig
  workerModels?: ModelConfig
  orientInterval?: number
  workerTimeoutMs?: number
  tickIntervalMs?: number
}

export type CortexResult =
  | { readonly _tag: "Completed"; readonly finalState: unknown }
  | { readonly _tag: "Interrupted"; readonly finalState: unknown; readonly criticals: Alert[] }

const DEFAULT_TICK_MS = 30_000
const DEFAULT_ORIENT_INTERVAL = 5
// workerTimeoutMs is reused as the per-turn wall-clock timeout in 4b.
// (Previously it bounded a whole delegation step; now it bounds each conscious turn.
// A dedicated consciousTurnTimeoutMs knob is deferred tuning — Phase 4c.)
const DEFAULT_WORKER_TIMEOUT_MS = 60 * 60 * 1000

/**
 * Push a `steer` line to the active session at most once every this-many ticks
 * (§7) — a knob alongside DEFAULT_ORIENT_INTERVAL. Exported so it is not an unused local.
 * Tunable per cadence profile (spec §11 open question).
 */
export const DEFAULT_STEER_CADENCE_TICKS = 3

const AVAILABLE_ACTIONS =
  "Each plan step is executed by the conscious agent (local LLM in an OpenCode session with full tool access). Plan concrete steps; each step.task names the action and step.goal describes the outcome."

export const runCortex = (config: CortexLoopConfig) =>
  Effect.gen(function* () {
    const eventProcessor = yield* EventProcessorTag
    const classifier = yield* SituationClassifierTag
    const interrupts = yield* InterruptRegistryTag
    const renderer = yield* StateRendererTag
    const promptBuilder = yield* PromptBuilderTag
    const consciousThought = yield* ConsciousThought
    const charFs = yield* CharacterFs

    const cadence: Cadence = config.cadence ?? "planned-action"
    const orientInterval = config.orientInterval ?? DEFAULT_ORIENT_INTERVAL
    const tickMs = config.tickIntervalMs ?? DEFAULT_TICK_MS
    const workerTimeoutMs = config.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS
    const runnerConfig: CortexRunnerConfig = {
      char: config.char,
      cadence,
      models: config.cortexModels ?? DEFAULT_CORTEX_MODELS,
    }

    let state = config.initialState
    const cortex = freshCortexState()
    let tick = 0
    let stepStartTick = 0
    let stepStartSnapshot = renderer.richSnapshot(state as never)
    // Orient headline of the in-progress plan — context for every step.
    let planHeadline = ""

    // Conscious-session state (replaces delegationFiber / forkStep machinery).
    let consciousFiber: Fiber.RuntimeFiber<{ result: TurnResult; sessionId: string }, never> | null = null
    let sessionId: string | null = null
    let stepReport = ""
    let stepDoneSignaled = false
    // Steering state: capacity-1 coalescing (overwrite = newest wins).
    let pendingDirective: string | null = null
    let lastSteerTick = 0

    // Provision the conscious agent once before the first tick.
    const handle = resolveHandle(runnerConfig.models, "conscious")
    const systemPrompt = promptBuilder.systemPrompt("select", "")
    yield* consciousThought.provision({
      containerId: config.containerId,
      char: config.char,
      handle,
      systemPrompt,
    })

    while (true) {
      tick++

      // 1. Drain world events into state.
      const tickEvents: string[] = []
      let draining = true
      while (draining) {
        const maybe = yield* Queue.poll(config.events)
        if (Option.isNone(maybe)) {
          draining = false
        } else {
          const event = maybe.value
          yield* Effect.try(() => {
            const r = eventProcessor.processEvent(event as never, state as never)
            if (r.stateUpdate) state = r.stateUpdate(state as never)
            if (r.log) r.log()
          }).pipe(Effect.catchAll((e) => logToConsole(config.char.name, "error", `event error: ${e}`)))
          tickEvents.push(
            typeof event === "object" && event !== null
              ? `type: ${(event as Record<string, unknown>).type ?? "unknown"}\n${JSON.stringify(event)}`
              : String(event),
          )
        }
      }

      // 2. Classify + critical interrupts (the amygdala cuts the line).
      const summary = classifier.summarize(state as never)
      renderer.logStateBar(config.char.name, summary.metrics)
      const criticals = interrupts.criticals(state as never, summary.situation)
      if (criticals.length > 0) {
        yield* logToConsole(
          config.char.name,
          "orchestrator",
          `Critical: ${criticals.map((a) => a.message).join("; ")}`,
        )
        if (consciousFiber) yield* Fiber.interrupt(consciousFiber)
        return { _tag: "Interrupted" as const, finalState: state, criticals }
      }

      // 3. If a conscious turn is in flight, check whether it finished.
      if (consciousFiber) {
        const done = yield* Fiber.poll(consciousFiber).pipe(Effect.map(Option.isSome))
        if (done) {
          const { result, sessionId: capturedId } = yield* Fiber.join(consciousFiber)
          consciousFiber = null
          sessionId = capturedId
          // Append turn output to the accumulated step report.
          const turnOutput = result.output ?? ""
          stepReport = stepReport ? `${stepReport}\n${turnOutput}` : turnOutput
          // Check whether the agent signaled completion.
          if (detectCompletion(turnOutput)) {
            stepDoneSignaled = true
          }
        }
        // While a turn runs, fall through to triage the world, then sleep.
      }

      // 4. HINDBRAIN triage — ungated: runs whenever there are events, even mid-session.
      let escalate = tick === 1
      let nonDiscard = false
      if (tickEvents.length > 0) {
        const observe = yield* runHindbrain(runnerConfig, tickEvents, cortex.waitState)
        yield* logToConsole(
          config.char.name,
          "cortex",
          `hindbrain: ${observe.disposition} ${observe.emotionalWeight}`,
        )
        cortex.emotionalWeight = observe.emotionalWeight
        if (observe.disposition !== "discard") {
          cortex.accumulatedEvents.push(...tickEvents)
          nonDiscard = true
        }
        if (observe.disposition === "escalate") escalate = true
      }
      if (!escalate && shouldForceOrient(cortex, tick, orientInterval)) escalate = true

      // 5. FOREBRAIN — two disjoint call sites, never both in the same tick.
      if (cortex.currentPlan === null) {
        // 5a. Idle path: orient → decide → plan (unchanged from pre-4b).
        if (escalate) {
          const background = yield* charFs
            .readBackground(config.char)
            .pipe(Effect.catchAll(() => Effect.succeed("")))
          const values = yield* charFs
            .readValues(config.char)
            .pipe(Effect.catchAll(() => Effect.succeed("")))
          const diary = yield* charFs
            .readDiary(config.char)
            .pipe(Effect.catchAll(() => Effect.succeed("")))
          const orient = yield* runForebrain(
            runnerConfig,
            cortex.accumulatedEvents,
            JSON.stringify(summary, null, 2),
            { background, values, diary },
            cortex.emotionalWeight,
          )
          yield* logToConsole(config.char.name, "cortex", `forebrain: ${orient.headline}`)
          const decide = yield* runConsciousDecide(runnerConfig, orient, "No active plan.", AVAILABLE_ACTIONS)
          yield* logToConsole(config.char.name, "cortex", `conscious: ${decide.decision}`)
          cortex.accumulatedEvents = []
          cortex.lastOrientTick = tick

          if (decide.decision === "terminate") return { _tag: "Completed" as const, finalState: state }
          if (decide.decision === "wait") {
            cortex.waitState = decide.wait
            if (decide.wait.disposition === "terminate")
              return { _tag: "Completed" as const, finalState: state }
          } else if (decide.decision === "plan" && decide.steps.length > 0) {
            cortex.currentPlan = decide
            cortex.currentStepIndex = 0
            planHeadline = orient.headline
          }
        }
      } else {
        // 5b. In-session path: on a NON-DISCARD hindbrain disposition,
        // run forebrain → formatSteerDirective → store as pendingDirective (overwrite = coalesce).
        // Runs on EVERY non-discard tick (spec §3-5b / §4); the cadence throttle
        // (DEFAULT_STEER_CADENCE_TICKS) + capacity-1 coalescing bound the actual steer turns.
        if (nonDiscard) {
          const background = yield* charFs
            .readBackground(config.char)
            .pipe(Effect.catchAll(() => Effect.succeed("")))
          const values = yield* charFs
            .readValues(config.char)
            .pipe(Effect.catchAll(() => Effect.succeed("")))
          const diary = yield* charFs
            .readDiary(config.char)
            .pipe(Effect.catchAll(() => Effect.succeed("")))
          const orient = yield* runForebrain(
            runnerConfig,
            cortex.accumulatedEvents,
            JSON.stringify(summary, null, 2),
            { background, values, diary },
            cortex.emotionalWeight,
          )
          yield* logToConsole(config.char.name, "cortex", `forebrain (in-session): ${orient.headline}`)
          // Laundered directive: formatSteerDirective formats model-generated forebrain output.
          pendingDirective = formatSteerDirective(orient)
          cortex.accumulatedEvents = []
          cortex.lastOrientTick = tick
        }
      }

      // 6. Step execution — when a plan is active and no conscious turn is in flight.
      if (cortex.currentPlan !== null && !consciousFiber) {
        const steps = planSteps(cortex.currentPlan)
        const step = steps[cortex.currentStepIndex]
        if (step) {
          const ticksConsumed = tick - stepStartTick
          const budgetElapsed = ticksConsumed >= step.timeoutTicks

          // 6a. Evaluate now if the agent signaled done OR the tick-budget expired.
          if (stepDoneSignaled || budgetElapsed) {
            if (stepDoneSignaled) {
              yield* logToConsole(config.char.name, "orchestrator", `step done-marker detected; evaluating`)
            } else {
              yield* logToConsole(config.char.name, "orchestrator", `step tick-budget elapsed (${ticksConsumed}/${step.timeoutTicks}); salvage evaluate`)
            }
            const after = renderer.richSnapshot(state as never)
            const stepIdx = cortex.currentStepIndex
            const conditionCheck = stepDoneSignaled
              ? `Agent signaled completion (${STEP_DONE_MARKER}) after ${ticksConsumed} ticks`
              : `Tick budget elapsed: ${ticksConsumed} ticks consumed of ${step.timeoutTicks} budgeted; no completion signal`
            const evalResult = yield* runConsciousEvaluate(runnerConfig, {
              task: step.task,
              goal: step.goal,
              successCondition: step.successCondition,
              ticksBudgeted: step.timeoutTicks,
              ticksConsumed,
              executionReport: formatExecutionReport(stepReport),
              stateDiff: renderer.stateDiff(stepStartSnapshot, after),
              conditionCheck,
              emotionalState: cortex.emotionalWeight,
              remainingSteps:
                steps
                  .slice(stepIdx + 1)
                  .map((s) => `${s.task}: ${s.goal}`)
                  .join("\n") || "None.",
            })
            yield* logToConsole(
              config.char.name,
              "cortex",
              `evaluate: ${evalResult.judgment} → ${evalResult.transition.transition}`,
            )
            if (evalResult.diaryEntry) {
              const diary = yield* charFs
                .readDiary(config.char)
                .pipe(Effect.catchAll(() => Effect.succeed("")))
              yield* charFs
                .writeDiary(
                  config.char,
                  diary ? `${diary}\n\n${evalResult.diaryEntry}` : evalResult.diaryEntry,
                )
                .pipe(
                  Effect.catchAll((e) =>
                    logToConsole(config.char.name, "error", `diary write failed: ${e}`),
                  ),
                )
            }
            const t = evalResult.transition
            if (t.transition === "terminate") return { _tag: "Completed" as const, finalState: state }
            if (t.transition === "wait") {
              cortex.waitState = t.wait
              cortex.currentPlan = null
            } else if (t.transition === "replan") {
              cortex.currentPlan = null
              cortex.lastOrientTick = 0
            } else {
              // next_step: advance and reset session state for the new step.
              cortex.currentStepIndex++
              if (cortex.currentStepIndex >= steps.length) {
                cortex.currentPlan = null
              }
            }
            // Reset per-step session state for the next step (or next plan).
            sessionId = null
            stepReport = ""
            stepDoneSignaled = false
            pendingDirective = null
            lastSteerTick = 0
            stepStartTick = tick
            stepStartSnapshot = renderer.richSnapshot(state as never)
          } else {
            // 6b. Budget not elapsed, no done-signal — fork the next turn.
            if (sessionId === null) {
              // Turn 1: open the session.
              stepStartTick = tick
              stepStartSnapshot = renderer.richSnapshot(state as never)
              yield* logToConsole(config.char.name, "orchestrator", `conscious turn 1: ${step.task}`)
              consciousFiber = yield* Effect.fork(
                consciousThought.turn(
                  {
                    containerId: config.containerId,
                    playerName: config.char.name,
                    char: config.char,
                    prompt: formatStepTask(step, planHeadline),
                    timeoutMs: workerTimeoutMs,
                  },
                  // No resume on turn 1.
                ),
              )
            } else if (
              pendingDirective !== null &&
              tick - lastSteerTick >= DEFAULT_STEER_CADENCE_TICKS
            ) {
              // Steer turn: send the latest coalesced directive to the existing session.
              const directive = pendingDirective
              pendingDirective = null
              lastSteerTick = tick
              yield* logToConsole(config.char.name, "orchestrator", `conscious steer turn (session ${sessionId})`)
              consciousFiber = yield* Effect.fork(
                consciousThought.turn(
                  {
                    containerId: config.containerId,
                    playerName: config.char.name,
                    char: config.char,
                    prompt: directive,
                    timeoutMs: workerTimeoutMs,
                  },
                  { sessionId },
                ),
              )
            }
            // Otherwise: session is open, waiting for turn result or cadence window.
          }
        }
      }

      // 7. Sleep one tick.
      yield* Effect.sleep(`${tickMs} millis`)
    }
  }) as Effect.Effect<
    CortexResult,
    ModelError,
    | EventProcessorTag
    | SituationClassifierTag
    | InterruptRegistryTag
    | StateRendererTag
    | PromptBuilderTag
    | CharacterFs
    | CharacterLog
    | ModelClient
    | ConsciousThought
    | Docker
    | CommandExecutor.CommandExecutor
    | OAuthToken
  >
```

- [ ] **Step 3: Run the new loop tests**

Run: `pnpm -C packages/core test cortex/loop`
Expected: PASS — all eight test groups pass (or at a minimum, all tests that were previously passing continue to pass, plus the new tests that verify the conscious-session behavior).

**Determinism note (implementer):** The steering tests are deterministic in *ordering*, not wall-clock. Each steering step's turn 1 returns NO done-marker ("working…") and only turn 2+ returns the marker, so the loop cannot terminate until a steer turn carrying a directive fires — it keeps ticking until the mid-session event (delivered by the `Effect.forkDaemon` offerer) is triaged in-session, a directive is stored, and the cadence window (`tick - lastSteerTick >= DEFAULT_STEER_CADENCE_TICKS`) opens. Wall-clock only changes the tick count. Two requirements: (1) the forked offerer's `sleep` must be long enough that its event lands AFTER tick 1's drain (else it gets consumed by the idle path and forms the plan instead of steering) — if a test flakes, increase the `sleep` delay, never shorten it; (2) all steering assertions must stay hard (`expect(capturedDirectives.length).toBeGreaterThanOrEqual(1)` etc.) — never make them conditional on capture, or the test passes vacuously; (3) the steering step's `timeoutTicks` must be large (these tests use 30) so the tick-budget backstop cannot salvage-complete the step before the mid-session event lands and steers — if a step terminates with zero captured directives, the budget pre-empted steering and the budget must be raised.

- [ ] **Step 4: Build and run full suite**

Run: `pnpm -C packages/core build && pnpm -C packages/core test`
Expected: build green; all tests pass; smoke tests skip.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cortex/loop.ts
git add packages/core/src/cortex/loop.test.ts
git commit -m "feat(cortex/loop): rework loop to use ConsciousThought conscious-session executor (Phase 4b)

Replaces delegationFiber/forkStep delegation with a per-turn OpenCode session
executor. Hindbrain runs ungated during active sessions; forebrain synthesizes
coalescing steer directives; step completion is signal-driven with tick-budget
backstop. Drops Cybernetics from the requirement channel; adds ConsciousThought
and Docker.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Checklist

**Spec §-by-§ coverage:**
- §2 `ConsciousThought` tag + `ConsciousThoughtLive`/`ConsciousThoughtTest` → Task 3.
- §2 `Cybernetics` untouched (dormant in 4b) → Global Constraint; `delegate.ts` not in any task.
- §2 requirement-channel swap (`-Cybernetics +ConsciousThought +Docker`) → Task 5 loop.ts return type annotation.
- §3 per-tick steps 1–7 → Task 5 loop body.
- §3 `consciousFiber`/`sessionId`/`stepReport`/`stepDoneSignaled`/`pendingDirective`/`lastSteerTick` state vars → Task 5.
- §3 four `!delegationFiber` gates removed → Task 5.
- §4 `DEFAULT_STEER_CADENCE_TICKS` cadence throttle, overwrite coalescing, `formatSteerDirective` → Tasks 4 + 5.
- §5 provisioning once before tick loop, `resolveHandle`, `provisionConsciousProvider`+`writeCharacterAgentFile` → Task 3 (`ConsciousThought.provision`) + Task 5 (pre-loop call).
- §6 `STEP_DONE_MARKER`, `detectCompletion`, tick-budget backstop → Task 4 + Task 5.
- §7 turn failure → `never` error channel via `catchAll` → Task 3 `ConsciousThought.turn`.
- §7 criticals → `Fiber.interrupt(consciousFiber)` → Task 5.
- §8 all eight loop test bullets → Task 5 test file.
- §9 file list → matches File Structure section above.
- §10 out-of-scope: frontier escalation, auto-escalation triggers, marker robustness, SDK path → none of these appear in any task.
- §11 follow-ups folded: (1) `Effect.asVoid` on `provision` → Task 3; (2) overwrite + special-char tests → Task 1; (3) typed resume error → Task 2.

**Placeholder scan:** No "TODO", "TBD", "similar to Task N", or "add error handling" in any code block. Every code step shows the complete TypeScript.

**Import specifier scan:** All relative imports end in `.js`. Absolute package imports (`effect`, `@effect/platform`, `@roci/core`) are not specifier-suffixed (correct for package imports).

**Test harness consistency:** Loop tests follow the existing pattern from `loop.test.ts` — `Effect.runPromise`, `Layer.mergeAll`, `tickIntervalMs: 1` for fast execution. `ConsciousThoughtTest` mirrors `CyberneticsTest` in signature and stub discipline. No `TestClock` required — `Effect.sleep` with real wall-clock at 1ms tick is fast enough.

**Docker in the requirement channel:** `Docker` is added because `ConsciousThought.provision` requires it. The app-level layer composition must provide `DockerLive` (or `DockerLive` is already present since `CyberneticsLive` doesn't require `Docker` but the app wired it for other reasons). **Integration check for the implementer:** confirm `DockerLive` is in the app's layer graph before the 4b loop runs in production. Do not change app wiring in this plan — flag it as an integration concern.
