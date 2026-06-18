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
