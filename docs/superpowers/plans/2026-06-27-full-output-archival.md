# Full Prompt+Response Archival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `events.jsonl` the complete, untruncated archive of every model/agent exchange — full prompt+response pairs for all four cortex tiers and the body — while the console stays readable.

**Architecture:** `events.jsonl` always stores full content; `renderEvent` is the only place that truncates (console readability). A new `debug`-level `exchange` event kind carries structured prompt/response; it's emitted from the single `callTier` chokepoint (covers all four cortex tiers) and from the body run path. Two pre-store truncations (forebrain 2000-char, stderr 500-char) are removed.

**Tech Stack:** TypeScript, Effect (Context/Layer services), vitest.

## Global Constraints

- All edits target the worktree checkout: `/Users/vcarl/workspace/roci/.claude/worktrees/better-logging/`. Verify every path is under it.
- Branch: `full-output-logging` (already checked out).
- Test runner: vitest. Single file: `pnpm exec vitest run <path>`; one case: `-t "<name>"`. `pnpm install --frozen-lockfile` first if `node_modules` is absent.
- Typecheck a package: `pnpm -C packages/core typecheck`. The pre-commit hook runs a full `nx` build — let it pass.
- Style in `packages/core` / `packages/domain-*`: 2-space indent, no semicolons, `.js` import specifiers.
- **Invariant (the whole point):** content stored in a `UnifiedEvent` is NEVER truncated. Only `renderEvent` truncates, for console display. `events.jsonl` is never filtered and never shortened.
- Log levels: `debug|info|warn|error`, `debug < info < warn < error`. `exchange` events are `debug`.
- Known pre-existing skipped tests: 4 live-infra smoke tests skip. Expect 0 failures otherwise.
- Commit messages: conventional-commit prefix, ending with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**Modified:**
- `packages/core/src/logging/events.ts` — add the `exchange` kind to `UnifiedEvent`.
- `packages/core/src/logging/levels.ts` — `classifyLevel`: `exchange → debug`.
- `packages/core/src/logging/console-renderer.ts` — compact `exchange` render case; `CONSOLE_LINE_LIMIT` long-line truncation for `system`/`text`/`error`.
- `packages/core/src/logging/log-writer.ts` — `logExchange` helper.
- `packages/core/src/cortex/tiers.ts` — `callTier` gains `step`, emits `exchange`; remove `RAW_FOREBRAIN_LOG_LIMIT` (log full output); runner signatures gain `CharacterLog`.
- `packages/core/src/cortex/tiers.test.ts` — provide a log layer to runner tests that now require `CharacterLog`; add exchange + full-raw tests.
- `packages/core/src/core/limbic/hypothalamus/transport.ts` — remove stderr `slice(0,500)`.
- `packages/core/src/core/limbic/hypothalamus/process-runner.ts` — emit body `exchange` (prompt + accumulated output).

**Test files touched:** `levels.test.ts`, `log-writer.test.ts`, `events.test.ts` (or a renderer test), `tiers.test.ts`, `transport.test.ts`, `process-runner.test.ts`.

---

## Task 1: Introduce the `exchange` event kind

**Files:**
- Modify: `packages/core/src/logging/events.ts`, `packages/core/src/logging/levels.ts`, `packages/core/src/logging/console-renderer.ts`, `packages/core/src/logging/log-writer.ts`
- Test: `packages/core/src/logging/levels.test.ts`, `packages/core/src/logging/log-writer.test.ts`, `packages/core/src/logging/events.test.ts`

**Interfaces:**
- Produces: `UnifiedEvent` gains `{ kind: "exchange"; channel: string; step: string; prompt: string; response: string; meta?: Record<string, unknown> }`. `classifyLevel(exchange) → "debug"`. `renderEvent` renders it as a compact one-liner. `logExchange(character, channel, step, prompt, response, meta?): Effect<void, LogWriterError, CharacterLog>`.

> Adding a union member forces the exhaustive switches in `classifyLevel` and `renderEvent` to handle it or typecheck fails — so this whole task is the minimal compilable unit.

- [ ] **Step 1: Write failing tests**

Add to `packages/core/src/logging/levels.test.ts` (inside the existing `describe("classifyLevel", ...)`):

