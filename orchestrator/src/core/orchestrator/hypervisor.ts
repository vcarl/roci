import { Effect, Queue, Option } from "effect"
import type { CharacterConfig } from "../../services/CharacterFs.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { CharacterLog } from "../../logging/log-writer.js"
import { Claude, type ClaudeModel } from "../../services/Claude.js"
import { CommandExecutor } from "@effect/platform"
import { EventProcessorTag } from "../limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../limbic/amygdala/interrupt.js"
import { PromptBuilderTag } from "../prompt-builder.js"
import { StateRendererTag } from "../state-renderer.js"
import type { HypervisorTempo } from "../limbic/hypothalamus/tempo.js"
import { runCycle } from "../limbic/hypothalamus/cycle-runner.js"
import { dream } from "../limbic/hippocampus/dream.js"
import type { Alert } from "../types.js"
import { logToConsole } from "../../logging/console-renderer.js"

// ── Types ────────────────────────────────────────────────────

export interface HypervisorConfig {
  char: CharacterConfig
  containerId: string
  containerEnv?: Record<string, string>
  events: Queue.Queue<unknown>
  initialState: unknown
  tempo: HypervisorTempo
  brainSystemPrompt: string
  bodySystemPrompt: string
  brainModel: ClaudeModel
  bodyModel: ClaudeModel
  brainTimeoutMs: number
  bodyTimeoutMs: number
  brainDisallowedTools?: string[]
}

export type HypervisorResult =
  | { readonly _tag: "Completed"; readonly finalState: unknown; readonly cyclesRun: number }
  | { readonly _tag: "Interrupted"; readonly finalState: unknown; readonly cyclesRun: number; readonly criticals: Alert[] }

export interface BreakConfig {
  char: CharacterConfig
  events: Queue.Queue<unknown>
  initialState: unknown
  tempo: HypervisorTempo
}

export type BreakResult =
  | { readonly _tag: "Completed"; readonly finalState: unknown }
  | { readonly _tag: "Interrupted"; readonly finalState: unknown; readonly criticals: Alert[] }

// ── runReflection ────────────────────────────────────────────

export const runReflection = (
  char: CharacterConfig,
  dreamThreshold: number,
) =>
  Effect.gen(function* () {
    const charFs = yield* CharacterFs
    const diary = yield* charFs.readDiary(char)
    const diaryLines = diary.split("\n").length

    if (diaryLines > dreamThreshold) {
      yield* logToConsole(char.name, "orchestrator", `Diary is ${diaryLines} lines — dreaming...`)
      yield* dream.execute({ char }).pipe(
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
                Effect.map(() => ({ category: undefined, stateUpdate: undefined })),
              ),
            ),
          )

          if (result.stateUpdate) {
            currentState = result.stateUpdate(currentState)
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

// ── runHypervisor ────────────────────────────────────────────

export const runHypervisor = (config: HypervisorConfig) =>
  Effect.gen(function* () {
    const eventProcessor = yield* EventProcessorTag
    const classifier = yield* SituationClassifierTag
    const interruptRegistry = yield* InterruptRegistryTag
    const promptBuilder = yield* PromptBuilderTag
    const renderer = yield* StateRendererTag
    const charFs = yield* CharacterFs
    const log = yield* CharacterLog

    let currentState = config.initialState
    let prevSnapshot = renderer.richSnapshot(currentState)
    const softAlertAcc = new Map<string, Alert>()

    for (let cycle = 0; cycle < config.tempo.maxCycles; cycle++) {
      // 1. Drain event queue
      let drained = false
      while (!drained) {
        const maybeEvent = yield* Queue.poll(config.events)
        if (Option.isNone(maybeEvent)) {
          drained = true
        } else {
          const event = maybeEvent.value
          yield* Effect.try(() => {
            const result = eventProcessor.processEvent(event, currentState)
            if (result.stateUpdate) {
              currentState = result.stateUpdate(currentState)
            }
            if (result.log) {
              result.log()
            }
          }).pipe(
            Effect.catchAll((e) =>
              logToConsole(config.char.name, "error", `Event processing error: ${e}`),
            ),
          )
        }
      }

      // 2. Classify
      const summary = classifier.summarize(currentState)

      // 3. Log state bar
      renderer.logStateBar(config.char.name, summary.metrics)

      // 4. State diff
      const currentSnapshot = renderer.richSnapshot(currentState)
      const stateDiff = renderer.stateDiff(prevSnapshot, currentSnapshot)

      // 5. Evaluate interrupts
      const allAlerts = interruptRegistry.evaluate(currentState, summary.situation)
      const criticals = allAlerts.filter(a => a.priority === "critical")

      if (criticals.length > 0) {
        yield* logToConsole(
          config.char.name,
          "orchestrator",
          `Critical interrupt: ${criticals.map(a => a.message).join("; ")}`,
        )
        return {
          _tag: "Interrupted" as const,
          finalState: currentState,
          cyclesRun: cycle,
          criticals,
        }
      }

      const softAlerts = allAlerts.filter(a => a.priority !== "critical")
      for (const alert of softAlerts) {
        softAlertAcc.set(alert.ruleName ?? alert.message, alert)
      }

      // 6. Read identity
      const background = yield* charFs.readBackground(config.char).pipe(
        Effect.catchAll(() => Effect.succeed("")),
      )
      const values = yield* charFs.readValues(config.char).pipe(
        Effect.catchAll(() => Effect.succeed("")),
      )
      const diary = yield* charFs.readDiary(config.char)

      // 7. Build prompt
      const currentSoftAlerts = Array.from(softAlertAcc.values())
      const brainPromptString = promptBuilder.brainPrompt({
        summary,
        diary,
        background,
        values,
        cycleNumber: cycle + 1,
        maxCycles: config.tempo.maxCycles,
        softAlerts: currentSoftAlerts,
        stateDiff: cycle > 0 ? stateDiff : undefined,
      })

      // Clear soft alert accumulator after building prompt
      softAlertAcc.clear()

      yield* logToConsole(config.char.name, "orchestrator", `Cycle ${cycle + 1}/${config.tempo.maxCycles}`)

      // 8. Run cycle
      const cycleResult = yield* runCycle({
        containerId: config.containerId,
        playerName: config.char.name,
        brainSystemPrompt: config.brainSystemPrompt,
        bodySystemPrompt: config.bodySystemPrompt,
        brainModel: config.brainModel,
        bodyModel: config.bodyModel,
        brainTimeoutMs: config.brainTimeoutMs,
        bodyTimeoutMs: config.bodyTimeoutMs,
        env: config.containerEnv,
        char: config.char,
        buildBrainPrompt: () => brainPromptString,
        brainDisallowedTools: config.brainDisallowedTools,
      })

      // 9. Log cycle completion
      yield* logToConsole(
        config.char.name,
        "orchestrator",
        `Cycle ${cycle + 1} complete — brain: ${Math.round(cycleResult.brainResult.durationMs / 1000)}s, body: ${Math.round(cycleResult.bodyResult.durationMs / 1000)}s`,
      )

      // 10. Update prevSnapshot
      prevSnapshot = renderer.richSnapshot(currentState)
    }

    return {
      _tag: "Completed" as const,
      finalState: currentState,
      cyclesRun: config.tempo.maxCycles,
    }
  })
