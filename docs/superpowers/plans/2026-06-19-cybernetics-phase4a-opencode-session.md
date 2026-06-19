# Phase 4a — OpenCode Conscious-Session Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a resumable, steerable conscious-tier transport — a sequence of `docker exec … opencode run` turns that share one OpenCode session, driven by the local host model with a per-character system prompt.

**Architecture:** Re-invoke-per-turn over the *existing* `docker exec` transport (no daemon, no ports). The first turn runs `opencode run --format json --agent <name> -m local/conscious <task>` and the session id is captured from the JSON event stream; each later turn resumes with `opencode run --format json -s <id> <directive>`. Provider config (host model endpoint) is provisioned **global, per container**; the character system prompt is provisioned **project-local** as `.opencode/agent/conscious.md` in the character's bind-mounted working dir. This is the transport substrate only — loop wiring, steering-queue consumption, and evaluate-after-turn are Phase 4b; escalation/completion is Phase 4c.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers on relative imports), Effect-TS (`Effect`, `Stream`, `Ref`, `Layer`, `Context`), `@effect/platform` (`Command`, `CommandExecutor`), Vitest, pnpm workspace (`@roci/core` at `packages/core`). Runtime under test: `opencode` 1.17.8 inside Docker, talking to a host `llama-server` over `host.docker.internal`.

## Global Constraints

- **Spec of record:** `docs/superpowers/specs/2026-06-19-cybernetics-phase4a-opencode-session-design.md`. Spike evidence: `sdd/phase4a-spike-report.md`.
- **`-s <id>` only.** Never use `opencode`'s `-c`/`--continue` for resume — it resumes the *most-recent* session and is unsafe under orchestration.
- **Resume turns omit `--agent` and `-m`.** The session already carries the agent/system context; a resume turn passes only `-s <id>` and the message.
- **Config scoping:** provider = global (`/home/node/.config/opencode/opencode.jsonc`, one per container); system prompt = project-local (`/work/players/<name>/.opencode/agent/conscious.md`).
- **Host reachability:** the conscious model handle's base URL is host loopback (`http://127.0.0.1:8083/v1`); inside the container it must be rewritten to `http://host.docker.internal:8083/v1`.
- **Config-protection:** after writing the project-local agent file, `chmod` it read-only so a confused tool-using turn cannot corrupt its own definition.
- **Stable identifiers:** OpenCode provider id `local`, model key `conscious`, model label `local/conscious`, agent name `conscious`.
- **Do NOT touch** `delegate` or the Agent-SDK frontier-worker path — they remain the Phase 4c escalation transport.
- **ESM imports:** relative imports use `.js` specifiers even though sources are `.ts`.
- **Commits:** every commit message ends with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. A pre-commit hook runs `pnpm build`; if it fails with a missing-`dist/` resolution error, run `pnpm build` once and retry.
- **Verify the full package suite is green before each commit:** `pnpm --filter @roci/core test`.

---

## File Structure

**New files:**
- `packages/core/src/cybernetics/opencode-config.ts` — pure generators (provider JSON, agent markdown, base-URL rewrite, shared constants) + two provisioning side-effects (`provisionConsciousProvider`, `writeCharacterAgentFile`).
- `packages/core/src/cybernetics/opencode-config.test.ts` — unit tests for the above.
- `packages/core/src/cybernetics/opencode-session.smoke.test.ts` — gated real-container two-turn round-trip.

**Modified files:**
- `packages/core/src/core/limbic/hypothalamus/types.ts` — add `sessionId?` to `TurnResult`; add `agentName?` to `TurnConfig`.
- `packages/core/src/core/limbic/hypothalamus/transport.ts` — add optional `captureFromRaw` hook; surface the captured value as `TurnResult.sessionId`.
- `packages/core/src/core/limbic/hypothalamus/transport.test.ts` — test the capture hook.
- `packages/core/src/core/limbic/hypothalamus/payload.ts` — add `buildOpenCodeSessionCommand`.
- `packages/core/src/core/limbic/hypothalamus/payload.test.ts` — test the command builder.
- `packages/core/src/core/limbic/hypothalamus/process-runner.ts` — add `runOpenCodeSessionTurn` + `firstSessionId` helper.
- `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts` — test the helper + export.
- `docs/cortex-smoke.md` — add the conscious-session smoke section.

---

## Task 1: OpenCode config generators (pure)

**Files:**
- Create: `packages/core/src/cybernetics/opencode-config.ts`
- Test: `packages/core/src/cybernetics/opencode-config.test.ts`

