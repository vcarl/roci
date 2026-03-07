import { Effect, Ref, Fiber } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterFs } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import {
  logPlanTransition,
  logStepResult,
  logToConsole,
  formatError,
} from "../logging/console-renderer.js"
import type { SkillRegistry } from "./skill.js"
import type { SituationClassifier } from "./situation.js"
import type { StateRenderer } from "./state-renderer.js"
import type { DomainState, DomainSituation } from "./domain-types.js"
import type { BrainMode, Plan, StepCompletionResult } from "./types.js"
import type { LifecycleHooks } from "./lifecycle.js"
import type { TimingRefs } from "./step-tracker.js"
import { recordStepTiming, recordStepOutcome } from "./step-tracker.js"
import { brainEvaluate } from "./brain.js"
import { runGenericSubagent } from "./subagent.js"
import { PromptBuilderTag } from "./prompt-builder.js"

export interface SubagentRefs {
  readonly fiber: Ref.Ref<Fiber.RuntimeFiber<string, unknown> | null>
  readonly report: Ref.Ref<string>
  readonly spawnState: Ref.Ref<Record<string, unknown> | null>
}

export interface PlanRefs {
  readonly plan: Ref.Ref<Plan | null>
  readonly step: Ref.Ref<number>
  readonly previousFailure: Ref.Ref<string | null>
}

/** Interrupt and null the current subagent fiber if one exists. */
export const killSubagent = (fiberRef: Ref.Ref<Fiber.RuntimeFiber<string, unknown> | null>) =>
  Effect.gen(function* () {
    const fiber = yield* Ref.get(fiberRef)
    if (fiber) {
      yield* Fiber.interrupt(fiber).pipe(Effect.catchAll(() => Effect.void))
      yield* Ref.set(fiberRef, null)
    }
  })

interface EvaluateServices {
  readonly renderer: StateRenderer
  readonly classifier: SituationClassifier
  readonly skills: SkillRegistry
  readonly hooks?: LifecycleHooks
  readonly tickIntervalSec: number
  readonly char: CharacterConfig
  readonly modeRef?: Ref.Ref<BrainMode>
  readonly investigationReportRef?: Ref.Ref<string | null>
}

/** Check if a completed subagent's step succeeded. Advance or replan. */
export const evaluateCompletedSubagent = (
  subagentRefs: SubagentRefs,
  planRefs: PlanRefs,
  timingRefs: TimingRefs,
  services: EvaluateServices,
  state: DomainState,
) =>
  Effect.gen(function* () {
    const log = yield* CharacterLog
    const plan = yield* Ref.get(planRefs.plan)
    const step = yield* Ref.get(planRefs.step)

    if (plan && step < plan.steps.length) {
      const currentStep = plan.steps[step]
      const timing = yield* recordStepTiming(timingRefs, currentStep.task, currentStep.goal, currentStep.timeoutTicks)
      const report = yield* Ref.get(subagentRefs.report)

      // Build state diff from spawn-time snapshot
      const stateBefore = yield* Ref.get(subagentRefs.spawnState)
      const stateAfter = services.renderer.richSnapshot(state)
      const diffStr = services.renderer.stateDiff(stateBefore, stateAfter)

      // Run deterministic condition check
      const situation = services.classifier.classify(state)
      const conditionCheck = services.skills.isStepComplete(currentStep, state, situation)

      // Short-circuit: if deterministic check passes with a recognized condition, skip LLM
      if (conditionCheck.complete && conditionCheck.matchedCondition) {
        yield* recordStepOutcome(timingRefs.stepTimingHistory, true, conditionCheck.reason, diffStr)
        yield* logStepResult(services.char.name, step, conditionCheck)
        yield* log.action(services.char, {
          timestamp: new Date().toISOString(),
          source: "monitor",
          character: services.char.name,
          type: "step_complete",
          stepIndex: step,
          task: currentStep.task,
          goal: currentStep.goal,
          successCondition: currentStep.successCondition,
          successConditionMet: true,
          reason: `[deterministic] ${conditionCheck.reason}`,
          stateSnapshot: conditionCheck.relevantState,
          stateDiff: diffStr,
          subagentReport: report.slice(-500),
        })

        if (services.hooks?.afterStep) {
          yield* services.hooks.afterStep(step, conditionCheck)
        }

        yield* Ref.set(planRefs.step, step + 1)
      } else {
        const mode = services.modeRef ? yield* Ref.get(services.modeRef) : ("select" as BrainMode)

        const result: StepCompletionResult = yield* brainEvaluate.execute({
          step: currentStep,
          subagentReport: report,
          state,
          stateBefore,
          stateDiff: diffStr,
          conditionCheck,
          ticksConsumed: timing.ticksConsumed,
          ticksBudgeted: timing.ticksBudgeted,
          tickIntervalSec: services.tickIntervalSec,
          mode,
        }).pipe(
          Effect.catchTag("ClaudeError", (e) =>
            Effect.succeed({
              complete: true as const,
              reason: `Brain evaluation failed (${e.message}), trusting subagent completion`,
              matchedCondition: null,
              relevantState: services.renderer.snapshot(state),
            }),
          ),
        )

        yield* recordStepOutcome(timingRefs.stepTimingHistory, result.complete, result.reason, diffStr)
        yield* logStepResult(services.char.name, step, result)

        yield* log.action(services.char, {
          timestamp: new Date().toISOString(),
          source: "monitor",
          character: services.char.name,
          type: "step_complete",
          stepIndex: step,
          task: currentStep.task,
          goal: currentStep.goal,
          successCondition: currentStep.successCondition,
          successConditionMet: result.complete,
          reason: result.reason,
          stateSnapshot: result.relevantState,
          subagentReport: report.slice(-500),
        })

        const finalResult = services.hooks?.afterStep
          ? yield* services.hooks.afterStep(step, result)
          : result

        if (finalResult.complete) {
          yield* Ref.set(planRefs.step, step + 1)
        } else {
          const failureContext = `Step ${step + 1} [${currentStep.task}] "${currentStep.goal}" failed: ${finalResult.reason}\nSubagent report: ${report.slice(-300) || "(no report)"}`
          yield* Ref.set(planRefs.previousFailure, failureContext)
          yield* Ref.set(planRefs.plan, null)
          yield* Ref.set(planRefs.step, 0)
        }
      }

      // Capture investigation report when an investigate task completes in select mode
      if (services.investigationReportRef && currentStep.task === "investigate") {
        const currentMode = services.modeRef ? yield* Ref.get(services.modeRef) : "select"
        if (currentMode === "select") {
          yield* Ref.set(services.investigationReportRef, report)
        }
      }
    }

    yield* Ref.set(subagentRefs.fiber, null)
    yield* Ref.set(subagentRefs.report, "")
    yield* Ref.set(subagentRefs.spawnState, null)
  })

