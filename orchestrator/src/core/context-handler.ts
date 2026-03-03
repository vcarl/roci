import { Context, Effect } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"

export interface ProcessedContext {
  chatMessages?: Array<{ channel: string; sender: string; content: string }>
}

/**
 * Processes accumulated context from domain events into a normalized form.
 * Handles domain-specific context keys (e.g. chat messages, combat updates)
 * and performs logging side effects.
 */
export interface ContextHandler {
  processContext(
    context: Record<string, unknown>,
    char: CharacterConfig,
  ): Effect.Effect<ProcessedContext, never, CharacterLog>
}

/**
 * Effect service tag for the context handler.
 */
export class ContextHandlerTag extends Context.Tag("ContextHandler")<
  ContextHandlerTag,
  ContextHandler
>() {}
