import { Effect, Ref, Fiber, Schedule, Duration } from "effect"
import { GameApi } from "../services/GameApi.js"
import { CharacterFs, type CharacterConfig } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import { brainPlan, brainInterrupt } from "../ai/brain.js"
import { runSubagent } from "../ai/subagent.js"
import { detectInterrupts } from "./interrupt.js"
import { isStepComplete } from "./plan-tracker.js"
import type { Plan } from "../ai/types.js"
import { logToConsole } from "../logging/console-renderer.js"

export interface TickLoopConfig {
  char: CharacterConfig
  containerId: string
  tickIntervalSeconds: number
  projectRoot: string
}

export const tickLoop = (config: TickLoopConfig) =>
  Effect.gen(function* () {
    const api = yield* GameApi
    const charFs = yield* CharacterFs
    const log = yield* CharacterLog

    const planRef = yield* Ref.make<Plan | null>(null)
    const stepRef = yield* Ref.make(0)
    const subagentFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, unknown> | null>(null)
    const tickCountRef = yield* Ref.make(0)
    const stepStartTickRef = yield* Ref.make(0)

    const tick = Effect.gen(function* () {
      const tickCount = yield* Ref.updateAndGet(tickCountRef, (n) => n + 1)

      // 1. Poll game state
      const state = yield* api.collectState()
      const situation = api.classify(state)
      const briefing = api.briefing(state, situation)

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
          // Subagent finished
          yield* logToConsole(config.char.name, "monitor", "Subagent completed")

          const plan = yield* Ref.get(planRef)
          const step = yield* Ref.get(stepRef)

          if (plan && step < plan.steps.length) {
            // Check success condition
            const currentStep = plan.steps[step]
            const success = isStepComplete(currentStep, state, situation)

            yield* log.action(config.char, {
              timestamp: new Date().toISOString(),
              source: "monitor",
              character: config.char.name,
              type: "step_complete",
              stepIndex: step,
              task: currentStep.task,
              successConditionMet: success,
            })

            yield* Ref.set(stepRef, step + 1)
          }

          yield* Ref.set(subagentFiberRef, null)
        } else {
          // Subagent still running — check timeout
          const plan = yield* Ref.get(planRef)
          const step = yield* Ref.get(stepRef)
          const startTick = yield* Ref.get(stepStartTickRef)

          if (plan && step < plan.steps.length) {
            const currentStep = plan.steps[step]

            // Check if the step's success condition is met even while subagent runs
            if (isStepComplete(currentStep, state, situation)) {
              yield* logToConsole(config.char.name, "monitor", `Step ${step} success condition met while subagent running — interrupting`)
              yield* Fiber.interrupt(currentFiber).pipe(Effect.catchAll(() => Effect.void))
              yield* Ref.set(subagentFiberRef, null)
              yield* Ref.set(stepRef, step + 1)
            }
            // Check timeout
            else if (tickCount - startTick >= currentStep.timeoutTicks) {
              yield* logToConsole(config.char.name, "monitor", `Step ${step} timed out — interrupting`)
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

        const newPlan = yield* brainPlan.execute({
          state,
          situation,
          diary,
          briefing,
          background,
          values,
        })

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

          yield* logToConsole(
            config.char.name,
            "monitor",
            `Spawning subagent: [${planStep.task}] ${planStep.goal} (${planStep.model})`,
          )

          const personality = yield* charFs.readBackground(config.char)
          const values = yield* charFs.readValues(config.char)

          const fiber = yield* runSubagent({
            char: config.char,
            containerId: config.containerId,
            step: planStep,
            state,
            situation,
            personality,
            values,
          }).pipe(
            Effect.catchAll((e) =>
              logToConsole(config.char.name, "monitor", `Subagent error: ${e}`),
            ),
            Effect.fork,
          )

          yield* Ref.set(subagentFiberRef, fiber)
          yield* Ref.set(stepStartTickRef, tickCount)
        }
      }
    })

    // Run the tick on a schedule
    yield* Effect.repeat(
      tick.pipe(
        Effect.catchAll((e) =>
          logToConsole(config.char.name, "monitor", `Tick error: ${e}`),
        ),
      ),
      Schedule.spaced(Duration.seconds(config.tickIntervalSeconds)),
    )
  })