**Interfaces:**
- Consumes: `ModelHandle` from `../model/handles.js`.
- Produces:
  - `CONSCIOUS_PROVIDER_ID = "local"`, `CONSCIOUS_MODEL_KEY = "conscious"`, `CONSCIOUS_MODEL_LABEL = "local/conscious"`, `CONSCIOUS_AGENT_NAME = "conscious"`, `GLOBAL_OPENCODE_CONFIG_PATH = "/home/node/.config/opencode/opencode.jsonc"`.
  - `hostInternalBaseUrl(baseUrl: string): string`
  - `buildProviderConfigJson(handle: ModelHandle): string`
  - `buildCharacterAgentMarkdown(opts: { systemPrompt: string; modelLabel?: string }): string`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/cybernetics/opencode-config.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import {
  hostInternalBaseUrl,
  buildProviderConfigJson,
  buildCharacterAgentMarkdown,
  CONSCIOUS_MODEL_LABEL,
} from "./opencode-config.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"

describe("hostInternalBaseUrl", () => {
  it("rewrites host loopback to host.docker.internal, preserving port and path", () => {
    expect(hostInternalBaseUrl("http://127.0.0.1:8083/v1")).toBe("http://host.docker.internal:8083/v1")
    expect(hostInternalBaseUrl("http://localhost:8083/v1")).toBe("http://host.docker.internal:8083/v1")
    expect(hostInternalBaseUrl("http://0.0.0.0:8083/v1")).toBe("http://host.docker.internal:8083/v1")
  })
  it("leaves a non-loopback host unchanged", () => {
    expect(hostInternalBaseUrl("http://10.0.0.5:8083/v1")).toBe("http://10.0.0.5:8083/v1")
  })
})

describe("buildProviderConfigJson", () => {
  const json = buildProviderConfigJson(DEFAULT_CORTEX_MODELS.conscious)
  const parsed = JSON.parse(json)
  it("keeps the permission bypass", () => {
    expect(parsed.permission).toEqual({ "*": "allow" })
  })
  it("declares the openai-compatible local provider at the host-internal URL", () => {
    expect(parsed.provider.local.npm).toBe("@ai-sdk/openai-compatible")
    expect(parsed.provider.local.options.baseURL).toBe("http://host.docker.internal:8083/v1")
    expect(parsed.provider.local.options.apiKey).toBeTruthy()
  })
  it("registers the conscious model key", () => {
    expect(parsed.provider.local.models.conscious).toBeDefined()
  })
})

