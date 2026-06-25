import { Effect } from "effect"
import { ModelClient, type ChatMessage } from "../../model/client.js"
import { ModelService } from "../../services/ModelService.js"
import {
  resolveHandle,
  DEFAULT_CORTEX_MODELS,
  type CortexModelConfig,
} from "../../model/handles.js"
import type { ModelError } from "../../model/errors.js"
import type { SpawnError, ReadinessError } from "../../services/model-backend.js"

/** A generation step returned empty content from the model — fail hard, do not
 *  silently fall back to a template. */
export class EmptyGenerationError {
  readonly _tag = "EmptyGenerationError"
  constructor(readonly step: string) {}
  get message(): string {
    return `Identity generation returned empty content for step: ${this.step}`
  }
  toString(): string {
    return this.message
  }
}

/**
 * Generate one identity artifact by calling the conscious cortex tier directly
 * over HTTP (the `callTier` pattern), gated by ModelService.withTier so the
 * resident server is ready. Uses the same conscious handle as the running loop.
 */
export const generateArtifact = (
  step: string,
  prompt: string,
  cortexModels: CortexModelConfig = DEFAULT_CORTEX_MODELS,
): Effect.Effect<
  string,
  ModelError | SpawnError | ReadinessError | EmptyGenerationError,
  ModelClient | ModelService
> =>
  Effect.gen(function* () {
    const svc = yield* ModelService
    const client = yield* ModelClient
    const handle = resolveHandle(cortexModels, "conscious")
    const messages: ChatMessage[] = [{ role: "user", content: prompt }]
    const res = yield* svc.withTier("conscious")(client.complete(handle, messages))
    const text = res.text.trim()
    if (!text) return yield* Effect.fail(new EmptyGenerationError(step))
    return text
  })
