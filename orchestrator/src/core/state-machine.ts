import * as readline from "node:readline"
import { Effect, Ref, Fiber, Queue, Deferred } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterFs } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import {
  logToConsole,
  logTickReceived,
} from "../logging/console-renderer.js"
import type { EventResult } from "./event-source.js"
import { EventProcessorTag } from "./event-source.js"
import { ContextHandlerTag } from "./context-handler.js"
import { SkillRegistryTag } from "./skill.js"
import { InterruptRegistryTag } from "./interrupt.js"
import { SituationClassifierTag } from "./situation.js"
import { StateRendererTag } from "./state-renderer.js"
import type { DomainState, DomainSituation, DomainEvent } from "./domain-types.js"
import type { BrainMode, Plan, StepTiming, Alert, ExitReason, StateMachineResult } from "./types.js"
import type { LifecycleHooks } from "./lifecycle.js"
import { brainInterrupt } from "./brain.js"
import { killSubagent, evaluateCompletedSubagent, checkMidRun, maybeSpawnSubagent } from "./subagent-manager.js"
import { maybeRequestPlan } from "./planning-cycle.js"
import { runGenericSubagent } from "./subagent.js"
import { PromptBuilderTag } from "./prompt-builder.js"

export interface StateMachineConfig {
  char: CharacterConfig
  containerId: string
  playerName: string
  containerEnv?: Record<string, string>
  events: Queue.Queue<DomainEvent>
  initialState: DomainState
  tickIntervalSec: number
  initialTick: number
  exitSignal?: Deferred.Deferred<ExitReason, never>
  hooks?: LifecycleHooks
  /** Pause for manual approval before plan/subagent steps. */
  manualApproval?: boolean
}

/**
 * Plan/act/evaluate state machine.
 * Reads events from a queue, drives the brain + subagent cycle,
 * handles interrupts and timeouts.
 */
