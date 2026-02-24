import { Effect } from "effect"

/**
 * A composable AI function: gather context → build prompt → invoke LLM → parse output.
 *
 * This is a lightweight abstraction — just a named Effect-returning function.
 */
export interface AiFunction<Input, Output, R, E> {
  readonly name: string
  readonly execute: (input: Input) => Effect.Effect<Output, E, R>
}
