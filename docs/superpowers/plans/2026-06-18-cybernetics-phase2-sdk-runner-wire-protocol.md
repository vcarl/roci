# Cybernetics Phase 2 — SDK-Runner Payload + NDJSON Wire Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third payload — an in-container Node host (`sdk-runner.mjs`) that drives the Anthropic Agent SDK's streaming-input `query()` — and a minimal NDJSON wire protocol over `docker exec -i`, so the frontier worker can run a task **run-to-completion** via the SDK (steering and cortex wiring come in Phases 3–4).

**Architecture:** Builds on the Phase 1 transport/payload split. The Phase 1 transport (`runTransport`) is reused unchanged: it runs a prebuilt `Command`, streams/normalizes stdout, and races exit-vs-timeout. This phase adds (a) `sdk-runner.mjs` — reads NDJSON `task`/`steer`/`end` on stdin, drives `query({ prompt: asyncGenerator })`, writes NDJSON `event`/`result` on stdout; (b) `normalizeSdk` — turns the runner's `event` lines into the existing `InternalEvent` shape so the transport's text accumulation works; (c) a host-side SDK payload (`runSdkTurn`) that builds the NDJSON stdin + the `docker exec … node sdk-runner.mjs` command and calls `runTransport` with `normalizeSdk`; (d) baking the runner + the SDK package into the Docker images.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (ESM, Node ≥18, bundles its own `claude` binary), Node ESM (`.mjs`) for the in-container runner, TypeScript + Effect-TS + `@effect/platform` for the host side, Vitest, Docker.

## Global Constraints

