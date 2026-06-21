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

/**
 * Shape of the subset of an OpenAI chat-completions response we read.
 *
 * Reasoning models surface their chain-of-thought separately from the final
 * answer. Depending on the server (MLX, vLLM, llama.cpp) that text lands in
 * `message.reasoning` or `message.reasoning_content`. When a reasoning model
 * spends its whole token budget thinking, `content` can come back empty/missing
 * while the usable text is in one of those fields — so we model them too.
 */
interface OpenAIChatResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }
  }>
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

/**
 * Return the first candidate that is a non-empty (post-trim) string, or
 * `undefined` if none qualify. Used to fall back from `content` to a reasoning
 * field without treating empty-string `content` as a usable answer.
 */
function firstNonEmpty(...candidates: Array<string | null | undefined>): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c
  }
  return undefined
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

    // A reasoning model may exhaust its budget on chain-of-thought and return
    // empty `content`, leaving the usable answer in `reasoning` /
    // `reasoning_content`. Prefer non-empty `content`, then fall back to those
    // fields so a reasoning model does not hard-fatal the loop. Only when no
    // tier yields usable text do we surface a ModelError.
    const message = json?.choices?.[0]?.message
    const text = firstNonEmpty(message?.content, message?.reasoning, message?.reasoning_content)
    if (text === undefined) {
      return yield* Effect.fail(
        err(
          handle,
          "malformed response: missing choices[0].message.content (and reasoning/reasoning_content empty)",
        ),
      )
    }

    return {
      text,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
      },
      raw: json,
    }
  })

export const ModelClientLive = Layer.succeed(ModelClient, ModelClient.of({ complete }))
