# Model Provider Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `model/` seam — a config-driven, OpenAI-compatible client the cortex calls to get a completion from whichever local (or remote) model backs a given tier.

**Architecture:** Cortex tiers (hindbrain/forebrain/conscious) hold only a tier name. A `CortexModelConfig` maps each tier to a `ModelHandle` (`{provider, baseUrl, model, params}`). A `ModelClient` Effect service performs an OpenAI-style `/chat/completions` call against the handle's `baseUrl`. Local MLX/llama-server and remote OpenRouter differ only by `baseUrl` + `apiKey`. Missing/unreachable models fail fast with a descriptive typed `ModelError` — there is no automatic failover.

**Tech Stack:** TypeScript (ESM, strict), Effect (`Context.Tag` / `Layer`), Node 20 global `fetch`, vitest. Package: `@roci/core`.

**Scope note:** This is Plan 1 of 4 from `docs/superpowers/specs/2026-06-18-cortex-cybernetics-design.md`. It is purely additive — it creates `packages/core/src/model/` and touches nothing existing except a one-line `index.ts` export. It does **not** delete `runtime.ts` or `model-config.ts` (those stay until Plan 4). Execution order of the sequence: **Plan 1** model seam (this) → **Plan 2** cybernetics delegation → **Plan 3** cortex tiers + ladder (consumes the seam and Cybernetics) → **Plan 4** domain integration + deletion.

## Global Constraints

- ESM with explicit `.js` import extensions on relative imports (e.g. `import { X } from "./handles.js"`).
- Tests use vitest (`import { describe, it, expect } from "vitest"`), colocated as `*.test.ts` next to source.
- Errors are plain classes with a `readonly _tag` string discriminator (match `ClaudeError` in `services/Claude.ts`) — Effect's typed error channel, not `throw`.
- No new runtime dependencies — use Node's global `fetch`.
- Pre-commit runs `nx run-many -t build` (tsc). Every commit must typecheck clean.
- Cortex tiers are exactly: `"hindbrain" | "forebrain" | "conscious"` (distinct from the legacy `fast|smart|reasoning` tiers in `model-config.ts`, which are untouched here).
- OpenAI-compatible request: `POST {baseUrl}/chat/completions`, body `{model, messages, temperature, max_tokens?, stream:false, ...extraBody}`, optional `Authorization: Bearer {apiKey}`. Response content at `choices[0].message.content`.

---

### Task 1: Cortex model config + handle resolution

**Files:**
- Create: `packages/core/src/model/handles.ts`
- Test: `packages/core/src/model/handles.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type CortexTier = "hindbrain" | "forebrain" | "conscious"`
  - `type ModelProvider = "mlx" | "llamacpp" | "openai-compatible"`
  - `interface ModelParams { temperature?: number; maxTokens?: number; extraBody?: Record<string, unknown> }`
  - `interface ModelHandle { tier: CortexTier; provider: ModelProvider; baseUrl: string; model: string; apiKey?: string; params?: ModelParams }`
  - `type CortexModelConfig = Record<CortexTier, ModelHandle>`
  - `interface CortexModelOverlay { hindbrain?: Partial<ModelHandle>; forebrain?: Partial<ModelHandle>; conscious?: Partial<ModelHandle> }`
  - `const DEFAULT_CORTEX_MODELS: CortexModelConfig`
  - `function resolveHandle(config: CortexModelConfig, tier: CortexTier): ModelHandle`
  - `function mergeCortexModels(base: CortexModelConfig, overlay: CortexModelOverlay | undefined): CortexModelConfig`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/model/handles.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import {
  DEFAULT_CORTEX_MODELS,
  resolveHandle,
  mergeCortexModels,
  type CortexModelConfig,
} from "./handles.js"

const base: CortexModelConfig = {
  hindbrain: { tier: "hindbrain", provider: "mlx", baseUrl: "http://127.0.0.1:8081/v1", model: "hind" },
  forebrain: { tier: "forebrain", provider: "mlx", baseUrl: "http://127.0.0.1:8082/v1", model: "fore" },
  conscious: { tier: "conscious", provider: "mlx", baseUrl: "http://127.0.0.1:8083/v1", model: "consc" },
}