```typescript
  it("maps exchange to debug", () => {
    expect(classifyLevel({ ...base, kind: "exchange", channel: "cortex", step: "orient", prompt: "p", response: "r" })).toBe("debug")
  })
```

Add to `packages/core/src/logging/events.test.ts` a renderer test:

```typescript
  it("renders an exchange as a compact one-liner (sizes, not full content)", () => {
    const out = renderEvent({
      timestamp: "t", character: "c", system: "cortex", subsystem: "orient",
      kind: "exchange", channel: "cortex", step: "orient",
      prompt: "x".repeat(1200), response: "y".repeat(9000),
    }).join("\n")
    expect(out).toContain("orient")
    expect(out).toContain("prompt=1200c")
    expect(out).toContain("resp=9000c")
    expect(out).not.toContain("yyyy") // full response must NOT appear on console
  })
```

Add to `packages/core/src/logging/log-writer.test.ts` (reuse the existing `readJsonl` helper and layer setup):

```typescript
  it("logExchange writes the full prompt and response to jsonl at debug", async () => {
    process.env.LOG_LEVEL = "info"
    const contents = await readJsonl(
      logExchange("c", "cortex", "orient", "P".repeat(50), "R".repeat(5000), { tier: "forebrain" }),
    )
    const line = JSON.parse(contents.trim().split("\n").pop() as string)
    expect(line.kind).toBe("exchange")
    expect(line.level).toBe("debug")
    expect(line.prompt.length).toBe(50)
    expect(line.response.length).toBe(5000) // full, untruncated
    expect(line.meta).toEqual({ tier: "forebrain" })
  })
```

Add `logExchange` to the import in `log-writer.test.ts`:
```typescript
import { CharacterLog, CharacterLogLive, logToConsole, logExchange } from "./log-writer.js"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/core/src/logging/levels.test.ts packages/core/src/logging/events.test.ts packages/core/src/logging/log-writer.test.ts`
Expected: FAIL — `exchange` not assignable to `UnifiedEvent` / `logExchange` not exported.

- [ ] **Step 3: Add the kind to `events.ts`**

In `packages/core/src/logging/events.ts`, add to the `UnifiedEvent` union (after the `error` member):

```typescript
  | { kind: "exchange"; channel: string; step: string; prompt: string; response: string; meta?: Record<string, unknown> }
```

- [ ] **Step 4: Add the `classifyLevel` case**

In `packages/core/src/logging/levels.ts`, add a case to the `classifyLevel` switch (before the `info` group or alongside `thinking`):

```typescript
    case "exchange":
      return "debug"
```

- [ ] **Step 5: Add the `renderEvent` case**

In `packages/core/src/logging/console-renderer.ts`, add a case to the `renderEvent` switch:

```typescript
    case "exchange":
      return [`${t} ${levelMarker(event)}⟳ ${event.step} prompt=${event.prompt.length}c resp=${event.response.length}c`]
```

- [ ] **Step 6: Add the `logExchange` helper**

In `packages/core/src/logging/log-writer.ts`, after `logToConsole`, add:

```typescript
/**
 * Emit a structured prompt+response exchange. Full content is stored in
 * events.jsonl; classifyLevel ranks it `debug`, so it stays out of the default
 * console view. Tag is [character:step].
 */
export const logExchange = (
  character: string,
  channel: string,
  step: string,
  prompt: string,
  response: string,
  meta?: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const log = yield* CharacterLog
    yield* log.emit(
      { name: character, dir: "" } as CharacterConfig,
      {
        ...eventBase(character, channel, step),
        kind: "exchange",
        channel,
        step,
        prompt,
        response,
        ...(meta ? { meta } : {}),
      },
    )
  })
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/core/src/logging/levels.test.ts packages/core/src/logging/events.test.ts packages/core/src/logging/log-writer.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm -C packages/core typecheck`
Expected: exit 0 (both exhaustive switches now handle `exchange`).

```bash
git add packages/core/src/logging/events.ts packages/core/src/logging/levels.ts packages/core/src/logging/console-renderer.ts packages/core/src/logging/log-writer.ts packages/core/src/logging/levels.test.ts packages/core/src/logging/events.test.ts packages/core/src/logging/log-writer.test.ts
git commit -m "feat(logging): add structured exchange event kind (debug-level)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Render-time long-line truncation (console only)

**Files:**
- Modify: `packages/core/src/logging/console-renderer.ts`
- Test: `packages/core/src/logging/events.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: long `system`/`text`/`error` message lines are truncated **for console only** with a ` … (N more chars — full in events.jsonl)` marker; the stored event is never mutated.