export const runStateMachine = (config: StateMachineConfig) =>
  Effect.gen(function* () {
    const eventProcessor = yield* EventProcessorTag
    const skills = yield* SkillRegistryTag
    const interrupts = yield* InterruptRegistryTag
    const classifier = yield* SituationClassifierTag
    const renderer = yield* StateRendererTag
    const contextHandler = yield* ContextHandlerTag
    const charFs = yield* CharacterFs
    const log = yield* CharacterLog

    // --- Lifecycle hooks + exit signal ---
    const hooks = config.hooks
    const exitSignal = config.exitSignal ?? (yield* Deferred.make<ExitReason, never>())

    // --- State refs ---
    const planRef = yield* Ref.make<Plan | null>(null)
    const stepRef = yield* Ref.make(0)
    const subagentFiberRef = yield* Ref.make<Fiber.RuntimeFiber<string, unknown> | null>(null)
    const tickCountRef = yield* Ref.make(config.initialTick)
    const stepStartTickRef = yield* Ref.make(config.initialTick)
    const subagentReportRef = yield* Ref.make("")
    const previousFailureRef = yield* Ref.make<string | null>(null)
    const stepTimingHistoryRef = yield* Ref.make<StepTiming[]>([])
    const lastProcessedTickRef = yield* Ref.make(0)
    const spawnStateRef = yield* Ref.make<Record<string, unknown> | null>(null)
    const turnCountRef = yield* Ref.make(0)
    const softAlertAccRef = yield* Ref.make<Map<string, Alert>>(new Map())
    const modeRef = yield* Ref.make<BrainMode>("select")
    const investigationReportRef = yield* Ref.make<string | null>(null)
    const procedureTargetsRef = yield* Ref.make<string[]>([])

    // --- Domain state ---
    const gameStateRef = yield* Ref.make<DomainState>(config.initialState)
    const chatContextRef = yield* Ref.make<Array<{ channel: string; sender: string; content: string }>>([])

    // --- Ref groups for extracted modules ---
    const subagentRefs = { fiber: subagentFiberRef, report: subagentReportRef, spawnState: spawnStateRef }
    const planRefs = { plan: planRef, step: stepRef, previousFailure: previousFailureRef }
    const timingRefs = { tickCount: tickCountRef, stepStartTick: stepStartTickRef, stepTimingHistory: stepTimingHistoryRef }
    const planningRefs = {
      plan: planRef,
      step: stepRef,
      subagentFiber: subagentFiberRef,
      previousFailure: previousFailureRef,
      chatContext: chatContextRef,
      stepTimingHistory: stepTimingHistoryRef,
      softAlertAcc: softAlertAccRef,
      tickCount: tickCountRef,
      stepStartTick: stepStartTickRef,
      mode: modeRef,
      investigationReport: investigationReportRef,
      procedureTargets: procedureTargetsRef,
    }
    const planningServices = { char: config.char, tickIntervalSec: config.tickIntervalSec, hooks }
    const evalServices = {
      renderer,
      classifier,
      skills,
      hooks,
      tickIntervalSec: config.tickIntervalSec,
      char: config.char,
      modeRef,
      investigationReportRef,
    }
    const spawnConfig = {
      char: config.char,
      containerId: config.containerId,
      playerName: config.playerName,
      containerEnv: config.containerEnv,
      tickIntervalSec: config.tickIntervalSec,
      modeRef,
    }
    const spawnServices = { renderer, hooks }

    // --- Manual approval gate ---

    /** Ring terminal bell and wait for Enter if manual approval is enabled. */
    const awaitApproval = (label: string) => {
      if (!config.manualApproval) return Effect.void
      return Effect.async<void, never>((resume) => {
        // Bell character + visible prompt
        process.stderr.write(`\x07\n[${config.char.name}] ⏸ ${label} — press Enter to continue...`)
        const rl = readline.createInterface({ input: process.stdin })
        rl.once("line", () => {
          rl.close()
          resume(Effect.void)
        })
      })
    }

    /** Plan + spawn cycle with manual approval gates. */
    const planAndSpawn = (state: DomainState, situation: DomainSituation, briefing: string) =>
      Effect.gen(function* () {
        // Check if planning will happen (same condition as maybeRequestPlan)
        const plan = yield* Ref.get(planRef)
        const step = yield* Ref.get(stepRef)
        const noFiber = (yield* Ref.get(subagentFiberRef)) === null
        const needsPlan = noFiber && (!plan || step >= (plan?.steps.length ?? 0))

        if (needsPlan) {
          const mode = yield* Ref.get(modeRef)
          yield* awaitApproval(`requesting plan (mode: ${mode})`)
        }

        yield* maybeRequestPlan(planningRefs, planningServices, state, situation, briefing)

        // Check if spawning will happen (same condition as maybeSpawnSubagent)
        const planAfter = yield* Ref.get(planRef)
        const stepAfter = yield* Ref.get(stepRef)
        const noFiberAfter = (yield* Ref.get(subagentFiberRef)) === null
        if (noFiberAfter && planAfter && stepAfter < planAfter.steps.length) {
          const nextStep = planAfter.steps[stepAfter]
          yield* awaitApproval(`spawning subagent: [${nextStep.task}] ${nextStep.goal}`)
        }

        yield* maybeSpawnSubagent(subagentRefs, planRefs, timingRefs, spawnConfig, spawnServices, state, situation)
      })

    // --- Inline helpers ---

    /** Check if a procedure plan just completed; if so, spawn diary and reset mode to 'select'. */
    const maybeCompleteProcedure = () =>
      Effect.gen(function* () {
        const mode = yield* Ref.get(modeRef)
        if (mode === "select") return

        const plan = yield* Ref.get(planRef)
        const step = yield* Ref.get(stepRef)
        if (!plan || step < plan.steps.length) return

        // Plan completed in a procedure mode — spawn diary subagent
        yield* awaitApproval(`procedure '${mode}' complete, spawning diary subagent`)
        yield* logToConsole(config.char.name, "monitor", `Procedure '${mode}' complete, writing diary...`)

        const diaryPrompt = `Update ./me/DIARY.md reflecting on what you accomplished, what you learned, and what to focus on next.

## Completed Procedure: ${mode}
${plan.reasoning}

## Steps Completed
${plan.steps.map((s, i) => `${i + 1}. [${s.task}] ${s.goal}`).join("\n")}

Write a brief diary entry summarizing outcomes and lessons learned. Append to the existing diary, don't replace it.`

        const charFsLocal = yield* CharacterFs
        const personality = yield* charFsLocal.readBackground(config.char)
        const values = yield* charFsLocal.readValues(config.char)
        const promptBuilder = yield* PromptBuilderTag
        const systemPromptText = promptBuilder.systemPrompt()
        const state = yield* Ref.get(gameStateRef)
        const situation = classifier.classify(state)

        yield* runGenericSubagent({
          char: config.char,
          containerId: config.containerId,
          playerName: config.playerName,
          systemPrompt: systemPromptText,
          containerEnv: config.containerEnv,
          step: { task: "diary", goal: "Update diary", model: "haiku", successCondition: "diary updated", timeoutTicks: 3 },
          state,
          situation,
          personality,
          values,
          tickIntervalSec: config.tickIntervalSec,
        }).pipe(
          Effect.timeout("60 seconds"),
          Effect.catchAll((e) =>
            logToConsole(config.char.name, "error", `Diary subagent failed: ${e}`).pipe(Effect.as("")),
          ),
        )

        yield* logToConsole(config.char.name, "monitor", `Diary updated. Returning to 'select' mode.`)
        yield* Ref.set(modeRef, "select")
        yield* Ref.set(investigationReportRef, null)
        yield* Ref.set(procedureTargetsRef, [])
      })

    /** Handle critical interrupts: kill subagent, ask brain for new plan. */
    const handleInterrupt = (criticals: Alert[], state: DomainState, situation: DomainSituation, briefing: string) =>
      Effect.gen(function* () {
        if (hooks?.onInterrupt) {
          yield* hooks.onInterrupt(criticals)
        }

        yield* logToConsole(config.char.name, "monitor", `INTERRUPT: ${criticals.map((a) => a.message).join("; ")}`)

        yield* log.thought(config.char, {
          timestamp: new Date().toISOString(),
          source: "monitor",
          character: config.char.name,
          type: "interrupt",
          alerts: criticals,
          action: "killing subagent, replanning",
        }).pipe(Effect.catchAll(() => Effect.void))

        yield* killSubagent(subagentFiberRef)

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
        }).pipe(Effect.catchAll(() => Effect.void))

        yield* logToConsole(config.char.name, "brain", `Interrupt plan: ${newPlan.reasoning}`)

        const tickCount = yield* Ref.get(tickCountRef)
        yield* Ref.set(planRef, newPlan)
        yield* Ref.set(stepRef, 0)
        yield* Ref.set(stepStartTickRef, tickCount)
        yield* Ref.set(softAlertAccRef, new Map())
      })

    // --- Main event processing ---

    /** Process a state update: the core decision cycle. */
    const handleStateUpdateEvent = (state: DomainState) =>
      Effect.gen(function* () {
        const situation = classifier.classify(state)
        const briefing = classifier.briefing(state, situation)

        renderer.logStateBar(config.char.name, state, situation)

        // Get current task for suppression
        const plan = yield* Ref.get(planRef)
        const step = yield* Ref.get(stepRef)
        const currentTask = plan && step < plan.steps.length ? plan.steps[step].task : undefined

        // Evaluate all rules once, partition
        const allAlerts = interrupts.evaluate(state, situation, currentTask)
        const criticals = allAlerts.filter(a => a.priority === "critical")
        const softAlerts = allAlerts.filter(a => a.priority !== "critical")

        // Critical → hard interrupt
        if (criticals.length > 0) {
          yield* handleInterrupt(criticals, state, situation, briefing)
        }

        // Non-critical → accumulate, dedup by ruleName
        if (softAlerts.length > 0) {
          yield* Ref.update(softAlertAccRef, (acc) => {
            const next = new Map(acc)
            for (const alert of softAlerts) {
              next.set(alert.ruleName ?? alert.message, alert)
            }
            return next
          })
        }

        // Check if subagent finished
        const currentFiber = yield* Ref.get(subagentFiberRef)
        if (currentFiber) {
          const poll = yield* Fiber.poll(currentFiber)
          if (poll._tag === "Some") {
            yield* evaluateCompletedSubagent(subagentRefs, planRefs, timingRefs, evalServices, state)
            yield* maybeCompleteProcedure()
          }
        }

        // Plan + spawn cycle
        yield* planAndSpawn(state, situation, briefing)
      })

    /** Process a tick: heartbeat, timeout checks, and proactive plan/spawn. */
    const handleTickEvent = (tick: number) =>
      Effect.gen(function* () {
        yield* logTickReceived(config.char.name, tick)
        yield* Ref.set(lastProcessedTickRef, tick)
        yield* Ref.set(tickCountRef, tick)

        const state = yield* Ref.get(gameStateRef)
        const situation = classifier.classify(state)
        const briefing = classifier.briefing(state, situation)

        yield* checkMidRun(subagentRefs, planRefs, timingRefs, { skills }, state, situation)

        const currentFiber = yield* Ref.get(subagentFiberRef)
        if (currentFiber) {
          const poll = yield* Fiber.poll(currentFiber)
          if (poll._tag === "Some") {
            yield* evaluateCompletedSubagent(subagentRefs, planRefs, timingRefs, evalServices, state)
            yield* maybeCompleteProcedure()
          }
        }

        yield* planAndSpawn(state, situation, briefing)
      })

    /** Process a reset event (e.g. death): kill everything, start fresh. */
    const handleReset = () =>
      Effect.gen(function* () {
        if (hooks?.onReset) {
          yield* hooks.onReset()
        }
        yield* killSubagent(subagentFiberRef)
        yield* Ref.set(planRef, null)
        yield* Ref.set(stepRef, 0)
        yield* Ref.set(softAlertAccRef, new Map())
        yield* Ref.set(modeRef, "select")
        yield* Ref.set(investigationReportRef, null)
        yield* Ref.set(procedureTargetsRef, [])
      })

    // --- Event loop ---

    yield* logToConsole(config.char.name, "monitor", "Starting event loop...")

    // Initial planning on startup
    yield* Effect.gen(function* () {
      const state = yield* Ref.get(gameStateRef)
      const situation = classifier.classify(state)
      const briefing = classifier.briefing(state, situation)
      yield* planAndSpawn(state, situation, briefing)
    }).pipe(
      Effect.catchAllCause((cause) => {
        const msg = cause.toString().slice(0, 500)
        return logToConsole(config.char.name, "error", `Initial planning error: ${msg}`)
      }),
    )

    // Exitable event loop — runs forever when no exitSignal/hooks are provided
    let running = true
    while (running) {
      yield* Effect.gen(function* () {
        const event = yield* Queue.take(config.events)

        // Process event through the domain event processor
        const result: EventResult = eventProcessor.processEvent(
          event,
          yield* Ref.get(gameStateRef),
        )

        // Apply state update if present
        if (result.stateUpdate) {
          yield* Ref.update(gameStateRef, result.stateUpdate)
        }

        // Update tick if present
        if (result.tick !== undefined) {
          yield* Ref.set(tickCountRef, result.tick)
        }

        // Run logging side effect
        if (result.log) {
          yield* Effect.sync(() => result.log!())
        }

        // Accumulate context (e.g. chat messages) via domain context handler
        if (result.accumulatedContext) {
          const { chatMessages } = yield* contextHandler.processContext(
            result.accumulatedContext, config.char)
          yield* Ref.update(chatContextRef, (msgs) =>
            [...msgs, ...(chatMessages ?? [])].slice(-20))
        }

        // Handle the different event result types
        yield* Effect.gen(function* () {
          if (result.isReset) {
            yield* handleReset()
            return
          }

          if (result.isInterrupt) {
            const plan = yield* Ref.get(planRef)
            const currentStep = yield* Ref.get(stepRef)
            const currentTask = plan && currentStep < plan.steps.length ? plan.steps[currentStep].task : undefined

            const state = yield* Ref.get(gameStateRef)
            const situation = classifier.classify(state)

            // Use domain-provided alerts if present, otherwise fall back to the interrupt registry
            const alerts: Alert[] = result.alerts ?? interrupts.criticals(state, situation, currentTask)
            if (alerts.length > 0) {
              const briefing = classifier.briefing(state, situation)
              yield* handleInterrupt(alerts, state, situation, briefing)
            }
            return
          }

          if (result.isStateUpdate) {
            const state = yield* Ref.get(gameStateRef)
            yield* handleStateUpdateEvent(state)
            return
          }

          if (result.isTick && result.tick !== undefined) {
            yield* handleTickEvent(result.tick)
            return
          }
        }).pipe(
          Effect.catchAllCause((cause) => {
            const msg = cause.toString().slice(0, 500)
            return logToConsole(config.char.name, "error", `Event processing error: ${msg}`)
          }),
        )

        // Increment turn count
        yield* Ref.update(turnCountRef, (n) => n + 1)

        // Check shouldExit hook
        if (hooks?.shouldExit) {
          const turnCount = yield* Ref.get(turnCountRef)
          const wantsExit = yield* hooks.shouldExit(turnCount)
          if (wantsExit) {
            yield* Deferred.succeed(exitSignal, { _tag: "HookRequested", reason: "shouldExit returned true" })
          }
        }

        // Check if exitSignal has been resolved
        const done = yield* Deferred.isDone(exitSignal)
        if (done) {
          running = false
        }
      })
    }

    // Return result — only reached when the loop exits
    const exitReason = yield* Deferred.await(exitSignal)
    const finalState = yield* Ref.get(gameStateRef)
    const turnCount = yield* Ref.get(turnCountRef)
    return { finalState, exitReason, turnCount } as StateMachineResult
  })