interface CheckMidRunServices {
  readonly skills: SkillRegistry
}

/** Check mid-run step completion and timeouts. */
export const checkMidRun = (
  subagentRefs: SubagentRefs,
  planRefs: PlanRefs,
  timingRefs: TimingRefs,
  services: CheckMidRunServices,
  state: DomainState,
  situation: DomainSituation,
) =>
  Effect.gen(function* () {
    const currentFiber = yield* Ref.get(subagentRefs.fiber)
    if (!currentFiber) return

    const plan = yield* Ref.get(planRefs.plan)
    const step = yield* Ref.get(planRefs.step)
    const startTick = yield* Ref.get(timingRefs.stepStartTick)
    const tickCount = yield* Ref.get(timingRefs.tickCount)

    if (plan && step < plan.steps.length) {
      const currentStep = plan.steps[step]

      const midRunResult = services.skills.isStepComplete(currentStep, state, situation)
      if (midRunResult.complete) {
        yield* recordStepTiming(timingRefs, currentStep.task, currentStep.goal, currentStep.timeoutTicks)
        yield* Fiber.interrupt(currentFiber).pipe(Effect.catchAll(() => Effect.void))
        yield* Ref.set(subagentRefs.fiber, null)
        yield* Ref.set(planRefs.step, step + 1)
      } else if (tickCount - startTick >= currentStep.timeoutTicks) {
        yield* recordStepTiming(timingRefs, currentStep.task, currentStep.goal, currentStep.timeoutTicks)
        yield* Fiber.interrupt(currentFiber).pipe(Effect.catchAll(() => Effect.void))
        yield* Ref.set(subagentRefs.fiber, null)
        yield* Ref.set(planRefs.step, step + 1)
      }
    }
  })

interface SpawnSubagentConfig {
  readonly char: CharacterConfig
  readonly containerId: string
  readonly playerName: string
  readonly containerEnv?: Record<string, string>
  readonly tickIntervalSec: number
  readonly modeRef?: Ref.Ref<BrainMode>
}

interface SpawnSubagentServices {
  readonly renderer: StateRenderer
  readonly hooks?: LifecycleHooks
}

/** Spawn a subagent for the current plan step if needed. */
export const maybeSpawnSubagent = (
  subagentRefs: SubagentRefs,
  planRefs: PlanRefs,
  timingRefs: TimingRefs,
  smConfig: SpawnSubagentConfig,
  services: SpawnSubagentServices,
  state: DomainState,
  situation: DomainSituation,
) =>
  Effect.gen(function* () {
    if ((yield* Ref.get(subagentRefs.fiber)) !== null) return

    const currentPlan = yield* Ref.get(planRefs.plan)
    const currentStep = yield* Ref.get(planRefs.step)

    if (currentPlan && currentStep < currentPlan.steps.length) {
      const planStep = currentPlan.steps[currentStep]

      const finalStep = services.hooks?.beforeStep
        ? yield* services.hooks.beforeStep(currentStep, planStep)
        : planStep

      yield* logPlanTransition(smConfig.char.name, currentPlan, currentStep)

      const charFs = yield* CharacterFs
      const personality = yield* charFs.readBackground(smConfig.char)
      const values = yield* charFs.readValues(smConfig.char)
      const promptBuilder = yield* PromptBuilderTag
      const systemPrompt = promptBuilder.systemPrompt()

      const mode = smConfig.modeRef ? yield* Ref.get(smConfig.modeRef) : ("select" as BrainMode)

      const fiber = yield* runGenericSubagent({
        char: smConfig.char,
        containerId: smConfig.containerId,
        playerName: smConfig.playerName,
        systemPrompt,
        containerEnv: smConfig.containerEnv,
        step: finalStep,
        state,
        situation,
        personality,
        values,
        tickIntervalSec: smConfig.tickIntervalSec,
        mode,
      }).pipe(
        Effect.tap((report) => Ref.set(subagentRefs.report, report)),
        Effect.catchAll((e) =>
          Effect.gen(function* () {
            const msg = formatError(e)
            yield* Ref.set(subagentRefs.report, `[SUBAGENT ERROR] ${msg}`)
            yield* logToConsole(smConfig.char.name, "error", msg)
            return ""
          }),
        ),
        Effect.fork,
      )

      const tickCount = yield* Ref.get(timingRefs.tickCount)
      yield* Ref.set(subagentRefs.fiber, fiber)
      yield* Ref.set(timingRefs.stepStartTick, tickCount)
      yield* Ref.set(subagentRefs.spawnState, services.renderer.richSnapshot(state))
    }
  })