> Needed because Task 3 makes the forebrain parse-failure (a `warn`, console-visible event) store the *full* raw output — without this it would flood the console.

- [ ] **Step 1: Write failing tests**

Add to `packages/core/src/logging/events.test.ts`:

```typescript
  it("truncates a long system line for console but leaves the stored event full", () => {
    const long = "Z".repeat(2000)
    const event = { timestamp: "t", character: "c", system: "cortex", subsystem: "cortex", kind: "system" as const, message: `raw output: ${long}` }
    const out = renderEvent(event).join("\n")
    expect(out).toContain("… (") // truncation marker present
    expect(out).toContain("full in events.jsonl")
    expect(out.length).toBeLessThan(1200) // console line is shortened
    expect(event.message).toBe(`raw output: ${long}`) // stored event UNCHANGED
  })

  it("does not truncate a short system line", () => {
    const event = { timestamp: "t", character: "c", system: "s", subsystem: "s", kind: "system" as const, message: "short message" }
    expect(renderEvent(event).join("\n")).toContain("short message")
    expect(renderEvent(event).join("\n")).not.toContain("…")
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/core/src/logging/events.test.ts -t "truncates a long system line"`
Expected: FAIL — the full 2000-char line is currently rendered.

- [ ] **Step 3: Implement the truncation helper and apply it**

In `packages/core/src/logging/console-renderer.ts`, add near the top (after the existing `MAX_HEAD`/`MAX_TAIL` consts):

```typescript
const CONSOLE_LINE_LIMIT = 800

/** Shorten one line for console display only; full text remains in events.jsonl. */
function truncateLine(line: string): string {
  if (line.length <= CONSOLE_LINE_LIMIT) return line
  return `${line.slice(0, CONSOLE_LINE_LIMIT)} … (${line.length - CONSOLE_LINE_LIMIT} more chars — full in events.jsonl)`
}
```

Apply it in the `system`, `text`, and `error` cases. Replace the `system` case:

```typescript
    case "system":
      return event.message.split("\n").map(line => `${t} ${levelMarker(event)}${truncateLine(line)}`)
```

Replace the `text` case's return mapping so each emitted line is truncated:

```typescript
    case "text": {
      const lines = event.text.split("\n").filter(l => l.trim().length > 0)
      const prefix = `${charName(event.character)}:`
      return lines.map(line => `${prefix} ${truncateLine(line.trim())}`)
    }
```

Replace the `error` case:

