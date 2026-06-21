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

/** Bounded retry/backoff/timeout policy for transient transport failures. */
export interface RetryPolicy {
  /** Total attempts (initial + retries). `1` disables retry. */
  maxAttempts: number
  /** Base backoff before retry #1; doubles each subsequent retry. */
  baseDelayMs: number
  /** Per-call deadline; a request still in flight past this aborts and becomes a retryable failure. */
  timeoutMs: number
}

/**
 * Defaults tuned for slow, cold local model servers (cold forebrain ~130s, an
 * uncontended cold probe >240s). The timeout must clear a genuinely cold call,
 * so it is generous; retry exists for transient blips (socket hangup, fetch
 * failed), not to paper over a permanently-down server — hence only 3 attempts.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  timeoutMs: 300_000,
}

export interface ModelClientDeps {
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Injectable backoff sleep; defaults to a real timer. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>
  /** Retry/backoff/timeout policy; defaults to {@link DEFAULT_RETRY_POLICY}. */
  retry?: RetryPolicy
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

function err(
  handle: ModelHandle,
  reason: string,
  opts: { cause?: unknown; retryable?: boolean } = {},
): ModelError {
  return new ModelError({
    tier: handle.tier,
    model: handle.model,
    baseUrl: handle.baseUrl,
    reason,
    cause: opts.cause,
    retryable: opts.retryable,
  })
}

/** HTTP statuses worth retrying: server errors and explicit rate limiting. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One transport attempt: forms the request, applies a per-call abort timeout,
 * and classifies any failure as retryable (network/timeout/5xx/429) or genuine
 * (malformed/invalid-JSON/4xx). Genuine failures are never retried.
 */
/** A genuine (non-retryable) failure raised mid-attempt, tunnelled through the
 *  transport promise so the single per-attempt timer still covers the body read. */
class GenuineFailure extends Error {
  constructor(readonly reason: string, readonly httpStatus?: number) {
    super(reason)
  }
}

const attempt = (
  deps: Required<Pick<ModelClientDeps, "fetchImpl">> & { timeoutMs: number },
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

    // The per-call timeout spans the WHOLE attempt — request AND body read — so a
    // server that sends status then stalls the body is also aborted (a retryable
    // failure), not just a connection that never opens.
    const result = yield* Effect.tryPromise({
      try: async (): Promise<CompletionResult> => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), deps.timeoutMs)
        try {
          const response = await deps.fetchImpl(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(handle.apiKey ? { Authorization: `Bearer ${handle.apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          })

          if (!response.ok) {
            const text = await response.text().catch(() => "")
            throw new GenuineFailure(`HTTP ${response.status}: ${text.slice(0, 200)}`, response.status)
          }

          let json: OpenAIChatResponse
          try {
            json = (await response.json()) as OpenAIChatResponse
          } catch (cause) {
            // A timeout abort during the body read must stay transient; only a
            // real parse error of a fully-received body is a genuine failure.
            if (controller.signal.aborted) throw cause
            throw new GenuineFailure("invalid JSON response")
          }

          const content = json?.choices?.[0]?.message?.content
          if (typeof content !== "string") {
            throw new GenuineFailure("malformed response: missing choices[0].message.content")
          }

          return {
            text: content,
            usage: {
              promptTokens: json.usage?.prompt_tokens,
              completionTokens: json.usage?.completion_tokens,
            },
            raw: json,
          }
        } finally {
          clearTimeout(timer)
        }
      },
      catch: (cause) => {
        // A deliberate genuine failure: classify by HTTP status (5xx/429 retry).
        if (cause instanceof GenuineFailure) {
          return err(handle, cause.reason, {
            retryable: cause.httpStatus !== undefined && isRetryableStatus(cause.httpStatus),
          })
        }
        // A network error, socket hangup, or timeout abort: all transient.
        return err(handle, `request failed (endpoint unreachable?): ${String(cause)}`, {
          cause,
          retryable: true,
        })
      },
    })

    return result
  })

/**
 * Build a ModelClient with injectable transport, sleep, and retry policy.
 * Bounded exponential backoff retries ONLY transient failures (`retryable`);
 * genuine ModelErrors surface immediately. After exhausting attempts the last
 * (transient) error is surfaced unchanged.
 */
export function makeModelClient(deps: ModelClientDeps = {}): { complete: ModelClient["Type"]["complete"] } {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const base = deps.retry ?? DEFAULT_RETRY_POLICY
  // Always make at least one attempt — a 0/negative config must not silently skip the call.
  const policy: RetryPolicy = { ...base, maxAttempts: Math.max(1, base.maxAttempts) }

  const complete = (
    handle: ModelHandle,
    messages: ChatMessage[],
  ): Effect.Effect<CompletionResult, ModelError> =>
    Effect.gen(function* () {
      let lastError: ModelError | null = null
      for (let i = 0; i < policy.maxAttempts; i++) {
        const result = yield* attempt(
          { fetchImpl, timeoutMs: policy.timeoutMs },
          handle,
          messages,
        ).pipe(Effect.either)
        if (result._tag === "Right") return result.right
        lastError = result.left
        // Genuine (non-retryable) errors fail fast; transient errors retry until
        // attempts are exhausted.
        if (!result.left.retryable || i === policy.maxAttempts - 1) {
          return yield* Effect.fail(result.left)
        }
        yield* Effect.promise(() => sleep(policy.baseDelayMs * 2 ** i))
      }
      // Unreachable: the loop always returns or fails. Guard for the type-checker.
      return yield* Effect.fail(lastError ?? err(handle, "retry loop exited without result"))
    })

  return { complete }
}

export const ModelClientLive = Layer.succeed(ModelClient, ModelClient.of(makeModelClient()))