describe("resolveHandle", () => {
  it("returns the handle for the requested tier", () => {
    expect(resolveHandle(base, "forebrain").model).toBe("fore")
    expect(resolveHandle(base, "conscious").baseUrl).toBe("http://127.0.0.1:8083/v1")
  })
})

describe("DEFAULT_CORTEX_MODELS", () => {
  it("defines all three tiers with localhost endpoints", () => {
    for (const tier of ["hindbrain", "forebrain", "conscious"] as const) {
      const h = DEFAULT_CORTEX_MODELS[tier]
      expect(h.tier).toBe(tier)
      expect(h.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
      expect(h.model.length).toBeGreaterThan(0)
    }
  })
})

describe("mergeCortexModels", () => {
  it("returns base unchanged when no overlay", () => {
    expect(mergeCortexModels(base, undefined)).toEqual(base)
  })

  it("overlays a single field on one tier without touching others", () => {
    const merged = mergeCortexModels(base, { conscious: { model: "gpt-oss-120b" } })
    expect(merged.conscious.model).toBe("gpt-oss-120b")
    expect(merged.conscious.baseUrl).toBe("http://127.0.0.1:8083/v1") // preserved
    expect(merged.hindbrain).toEqual(base.hindbrain) // untouched
  })

  it("can repoint a tier at a remote provider", () => {
    const merged = mergeCortexModels(base, {
      conscious: { provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4", apiKey: "sk-x" },
    })
    expect(merged.conscious.provider).toBe("openai-compatible")
    expect(merged.conscious.apiKey).toBe("sk-x")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/model/handles.test.ts`
Expected: FAIL — cannot find module `./handles.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/model/handles.ts`:

```typescript
/** Cortex cognition tiers. Distinct from the legacy fast/smart/reasoning tiers. */
export type CortexTier = "hindbrain" | "forebrain" | "conscious"

/**
 * Serving provider for a model. All three are reached over the same
 * OpenAI-compatible HTTP API; the value is metadata for logging/serving and
 * does not change how ModelClient forms the request.
 */
export type ModelProvider = "mlx" | "llamacpp" | "openai-compatible"

export interface ModelParams {
  temperature?: number
  maxTokens?: number
  /**
   * Extra OpenAI-compatible body fields merged verbatim into the request
   * (e.g. `response_format`, or llama.cpp's `grammar`/`json_schema`).
   * Used by Plan 2 for grammar-constrained decoding.
   */
  extraBody?: Record<string, unknown>
}

export interface ModelHandle {
  tier: CortexTier
  provider: ModelProvider
  /** OpenAI-compatible base URL including the version path, e.g. "http://127.0.0.1:8081/v1". */
  baseUrl: string
  model: string
  apiKey?: string
  params?: ModelParams
}

export type CortexModelConfig = Record<CortexTier, ModelHandle>

/** Partial overlay applied per tier (from a config file or CLI flags). */
export interface CortexModelOverlay {
  hindbrain?: Partial<ModelHandle>
  forebrain?: Partial<ModelHandle>
  conscious?: Partial<ModelHandle>
}

/**
 * Default local config for Apple Silicon (M5 / 128GB). Model names are
 * starting points to be tuned empirically by the testbench
 * (~/workspace/testbench/llms); ports assume one server process per resident
 * tier. The serving topology (which ports, on-demand loading) is configured
 * externally, not by this module.
 */
export const DEFAULT_CORTEX_MODELS: CortexModelConfig = {
  hindbrain: {
    tier: "hindbrain",
    provider: "mlx",
    baseUrl: "http://127.0.0.1:8081/v1",
    model: "mlx-community/Qwen3.5-9B-4bit",
    params: { temperature: 0.3 },
  },
  forebrain: {
    tier: "forebrain",
    provider: "mlx",
    baseUrl: "http://127.0.0.1:8082/v1",
    model: "mlx-community/GLM-4.7-Flash-4bit",
    params: { temperature: 0.5 },
  },
  conscious: {
    tier: "conscious",
    provider: "mlx",
    baseUrl: "http://127.0.0.1:8083/v1",
    model: "mlx-community/Qwen3.5-122B-A10B-4bit",
    params: { temperature: 0.7 },
  },
}

/** Look up the handle backing a cortex tier. */
export function resolveHandle(config: CortexModelConfig, tier: CortexTier): ModelHandle {
  return config[tier]
}

/** Merge a per-tier overlay onto a base config. Each tier is shallow-merged. */
export function mergeCortexModels(
  base: CortexModelConfig,
  overlay: CortexModelOverlay | undefined,
): CortexModelConfig {
  if (!overlay) return base
  const tiers: CortexTier[] = ["hindbrain", "forebrain", "conscious"]
  const out = {} as CortexModelConfig
  for (const tier of tiers) {
    out[tier] = overlay[tier] ? { ...base[tier], ...overlay[tier] } : base[tier]
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/model/handles.test.ts`
Expected: PASS (3 describe blocks, 5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add packages/core/src/model/handles.ts packages/core/src/model/handles.test.ts
git commit -m "feat(model): cortex model handles + tier config resolution"
```

---

### Task 2: ModelClient + ModelError (contract-tested against a mock OpenAI server)

**Files:**
- Create: `packages/core/src/model/errors.ts`
- Create: `packages/core/src/model/client.ts`
- Test: `packages/core/src/model/client.test.ts`
- Modify: `packages/core/src/index.ts` (add exports)

**Interfaces:**
- Consumes: `ModelHandle` from `./handles.js` (Task 1).
- Produces:
  - `class ModelError` — `{ _tag: "ModelError"; tier; model; baseUrl; reason; cause? }`, with a descriptive `message` getter.
  - `interface ChatMessage { role: "system" | "user" | "assistant"; content: string }`
  - `interface CompletionResult { text: string; usage?: { promptTokens?: number; completionTokens?: number }; raw: unknown }`
  - `class ModelClient` (Effect `Context.Tag`) with `complete(handle: ModelHandle, messages: ChatMessage[]): Effect.Effect<CompletionResult, ModelError>`
  - `const ModelClientLive: Layer.Layer<ModelClient>`

- [ ] **Step 1: Write the ModelError + the failing client test**

Create `packages/core/src/model/errors.ts`:

```typescript
import type { CortexTier } from "./handles.js"

export interface ModelErrorFields {
  tier: CortexTier
  model: string
  baseUrl: string
  reason: string
  cause?: unknown
}

/**
 * A model call failed. Fail-fast and descriptive: a missing/unreachable local
 * model is a config/ops error, surfaced loudly — there is no automatic failover.
 */
export class ModelError {
  readonly _tag = "ModelError"
  readonly tier: CortexTier
  readonly model: string
  readonly baseUrl: string
  readonly reason: string
  readonly cause?: unknown

  constructor(fields: ModelErrorFields) {
    this.tier = fields.tier
    this.model = fields.model
    this.baseUrl = fields.baseUrl
    this.reason = fields.reason
    this.cause = fields.cause
  }

  get message(): string {
    return `Model call failed [tier=${this.tier} model=${this.model} endpoint=${this.baseUrl}]: ${this.reason}`
  }

  toString(): string {
    return this.message
  }
}
```

Create `packages/core/src/model/client.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createServer, type Server } from "node:http"
import { Effect, Either } from "effect"
import { ModelClient, ModelClientLive } from "./client.js"
import { ModelError } from "./errors.js"
import type { ModelHandle } from "./handles.js"

// A mock OpenAI-compatible server whose behavior is switched per-test.
let server: Server
let port: number
let mode: "ok" | "500" | "garbage" = "ok"

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end("not found")
      return
    }
    if (mode === "500") {
      res.writeHead(500, { "Content-Type": "text/plain" }).end("model not loaded")
      return
    }
    if (mode === "garbage") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"unexpected":true}')
      return
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function handle(p: number): ModelHandle {
  return { tier: "hindbrain", provider: "openai-compatible", baseUrl: `http://127.0.0.1:${p}/v1`, model: "test" }
}

const run = <A, E>(eff: Effect.Effect<A, E, ModelClient>) =>
  Effect.runPromise(Effect.provide(eff, ModelClientLive))

describe("ModelClient.complete", () => {
  it("returns the assistant content on a 200 response", async () => {
    mode = "ok"
    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle(port), [{ role: "user", content: "ping" }])
      }),
    )
    expect(result.text).toBe("pong")
    expect(result.usage?.completionTokens).toBe(1)
  })

  it("fails with ModelError on a non-2xx response", async () => {
    mode = "500"
    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle(port), [{ role: "user", content: "ping" }])
      }).pipe(Effect.either),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ModelError)
      expect(result.left.reason).toContain("500")
      expect(result.left.message).toContain("endpoint=")
    }
  })

  it("fails with ModelError when the response has no choices content", async () => {
    mode = "garbage"
    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        return yield* client.complete(handle(port), [{ role: "user", content: "ping" }])
      }).pipe(Effect.either),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left.reason).toMatch(/malformed/i)
  })

  it("fails with ModelError when the endpoint is unreachable", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* ModelClient
        // Port 1 is never listening.
        return yield* client.complete(handle(1), [{ role: "user", content: "ping" }])
      }).pipe(Effect.either),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left.reason).toMatch(/request failed|unreachable/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/model/client.test.ts`
Expected: FAIL — cannot find module `./client.js`.

- [ ] **Step 3: Write the ModelClient implementation**

Create `packages/core/src/model/client.ts`:

```typescript
import { Context, Effect, Layer } from "effect"
import type { ModelHandle } from "./handles.js"
import { ModelError } from "./errors.js"

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface CompletionResult {
  text: string
  usage?: { promptTokens?: number; completionTokens?: number }
  raw: unknown
}

/** Shape of the subset of an OpenAI chat-completions response we read. */
interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export class ModelClient extends Context.Tag("ModelClient")<
  ModelClient,
  {
    readonly complete: (
      handle: ModelHandle,
      messages: ChatMessage[],
    ) => Effect.Effect<CompletionResult, ModelError>
  }
>() {}

function err(handle: ModelHandle, reason: string, cause?: unknown): ModelError {
  return new ModelError({ tier: handle.tier, model: handle.model, baseUrl: handle.baseUrl, reason, cause })
}

const complete = (
  handle: ModelHandle,
  messages: ChatMessage[],
): Effect.Effect<CompletionResult, ModelError> =>
  Effect.gen(function* () {
    const url = `${handle.baseUrl.replace(/\/+$/, "")}/chat/completions`
    const body = {
      model: handle.model,
      messages,
      temperature: handle.params?.temperature ?? 0.7,
      ...(handle.params?.maxTokens ? { max_tokens: handle.params.maxTokens } : {}),
      stream: false,
      ...(handle.params?.extraBody ?? {}),
    }

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(handle.apiKey ? { Authorization: `Bearer ${handle.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
        }),
      catch: (cause) => err(handle, `request failed (endpoint unreachable?): ${String(cause)}`, cause),
    })

    if (!response.ok) {
      const text = yield* Effect.promise(() => response.text().catch(() => ""))
      return yield* Effect.fail(err(handle, `HTTP ${response.status}: ${text.slice(0, 200)}`))
    }

    const json = yield* Effect.tryPromise({
      try: () => response.json() as Promise<OpenAIChatResponse>,
      catch: (cause) => err(handle, `invalid JSON response: ${String(cause)}`, cause),
    })

    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== "string") {
      return yield* Effect.fail(err(handle, "malformed response: missing choices[0].message.content"))
    }

    return {
      text: content,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
      },
      raw: json,
    }
  })

export const ModelClientLive = Layer.succeed(ModelClient, ModelClient.of({ complete }))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/model/client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Export the module from the package index**

Add to `packages/core/src/index.ts` (append near other exports; verify exact existing style first with `grep "export" packages/core/src/index.ts | head`):

```typescript
export * from "./model/handles.js"
export * from "./model/errors.js"
export * from "./model/client.js"
```

- [ ] **Step 6: Typecheck the whole build**

Run: `cd /Users/vcarl/workspace/roci && npx nx run @roci/core:build --skip-nx-cache`
Expected: build succeeds. If `fetch` is flagged as undefined, confirm `@types/node` (v20+) is installed in `packages/core` — it provides the global `fetch` type; no `lib` change should be needed.

- [ ] **Step 7: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add packages/core/src/model/ packages/core/src/index.ts
git commit -m "feat(model): ModelClient OpenAI-compatible seam + fail-fast ModelError"
```

---

### Task 3: Real-endpoint smoke test (guarded integration)

**Files:**
- Create: `packages/core/src/model/client.smoke.test.ts`

This gives a way to verify the seam against a *real* local MLX/llama-server, without putting a GPU dependency in the unit suite. It is skipped unless `ROCI_MODEL_SMOKE_URL` is set.

**Interfaces:**
- Consumes: `ModelClient`, `ModelClientLive` (Task 2); `ModelHandle` (Task 1).
- Produces: nothing (test-only).

- [ ] **Step 1: Write the guarded smoke test**

Create `packages/core/src/model/client.smoke.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { ModelClient, ModelClientLive } from "./client.js"
import type { ModelHandle } from "./handles.js"

// Point at a running OpenAI-compatible server, e.g.:
//   ROCI_MODEL_SMOKE_URL=http://127.0.0.1:8081/v1 \
//   ROCI_MODEL_SMOKE_MODEL=mlx-community/Qwen3.5-9B-4bit \
//   npx vitest run packages/core/src/model/client.smoke.test.ts
const url = process.env.ROCI_MODEL_SMOKE_URL
const model = process.env.ROCI_MODEL_SMOKE_MODEL ?? "local"

describe.skipIf(!url)("ModelClient against a real local endpoint", () => {
  it("returns a non-empty completion", async () => {
    const handle: ModelHandle = {
      tier: "hindbrain",
      provider: "openai-compatible",
      baseUrl: url as string,
      model,
      params: { maxTokens: 32, temperature: 0 },
    }
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const client = yield* ModelClient
          return yield* client.complete(handle, [
            { role: "user", content: "Reply with the single word: pong" },
          ])
        }),
        ModelClientLive,
      ),
    )
    expect(result.text.length).toBeGreaterThan(0)
  }, 60_000)
})
```

- [ ] **Step 2: Verify it skips cleanly with no endpoint**

Run: `cd /Users/vcarl/workspace/roci && npx vitest run packages/core/src/model/client.smoke.test.ts`
Expected: the suite is skipped (0 failures, the describe block reported as skipped).

- [ ] **Step 3: Commit**

```bash
cd /Users/vcarl/workspace/roci
git add packages/core/src/model/client.smoke.test.ts
git commit -m "test(model): guarded real-endpoint smoke for ModelClient"
```

---

## Self-Review

**Spec coverage (against §4b, §6, §7 of the design spec):**
- ✅ §4b ModelClient/ModelHandle seam, provider ∈ {mlx, llamacpp, openai-compatible}, local↔remote by baseUrl+apiKey — Tasks 1 & 2.
- ✅ §6 fail-fast `ModelError` naming tier/model/endpoint, no auto-failover — Task 2 (`ModelError`, the 500/unreachable tests).
- ✅ §7 provider-parity contract test against a mock OpenAI-compatible server — Task 2; real-endpoint verification — Task 3.
- ✅ §4b "extraBody" forward-hook for grammar-constrained decoding (consumed by Plan 2) — Task 1 `ModelParams.extraBody`, threaded in Task 2 request body.
- Out of scope by design (later plans): cortex tiers/ladder (Plan 2), cybernetics delegation (Plan 3), deleting `runtime.ts`/`model-config.ts` (Plan 4).

**Placeholder scan:** No TBD/TODO/"handle errors appropriately". Every code step shows complete code; every run step shows the exact command and expected result.

**Type consistency:** `CortexTier`, `ModelHandle`, `ModelParams.extraBody`, `ModelError` fields, `ChatMessage`, `CompletionResult`, and `ModelClient.complete`'s signature are used identically across Tasks 1–3 and the test files. `ModelError.tier` is typed `CortexTier` and every handle in tests sets `tier: "hindbrain"`. `ModelClientLive` is `Layer.succeed` (no dependencies), matching `Effect.provide(eff, ModelClientLive)` usage in tests.