```typescript
    case "error":
      return [`${t} ${levelMarker(event)}${truncateLine(`error: ${event.message}`)}`]
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run packages/core/src/logging/events.test.ts`
Expected: PASS (new + existing renderer tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm -C packages/core typecheck`
Expected: exit 0.

```bash
git add packages/core/src/logging/console-renderer.ts packages/core/src/logging/events.test.ts
git commit -m "feat(logging): truncate long lines for console only, keep jsonl full

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Cortex tiers — full output + prompt/response exchange

**Files:**
- Modify: `packages/core/src/cortex/tiers.ts`
- Test: `packages/core/src/cortex/tiers.test.ts`

**Interfaces:**
- Consumes: `logExchange` from `../logging/log-writer.js`.
- Produces: `callTier(config, tier, step, prompt)` (new 3rd arg `step: "observe"|"orient"|"decide"|"evaluate"`) emits a `cortex` exchange per call. `runHindbrain` / `runConsciousDecide` / `runConsciousEvaluate` signatures gain `CharacterLog` in their `R` (requirements). The forebrain parse-failure logs the **full** raw output (no truncation).

- [ ] **Step 1: Write failing tests**

Add two tests to `packages/core/src/cortex/tiers.test.ts`. No new imports are needed — they reuse the existing `recordingLog`, `recordingService`, `fixedClient`, `config`, and the `UnifiedEvent` type already imported in the file:

```typescript
describe("callTier emits a full prompt+response exchange", () => {
  it("emits a cortex exchange with the full response on the hindbrain success path", async () => {
    const logs: UnifiedEvent[] = []
    const body = '{"disposition":"discard","emotionalWeight":"😐","reason":"noise"}'
    await Effect.runPromise(
      Effect.provide(
        runHindbrain(config, ["type: tick\n{}"], null),
        Layer.mergeAll(fixedClient(body), recordingService([]), recordingLog(logs)),
      ),
    )
    const ex = logs.find((e) => e.kind === "exchange") as Extract<UnifiedEvent, { kind: "exchange" }> | undefined
    expect(ex).toBeDefined()
    expect(ex!.channel).toBe("cortex")
    expect(ex!.step).toBe("observe")
    expect(ex!.prompt.length).toBeGreaterThan(0)
    expect(ex!.response).toBe(body) // full model output, verbatim
  })
})

describe("runForebrain — full (untruncated) raw output on parse failure", () => {
  it("logs the entire raw output, with no [truncated] marker, when it exceeds the old 2000-char cap", async () => {
    const logs: UnifiedEvent[] = []
    const raw = "NO-JSON " + "Q".repeat(3000) // > old RAW_FOREBRAIN_LOG_LIMIT
    await Effect.runPromise(
      Effect.provide(
        runForebrain(config, ["e1"], "{}", { background: "", values: "", diary: "" }, "😐"),
        Layer.mergeAll(fixedClient(raw), recordingService([]), recordingLog(logs)),
      ),
    )
    const msg = logs
      .filter((e) => e.kind === "system")
      .map((e) => (e as { message?: string }).message ?? "")
      .find((m) => /parse failure/i.test(m))
    expect(msg).toBeDefined()
    expect(msg!).toContain(raw) // FULL raw present
    expect(msg!).not.toMatch(/truncated/i)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/core/src/cortex/tiers.test.ts -t "exchange"`
Expected: FAIL — no exchange event emitted (and the forebrain test fails on `[truncated]`/missing tail once it runs).

- [ ] **Step 3: Update `callTier` (add `step`, emit exchange) and the forebrain parse-failure**

In `packages/core/src/cortex/tiers.ts`:

First extend the import on line 21:
```typescript
import { CharacterLog, logToConsole, logExchange } from "../logging/log-writer.js"
```

Replace `callTier` (lines 54-64) with:

```typescript
/** Run one prompt against the model backing `tier`, log the full exchange, return the raw text. */
const callTier = (
  config: CortexRunnerConfig,
  tier: "hindbrain" | "forebrain" | "conscious",
  step: "observe" | "orient" | "decide" | "evaluate",
  prompt: string,
) =>
  Effect.gen(function* () {
    const svc = yield* ModelService
    const client = yield* ModelClient
    const handle = resolveHandle(config.models, tier)
    const res = yield* svc.withTier(tier)(
      client.complete(handle, [{ role: "user", content: prompt }]),
    )
    // Full prompt+response archive (debug level; jsonl-complete). Never crash the loop.
    yield* logExchange(config.char.name, "cortex", step, prompt, res.text, {
      tier,
      model: handle.model,
      usage: res.usage,
    }).pipe(Effect.catchAll(() => Effect.void))
    return res.text
  })
```

Update each runner's `callTier` call:
- `runHindbrain` (line 81): `callTier(config, "hindbrain", "observe", prompt)`
- `runForebrain` (line 128): `callTier(config, "forebrain", "orient", prompt)`
- `runConsciousDecide` (line 190): `callTier(config, "conscious", "decide", prompt)`
- `runConsciousEvaluate` (line 252): `callTier(config, "conscious", "evaluate", prompt)`

Remove the `RAW_FOREBRAIN_LOG_LIMIT` constant (line 92-93) and replace the forebrain parse-failure block (lines 146-162) with the full-output version:

```typescript
      // Parse miss: log the FULL raw forebrain output so the failure is fully
      // diagnosable. The console truncates long lines for display; events.jsonl
      // keeps the complete text. Only fires on failure — the success path never logs here.
      return logToConsole(
        config.char.name,
        "cortex",
        `tier=forebrain step=orient parse failure; raw output: ${text}`,
        "warn",
      ).pipe(
        // A log-write failure must never crash the loop — swallow it.
        Effect.catchAll(() => Effect.void),
        Effect.as<OrientResult>(fallback),
      )
```

- [ ] **Step 4: Add `CharacterLog` to the three runner signatures**

`callTier` now requires `CharacterLog`. Update the `R` (third type param) of the runner return types in `tiers.ts`:
- `runHindbrain` (line 71): change `ModelClient | ModelService` → `ModelClient | ModelService | CharacterLog`
- `runConsciousDecide` (line 173): change `ModelClient | ModelService` → `ModelClient | ModelService | CharacterLog`
- `runConsciousEvaluate` (line 228): change `ModelClient | ModelService` → `ModelClient | ModelService | CharacterLog`

(`runForebrain` already lists `CharacterLog`. `loop.ts` already provides `CharacterLog` to these calls — no change needed there. Confirm via typecheck in Step 6.)

- [ ] **Step 5: Provide a log layer to existing tier tests that now require it**

The runner tests that call `runHindbrain` / `runConsciousDecide` / `runConsciousEvaluate` with only `fixedClient` + `recordingService` now need a `CharacterLog` layer. In `packages/core/src/cortex/tiers.test.ts`, add `silentLog` to every such `Layer.mergeAll(...)` that lacks a log layer:
- `runHindbrain` tests (the two in `describe("runHindbrain", ...)`, and the reasoning-only test)
- `runConsciousDecide` `decideWith`
- `runConsciousEvaluate` `evalWith`
- the `callTier routes through ModelService.withTier` test

Example — change:
```typescript
        Layer.mergeAll(fixedClient("the model rambled"), recordingService([])),
```
to:
```typescript
        Layer.mergeAll(fixedClient("the model rambled"), recordingService([]), silentLog),
```
Apply the same `, silentLog` addition to each runner-test `Layer.mergeAll` that doesn't already include a log layer. (The `runForebrain` tests already provide one.)

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm exec vitest run packages/core/src/cortex/tiers.test.ts`
Expected: PASS (new exchange + full-raw tests green; all existing tier tests still green with the log layer added).

Run: `pnpm -C packages/core typecheck`
Expected: exit 0 (loop.ts provides CharacterLog to the runners; no loop.ts edit needed). If typecheck reports `loop.ts` missing `CharacterLog` for a runner call, that means the loop's effect lacked it — add a `CharacterLog` provision there; but it already uses `logToConsole`, so this should not occur.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/cortex/tiers.ts packages/core/src/cortex/tiers.test.ts
git commit -m "feat(cortex): archive full prompt+response per tier; stop truncating forebrain output

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Body — full stderr + task-prompt exchange

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/transport.ts`, `packages/core/src/core/limbic/hypothalamus/process-runner.ts`
- Test: `packages/core/src/core/limbic/hypothalamus/transport.test.ts`, `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`

**Interfaces:**
- Consumes: `logExchange` from `../../../logging/log-writer.js`.
- Produces: process `stderr` is logged in full (no 500-char slice). Each body run (`runTurn`, `runSdkWithStdin`, `runOpenCodeSessionTurn`) emits a `body` exchange with `prompt = config.prompt` and `response = result.output`.

- [ ] **Step 1: Write failing test — full stderr**

In `packages/core/src/core/limbic/hypothalamus/transport.test.ts`, find the existing stderr-handling test (a successful-exit case that logs `stderr: …`). If one exists, extend it; otherwise add a focused test using the file's existing capturing-`emit` + stub-executor harness, asserting a >500-char stderr is logged in full:

```typescript
  it("logs stderr in full (no 500-char truncation)", async () => {
    const big = "E".repeat(1500)
    // ...drive runTransport with the harness's stub executor producing `big` on stderr,
    // a successful (code 0) exit, and empty stdout...
    const stderrEvents = emitted.filter((e) => e.kind === "system" && /^stderr:/.test((e as { message?: string }).message ?? ""))
    expect(stderrEvents.length).toBe(1)
    expect((stderrEvents[0] as { message: string }).message).toContain(big) // full, untruncated
  })
```
(Use the same stub-executor construction the other `transport.test.ts` cases use — match the existing harness; do not invent a new one.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/transport.test.ts -t "stderr in full"`
Expected: FAIL — current code slices stderr to 500 chars.

- [ ] **Step 3: Remove the stderr slice**

In `packages/core/src/core/limbic/hypothalamus/transport.ts` line 190, change:
```typescript
        yield* logToConsole(input.char.name, input.role, `stderr: ${stderr.trim().slice(0, 500)}`)
```
to:
```typescript
        yield* logToConsole(input.char.name, input.role, `stderr: ${stderr.trim()}`)
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing test — body exchange**

In `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`, using the file's existing executor-stub + capturing-`CharacterLog` harness, add a test that runs `runTurn` (or whichever run function the harness already exercises) with a known `config.prompt` and asserts a body exchange was emitted:

```typescript
  it("emits a body exchange carrying the full task prompt", async () => {
    // ...run runTurn with config.prompt = "# Task: do the thing" through the harness...
    const ex = emitted.find((e) => e.kind === "exchange") as Extract<UnifiedEvent, { kind: "exchange" }> | undefined
    expect(ex).toBeDefined()
    expect(ex!.channel).toBe("body")
    expect(ex!.prompt).toContain("# Task: do the thing")
  })
```
(Wire it into the existing harness's capturing log + stub executor; match how the file already constructs `TurnConfig` and the executor.)

- [ ] **Step 6: Run to verify failure**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/process-runner.test.ts -t "body exchange"`
Expected: FAIL — no exchange emitted yet.

- [ ] **Step 7: Emit the body exchange**

In `packages/core/src/core/limbic/hypothalamus/process-runner.ts`, extend the import on line 19:
```typescript
import { CharacterLog, logToConsole, logExchange } from "../../../logging/log-writer.js"
```

Add a helper after `buildExecArgs`:
```typescript
/** Archive the body turn's prompt+output (debug level; jsonl-complete). Never crashes the turn. */
const emitBodyExchange = (config: TurnConfig, output: string) =>
  logExchange(config.char.name, "body", "act", config.prompt, output).pipe(Effect.catchAll(() => Effect.void))
```

Then in each of the three run functions, capture the transport result, emit, and return it:

- `runTurn` (lines 75-82): replace `return yield* runTransport({...})` with:
```typescript
    const result = yield* runTransport({
      command,
      normalize: normalizerFor(runtime),
      runtimeTag: "claude",
      char: config.char,
      role: config.role,
      timeoutMs: config.timeoutMs,
    })
    yield* emitBodyExchange(config, result.output)
    return result
```

- `runSdkWithStdin` (lines 108-115): replace `return yield* runTransport({...})` with the same pattern (capture `result`, `yield* emitBodyExchange(config, result.output)`, `return result`).

- `runOpenCodeSessionTurn` (lines 193-207): after `const result = yield* runTransport({...})` and before the `const sessionId = ...` line, add:
```typescript
    yield* emitBodyExchange(config, result.output)
```

- [ ] **Step 8: Run tests + typecheck**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/process-runner.test.ts packages/core/src/core/limbic/hypothalamus/transport.test.ts`
Expected: PASS.

Run: `pnpm -C packages/core typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/transport.ts packages/core/src/core/limbic/hypothalamus/process-runner.ts packages/core/src/core/limbic/hypothalamus/transport.test.ts packages/core/src/core/limbic/hypothalamus/process-runner.test.ts
git commit -m "feat(body): archive full stderr and task-prompt+output exchange

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole suite**

Run: `pnpm exec vitest run`
Expected: 0 failures (4 live-infra smoke tests skip). Confirm no regressions in cortex/logging/transport. If any logging/cortex test fails, fix before proceeding.

- [ ] **Step 2: Manual sanity (optional, if a live run is convenient)**

With a live run: at default `LOG_LEVEL` (info) the console shows the readable headlines and NOT the exchange dumps; `events.jsonl` contains `kind:"exchange"` records for `cortex` (observe/orient/decide/evaluate) and `body`, each with full untruncated `prompt`/`response`. A forebrain parse failure stores the complete raw output (no `[truncated]`). `LOG_LEVEL=debug` surfaces the compact `⟳ <step> prompt=Nc resp=Nc` lines on the console.

- [ ] **Step 3: Final commit (only if verification fixups were made)**

```bash
git add -A
git commit -m "test(logging): verify full-output archival suite

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
