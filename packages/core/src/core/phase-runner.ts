import { Effect } from "effect"
import type { PhaseContext, PhaseRegistry } from "./phase.js"
import { logToConsole } from "../logging/log-writer.js"

/**
 * Run phases in sequence according to the given registry.
 * Starts with the initial phase and follows Continue/Restart/Shutdown transitions.
 * The R type parameter captures all service requirements from the phases.
 */
export const runPhases = <S, Evt, R>(
  initialContext: PhaseContext<S, Evt>,
  registry: PhaseRegistry<S, Evt, R>,
): Effect.Effect<void, unknown, R> =>
  Effect.gen(function* () {
    let currentPhaseName = registry.initialPhase
    let context = initialContext

    while (true) {
      const phase = registry.getPhase(currentPhaseName)
      if (!phase) {
        yield* logToConsole(
          context.char.name,
          "orchestrator",
          `Unknown phase "${currentPhaseName}" — shutting down`,
        )
        return
      }

      yield* logToConsole(context.char.name, "orchestrator", `Entering phase: ${phase.name}`)

      const result = yield* phase.run(context)

      switch (result._tag) {
        case "Continue": {
          yield* logToConsole(
            context.char.name,
            "orchestrator",
            `Phase "${phase.name}" complete → next: "${result.next}"`,
          )
          // Thread connection and data forward (merge phaseData, don't replace)
          context = {
            ...context,
            connection: result.connection ?? context.connection,
            phaseData: result.data
              ? { ...context.phaseData, ...result.data }
              : context.phaseData,
          }
          currentPhaseName = result.next
          break
        }
        case "Restart": {
          yield* logToConsole(
            context.char.name,
            "orchestrator",
            `Phase "${phase.name}" requested restart → "${registry.initialPhase}"`,
          )
          currentPhaseName = registry.initialPhase
          context = { ...context, connection: undefined, phaseData: undefined }
          break
        }
        case "Shutdown": {
          yield* logToConsole(context.char.name, "orchestrator", `Phase "${phase.name}" requested shutdown`)
          return
        }
      }
    }
  }) as Effect.Effect<void, unknown, R>
