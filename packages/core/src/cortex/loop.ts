import { Effect, Queue, Option, Fiber } from "effect"
import { CommandExecutor } from "@effect/platform"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterFs } from "../services/CharacterFs.js"
import { CharacterLog, logToConsole } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { EventProcessorTag } from "../core/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../core/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../core/limbic/amygdala/interrupt.js"
import { StateRendererTag } from "../core/state-renderer.js"
import { PromptBuilderTag } from "../core/prompt-builder.js"
import { Cybernetics } from "../cybernetics/delegate.js"
import type { DelegationResult } from "../cybernetics/types.js"
import { ModelClient } from "../model/client.js"
import type { ModelError } from "../model/errors.js"
import { DEFAULT_CORTEX_MODELS, type CortexModelConfig } from "../model/handles.js"
import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "../core/model-config.js"
import type { Cadence } from "../skills/cadence.js"
import type { Alert, PlanStep } from "../core/types.js"
import {
  runHindbrain,
  runForebrain,
  runConsciousDecide,
  runConsciousEvaluate,
  type CortexRunnerConfig,
} from "./tiers.js"
import {
  freshCortexState,
  shouldForceOrient,
  planSteps,
  formatStepTask,
  formatExecutionReport,
} from "./state.js"

export interface CortexLoopConfig {
  char: CharacterConfig
  containerId: string
  containerEnv?: Record<string, string>
  addDirs?: string[]
  events: Queue.Queue<unknown>
  initialState: unknown
  cadence?: Cadence
  cortexModels?: CortexModelConfig
  workerModels?: ModelConfig
  orientInterval?: number
  workerTimeoutMs?: number
  tickIntervalMs?: number
}

export type CortexResult =
  | { readonly _tag: "Completed"; readonly finalState: unknown }
  | { readonly _tag: "Interrupted"; readonly finalState: unknown; readonly criticals: Alert[] }

const DEFAULT_TICK_MS = 30_000
const DEFAULT_ORIENT_INTERVAL = 5
const DEFAULT_WORKER_TIMEOUT_MS = 60 * 60 * 1000

const AVAILABLE_ACTIONS =
  "Each plan step is delegated to a Claude Code worker that does real work (shell, git, gh, file edits, game CLI). Plan concrete steps; each step.task names the action and step.goal describes the outcome."

