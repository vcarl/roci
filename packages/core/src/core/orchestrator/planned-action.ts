import { Effect, Queue, Option } from "effect"
import type { CharacterConfig } from "../../services/CharacterFs.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { CommandExecutor } from "@effect/platform"
import { EventProcessorTag } from "../limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../limbic/amygdala/interrupt.js"
import type { PlannedActionTempo } from "../limbic/hypothalamus/tempo.js"
import { dream } from "../limbic/hippocampus/dream.js"
import type { Alert } from "../types.js"
import { logToConsole } from "../../logging/console-renderer.js"
import type { ModelConfig } from "../model-config.js"

// ── Types ────────────────────────────────────────────────────

export interface BreakConfig {
  char: CharacterConfig
  events: Queue.Queue<unknown>
  initialState: unknown
  tempo: PlannedActionTempo
}

export type BreakResult =
  | { readonly _tag: "Completed"; readonly finalState: unknown }
  | { readonly _tag: "Interrupted"; readonly finalState: unknown; readonly criticals: Alert[] }

// ── runReflection ────────────────────────────────────────────

export const runReflection = (
  char: CharacterConfig,
  dreamThreshold: number,
  containerId: string,
  models: ModelConfig,
  addDirs?: string[],
  env?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const charFs = yield* CharacterFs
    const diary = yield* charFs.readDiary(char)
    const diaryLines = diary.split("\n").length

    if (diaryLines > dreamThreshold) {
      yield* logToConsole(char.name, "orchestrator", `Diary is ${diaryLines} lines — dreaming...`)
      yield* dream.execute({ char, containerId, playerName: char.name, addDirs, env, models }).pipe(
        Effect.catchAll((e) =>
          logToConsole(char.name, "error", `Dream failed: ${e}`),
        ),
      )
    }
  })

// ── runBreak ─────────────────────────────────────────────────

export const runBreak = (config: BreakConfig) =>
  Effect.gen(function* () {
    const eventProcessor = yield* EventProcessorTag
    const classifier = yield* SituationClassifierTag
    const interruptRegistry = yield* InterruptRegistryTag

    yield* logToConsole(
      config.char.name,
      "orchestrator",
      `Break phase — resting for ${config.tempo.breakDurationMs / 60_000} minutes (monitoring for critical interrupts)`,
    )

    const startTime = Date.now()
    let currentState = config.initialState

    while (Date.now() - startTime < config.tempo.breakDurationMs) {
      // Drain all pending events without blocking
      let drained = false
      while (!drained) {
        const maybeEvent = yield* Queue.poll(config.events)
        if (Option.isNone(maybeEvent)) {
          drained = true
        } else {
          const event = maybeEvent.value
          const result = yield* Effect.try(() =>
            eventProcessor.processEvent(event, currentState)
          ).pipe(
            Effect.catchAll((e) =>
              logToConsole(config.char.name, "error", `Event processing error during break: ${e}`).pipe(
                Effect.map(() => ({ category: undefined, stateUpdate: undefined, log: undefined })),
              ),
            ),
          )

          if (result.stateUpdate) {
            currentState = result.stateUpdate(currentState)
          }

          if (result.log) {
            result.log()
          }

          // Only check for critical interrupts on state changes
          if (result.category?._tag === "StateChange") {
            const summary = classifier.summarize(currentState)
            const criticals = interruptRegistry.criticals(currentState, summary.situation)

            if (criticals.length > 0) {
              yield* logToConsole(
                config.char.name,
                "orchestrator",
                `Critical interrupt during break: ${criticals.map(a => a.message).join("; ")} — waking up`,
              )
              return {
                _tag: "Interrupted" as const,
                finalState: currentState,
                criticals,
              }
            }
          }
        }
      }

      yield* Effect.sleep(`${config.tempo.breakPollIntervalSec} seconds`)
    }

    const elapsedMin = Math.round((Date.now() - startTime) / 60_000)
    yield* logToConsole(config.char.name, "orchestrator", `Break complete (${elapsedMin} min) — proceeding to reflection`)

    return {
      _tag: "Completed" as const,
      finalState: currentState,
    }
  })
