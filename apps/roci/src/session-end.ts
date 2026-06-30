import { Cause, Effect, Exit } from "effect"
import { CharacterLog, logSessionEnd } from "@roci/core/logging/log-writer.js"
import { consumeShutdownSignal } from "@roci/core/logging/behavior-digest.js"

/**
 * Map a character loop's Effect Exit to a session_end reason. An interrupt
 * (SIGINT/SIGTERM propagated through runMain) is a "signal" stop; any other
 * failure is an "error"; a clean completion is "clean".
 */
export function sessionEndReasonForExit(
  exit: Exit.Exit<unknown, unknown>,
): { reason: "clean" | "signal" | "error"; signal?: string } {
  if (Exit.isSuccess(exit)) return { reason: "clean" }
  if (Cause.isInterruptedOnly(exit.cause)) {
    const signal = consumeShutdownSignal()
    return signal ? { reason: "signal", signal } : { reason: "signal" }
  }
  return { reason: "error" }
}

/**
 * Wrap a character loop so its terminal session_end is emitted on every exit
 * path (clean / signal / error). Idempotent via logSessionEnd's guard. The
 * onExit runs against the RAW loop exit, so place this INSIDE any catchAll that
 * would otherwise convert a failure to success.
 */
export const withSessionEnd = <A, E, R>(
  character: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | CharacterLog> =>
  effect.pipe(
    Effect.onExit((exit) => {
      const { reason, signal } = sessionEndReasonForExit(exit as Exit.Exit<unknown, unknown>)
      return logSessionEnd(character, reason, signal)
    }),
  )
