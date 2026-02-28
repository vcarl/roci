import { Effect, Ref, Fiber, Schedule, Duration } from "effect"
import { FileSystem } from "@effect/platform"
import { GameApi } from "../services/GameApi.js"
import { CharacterFs, type CharacterConfig } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import { brainPlan, brainInterrupt, brainEvaluate, type StepTiming } from "../ai/brain.js"
import { runSubagent } from "../ai/subagent.js"
import { detectInterrupts } from "./interrupt.js"
import { isStepComplete, buildStateSnapshot, buildRichSnapshot, buildStateDiff } from "./plan-tracker.js"
import type { Plan } from "../ai/types.js"
import { logToConsole, logStateBar, logPlanTransition, logStepResult, formatError } from "../logging/console-renderer.js"
import * as path from "node:path"

export interface TickLoopConfig {
  char: CharacterConfig
  containerId: string
  playerName: string
  tickIntervalSeconds: number
  projectRoot: string
  containerEnv?: Record<string, string>
  tickIntervalSecOverride?: number  // from server; defaults to tickIntervalSeconds
}

export const tickLoop = (config: TickLoopConfig) =>
  Effect.gen(function* () {
    const api = yield* GameApi
    const charFs = yield* CharacterFs
    const log = yield* CharacterLog

    const planRef = yield* Ref.make<Plan | null>(null)
    const stepRef = yield* Ref.make(0)
    const subagentFiberRef = yield* Ref.make<Fiber.RuntimeFiber<string, unknown> | null>(null)
    const tickCountRef = yield* Ref.make(0)
    const stepStartTickRef = yield* Ref.make(0)
    const subagentReportRef = yield* Ref.make("")
    const previousFailureRef = yield* Ref.make<string | null>(null)
    const stepTimingHistoryRef = yield* Ref.make<StepTiming[]>([])
    const spawnStateRef = yield* Ref.make<Record<string, unknown> | null>(null)
    const tickIntervalSec = config.tickIntervalSecOverride ?? config.tickIntervalSeconds

    /** Record step timing and log it. */
    const recordStepTiming = (task: string, goal: string, ticksBudgeted: number) =>
      Effect.gen(function* () {
        const startTick = yield* Ref.get(stepStartTickRef)
        const currentTick = yield* Ref.get(tickCountRef)
        const ticksConsumed = currentTick - startTick
        const overrun = ticksConsumed > ticksBudgeted
        const timing: StepTiming = { task, goal, ticksBudgeted, ticksConsumed, overrun }
        yield* Ref.update(stepTimingHistoryRef, (history) => [...history.slice(-9), timing])
        const budgetLabel = overrun
          ? `OVERRUN by ${ticksConsumed - ticksBudgeted}`
          : "within budget"
        yield* logToConsole(config.char.name, "monitor",
          `Step took ${ticksConsumed}/${ticksBudgeted} ticks (${budgetLabel})`)
        return timing
      })

    const tick = Effect.gen(function* () {
      const tickCount = yield* Ref.updateAndGet(tickCountRef, (n) => n + 1)

      // 1. Poll game state
      const state = yield* api.collectState()
      const situation = api.classify(state)
      const briefing = api.briefing(state, situation)

      // State bar each tick
      yield* logStateBar(config.char.name, state, situation)

      // 2. Check for interrupts
      const criticals = detectInterrupts(situation)
      if (criticals.length > 0) {
        yield* logToConsole(config.char.name, "monitor", `INTERRUPT: ${criticals.map((a) => a.message).join("; ")}`)

        yield* log.thought(config.char, {
          timestamp: new Date().toISOString(),
          source: "monitor",
          character: config.char.name,
          type: "interrupt",
          alerts: criticals,
          action: "killing subagent, replanning",
        })

        // Kill active subagent
        const fiber = yield* Ref.get(subagentFiberRef)
        if (fiber) {
          yield* Fiber.interrupt(fiber).pipe(Effect.catchAll(() => Effect.void))
          yield* Ref.set(subagentFiberRef, null)
        }

        // Brain interrupt mode
        const background = yield* charFs.readBackground(config.char)
        const newPlan = yield* brainInterrupt.execute({
          state,
          situation,
          alerts: criticals,
          currentPlan: yield* Ref.get(planRef),
          briefing,
          background,
        })

        yield* log.thought(config.char, {
          timestamp: new Date().toISOString(),
          source: "brain",
          character: config.char.name,
          type: "interrupt_plan",
          plan: newPlan,
        })

        yield* logToConsole(config.char.name, "brain", `Interrupt plan: ${newPlan.reasoning}`)

        yield* Ref.set(planRef, newPlan)
        yield* Ref.set(stepRef, 0)
        yield* Ref.set(stepStartTickRef, tickCount)
      }

      // 3. Check subagent status
      const currentFiber = yield* Ref.get(subagentFiberRef)
      if (currentFiber) {
        const poll = yield* Fiber.poll(currentFiber)
        if (poll._tag === "Some") {
          // Subagent finished — re-poll fresh state and evaluate with brain
          yield* logToConsole(config.char.name, "monitor", "Subagent completed, evaluating...")

          const plan = yield* Ref.get(planRef)
          const step = yield* Ref.get(stepRef)

          if (plan && step < plan.steps.length) {
            const currentStep = plan.steps[step]
            const timing = yield* recordStepTiming(currentStep.task, currentStep.goal, currentStep.timeoutTicks)

            // Re-poll state after subagent's last action
            const freshState = yield* api.collectState()
            const report = yield* Ref.get(subagentReportRef)

            // Build state diff from spawn-time snapshot
            const stateBefore = yield* Ref.get(spawnStateRef)
            const stateAfter = buildRichSnapshot(freshState)
            const stateDiff = buildStateDiff(stateBefore, stateAfter)

            // Run deterministic condition check
            const conditionCheck = isStepComplete(currentStep, freshState, situation)

            // Short-circuit: if deterministic check passes with a recognized condition, skip LLM
            if (conditionCheck.complete && conditionCheck.matchedCondition) {
              yield* logStepResult(config.char.name, step, conditionCheck)
              yield* log.action(config.char, {
                timestamp: new Date().toISOString(),
                source: "monitor",
                character: config.char.name,
                type: "step_complete",
                stepIndex: step,
                task: currentStep.task,
                goal: currentStep.goal,
                successCondition: currentStep.successCondition,
                successConditionMet: true,
                reason: `[deterministic] ${conditionCheck.reason}`,
                stateSnapshot: conditionCheck.relevantState,
                stateDiff,
                subagentReport: report.slice(-500),
              })

              yield* Ref.set(stepRef, step + 1)
              yield* Ref.set(subagentFiberRef, null)
              yield* Ref.set(subagentReportRef, "")
              yield* Ref.set(spawnStateRef, null)
              return
            }

            // Brain evaluates whether the subagent delivered
            const result = yield* brainEvaluate.execute({
              step: currentStep,
              subagentReport: report,
              state: freshState,
              stateBefore,
              stateDiff,
              conditionCheck,
              ticksConsumed: timing.ticksConsumed,
              ticksBudgeted: timing.ticksBudgeted,
              tickIntervalSec,
            }).pipe(
              Effect.catchAll((e) =>
                Effect.succeed({
                  complete: true as const,
                  reason: `Brain evaluation failed (${e}), trusting subagent completion`,
                  matchedCondition: null,
                  relevantState: buildStateSnapshot(freshState),
                }),
              ),
            )

            yield* logStepResult(config.char.name, step, result)

            // Enriched step_complete log entry
            yield* log.action(config.char, {
              timestamp: new Date().toISOString(),
              source: "monitor",
              character: config.char.name,
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

            if (result.complete) {
              yield* Ref.set(stepRef, step + 1)
            } else {
              // Step failed — replan with failure context
              const failureContext = `Step ${step + 1} [${currentStep.task}] "${currentStep.goal}" failed: ${result.reason}\nSubagent report: ${report.slice(-300) || "(no report)"}`
              yield* logToConsole(config.char.name, "monitor",
                `Step ${step + 1} failed, requesting new plan...`)
              yield* Ref.set(previousFailureRef, failureContext)
              yield* Ref.set(planRef, null)
              yield* Ref.set(stepRef, 0)
            }
          }

          yield* Ref.set(subagentFiberRef, null)
          yield* Ref.set(subagentReportRef, "")
          yield* Ref.set(spawnStateRef, null)
        } else {
          // Subagent still running — check mid-run success + timeout
          const plan = yield* Ref.get(planRef)
          const step = yield* Ref.get(stepRef)
          const startTick = yield* Ref.get(stepStartTickRef)

          if (plan && step < plan.steps.length) {
            const currentStep = plan.steps[step]

            // Mid-run state-based check
            const midRunResult = isStepComplete(currentStep, state, situation)
            if (midRunResult.complete) {
              yield* logToConsole(config.char.name, "monitor",
                `Step ${step + 1} condition met mid-run: ${midRunResult.reason}`)
              yield* recordStepTiming(currentStep.task, currentStep.goal, currentStep.timeoutTicks)
              yield* Fiber.interrupt(currentFiber).pipe(Effect.catchAll(() => Effect.void))
              yield* Ref.set(subagentFiberRef, null)
              yield* Ref.set(stepRef, step + 1)
            }
            // Check timeout
            else if (tickCount - startTick >= currentStep.timeoutTicks) {
              yield* logToConsole(config.char.name, "monitor", `Step ${step + 1} timed out — interrupting`)
              yield* recordStepTiming(currentStep.task, currentStep.goal, currentStep.timeoutTicks)
              yield* Fiber.interrupt(currentFiber).pipe(Effect.catchAll(() => Effect.void))
              yield* Ref.set(subagentFiberRef, null)
              yield* Ref.set(stepRef, step + 1)
            }
          }
        }
      }

      // 4. Need a new plan?
      const plan = yield* Ref.get(planRef)
      const step = yield* Ref.get(stepRef)
      const noFiber = (yield* Ref.get(subagentFiberRef)) === null

      if (noFiber && (!plan || step >= (plan?.steps.length ?? 0))) {
        yield* logToConsole(config.char.name, "monitor", "Requesting new plan from brain...")

        const diary = yield* charFs.readDiary(config.char)
        const background = yield* charFs.readBackground(config.char)
        const values = yield* charFs.readValues(config.char)

        const previousFailure = yield* Ref.get(previousFailureRef)
        const stepTimingHistory = yield* Ref.get(stepTimingHistoryRef)

        const newPlan = yield* brainPlan.execute({
          state,
          situation,
          diary,
          briefing,
          background,
          values,
          previousFailure: previousFailure ?? undefined,
          stepTimingHistory: stepTimingHistory.length > 0 ? stepTimingHistory : undefined,
          tickIntervalSec,
        })

        yield* Ref.set(previousFailureRef, null)

        yield* log.thought(config.char, {
          timestamp: new Date().toISOString(),
          source: "brain",
          character: config.char.name,
          type: "plan",
          plan: newPlan,
          reasoning: newPlan.reasoning,
        })

        yield* logToConsole(
          config.char.name,
          "brain",
          `New plan (${newPlan.steps.length} steps): ${newPlan.reasoning}`,
        )

        yield* Ref.set(planRef, newPlan)
        yield* Ref.set(stepRef, 0)
        yield* Ref.set(stepStartTickRef, tickCount)
      }

      // 5. Spawn subagent if needed
      if ((yield* Ref.get(subagentFiberRef)) === null) {
        const currentPlan = yield* Ref.get(planRef)
        const currentStep = yield* Ref.get(stepRef)

        if (currentPlan && currentStep < currentPlan.steps.length) {
          const planStep = currentPlan.steps[currentStep]

          // Plan transition header
          yield* logPlanTransition(config.char.name, currentPlan, currentStep)

          yield* logToConsole(
            config.char.name,
            "monitor",
            `Spawning subagent: [${planStep.task}] ${planStep.goal} (${planStep.model})`,
          )

          const personality = yield* charFs.readBackground(config.char)
          const values = yield* charFs.readValues(config.char)
          const fs = yield* FileSystem.FileSystem
          const systemPrompt = yield* fs.readFileString(
            path.resolve(config.projectRoot, "in-game-CLAUDE.md"),
          ).pipe(Effect.catchAll(() => Effect.succeed("")))

          const fiber = yield* runSubagent({
            char: config.char,
            containerId: config.containerId,
            playerName: config.playerName,
            systemPrompt,
            containerEnv: config.containerEnv,
            step: planStep,
            state,
            situation,
            personality,
            values,
            tickIntervalSec,
          }).pipe(
            Effect.tap((report) => Ref.set(subagentReportRef, report)),
            Effect.catchAll((e) =>
              Effect.gen(function* () {
                const msg = formatError(e)
                yield* Ref.set(subagentReportRef, `[SUBAGENT ERROR] ${msg}`)
                yield* logToConsole(config.char.name, "error", msg)
                return ""
              }),
            ),
            Effect.fork,
          )

          yield* Ref.set(subagentFiberRef, fiber)
          yield* Ref.set(stepStartTickRef, tickCount)
          yield* Ref.set(spawnStateRef, buildRichSnapshot(state))
        }
      }
    })

    // Run the tick on a schedule
    yield* Effect.repeat(
      tick.pipe(
        Effect.catchAll((e) => {
          const msg = formatError(e)
          return logToConsole(config.char.name, "error", `Tick error: ${msg}`)
        }),
      ),
      Schedule.spaced(Duration.seconds(config.tickIntervalSeconds)),
    )
  })