describe("buildCharacterAgentMarkdown", () => {
  it("emits frontmatter with mode/model and the system prompt as the body", () => {
    const md = buildCharacterAgentMarkdown({ systemPrompt: "You are Ada." })
    expect(md).toContain("mode: primary")
    expect(md).toContain(`model: ${CONSCIOUS_MODEL_LABEL}`)
    expect(md.trimEnd().endsWith("You are Ada.")).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @roci/core test opencode-config`
Expected: FAIL — cannot resolve `./opencode-config.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/cybernetics/opencode-config.ts`:

```typescript
import type { ModelHandle } from "../model/handles.js"

/** OpenCode provider id for the local host model server. */
export const CONSCIOUS_PROVIDER_ID = "local"
/** Model key inside the provider's `models` map. */
export const CONSCIOUS_MODEL_KEY = "conscious"
/** `-m` label: `<provider>/<model-key>`. */
export const CONSCIOUS_MODEL_LABEL = `${CONSCIOUS_PROVIDER_ID}/${CONSCIOUS_MODEL_KEY}`
/** Project-local agent name (file basename, `--agent` value). */
export const CONSCIOUS_AGENT_NAME = "conscious"
/** Global (per-container) OpenCode config path. */
export const GLOBAL_OPENCODE_CONFIG_PATH = "/home/node/.config/opencode/opencode.jsonc"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0"])

/** Rewrite a host-loopback base URL to the container's route to the host. */
export function hostInternalBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (LOOPBACK_HOSTS.has(url.hostname)) {
    url.hostname = "host.docker.internal"
  }
  return url.toString().replace(/\/$/, baseUrl.endsWith("/") ? "/" : "")
}

/** Global OpenCode config JSON: permission bypass + the local-model provider. */
export function buildProviderConfigJson(handle: ModelHandle): string {
  const config = {
    $schema: "https://opencode.ai/config.json",
    permission: { "*": "allow" },
    provider: {
      [CONSCIOUS_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local Cortex",
        options: {
          baseURL: hostInternalBaseUrl(handle.baseUrl),
          apiKey: handle.apiKey ?? "sk-local",
        },
        models: { [CONSCIOUS_MODEL_KEY]: { name: handle.model } },
      },
    },
  }
  return JSON.stringify(config, null, 2)
}

/** Project-local agent markdown: frontmatter + system prompt body. */
export function buildCharacterAgentMarkdown(opts: {
  systemPrompt: string
  modelLabel?: string
}): string {
  const model = opts.modelLabel ?? CONSCIOUS_MODEL_LABEL
  return `---\nmode: primary\nmodel: ${model}\n---\n\n${opts.systemPrompt}\n`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @roci/core test opencode-config`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cybernetics/opencode-config.ts packages/core/src/cybernetics/opencode-config.test.ts
git commit -m "feat(cybernetics): OpenCode conscious-session config generators

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Capture the session id through the transport

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/types.ts`
- Modify: `packages/core/src/core/limbic/hypothalamus/transport.ts`
- Test: `packages/core/src/core/limbic/hypothalamus/transport.test.ts`

**Interfaces:**
- Produces: `TurnResult.sessionId?: string`; `TransportInput.captureFromRaw?: (raw: Record<string, unknown>) => string | null`. When `captureFromRaw` is set, the transport stores the **first** non-null return across all stdout lines and returns it as `TurnResult.sessionId`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/core/limbic/hypothalamus/transport.test.ts` (it already imports `Effect`, `Layer`, `Command`, `NodeContext`, `runTransport`, `CharacterLog`, `normalizeClaude`; add `normalizeOpenCode` to the existing stream-normalizer import):

```typescript
import { normalizeOpenCode } from "../../../logging/stream-normalizer.js"

describe("runTransport captureFromRaw", () => {
  it("captures the first non-null value and returns it as sessionId", async () => {
    const l1 = '{"type":"step_start","sessionID":"ses_abc","part":{"model":"local/conscious"}}'
    const l2 = '{"type":"text","part":{"text":"hello"}}'
    const command = Command.make("bash", "-c", `printf '%s\\n%s\\n' '${l1}' '${l2}'`)

    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({
          command,
          normalize: normalizeOpenCode,
          runtimeTag: "opencode",
          char,
          role: "body",
          timeoutMs: 5000,
          captureFromRaw: (raw) => (typeof raw.sessionID === "string" ? raw.sessionID : null),
        }),
        deps,
      ),
    )
    expect(result.sessionId).toBe("ses_abc")
    expect(result.output).toContain("hello")
  })

  it("leaves sessionId undefined when no capture hook is given", async () => {
    const command = Command.make("bash", "-c", `printf '%s\\n' '{"type":"text","part":{"text":"hi"}}'`)
    const result = await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeOpenCode, runtimeTag: "opencode", char, role: "body", timeoutMs: 5000 }),
        deps,
      ),
    )
    expect(result.sessionId).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @roci/core test transport`
Expected: FAIL — `captureFromRaw` is not a known property / `result.sessionId` is always undefined.

- [ ] **Step 3: Write minimal implementation**

In `types.ts`, add the optional field to `TurnResult`:

```typescript
/** Result of a completed (or timed-out) turn. */
export interface TurnResult {
  output: string
  timedOut: boolean
  durationMs: number
  /** First captured stream value (e.g. OpenCode sessionID), when a capture hook ran. */
  sessionId?: string
}
```

In `transport.ts`, add the field to `TransportInput`:

```typescript
  timeoutMs: number
  /** Optional: extract a value from each raw stdout line; the first non-null is kept. */
  captureFromRaw?: (raw: Record<string, unknown>) => string | null
}
```

In `runTransport`, add a capture Ref next to `textAccumulator`:

```typescript
      const textAccumulator = yield* Ref.make<string[]>([])
      const capturedSessionId = yield* Ref.make<string | null>(null)
```

Inside the stdout `mapEffect`, after `const raw = parseStreamJson(line)` and within the `if (raw) { … }` block (before/after the normalize loop is fine), add:

```typescript
            if (raw) {
              if (input.captureFromRaw) {
                const already = yield* Ref.get(capturedSessionId)
                if (already === null) {
                  const v = input.captureFromRaw(raw)
                  if (v) yield* Ref.set(capturedSessionId, v)
                }
              }
              const internal = input.normalize(raw)
              // … existing normalize/emit/accumulate loop unchanged …
```

At the return, thread it through:

```typescript
      const textParts = yield* Ref.get(textAccumulator)
      const output = textParts.join("\n")
      const durationMs = Date.now() - start
      const sessionId = yield* Ref.get(capturedSessionId)
      return { output, timedOut, durationMs, sessionId: sessionId ?? undefined }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @roci/core test transport`
Expected: PASS (new cases plus the existing transport tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/types.ts packages/core/src/core/limbic/hypothalamus/transport.ts packages/core/src/core/limbic/hypothalamus/transport.test.ts
git commit -m "feat(transport): optional captureFromRaw hook surfaces sessionId

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `buildOpenCodeSessionCommand` (payload)

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/types.ts`
- Modify: `packages/core/src/core/limbic/hypothalamus/payload.ts`
- Test: `packages/core/src/core/limbic/hypothalamus/payload.test.ts`

**Interfaces:**
- Consumes: `shellEscape` (existing, `payload.ts`); `CONSCIOUS_AGENT_NAME` from `../../../cybernetics/opencode-config.js`.
- Produces:
  - `TurnConfig.agentName?: string` (the `--agent` value for a first turn).
  - `buildOpenCodeSessionCommand(config: TurnConfig, resume?: { sessionId: string }): string`.
    - First turn (`resume` absent): `opencode run --format json --agent <agentName> -m <model> <escaped-prompt>`.
    - Resume turn (`resume` present): `opencode run --format json -s <sessionId> <escaped-prompt>` (no `--agent`, no `-m`).

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/core/limbic/hypothalamus/payload.test.ts` (add the import):

```typescript
import { buildOpenCodeSessionCommand } from "./payload.js"

describe("buildOpenCodeSessionCommand", () => {
  const cfg: TurnConfig = { ...base, model: "local/conscious", agentName: "conscious", prompt: "do the thing" }

  it("first turn carries --agent, -m, --format json, and the escaped prompt", () => {
    const cmd = buildOpenCodeSessionCommand(cfg)
    expect(cmd.startsWith("opencode run")).toBe(true)
    expect(cmd).toContain("--format json")
    expect(cmd).toContain("--agent conscious")
    expect(cmd).toContain("-m local/conscious")
    expect(cmd).toContain("$'do the thing'")
  })

  it("resume turn carries -s and the prompt but NOT --agent or -m", () => {
    const cmd = buildOpenCodeSessionCommand({ ...cfg, prompt: "now do this" }, { sessionId: "ses_abc" })
    expect(cmd).toContain("-s ses_abc")
    expect(cmd).toContain("$'now do this'")
    expect(cmd).not.toContain("--agent")
    expect(cmd).not.toContain("-m ")
  })

  it("falls back to the default agent name when none is set", () => {
    const cmd = buildOpenCodeSessionCommand({ ...cfg, agentName: undefined })
    expect(cmd).toContain("--agent conscious")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @roci/core test payload`
Expected: FAIL — `buildOpenCodeSessionCommand` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `types.ts`, add to `TurnConfig` (near the other optional fields):

```typescript
  /** OpenCode agent name to run on a conscious-session first turn (`--agent`). */
  agentName?: string
```

In `payload.ts`, add the import and the builder:

```typescript
import { CONSCIOUS_AGENT_NAME } from "../../../cybernetics/opencode-config.js"

/**
 * Inner command for a conscious-tier OpenCode session turn. First turn opens the
 * session with the project-local agent and model; a resume turn continues an
 * existing session by id (and must NOT re-pass --agent/-m — the session carries
 * that context). `-s <id>` only; `--continue` is never used (orchestration-unsafe).
 */
export function buildOpenCodeSessionCommand(
  config: TurnConfig,
  resume?: { sessionId: string },
): string {
  const parts = ["opencode", "run", "--format", "json"]
  if (resume) {
    parts.push("-s", resume.sessionId)
  } else {
    parts.push("--agent", config.agentName ?? CONSCIOUS_AGENT_NAME)
    parts.push("-m", String(config.model))
  }
  parts.push(shellEscape(config.prompt))
  return parts.join(" ")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @roci/core test payload`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/types.ts packages/core/src/core/limbic/hypothalamus/payload.ts packages/core/src/core/limbic/hypothalamus/payload.test.ts
git commit -m "feat(payload): buildOpenCodeSessionCommand (first + resume turns)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `runOpenCodeSessionTurn` (process-runner)

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/process-runner.ts`
- Test: `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts`

**Interfaces:**
- Consumes: `buildExecArgs` (existing), `runTransport` (existing), `buildOpenCodeSessionCommand` (Task 3), `normalizeOpenCode`, `TurnConfig`/`TurnResult` with `sessionId` (Task 2), `OAuthToken`, `CharacterLog`, `ClaudeError`.
- Produces:
  - `firstSessionId(raw: Record<string, unknown>): string | null` — capture predicate (`sessionID` field when it is a string).
  - `runOpenCodeSessionTurn(config: TurnConfig, resume?: { sessionId: string }): Effect.Effect<{ result: TurnResult; sessionId: string }, ClaudeError, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken>` — builds the `docker exec opencode run` command, runs it through the shared transport with `captureFromRaw: firstSessionId`, and fails with `ClaudeError` if no session id was captured.

> **Note (test seam):** like `runSdkSession`, this function hardcodes `Command.make("docker", …)`, so it cannot run host-side. Unit tests cover the pure `firstSessionId` predicate and the export; the capture seam is already proven in Task 2 and the real two-turn round-trip in the Task 7 smoke test.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/core/limbic/hypothalamus/process-runner.test.ts` (add to the existing import from `./process-runner.js`):

```typescript
import { runOpenCodeSessionTurn, firstSessionId } from "./process-runner.js"

describe("firstSessionId", () => {
  it("returns the sessionID string when present", () => {
    expect(firstSessionId({ type: "step_start", sessionID: "ses_xyz" })).toBe("ses_xyz")
  })
  it("returns null when absent or non-string", () => {
    expect(firstSessionId({ type: "text" })).toBeNull()
    expect(firstSessionId({ sessionID: 123 })).toBeNull()
  })
})

describe("runOpenCodeSessionTurn", () => {
  it("is exported as a function", () => {
    expect(typeof runOpenCodeSessionTurn).toBe("function")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @roci/core test process-runner`
Expected: FAIL — `runOpenCodeSessionTurn` / `firstSessionId` not exported.

- [ ] **Step 3: Write minimal implementation**

In `process-runner.ts`, add imports:

```typescript
import { buildOpenCodeSessionCommand } from "./payload.js"
import { normalizeOpenCode } from "../../../logging/stream-normalizer.js"
```

Add the helper and the runner (after `runSdkSession`):

```typescript
/** Capture predicate for the OpenCode sessionID field on a raw stream line. */
export const firstSessionId = (raw: Record<string, unknown>): string | null =>
  typeof raw.sessionID === "string" ? raw.sessionID : null

/**
 * Run one conscious-tier OpenCode session turn over the shared docker-exec
 * transport. First turn (no `resume`) opens the session with the project-local
 * agent + local model and captures the new session id; a resume turn continues
 * `resume.sessionId`. Returns the turn result plus the (captured or carried)
 * session id. Fails with ClaudeError if a first turn yields no session id.
 */
export const runOpenCodeSessionTurn = (
  config: TurnConfig,
  resume?: { sessionId: string },
): Effect.Effect<
  { result: TurnResult; sessionId: string },
  ClaudeError,
  CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
> =>
  Effect.gen(function* () {
    const oauthToken = yield* OAuthToken
    const { token } = yield* oauthToken.getToken

    const innerCmd = buildOpenCodeSessionCommand(config, resume)
    const execArgs = buildExecArgs(config, innerCmd, token)

    const redactedArgs = execArgs.map((a) =>
      a.includes("CLAUDE_CODE_OAUTH_TOKEN=") ? "CLAUDE_CODE_OAUTH_TOKEN=<redacted>" : a,
    )
    yield* logToConsole(config.char.name, config.role, `docker ${redactedArgs.join(" ")}`)

    const command = Command.make("docker", ...execArgs)

    const result = yield* runTransport({
      command,
      normalize: normalizeOpenCode,
      runtimeTag: "opencode",
      char: config.char,
      role: config.role,
      timeoutMs: config.timeoutMs,
      captureFromRaw: firstSessionId,
    })

    const sessionId = result.sessionId ?? resume?.sessionId
    if (!sessionId) {
      return yield* Effect.fail(new ClaudeError("OpenCode session id not captured from run output"))
    }
    return { result, sessionId }
  }).pipe(
    Effect.mapError((e) => (e instanceof ClaudeError ? e : new ClaudeError("OpenCode session runner failed", e))),
  )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @roci/core test process-runner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/process-runner.ts packages/core/src/core/limbic/hypothalamus/process-runner.test.ts
git commit -m "feat(process-runner): runOpenCodeSessionTurn (resumable conscious session)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Provisioning — global provider config + project-local agent file

**Files:**
- Modify: `packages/core/src/cybernetics/opencode-config.ts`
- Modify: `packages/core/src/cybernetics/opencode-config.test.ts`

**Interfaces:**
- Consumes: `Docker` service (`../services/Docker.js`), Node `fs` (`node:fs`), the Task 1 generators, `ModelHandle`.
- Produces:
  - `provisionConsciousProvider(containerId: string, handle: ModelHandle): Effect.Effect<void, DockerError, Docker>` — writes `GLOBAL_OPENCODE_CONFIG_PATH` inside the container (idempotent; base64-piped to avoid shell-quoting issues).
  - `writeCharacterAgentFile(opts: { playersDir: string; playerName: string; systemPrompt: string; modelLabel?: string }): void` — writes `<playersDir>/<playerName>/.opencode/agent/conscious.md` on the host (the bind-mounted dir), then `chmod`s it read-only. Re-writable on re-run.

> **Call site:** both functions are invoked by Phase 4b's session setup (provider once per container; agent file per character). Phase 4a only implements and tests them.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/cybernetics/opencode-config.test.ts`:

```typescript
import { Effect, Layer } from "effect"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { provisionConsciousProvider, writeCharacterAgentFile, GLOBAL_OPENCODE_CONFIG_PATH } from "./opencode-config.js"
import { Docker, type DockerError } from "../services/Docker.js"

describe("provisionConsciousProvider", () => {
  it("execs a command that writes the provider config to the global path", async () => {
    const calls: string[][] = []
    const StubDocker = Layer.succeed(
      Docker,
      Docker.of({
        exec: (_id, command) => {
          calls.push(command)
          return Effect.succeed("")
        },
      } as unknown as typeof Docker.Service),
    )

    await Effect.runPromise(
      Effect.provide(provisionConsciousProvider("cabc", DEFAULT_CORTEX_MODELS.conscious), StubDocker),
    )

    const joined = calls.flat().join(" ")
    expect(joined).toContain(GLOBAL_OPENCODE_CONFIG_PATH)
    // base64 of the generated config is present in the exec command
    const b64 = Buffer.from(buildProviderConfigJson(DEFAULT_CORTEX_MODELS.conscious)).toString("base64")
    expect(joined).toContain(b64)
  })
})

describe("writeCharacterAgentFile", () => {
  it("writes the agent markdown read-only into the character's .opencode dir", () => {
    const playersDir = mkdtempSync(path.join(tmpdir(), "roci-players-"))
    writeCharacterAgentFile({ playersDir, playerName: "ada", systemPrompt: "You are Ada." })
    const file = path.join(playersDir, "ada", ".opencode", "agent", "conscious.md")
    expect(readFileSync(file, "utf8")).toContain("You are Ada.")
    expect(statSync(file).mode & 0o222).toBe(0) // no write bits
  })
  it("is re-runnable even though the previous file is read-only", () => {
    const playersDir = mkdtempSync(path.join(tmpdir(), "roci-players-"))
    writeCharacterAgentFile({ playersDir, playerName: "ada", systemPrompt: "v1" })
    writeCharacterAgentFile({ playersDir, playerName: "ada", systemPrompt: "v2" })
    const file = path.join(playersDir, "ada", ".opencode", "agent", "conscious.md")
    expect(readFileSync(file, "utf8")).toContain("v2")
  })
})
```

(Add `buildProviderConfigJson` to the existing import from `./opencode-config.js` if not already imported.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @roci/core test opencode-config`
Expected: FAIL — `provisionConsciousProvider` / `writeCharacterAgentFile` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/core/src/cybernetics/opencode-config.ts`:

```typescript
import { Effect } from "effect"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { Docker } from "../services/Docker.js"

/**
 * Write the global OpenCode provider config inside the container. Base64-pipes the
 * JSON to sidestep shell quoting. Idempotent — safe to run before each session.
 */
export function provisionConsciousProvider(containerId: string, handle: ModelHandle) {
  const json = buildProviderConfigJson(handle)
  const b64 = Buffer.from(json).toString("base64")
  const dir = path.posix.dirname(GLOBAL_OPENCODE_CONFIG_PATH)
  const script = `mkdir -p ${dir} && echo ${b64} | base64 -d > ${GLOBAL_OPENCODE_CONFIG_PATH}`
  return Effect.gen(function* () {
    const docker = yield* Docker
    yield* docker.exec(containerId, ["bash", "-lc", script])
  })
}

/**
 * Write the per-character conscious agent file into the bind-mounted players dir
 * (host-side), then chmod it read-only so a confused tool turn cannot corrupt it.
 */
export function writeCharacterAgentFile(opts: {
  playersDir: string
  playerName: string
  systemPrompt: string
  modelLabel?: string
}): void {
  const dir = path.join(opts.playersDir, opts.playerName, ".opencode", "agent")
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${CONSCIOUS_AGENT_NAME}.md`)
  if (existsSync(file)) chmodSync(file, 0o644) // restore write to allow re-write
  writeFileSync(file, buildCharacterAgentMarkdown({ systemPrompt: opts.systemPrompt, modelLabel: opts.modelLabel }))
  chmodSync(file, 0o444)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @roci/core test opencode-config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cybernetics/opencode-config.ts packages/core/src/cybernetics/opencode-config.test.ts
git commit -m "feat(cybernetics): provision OpenCode provider (global) + agent file (project-local)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Conscious-session smoke test (gated, real container)

**Files:**
- Create: `packages/core/src/cybernetics/opencode-session.smoke.test.ts`

**Interfaces:**
- Consumes: `runOpenCodeSessionTurn` (Task 4), `provisionConsciousProvider` + `writeCharacterAgentFile` + `CONSCIOUS_AGENT_NAME` + `CONSCIOUS_MODEL_LABEL` (Tasks 1/5), `Docker`, `CharacterLogLive`, `OAuthTokenLive`, `ProjectRoot`, `DEFAULT_CORTEX_MODELS`. Mirrors the gating style of `delegate.smoke.test.ts`.

> Gated by `ROCI_OPENCODE_SESSION_CONTAINER` (and a reachable host `llama-server` on the conscious port). Skipped in normal runs, so the suite's skip count rises by one.

- [ ] **Step 1: Write the test (it is the deliverable; gated-skip means it "passes" by skipping in CI)**

Create `packages/core/src/cybernetics/opencode-session.smoke.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { NodeContext, NodeFileSystem } from "@effect/platform-node"
import { runOpenCodeSessionTurn } from "../core/limbic/hypothalamus/process-runner.js"
import { provisionConsciousProvider, writeCharacterAgentFile, CONSCIOUS_AGENT_NAME, CONSCIOUS_MODEL_LABEL } from "./opencode-config.js"
import { DockerLive } from "../services/Docker.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import { CharacterLogLive } from "../logging/log-writer.js"
import { OAuthTokenLive } from "../services/OAuthToken.js"
import { ProjectRoot } from "../services/ProjectRoot.js"
import type { TurnConfig } from "../core/limbic/hypothalamus/types.js"

// Prereqs: a host llama-server on the conscious port, and a roci container:
//   ROCI_OPENCODE_SESSION_CONTAINER=<id> ROCI_OPENCODE_SESSION_PLAYER=<name> \
//   pnpm --filter @roci/core test opencode-session.smoke
const containerId = process.env.ROCI_OPENCODE_SESSION_CONTAINER
const playerName = process.env.ROCI_OPENCODE_SESSION_PLAYER ?? "test-pilot"

describe.skipIf(!containerId)("OpenCode conscious session (real container)", () => {
  it("opens a session, then a resume turn recalls turn-1 context", async () => {
    const projectRootLayer = Layer.succeed(ProjectRoot, process.cwd())
    const characterLogLayer = CharacterLogLive.pipe(Layer.provide(Layer.mergeAll(projectRootLayer, NodeFileSystem.layer)))
    const oauthTokenLayer = OAuthTokenLive.pipe(Layer.provide(Layer.mergeAll(projectRootLayer, characterLogLayer)))
    const deps = Layer.mergeAll(NodeContext.layer, DockerLive, characterLogLayer, oauthTokenLayer)

    // Provision provider (global) + agent (project-local under <cwd>/players/<name>).
    writeCharacterAgentFile({
      playersDir: `${process.cwd()}/players`,
      playerName,
      systemPrompt: "You are a terse test agent. Answer in one short sentence.",
    })

    const char = { name: playerName, dir: `/work/players/${playerName}/me` }
    const base: TurnConfig = {
      containerId: containerId as string,
      playerName,
      char,
      systemPrompt: "",
      model: CONSCIOUS_MODEL_LABEL,
      agentName: CONSCIOUS_AGENT_NAME,
      prompt: "Remember this codeword: BANANA. Acknowledge.",
      timeoutMs: 120_000,
      role: "body",
    }

    const program = Effect.gen(function* () {
      yield* provisionConsciousProvider(containerId as string, DEFAULT_CORTEX_MODELS.conscious)
      const first = yield* runOpenCodeSessionTurn(base)
      const second = yield* runOpenCodeSessionTurn(
        { ...base, prompt: "What was the codeword I gave you?" },
        { sessionId: first.sessionId },
      )
      return { first, second }
    })

    const { first, second } = await Effect.runPromise(Effect.provide(program, deps))
    expect(first.sessionId).toMatch(/^ses_/)
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.result.output.toUpperCase()).toContain("BANANA")
  }, 300_000)
})
```

> If the real `Docker` layer export is named differently than `DockerLive`, use the project's actual export (grep `export const Docker` in `services/Docker.ts`); the rest of the test is unchanged.

- [ ] **Step 2: Run the suite to confirm it skips cleanly**

Run: `pnpm --filter @roci/core test opencode-session.smoke`
Expected: the describe block is SKIPPED (no `ROCI_OPENCODE_SESSION_CONTAINER` set); no failures.

- [ ] **Step 3: (Optional, when hardware available) run it for real**

Start a host `llama-server` on the conscious port and a roci container, then:
Run: `ROCI_OPENCODE_SESSION_CONTAINER=<id> pnpm --filter @roci/core test opencode-session.smoke`
Expected: PASS — `second.result.output` contains "BANANA", same session id across turns.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/cybernetics/opencode-session.smoke.test.ts
git commit -m "test(cybernetics): gated smoke for resumable OpenCode conscious session

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Document the conscious-session smoke in cortex-smoke.md

**Files:**
- Modify: `docs/cortex-smoke.md`

- [ ] **Step 1: Add a section** documenting how to run the Task 6 smoke. Append after the existing cybernetics/steering smoke section:

````markdown
## Step N: Conscious-Session Transport (Phase 4a)

Exercises the resumable OpenCode conscious session against the local conscious model.

**Prereqs:** a host `llama-server` (or MLX server) on the conscious port (8083), and a running roci container (see "Start a Domain Container").

```bash
# Provider config is provisioned into the container by the test; the agent file
# is written under ./players/<name>/.opencode/agent/conscious.md (read-only).
ROCI_OPENCODE_SESSION_CONTAINER=$(docker ps --filter label=roci-crew=true -q | head -1) \
ROCI_OPENCODE_SESSION_PLAYER=test-pilot \
  pnpm --filter @roci/core test opencode-session.smoke
```

**Expected:** the test opens a session (turn 1), resumes it by id (turn 2), and turn 2's output contains the turn-1 codeword — proving session continuity over re-invoke-per-turn. Without the env var the test skips.

**Notes:**
- A new session's first turn fires an extra internal "title" model call (≈2 model calls on turn 1, 1 per turn after).
- On non-Docker-Desktop Linux the container needs `--add-host=host.docker.internal:host-gateway` to reach the host model server.
````

(Replace `Step N` with the next sequential step number in the doc.)

- [ ] **Step 2: Verify the doc renders / links are consistent**

Run: `git diff docs/cortex-smoke.md`
Expected: a single new section, consistent heading numbering.

- [ ] **Step 3: Commit (docs-only, skip the build hook)**

```bash
git add docs/cortex-smoke.md
git commit --no-verify -m "docs(cortex-smoke): conscious-session transport smoke steps

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** (spec §-by-§ → task):
- §3 provider global / agent project-local → Tasks 1 (generators) + 5 (provisioning).
- §3 config-protection chmod → Task 5 (`writeCharacterAgentFile` chmods 0o444).
- §3 loopback → host.docker.internal rewrite → Task 1 (`hostInternalBaseUrl`).
- §4.1 provider config from the conscious handle → Tasks 1 + 5.
- §4.2 agent file = system prompt, closes the `payload.ts:84` opencode TBD → Tasks 1 + 5 (the session path supplies the system prompt via the agent, not `--system-prompt`).
- §4.3 `runOpenCodeSessionTurn`, `-s` only, resume omits `--agent`/`-m`, session-id capture → Tasks 2 + 3 + 4.
- §4.4 standalone runner, `delegate` untouched → Task 4 (new function; no edits to `delegate.ts`).
- §6 error handling (turn failure, missing session id) → Tasks 2/4 (ClaudeError on missing id; transport exit/timeout race reused).
- §7 testing (host-side units + container smoke) → Tasks 1–6.
- §8 operational notes (title call, host.docker.internal on Linux) → Task 7 docs.
- §9 scope boundary — no loop wiring, no `delegate` changes → respected (no task touches `loop.ts` or `delegate.ts`).

**2. Placeholder scan:** No "TBD/TODO/handle edge cases" — every code step shows complete code; the only `Step N` is an explicit instruction to substitute the next doc heading number.

**3. Type consistency:** `TurnResult.sessionId?` (Task 2) is consumed by `runOpenCodeSessionTurn` (Task 4); `TransportInput.captureFromRaw` (Task 2) ↔ `firstSessionId` (Task 4); `TurnConfig.agentName?` (Task 3) ↔ `buildOpenCodeSessionCommand` (Task 3) ↔ smoke `base` config (Task 6); `CONSCIOUS_MODEL_LABEL`/`CONSCIOUS_AGENT_NAME` (Task 1) used consistently in Tasks 3/6. `buildProviderConfigJson`/`buildCharacterAgentMarkdown` (Task 1) consumed by Task 5 provisioning. Return shape `{ result, sessionId }` (Task 4) consumed by Task 6 smoke.

**One open item for the implementer** (from spec §10, non-blocking): the typed "session not found on resume" error is left as a follow-up — Task 4 fails generically via `ClaudeError`; distinguishing stale-session from other failures (string-match on OpenCode error output) is a 4b recovery-policy concern, intentionally out of 4a scope.