export const runCortex = (config: CortexLoopConfig) =>
  Effect.gen(function* () {
    const eventProcessor = yield* EventProcessorTag
    const classifier = yield* SituationClassifierTag
    const interrupts = yield* InterruptRegistryTag
    const renderer = yield* StateRendererTag
    const promptBuilder = yield* PromptBuilderTag
    const cybernetics = yield* Cybernetics
    const charFs = yield* CharacterFs

    const cadence: Cadence = config.cadence ?? "planned-action"
    const orientInterval = config.orientInterval ?? DEFAULT_ORIENT_INTERVAL
    const tickMs = config.tickIntervalMs ?? DEFAULT_TICK_MS
    const workerTimeoutMs = config.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS
    const workerModels = config.workerModels ?? DEFAULT_MODEL_CONFIG
    const runnerConfig: CortexRunnerConfig = {
      char: config.char,
      cadence,
      models: config.cortexModels ?? DEFAULT_CORTEX_MODELS,
    }

    let state = config.initialState
    const cortex = freshCortexState()
    let tick = 0
    let stepStartTick = 0
    let stepStartSnapshot = renderer.richSnapshot(state as never)
    // Orient headline of the in-progress plan — reused as context for every step.
    let planHeadline = ""
    // Fiber running the current delegation, or null.
    let delegationFiber: Fiber.RuntimeFiber<DelegationResult, never> | null = null

    // Fork the current step (steps[currentStepIndex]) of the in-progress plan as a
    // cybernetic delegation. Shared by the first step (step 0, just after decide)
    // and every subsequent step advanced into by an evaluate → next_step transition,
    // so every step is forked through one identical code path.
    const forkStep = (step: PlanStep) =>
      Effect.gen(function* () {
        const systemPrompt = promptBuilder.systemPrompt("select", "")
        stepStartTick = tick
        stepStartSnapshot = renderer.richSnapshot(state as never)
        yield* logToConsole(config.char.name, "orchestrator", `delegating: ${step.task}`)
        return yield* Effect.fork(
          cybernetics.delegate({
            containerId: config.containerId,
            playerName: config.char.name,
            char: config.char,
            task: formatStepTask(step, planHeadline),
            systemPrompt,
            model: workerModels.tiers[step.tier],
            timeoutMs: workerTimeoutMs,
            addDirs: config.addDirs,
            env: config.containerEnv,
          }),
        )
      })

    while (true) {
      tick++

      // 1. Drain world events into state.
      const tickEvents: string[] = []
      let draining = true
      while (draining) {
        const maybe = yield* Queue.poll(config.events)
        if (Option.isNone(maybe)) {
          draining = false
        } else {
          const event = maybe.value
          yield* Effect.try(() => {
            const r = eventProcessor.processEvent(event as never, state as never)
            if (r.stateUpdate) state = r.stateUpdate(state as never)
            if (r.log) r.log()
          }).pipe(Effect.catchAll((e) => logToConsole(config.char.name, "error", `event error: ${e}`)))
          tickEvents.push(
            typeof event === "object" && event !== null
              ? `type: ${(event as Record<string, unknown>).type ?? "unknown"}\n${JSON.stringify(event)}`
              : String(event),
          )
        }
      }

      // 2. Classify + critical interrupts (the amygdala cuts the line).
      const summary = classifier.summarize(state as never)
      renderer.logStateBar(config.char.name, summary.metrics)
      const criticals = interrupts.criticals(state as never, summary.situation)
      if (criticals.length > 0) {
        yield* logToConsole(
          config.char.name,
          "orchestrator",
          `Critical: ${criticals.map((a) => a.message).join("; ")}`,
        )
        if (delegationFiber) yield* Fiber.interrupt(delegationFiber)
        return { _tag: "Interrupted" as const, finalState: state, criticals }
      }

      // 3. If a delegation is in flight, check whether it finished.
      if (delegationFiber) {
        const done = yield* Fiber.poll(delegationFiber).pipe(Effect.map(Option.isSome))
        if (done) {
          const result = yield* Fiber.join(delegationFiber)
          delegationFiber = null
          // EVALUATE the step outcome.
          const after = renderer.richSnapshot(state as never)
          const stepIdx = cortex.currentStepIndex
          const steps = planSteps(cortex.currentPlan)
          const step = steps[stepIdx]
          if (step) {
            const evalResult = yield* runConsciousEvaluate(runnerConfig, {
              task: step.task,
              goal: step.goal,
              successCondition: step.successCondition,
              ticksBudgeted: step.timeoutTicks,
              ticksConsumed: tick - stepStartTick,
              executionReport: formatExecutionReport(result.output),
              stateDiff: renderer.stateDiff(stepStartSnapshot, after),
              conditionCheck: `worker status: ${result.status}`,
              emotionalState: cortex.emotionalWeight,
              remainingSteps:
                steps
                  .slice(stepIdx + 1)
                  .map((s) => `${s.task}: ${s.goal}`)
                  .join("\n") || "None.",
            })
            yield* logToConsole(
              config.char.name,
              "cortex",
              `evaluate: ${evalResult.judgment} → ${evalResult.transition.transition}`,
            )
            if (evalResult.diaryEntry) {
              const diary = yield* charFs
                .readDiary(config.char)
                .pipe(Effect.catchAll(() => Effect.succeed("")))
              yield* charFs
                .writeDiary(
                  config.char,
                  diary ? `${diary}\n\n${evalResult.diaryEntry}` : evalResult.diaryEntry,
                )
                .pipe(
                  Effect.catchAll((e) =>
                    logToConsole(config.char.name, "error", `diary write failed: ${e}`),
                  ),
                )
            }
            const t = evalResult.transition
            if (t.transition === "terminate") return { _tag: "Completed" as const, finalState: state }
            if (t.transition === "wait") {
              cortex.waitState = t.wait
              cortex.currentPlan = null
            } else if (t.transition === "replan") {
              cortex.currentPlan = null
              cortex.lastOrientTick = 0
            } else {
              // next_step
              cortex.currentStepIndex++
              if (cortex.currentStepIndex >= steps.length) cortex.currentPlan = null
            }
          }
        }
        // While a delegation runs, fall through to keep triaging the world, then sleep.
      }

      // 4. HINDBRAIN triage (only when idle of a running plan and there are events).
      let escalate = tick === 1
      if (!delegationFiber && tickEvents.length > 0) {
        const observe = yield* runHindbrain(runnerConfig, tickEvents, cortex.waitState)
        yield* logToConsole(
          config.char.name,
          "cortex",
          `hindbrain: ${observe.disposition} ${observe.emotionalWeight}`,
        )
        cortex.emotionalWeight = observe.emotionalWeight
        if (observe.disposition !== "discard") cortex.accumulatedEvents.push(...tickEvents)
        if (observe.disposition === "escalate") escalate = true
      }
      if (!delegationFiber && !escalate && shouldForceOrient(cortex, tick, orientInterval))
        escalate = true

      // 5. FOREBRAIN + CONSCIOUS(decide) — only when no plan is executing.
      if (escalate && !delegationFiber && cortex.currentPlan === null) {
        const background = yield* charFs
          .readBackground(config.char)
          .pipe(Effect.catchAll(() => Effect.succeed("")))
        const values = yield* charFs
          .readValues(config.char)
          .pipe(Effect.catchAll(() => Effect.succeed("")))
        const diary = yield* charFs
          .readDiary(config.char)
          .pipe(Effect.catchAll(() => Effect.succeed("")))
        const orient = yield* runForebrain(
          runnerConfig,
          cortex.accumulatedEvents,
          JSON.stringify(summary, null, 2),
          { background, values, diary },
          cortex.emotionalWeight,
        )
        yield* logToConsole(config.char.name, "cortex", `forebrain: ${orient.headline}`)
        const decide = yield* runConsciousDecide(runnerConfig, orient, "No active plan.", AVAILABLE_ACTIONS)
        yield* logToConsole(config.char.name, "cortex", `conscious: ${decide.decision}`)
        cortex.accumulatedEvents = []
        cortex.lastOrientTick = tick

        if (decide.decision === "terminate") return { _tag: "Completed" as const, finalState: state }
        if (decide.decision === "wait") {
          cortex.waitState = decide.wait
          if (decide.wait.disposition === "terminate")
            return { _tag: "Completed" as const, finalState: state }
        } else if (decide.decision === "plan" && decide.steps.length > 0) {
          cortex.currentPlan = decide
          cortex.currentStepIndex = 0
          planHeadline = orient.headline
        }
      }

      // 6. Fork the current step whenever a plan has a remaining, not-yet-running
      // step. Reached for step 0 (just after decide) and for every later step the
      // evaluate → next_step transition advanced into, so all steps fork identically.
      if (!delegationFiber && cortex.currentPlan !== null) {
        const steps = planSteps(cortex.currentPlan)
        const step = steps[cortex.currentStepIndex]
        if (step) delegationFiber = yield* forkStep(step)
      }

      // 7. Sleep one tick.
      yield* Effect.sleep(`${tickMs} millis`)
    }
  }) as Effect.Effect<
    CortexResult,
    ModelError,
    | EventProcessorTag
    | SituationClassifierTag
    | InterruptRegistryTag
    | StateRendererTag
    | PromptBuilderTag
    | CharacterFs
    | CharacterLog
    | ModelClient
    | Cybernetics
    | CommandExecutor.CommandExecutor
    | OAuthToken
  >