- **Wire protocol is versioned NDJSON, `"v":1`.** One JSON object per line. Host→runner: `{"v":1,"type":"task","text":…}`, `{"v":1,"type":"steer","text":…}`, `{"v":1,"type":"end"}`. Runner→host: `{"v":1,"type":"event","event":<SDKMessage>}`, `{"v":1,"type":"result","status":"completed"|"failed"|"timed_out","output":<string>}`. `task`/`steer` are structurally identical (each becomes one user turn).
- **Phase 2 is run-to-completion only.** The host sends exactly `task` then `end`; it never sends `steer` in this phase. The runner MUST still parse `steer` correctly (forward-compatible for Phase 3), but no host code emits it yet. Do not build the coalescing queue / cadence (those are Phase 3).
- **Reuse the Phase 1 transport unchanged.** `runTransport` (in `transport.ts`) is not modified. The SDK payload supplies a `Command` (NDJSON stdin attached) + `normalizeSdk` + `runtimeTag: "sdk"`.
- **Existing payloads unchanged.** `runTurn`, `payload.ts`'s claude/opencode builders, and all current callers keep working; the full existing suite stays green.
- **The in-container runner is ESM `.mjs`** and imports the SDK via a local `node_modules` installed at image-build time. The pure protocol logic is a separate `.mjs` with **no SDK import**, so it is unit-testable on the host.
- **SDK options for the headless worker:** `permissionMode: "bypassPermissions"`, `cwd: process.cwd()`, plus `model`, `systemPrompt`, `maxTurns` sourced from env vars the host sets on the `docker exec`. The runner takes **no CLI flags**.
- **Never use `--bare` with `claude -p`** (unchanged constraint; the SDK path doesn't use `claude -p`).
- **ESM `.js` import specifiers** in TS source; Effect named imports.
- **Auth — RESOLVED by the Task 1 spike (2026-06-18).** The SDK's bundled binary **honors `CLAUDE_CODE_OAUTH_TOKEN`** (the `system/init` message reports `apiKeySource:"none"`, confirming the OAuth path); `ANTHROPIC_API_KEY` is not needed. The `"sonnet"` alias is accepted (resolves to `claude-sonnet-4-6`), so `sdkEnv` passes `config.model` verbatim — no alias mapping. Pinned SDK version: **`0.3.183`** (bundles claude-code 2.1.183). The design holds as written; inject `CLAUDE_CODE_OAUTH_TOKEN`, pass the model alias via env.
- **Runner must tolerate non-content message types.** The spike observed the stream order `system/init` → `rate_limit_event` → `assistant` → `result` (zero stderr). The runner forwards every SDK message verbatim; `normalizeSdk` maps `rate_limit_event` to a `rate_limit` event (like `normalizeClaude`) and unknown types to `passthrough` — never an error.
- Commit messages: imperative, conventional-commit prefix; end with a blank line then exactly:

  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

## Phase 2 File Structure

**New files (canonical sources in core):**
- `packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner-protocol.mjs` — pure JS ESM, no SDK import: `parseCommand`, `toSdkUserMessage`, `formatEventLine`, `formatResultLine`, `statusFromResult`.
- `packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner-protocol.test.ts` — unit tests for the protocol module.
- `packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner.mjs` — the entry: wires stdin/stdout to `query()` using the protocol module + the SDK.
- `packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner-package.json` — declares `@anthropic-ai/claude-agent-sdk` for the in-image `npm install`.
- `packages/core/src/core/limbic/hypothalamus/sdk-payload.ts` — host-side SDK payload helpers: `SDK_RUNNER_PATH`, `buildSdkInnerCommand`, `buildSdkStdin`, `sdkEnv`.
- `packages/core/src/core/limbic/hypothalamus/sdk-payload.test.ts` — unit tests for the above.

**Modified files:**
- `packages/core/src/logging/stream-normalizer.ts` — add `normalizeSdk`.
- `packages/core/src/logging/stream-normalizer.test.ts` — add `normalizeSdk` tests (create if absent).
- `packages/core/src/core/limbic/hypothalamus/process-runner.ts` — add `runSdkTurn`.
- `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts` — add `runSdkTurn` host-side test (fake echo runner emitting SDK NDJSON).
- `packages/domain-spacemolt/src/docker/Dockerfile` and `packages/domain-github/src/docker/Dockerfile` — install the SDK runner.
- `packages/domain-spacemolt/src/docker/` and `packages/domain-github/src/docker/` — receive copies of the three runner files (precedent: `roci-channel.ts` is already duplicated per domain context).
- `docs/cortex-smoke.md` — add the run-to-completion SDK smoke checklist + record the Task 1 auth finding.

**Known debt (note, don't fix here):** the three runner files are duplicated from `core` into each domain docker context, matching the existing `roci-channel.ts` pattern. A future build-time copy step should make `core` the single source; out of scope for Phase 2.

---

## Phase 1 recap (already merged on this branch)

`payload.ts` exports `selectRuntime`, `buildInnerArgs`, `buildInnerCommand`, `normalizerFor`, `shellEscape`. `transport.ts` exports `runTransport(input: TransportInput)` where `TransportInput = { command: Command.Command; normalize: (raw) => InternalEvent[]; runtimeTag: string; char: CharacterConfig; role: "brain"|"body"; timeoutMs: number }`, requiring `CommandExecutor.CommandExecutor | CharacterLog`. `process-runner.ts` exports `buildExecArgs(config, innerCmd, token)` and `runTurn(config)`. `normalizeClaude`/`normalizeOpenCode` live in `stream-normalizer.ts` and return `InternalEvent[]`.

---

## Task 1: De-risking spike — validate SDK auth + model alias in a real container

**No commit.** This is an exploratory gate. It produces findings recorded in `docs/cortex-smoke.md` (committed in Task 8) that later tasks depend on. It needs Docker + a valid OAuth token + network egress to the Anthropic API. If you cannot run Docker or have no valid token in this environment, report **BLOCKED** with that fact — the controller will run the spike or supply findings.

**Files:** none (throwaway container).

> **✅ COMPLETED 2026-06-18 — findings already folded into Global Constraints. Do NOT re-run.** Results: SDK `0.3.183`; `CLAUDE_CODE_OAUTH_TOKEN` authenticates (`apiKeySource:"none"`); `"sonnet"` alias accepted → `claude-sonnet-4-6`; terminal `result` is `subtype:"success", is_error:false, result:"<text>"`; stream order `system/init → rate_limit_event → assistant → result`, zero stderr. The steps below are retained as the reproduction record.

- [ ] **Step 1: Build a throwaway image with the SDK installed**

Create a temp dir and Dockerfile:

```bash
mkdir -p /tmp/sdk-spike && cd /tmp/sdk-spike
cat > Dockerfile <<'EOF'
FROM node:20
USER node
WORKDIR /home/node/sdk-runner
RUN npm init -y && npm install @anthropic-ai/claude-agent-sdk
EOF
docker build -t sdk-spike .
```
Expected: build succeeds; the SDK and its bundled binary install.

- [ ] **Step 2: Probe which credential the SDK honors**

Use the same OAuth token the orchestrator uses (read it from the project's `.oauth-token`; do NOT print it). Run a tiny one-shot via streaming input:

```bash
TOKEN="$(cat /Users/vcarl/workspace/roci/.claude/worktrees/agent-sdk/.oauth-token 2>/dev/null || echo MISSING)"
docker run --rm -i -e CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" sdk-spike node --input-type=module -e '
import { query } from "@anthropic-ai/claude-agent-sdk";
async function* g(){ yield { type:"user", message:{ role:"user", content:"Reply with exactly: OK" }, parent_tool_use_id:null }; }
for await (const m of query({ prompt: g(), options: { model:"sonnet", permissionMode:"bypassPermissions", maxTurns:1 } })) {
  console.log(JSON.stringify({ t:m.type, sub:m.subtype, isErr:m.is_error, result:m.result }));
  if (m.type==="result") process.exit(m.is_error?1:0);
}
'
```
Expected (success case): lines including a final `{"t":"result","sub":"success","isErr":false,"result":"OK"}`. **Record:** whether `CLAUDE_CODE_OAUTH_TOKEN` alone authenticated.

- [ ] **Step 3: If OAuth token did NOT authenticate, probe `ANTHROPIC_API_KEY`**

Re-run Step 2 substituting `-e ANTHROPIC_API_KEY="$TOKEN"` (and/or both). Record which env var the SDK actually honors. If neither works with the OAuth token, record the exact error and STOP — report findings to the controller (the credential model may need an API key, which changes the per-exec env injection design).

- [ ] **Step 4: Confirm model alias + result shape**

From the Step 2 output, confirm: (a) the `"sonnet"` alias was accepted (no "unknown model" error); (b) the terminal message is `type:"result"` with `subtype:"success"`, `is_error:false`, and a `result` string field. If aliases are rejected, record the required full model id format (e.g. `claude-sonnet-4-…`) — Task 6's `sdkEnv` model mapping consumes this.

- [ ] **Step 5: Record findings (for Task 8 to commit)**

Write the four findings to a scratch note (`/tmp/sdk-spike/findings.md`): (1) auth env var that works, (2) whether model aliases work or the required id format, (3) confirmed result-message shape, (4) any surprises (e.g. extra `system`/`init` messages, partial messages). Report DONE with the findings inline. **These findings are authoritative for Tasks 6–8 — flag any later task whose code contradicts them.**

---

## Task 2: Wire-protocol logic module (`sdk-runner-protocol.mjs`)

Pure JS ESM, no SDK import — so it is unit-testable on the host. This is the brain of the runner; the entry (Task 6) is thin glue.

**Files:**
- Create: `packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner-protocol.mjs`
- Test: `packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner-protocol.test.ts`

**Interfaces:**
- Produces:
  - `parseCommand(line: string): { type: "task"|"steer"|"end", text?: string } | null` — parse one host→runner NDJSON line; `null` for blank/invalid/unknown-type lines.
  - `toSdkUserMessage(text: string): object` — `{ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }`.
  - `statusFromResult(sdkResult: object): "completed" | "failed"` — `"completed"` iff `subtype === "success" && !is_error`, else `"failed"`.
  - `formatEventLine(sdkMessage: object): string` — `JSON.stringify({ v: 1, type: "event", event: sdkMessage })`.
  - `formatResultLine(sdkResult: object): string` — `JSON.stringify({ v: 1, type: "result", status: statusFromResult(sdkResult), output: sdkResult.result ?? "" })`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner-protocol.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import {
  parseCommand,
  toSdkUserMessage,
  statusFromResult,
  formatEventLine,
  formatResultLine,
} from "./sdk-runner-protocol.mjs"

describe("parseCommand", () => {
  it("parses task/steer/end", () => {
    expect(parseCommand('{"v":1,"type":"task","text":"do it"}')).toEqual({ type: "task", text: "do it" })
    expect(parseCommand('{"v":1,"type":"steer","text":"now this"}')).toEqual({ type: "steer", text: "now this" })
    expect(parseCommand('{"v":1,"type":"end"}')).toEqual({ type: "end" })
  })
  it("returns null for blank, invalid JSON, or unknown type", () => {
    expect(parseCommand("")).toBeNull()
    expect(parseCommand("   ")).toBeNull()
    expect(parseCommand("not json")).toBeNull()
    expect(parseCommand('{"v":1,"type":"bogus"}')).toBeNull()
  })
})

describe("toSdkUserMessage", () => {
  it("wraps text as a streaming-input user message", () => {
    expect(toSdkUserMessage("hello")).toEqual({
      type: "user",
      message: { role: "user", content: "hello" },
      parent_tool_use_id: null,
    })
  })
})

describe("statusFromResult", () => {
  it("maps success to completed, everything else to failed", () => {
    expect(statusFromResult({ subtype: "success", is_error: false })).toBe("completed")
    expect(statusFromResult({ subtype: "success", is_error: true })).toBe("failed")
    expect(statusFromResult({ subtype: "error_max_turns", is_error: true })).toBe("failed")
    expect(statusFromResult({ subtype: "error_during_execution", is_error: true })).toBe("failed")
  })
})

describe("formatEventLine / formatResultLine", () => {
  it("wraps an SDK message as an event line", () => {
    const line = formatEventLine({ type: "assistant", message: { content: [] } })
    expect(JSON.parse(line)).toEqual({ v: 1, type: "event", event: { type: "assistant", message: { content: [] } } })
  })
  it("wraps an SDK result as a result line with status + output", () => {
    const line = formatResultLine({ type: "result", subtype: "success", is_error: false, result: "final text" })
    expect(JSON.parse(line)).toEqual({ v: 1, type: "result", status: "completed", output: "final text" })
  })
  it("defaults missing result text to empty string", () => {
    expect(JSON.parse(formatResultLine({ subtype: "success", is_error: false }))).toEqual({
      v: 1, type: "result", status: "completed", output: "",
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner-protocol.test.ts`
Expected: FAIL — cannot resolve `./sdk-runner-protocol.mjs`.

- [ ] **Step 3: Create `sdk-runner-protocol.mjs`**

```js
// Pure wire-protocol logic for the SDK runner. No SDK import — unit-testable on the host.
// Wire protocol (versioned NDJSON, v:1):
//   host→runner: {type:"task",text} | {type:"steer",text} | {type:"end"}
//   runner→host: {type:"event",event:<SDKMessage>} | {type:"result",status,output}

/** Parse one host→runner NDJSON line. Returns null for blank/invalid/unknown lines. */
export function parseCommand(line) {
  if (!line || !line.trim()) return null
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (obj.type === "task" || obj.type === "steer") {
    return { type: obj.type, text: typeof obj.text === "string" ? obj.text : "" }
  }
  if (obj.type === "end") return { type: "end" }
  return null
}

/** Wrap text as a streaming-input SDKUserMessage. */
export function toSdkUserMessage(text) {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }
}

/** Map an SDK result message to our coarse status. */
export function statusFromResult(sdkResult) {
  return sdkResult.subtype === "success" && !sdkResult.is_error ? "completed" : "failed"
}

/** Format an SDK message as a runner→host event line. */
export function formatEventLine(sdkMessage) {
  return JSON.stringify({ v: 1, type: "event", event: sdkMessage })
}

/** Format an SDK result message as a terminal runner→host result line. */
export function formatResultLine(sdkResult) {
  return JSON.stringify({
    v: 1,
    type: "result",
    status: statusFromResult(sdkResult),
    output: sdkResult.result ?? "",
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner-protocol.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner-protocol.mjs packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner-protocol.test.ts
git commit -m "feat: add SDK-runner wire-protocol logic module"
```

---

## Task 3: `normalizeSdk` — unwrap runner event lines into InternalEvents

The transport feeds each runner stdout line to a normalizer and accumulates `text` events into the turn's output. `normalizeSdk` unwraps the `{type:"event",event:<SDKMessage>}` envelope and maps the SDK message's content to `InternalEvent[]`, mirroring how `normalizeClaude` handles an `assistant` message.

**Files:**
- Modify: `packages/core/src/logging/stream-normalizer.ts`
- Test: `packages/core/src/logging/stream-normalizer.test.ts` (create if it does not exist)

**Interfaces:**
- Consumes: `InternalEvent` type and the existing `RawEvent` alias in `stream-normalizer.ts`.
- Produces: `normalizeSdk(raw: Record<string, unknown>): InternalEvent[]`.

- [ ] **Step 1: Write the failing test**

Create or extend `packages/core/src/logging/stream-normalizer.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { normalizeSdk } from "./stream-normalizer.js"

describe("normalizeSdk", () => {
  it("unwraps an event line's assistant text blocks", () => {
    const raw = {
      v: 1,
      type: "event",
      event: { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
    }
    expect(normalizeSdk(raw)).toEqual([{ type: "text", text: "hello" }])
  })
  it("maps assistant thinking and tool_use blocks", () => {
    const raw = {
      type: "event",
      event: {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
    }
    expect(normalizeSdk(raw)).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ])
  })
  it("maps a system event to a system InternalEvent", () => {
    const raw = { type: "event", event: { type: "system", subtype: "init", model: "claude-sonnet" } }
    expect(normalizeSdk(raw)).toEqual([{ type: "system", model: "claude-sonnet" }])
  })
  it("maps a rate_limit_event to a rate_limit InternalEvent (spike observed this in-stream)", () => {
    const raw = { type: "event", event: { type: "rate_limit_event", rate_limit_info: { status: "allowed" } } }
    expect(normalizeSdk(raw)).toEqual([{ type: "rate_limit", status: "allowed" }])
  })
  it("returns [] for the terminal result line (output captured via accumulated text)", () => {
    expect(normalizeSdk({ type: "result", status: "completed", output: "done" })).toEqual([])
    expect(normalizeSdk({ type: "event", event: { type: "result", subtype: "success", result: "done" } })).toEqual([])
  })
  it("passes through unknown event types", () => {
    expect(normalizeSdk({ type: "event", event: { type: "weird_thing" } })).toEqual([
      { type: "passthrough", rawType: "weird_thing" },
    ])
  })
  it("returns [] for malformed lines", () => {
    expect(normalizeSdk({ foo: "bar" })).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/logging/stream-normalizer.test.ts`
Expected: FAIL — `normalizeSdk` not exported.

- [ ] **Step 3: Add `normalizeSdk` to `stream-normalizer.ts`**

Append to `packages/core/src/logging/stream-normalizer.ts` (uses the same `RawEvent` alias and `InternalEvent` type already defined in the file):

```ts
/**
 * Normalize a line from the SDK runner (Phase 2). The runner wraps each SDK
 * message as `{ v:1, type:"event", event:<SDKMessage> }` and emits a terminal
 * `{ v:1, type:"result", status, output }`. We unwrap the envelope and map the
 * SDK assistant content the same way `normalizeClaude` maps stream-json
 * assistant blocks. The result line yields nothing — the turn's output comes
 * from accumulated text events (the transport already does this).
 */
export function normalizeSdk(raw: RawEvent): InternalEvent[] {
  if (raw.type === "result") return []
  if (raw.type !== "event") return []

  const event = raw.event as RawEvent | undefined
  if (!event) return []
  const eventType = event.type as string | undefined

  if (eventType === "system") {
    return [{ type: "system", model: event.model as string | undefined }]
  }
  if (eventType === "rate_limit_event") {
    const info = event.rate_limit_info as RawEvent | undefined
    return [{ type: "rate_limit", status: String(info?.status ?? "unknown") }]
  }
  if (eventType === "result") {
    return []
  }
  if (eventType === "assistant") {
    const message = event.message as RawEvent | undefined
    const content = message?.content as RawEvent[] | undefined
    if (!content) return []
    return content.map((block): InternalEvent => {
      if (block.type === "thinking") return { type: "thinking", text: block.thinking as string }
      if (block.type === "text") return { type: "text", text: block.text as string }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id as string,
          name: block.name as string,
          input: (block.input as Record<string, unknown>) ?? {},
        }
      }
      return { type: "passthrough", rawType: String(block.type) }
    })
  }
  return [{ type: "passthrough", rawType: String(eventType) }]
}
```

Note: confirm the `tool_use` and `thinking` block shapes match how `normalizeClaude` builds those same `InternalEvent` variants (read `normalizeClaude` in the same file). They must be identical so downstream logging is uniform.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/logging/stream-normalizer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/logging/stream-normalizer.ts packages/core/src/logging/stream-normalizer.test.ts
git commit -m "feat: add normalizeSdk to unwrap SDK-runner event lines"
```

---

## Task 4: Host-side SDK payload helpers (`sdk-payload.ts`)

Pure host-side helpers that build the inner command, the NDJSON stdin, and the env for an SDK turn.

**Files:**
- Create: `packages/core/src/core/limbic/hypothalamus/sdk-payload.ts`
- Test: `packages/core/src/core/limbic/hypothalamus/sdk-payload.test.ts`

**Interfaces:**
- Consumes: `TurnConfig` (`./types.js`).
- Produces:
  - `SDK_RUNNER_PATH: string` — `"/home/node/sdk-runner/sdk-runner.mjs"` (the in-image install location).
  - `buildSdkInnerCommand(): string` — `` `node ${SDK_RUNNER_PATH}` `` (no flags).
  - `buildSdkStdin(task: string): string` — two NDJSON lines: a `task` then an `end`, newline-terminated: `'{"v":1,"type":"task","text":…}\n{"v":1,"type":"end"}\n'`. Uses `JSON.stringify` so `task` text is safely escaped.
  - `sdkEnv(config: TurnConfig): Record<string, string>` — env the runner reads: `ROCI_SDK_MODEL` (from `config.model`), `ROCI_SDK_SYSTEM_PROMPT` (from `config.systemPrompt`), `ROCI_SDK_MAX_TURNS` (a sensible default, e.g. `"40"`). Merged with any `config.env`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/core/limbic/hypothalamus/sdk-payload.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { SDK_RUNNER_PATH, buildSdkInnerCommand, buildSdkStdin, sdkEnv } from "./sdk-payload.js"
import type { TurnConfig } from "./types.js"

const base: TurnConfig = {
  containerId: "c1",
  playerName: "ada",
  systemPrompt: "you are an engineer",
  prompt: "fix the bug",
  model: "opus",
  timeoutMs: 1000,
  char: { name: "ada", dir: "/work/players/ada/me" },
  role: "body",
}

describe("buildSdkInnerCommand", () => {
  it("invokes node on the runner with no flags", () => {
    expect(buildSdkInnerCommand()).toBe(`node ${SDK_RUNNER_PATH}`)
  })
})

describe("buildSdkStdin", () => {
  it("emits a task line then an end line, newline-terminated", () => {
    const lines = buildSdkStdin("fix the bug").trimEnd().split("\n")
    expect(JSON.parse(lines[0])).toEqual({ v: 1, type: "task", text: "fix the bug" })
    expect(JSON.parse(lines[1])).toEqual({ v: 1, type: "end" })
  })
  it("safely escapes task text with quotes/newlines", () => {
    const lines = buildSdkStdin('say "hi"\nthen stop').trimEnd().split("\n")
    expect(JSON.parse(lines[0])).toEqual({ v: 1, type: "task", text: 'say "hi"\nthen stop' })
  })
})

describe("sdkEnv", () => {
  it("maps config fields to ROCI_SDK_* env and merges config.env", () => {
    const env = sdkEnv({ ...base, env: { FOO: "bar" } })
    expect(env.ROCI_SDK_MODEL).toBe("opus")
    expect(env.ROCI_SDK_SYSTEM_PROMPT).toBe("you are an engineer")
    expect(env.ROCI_SDK_MAX_TURNS).toBe("40")
    expect(env.FOO).toBe("bar")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/sdk-payload.test.ts`
Expected: FAIL — cannot resolve `./sdk-payload.js`.

- [ ] **Step 3: Create `sdk-payload.ts`**

```ts
import type { TurnConfig } from "./types.js"

/** Where the SDK runner is installed inside the container image (Task 7). */
export const SDK_RUNNER_PATH = "/home/node/sdk-runner/sdk-runner.mjs"

/** Default max agentic turns for a single SDK session. */
const DEFAULT_SDK_MAX_TURNS = 40

/** The inner command run inside the container: the SDK runner, no flags. */
export function buildSdkInnerCommand(): string {
  return `node ${SDK_RUNNER_PATH}`
}

/**
 * The NDJSON stdin for a run-to-completion SDK turn: one `task`, then `end`.
 * Phase 2 never emits `steer` (that is Phase 3).
 */
export function buildSdkStdin(task: string): string {
  const taskLine = JSON.stringify({ v: 1, type: "task", text: task })
  const endLine = JSON.stringify({ v: 1, type: "end" })
  return `${taskLine}\n${endLine}\n`
}

/**
 * Env the runner reads (it takes no CLI flags). The host sets these on the
 * `docker exec`. NOTE: `ROCI_SDK_MODEL` carries `config.model` verbatim; if the
 * Task 1 spike found that the SDK rejects aliases, map the alias to the required
 * model id HERE before returning.
 */
export function sdkEnv(config: TurnConfig): Record<string, string> {
  return {
    ...(config.env ?? {}),
    ROCI_SDK_MODEL: config.model,
    ROCI_SDK_SYSTEM_PROMPT: config.systemPrompt,
    ROCI_SDK_MAX_TURNS: String(DEFAULT_SDK_MAX_TURNS),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/sdk-payload.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/sdk-payload.ts packages/core/src/core/limbic/hypothalamus/sdk-payload.test.ts
git commit -m "feat: add host-side SDK payload helpers"
```

---

## Task 5: `runSdkTurn` — compose the SDK payload with the transport

The host-side entry that runs an SDK turn run-to-completion: builds the NDJSON stdin + the `docker exec … node sdk-runner.mjs` command (with `sdkEnv` injected and the OAuth token), then calls `runTransport` with `normalizeSdk`.

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/process-runner.ts`
- Test: `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`

**Interfaces:**
- Consumes: `buildExecArgs` (local), `buildSdkInnerCommand`/`buildSdkStdin`/`sdkEnv` (`./sdk-payload.js`), `normalizeSdk` (`../../../logging/stream-normalizer.js`), `runTransport` (`./transport.js`), `OAuthToken`, `Command`, `Stream`.
- Produces: `runSdkTurn(config: TurnConfig): Effect.Effect<TurnResult, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken>` — same R/E/A channels as `runTurn`.

Note on `buildExecArgs`: it already merges `config.env` (skipping the OAuth key) then appends the OAuth token. To inject the SDK env, build a `TurnConfig`-shaped object whose `env` is `sdkEnv(config)` and pass it to `buildExecArgs` so the `-e ROCI_SDK_*` flags are emitted by the existing logic. The OAuth token env decision from Task 1 stands: if Task 1 found the SDK needs `ANTHROPIC_API_KEY` instead of/in addition to `CLAUDE_CODE_OAUTH_TOKEN`, add it to `sdkEnv` (so it flows through `buildExecArgs`'s custom-env loop) and note it.

- [ ] **Step 1: Write the failing test (host-side, fake echo runner emitting SDK NDJSON)**

Add to `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`. This proves `runSdkTurn` runs a real local subprocess emitting the SDK wire protocol and accumulates the assistant text — exercising the `normalizeSdk` + transport composition without Docker. Because `runSdkTurn` hardcodes `Command.make("docker", …)`, we test the **composition seam** via the exported pieces and a transport-level integration:

```ts
import { Effect, Layer, Stream } from "effect"
import { Command } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { runTransport } from "./transport.js"
import { normalizeSdk } from "../../../logging/stream-normalizer.js"
import { buildSdkStdin } from "./sdk-payload.js"
import { CharacterLog } from "../../../logging/log-writer.js"

const StubCharacterLog = Layer.succeed(CharacterLog, CharacterLog.of({ emit: () => Effect.void }))
const sdkDeps = Layer.merge(NodeContext.layer, StubCharacterLog)
const char = { name: "ada", dir: "/work/players/ada/me" }

describe("SDK payload over the transport (run-to-completion)", () => {
  it("accumulates assistant text from a fake runner emitting SDK NDJSON", async () => {
    // A fake runner: echoes two event lines (assistant text) then a result line.
    const ev1 = JSON.stringify({ v: 1, type: "event", event: { type: "assistant", message: { content: [{ type: "text", text: "part1" }] } } })
    const ev2 = JSON.stringify({ v: 1, type: "event", event: { type: "assistant", message: { content: [{ type: "text", text: "part2" }] } } })
    const res = JSON.stringify({ v: 1, type: "result", status: "completed", output: "part1\npart2" })
    const script = `printf '%s\\n%s\\n%s\\n' '${ev1}' '${ev2}' '${res}'`
    const command = Command.make("bash", "-c", script)

    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeSdk, runtimeTag: "sdk", char, role: "body", timeoutMs: 5000 }),
        sdkDeps,
      ),
    )
    expect(result.timedOut).toBe(false)
    expect(result.output).toBe("part1\npart2")
  })

  it("buildSdkStdin feeds a runner that reads it (round-trip through stdin)", async () => {
    // Prove the NDJSON stdin is consumable: a fake runner reads stdin and echoes
    // an assistant event carrying the task text back.
    const stdin = Stream.encodeText(Stream.make(buildSdkStdin("echo me")))
    const script = `node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const first=JSON.parse(d.split("\\n")[0]);console.log(JSON.stringify({v:1,type:"event",event:{type:"assistant",message:{content:[{type:"text",text:first.text}]}}}));})'`
    const command = Command.make("bash", "-c", script).pipe(Command.stdin(stdin))

    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeSdk, runtimeTag: "sdk", char, role: "body", timeoutMs: 5000 }),
        sdkDeps,
      ),
    )
    expect(result.output).toBe("echo me")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`
Expected: FAIL initially only if imports are missing; these two cases should actually PASS once `normalizeSdk` (Task 3) and `buildSdkStdin` (Task 4) exist — they test the composition, not yet `runSdkTurn`. Add the `runSdkTurn` unit assertion next so there is a red for the new function:

Append:

```ts
import { runSdkTurn } from "./process-runner.js"

describe("runSdkTurn", () => {
  it("is exported as a function with the runTurn-style signature", () => {
    expect(typeof runSdkTurn).toBe("function")
  })
})
```

Run again; expect FAIL — `runSdkTurn` not exported.

- [ ] **Step 3: Add `runSdkTurn` to `process-runner.ts`**

```ts
import { buildSdkInnerCommand, buildSdkStdin, sdkEnv } from "./sdk-payload.js"
import { normalizeSdk } from "../../../logging/stream-normalizer.js"

/**
 * Run a frontier-worker SDK turn run-to-completion. Builds the NDJSON stdin
 * (`task` then `end`), the `docker exec … node sdk-runner.mjs` command (with the
 * SDK env + OAuth token injected via buildExecArgs), and delegates streaming /
 * race / kill to the shared transport with normalizeSdk. Phase 2: no steering.
 */
export const runSdkTurn = (config: TurnConfig): Effect.Effect<
  TurnResult,
  ClaudeError,
  CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
> =>
  Effect.gen(function* () {
    const oauthToken = yield* OAuthToken
    const { token } = yield* oauthToken.getToken

    const innerCmd = buildSdkInnerCommand()
    // Inject the SDK env through buildExecArgs's custom-env loop.
    const execArgs = buildExecArgs({ ...config, env: sdkEnv(config) }, innerCmd, token)

    const redactedArgs = execArgs.map((a) =>
      a.includes("CLAUDE_CODE_OAUTH_TOKEN=") ? "CLAUDE_CODE_OAUTH_TOKEN=<redacted>" : a,
    )
    yield* logToConsole(config.char.name, config.role, `docker ${redactedArgs.join(" ")}`)

    const stdin = Stream.encodeText(Stream.make(buildSdkStdin(config.prompt)))
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
```

(The outer `mapError` is required for the same reason `runTurn` needs it: `logToConsole` contributes a non-`ClaudeError` to the error channel.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`
Then typecheck: `pnpm exec tsc -p packages/core --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Run the full suite, then commit**

Run: `pnpm test` (if a `domain-spacemolt` resolution error appears, run `pnpm build` then `pnpm test` — stale `dist/`, not a regression).
Expected: green.

```bash
git add packages/core/src/core/limbic/hypothalamus/process-runner.ts packages/core/src/core/limbic/hypothalamus/process-runner.test.ts
git commit -m "feat: add runSdkTurn composing the SDK payload with the transport"
```

---

## Task 6: The `sdk-runner.mjs` entry script

The thin glue: read NDJSON stdin via the protocol module, drive `query()`, write NDJSON stdout. Logic lives in `sdk-runner-protocol.mjs` (Task 2), so this file is small. It cannot be unit-tested on the host (it imports the SDK); it is validated by the Task 7 container smoke. Keep it minimal and faithful to the spike's findings (Task 1).

**Files:**
- Create: `packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner.mjs`
- Create: `packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner-package.json`

- [ ] **Step 1: Create `sdk-runner-package.json`**

Pin the SDK version the Task 1 spike validated (`0.3.183`):

```json
{
  "name": "roci-sdk-runner",
  "private": true,
  "type": "module",
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.3.183"
  }
}
```

- [ ] **Step 2: Create `sdk-runner.mjs`**

```js
// In-container frontier-worker entry. Reads NDJSON commands on stdin, drives the
// Agent SDK's streaming-input query(), writes NDJSON events/result on stdout.
// Pure protocol logic lives in ./sdk-runner-protocol.mjs (unit-tested on the host).
import { query } from "@anthropic-ai/claude-agent-sdk"
import * as readline from "node:readline"
import {
  parseCommand,
  toSdkUserMessage,
  formatEventLine,
  formatResultLine,
} from "./sdk-runner-protocol.mjs"

// Async generator of SDKUserMessages, driven by stdin. Completes on `end`.
async function* inputMessages() {
  const rl = readline.createInterface({ input: process.stdin })
  for await (const line of rl) {
    const cmd = parseCommand(line)
    if (!cmd) continue
    if (cmd.type === "end") {
      rl.close()
      return
    }
    // task and steer are structurally identical: each becomes one user turn.
    yield toSdkUserMessage(cmd.text)
  }
}

async function main() {
  const options = {
    model: process.env.ROCI_SDK_MODEL,
    systemPrompt: process.env.ROCI_SDK_SYSTEM_PROMPT,
    maxTurns: Number(process.env.ROCI_SDK_MAX_TURNS ?? "40"),
    permissionMode: "bypassPermissions",
    cwd: process.cwd(),
  }
  try {
    for await (const message of query({ prompt: inputMessages(), options })) {
      process.stdout.write(`${formatEventLine(message)}\n`)
      if (message.type === "result") {
        process.stdout.write(`${formatResultLine(message)}\n`)
      }
    }
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({ v: 1, type: "result", status: "failed", output: String(err?.message ?? err) })}\n`,
    )
    process.exitCode = 1
  }
}

main()
```

- [ ] **Step 3: Sanity-check syntax (no SDK needed for parse)**

Run: `node --check packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner.mjs`
Expected: no output (syntax OK). (This only parses; it does not import the SDK.)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner.mjs packages/core/src/core/limbic/hypothalamus/sdk-runner/sdk-runner-package.json
git commit -m "feat: add SDK-runner entry script (streaming-input query driver)"
```

---

## Task 7: Bake the runner into the Docker images + container smoke

Install the runner and the SDK into both domain images, then prove a real run-to-completion SDK turn in a container. Needs Docker + a valid token + network. If unavailable, report BLOCKED.

**Files:**
- Copy the three runner files into each domain docker context.
- Modify: `packages/domain-spacemolt/src/docker/Dockerfile`, `packages/domain-github/src/docker/Dockerfile`.

- [ ] **Step 1: Copy the runner files into each domain docker context**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/agent-sdk
SRC=packages/core/src/core/limbic/hypothalamus/sdk-runner
for d in packages/domain-spacemolt/src/docker packages/domain-github/src/docker; do
  cp "$SRC/sdk-runner.mjs" "$SRC/sdk-runner-protocol.mjs" "$SRC/sdk-runner-package.json" "$d/"
done
```
(Canonical source stays in `core`; these are committed copies, matching the existing `roci-channel.ts` duplication. Note the debt.)

- [ ] **Step 2: Add the install block to BOTH Dockerfiles**

Insert after the OpenCode install block (before the firewall/channel setup) in each Dockerfile, as the `node` user:

```dockerfile
# Install the Agent SDK frontier-worker runner (Phase 2)
RUN mkdir -p /home/node/sdk-runner
COPY --chown=node:node sdk-runner.mjs sdk-runner-protocol.mjs /home/node/sdk-runner/
COPY --chown=node:node sdk-runner-package.json /home/node/sdk-runner/package.json
RUN cd /home/node/sdk-runner && npm install --omit=dev
```

(`/home/node` is already `node`-owned and writable, unlike `/opt`. `SDK_RUNNER_PATH` in `sdk-payload.ts` matches `/home/node/sdk-runner/sdk-runner.mjs`.)

- [ ] **Step 3: Build the spacemolt image**

Run: `docker build -t roci-spacemolt-sdktest -f packages/domain-spacemolt/src/docker/Dockerfile packages/domain-spacemolt/src/docker`
Expected: build succeeds; the SDK installs under `/home/node/sdk-runner/node_modules`.

- [ ] **Step 4: Container smoke — real run-to-completion SDK turn**

Feed the runner the wire protocol directly (use the auth env var Task 1 established; shown here with `CLAUDE_CODE_OAUTH_TOKEN` — substitute if Task 1 found otherwise). Do not print the token.

```bash
TOKEN="$(cat .oauth-token)"
printf '%s\n%s\n' '{"v":1,"type":"task","text":"Reply with exactly: OK"}' '{"v":1,"type":"end"}' \
| docker run --rm -i \
    -e CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" \
    -e ROCI_SDK_MODEL=sonnet \
    -e ROCI_SDK_SYSTEM_PROMPT="You are a terse assistant." \
    -e ROCI_SDK_MAX_TURNS=1 \
    roci-spacemolt-sdktest node /home/node/sdk-runner/sdk-runner.mjs
```
Expected: NDJSON lines — one or more `{"v":1,"type":"event",…}` then a terminal `{"v":1,"type":"result","status":"completed","output":"OK"}`. Record the actual output in the report. If `status:"failed"` with an auth error, the env-var choice is wrong — revisit Task 1's finding and `sdkEnv`.

- [ ] **Step 5: Build the github image too (parity)**

Run: `docker build -t roci-github-sdktest -f packages/domain-github/src/docker/Dockerfile packages/domain-github/src/docker`
Expected: build succeeds. (No second smoke needed — the runner is identical; the build proves the COPY/install lines are correct for that context.)

- [ ] **Step 6: Commit**

```bash
git add packages/domain-spacemolt/src/docker packages/domain-github/src/docker
git commit -m "feat: bake SDK-runner + agent-sdk into domain images"
```

---

## Task 8: Document the wire protocol + smoke, record the auth finding

**Files:**
- Modify: `docs/cortex-smoke.md`

- [ ] **Step 1: Add a Phase 2 section to `docs/cortex-smoke.md`**

Document, in prose matching the file's existing style: (a) the NDJSON wire protocol table (host→runner `task`/`steer`/`end`; runner→host `event`/`result`); (b) the **Task 1 auth finding** — which credential env var the SDK honors and whether model aliases work; (c) the run-to-completion container smoke command from Task 7 Step 4 and its expected `result` line; (d) a note that steering and cortex wiring are Phases 3–4, and that `steer` is parsed-but-unused in Phase 2.

- [ ] **Step 2: Commit**

```bash
git add docs/cortex-smoke.md
git commit -m "docs: document SDK-runner wire protocol, auth finding, and smoke"
```

---

## Self-Review

Checked against the spec (`docs/superpowers/specs/2026-06-18-cybernetics-agent-sdk-steering-design.md` §5(2) "New sdk-runner.js", §6 "Wire protocol", §9 "Completion signal") and the Phase 2 roadmap entry:

**1. Spec coverage:**
- "Image ships `@anthropic-ai/claude-agent-sdk` alongside the bundled binary (new dependency)" → Task 6 `sdk-runner-package.json` + Task 7 install block. ✓
- "Runner reads NDJSON stdin → SDKUserMessages, drives `query({ prompt: generator })`, writes NDJSON stdout" → Tasks 2 + 6. ✓
- "Wire protocol: host→runner `task`/`steer`/`end`; runner→host `event`/`result`; `task` & `steer` structurally identical; run-to-completion = `task` then `end`" → Global Constraints + Tasks 2, 4. ✓
- "Events fed through the existing normalizer" → Task 3 `normalizeSdk` + Task 5 composition. ✓
- "Terminal `result` line with status" → Task 2 `formatResultLine` + `statusFromResult`. ✓
- "Completion signal — in streaming mode the session doesn't self-terminate" → handled by the input generator returning on `end` (Task 6), which ends the `query()` loop; the structured **completion marker** the agent emits mid-text is a Phase 3/4 concern (steering keeps the session open) and is explicitly out of Phase 2 scope. Noted.
- Steering machinery (coalescing queue, cadence, `delegate(config, steering)`) → explicitly deferred to Phase 3. ✓
- "Retain dormant `claude -p`" → unchanged from Phase 1; not touched here. ✓

**2. Placeholder scan:** No "TBD/handle errors/etc." The only intentional fill-in is `<VERSION_FROM_SPIKE>` in `sdk-runner-package.json` (Task 6 Step 1), which is resolved by the Task 1 spike output — flagged explicitly, not a vague placeholder. Auth env var and model-alias handling are likewise gated on Task 1's concrete findings.

**3. Type consistency:** `normalizeSdk` returns `InternalEvent[]` matching the transport's `normalize` param and `normalizeClaude`'s variants (text/thinking/tool_use/system/passthrough). `buildSdkStdin`/`parseCommand`/`formatResultLine` agree on the `{v:1,type,text}`/`{v:1,type:"result",status,output}` shapes. `runSdkTurn`'s signature matches `runTurn`'s `(TurnConfig) => Effect<TurnResult, ClaudeError, CommandExecutor | CharacterLog | OAuthToken>`. `SDK_RUNNER_PATH` (`/home/node/sdk-runner/sdk-runner.mjs`) matches the Dockerfile COPY target and the Task 7 smoke invocation.

**Risk callouts for the executor:** (a) Task 1 is a hard gate — if the SDK won't auth with the OAuth token and no API key is available, Tasks 6–7 are blocked. (b) Tasks 1, 7 need Docker + network + a valid token; in an environment without them, those tasks report BLOCKED and the host-side Tasks 2–5 (pure/unit-tested) still land independently.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-18-cybernetics-phase2-sdk-runner-wire-protocol.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute in this session with executing-plans, batch checkpoints.

**Which approach?**
