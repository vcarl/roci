import * as readline from "node:readline"
import { Effect, Ref, Fiber, Queue, Deferred } from "effect"
import type { CharacterConfig } from "../../services/CharacterFs.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { CharacterLog } from "../../logging/log-writer.js"
import {
  logToConsole,
  logTickReceived,
} from "../../logging/console-renderer.js"
import type { EventResult } from "../limbic/thalamus/event-processor.js"
import { EventProcessorTag } from "../limbic/thalamus/event-processor.js"
import type { SituationSummary } from "../limbic/thalamus/situation-classifier.js"
import { SkillRegistryTag } from "../skill.js"
import { InterruptRegistryTag } from "../limbic/amygdala/interrupt.js"
import { SituationClassifierTag } from "../limbic/thalamus/situation-classifier.js"
import { StateRendererTag } from "../state-renderer.js"
import type { DomainState, DomainEvent } from "../domain-types.js"
import type { BrainMode, Plan, StepTiming, Alert, ExitReason, StateMachineResult } from "../types.js"
import type { LifecycleHooks } from "./lifecycle.js"
import { brainInterrupt } from "./planning/brain.js"
import { killSubagent, evaluateCompletedSubagent, checkMidRun, maybeSpawnSubagent } from "./planning/subagent-manager.js"
import { maybeRequestPlan } from "./planning/planning-cycle.js"
import { runTurn } from "../limbic/hypothalamus/process-runner.js"
import { PromptBuilderTag } from "../prompt-builder.js"

export interface StateMachineConfig {
  char: CharacterConfig
  containerId: string
  playerName: string
  containerEnv?: Record<string, string>
  /** Container --add-dir paths for claude subagent. */
  addDirs?: string[]
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
    const procedureStartStateRef = yield* Ref.make<Record<string, unknown> | null>(null)

    // --- Failure cap refs ---
    const consecutiveFailuresRef = yield* Ref.make(0)
    const replanBlockedUntilTickRef = yield* Ref.make(0)

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
      procedureStartState: procedureStartStateRef,
    }
    const planningServices = { char: config.char, containerId: config.containerId, playerName: config.playerName, containerEnv: config.containerEnv, addDirs: config.addDirs, tickIntervalSec: config.tickIntervalSec, hooks, renderer }
    const evalServices = {
      renderer,
      classifier,
      skills,
      hooks,
      tickIntervalSec: config.tickIntervalSec,
      char: config.char,
      containerId: config.containerId,
      playerName: config.playerName,
      containerEnv: config.containerEnv,
      addDirs: config.addDirs,
      modeRef,
      investigationReportRef,
    }
    const spawnConfig = {
      char: config.char,
      containerId: config.containerId,
      playerName: config.playerName,
      containerEnv: config.containerEnv,
      addDirs: config.addDirs,
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

    /** Track step outcomes for failure cap. */
    const trackStepOutcome = () =>
      Effect.gen(function* () {
        const plan = yield* Ref.get(planRef)
        // If plan was just cleared (null) and we had a previous failure, increment counter
        if (plan === null) {
          const pf = yield* Ref.get(previousFailureRef)
          if (pf !== null) {
            const failures = yield* Ref.updateAndGet(consecutiveFailuresRef, (n) => n + 1)
            if (failures >= 5) {
              const tick = yield* Ref.get(tickCountRef)
              const blockTicks = Math.min(failures * 4, 60)
              yield* Ref.set(replanBlockedUntilTickRef, tick + blockTicks)
              yield* logToConsole(
                config.char.name,
                "monitor",
                `Failure cap: ${failures} consecutive failures — blocking replan for ${blockTicks} ticks`,
              )
            }
          }
        } else {
          // Plan exists (success or first plan) — reset counter
          yield* Ref.set(consecutiveFailuresRef, 0)
        }
      })

    /** Plan + spawn cycle with manual approval gates and failure cap. */
    const planAndSpawn = (state: DomainState, summary: SituationSummary) =>
      Effect.gen(function* () {
        // Failure cap: skip planning if blocked due to consecutive failures
        const tick = yield* Ref.get(tickCountRef)
        const blockedUntil = yield* Ref.get(replanBlockedUntilTickRef)
        if (tick < blockedUntil) return

        // Check if planning will happen (same condition as maybeRequestPlan)
        const plan = yield* Ref.get(planRef)
        const step = yield* Ref.get(stepRef)
        const noFiber = (yield* Ref.get(subagentFiberRef)) === null
        const needsPlan = noFiber && (!plan || step >= (plan?.steps.length ?? 0))

        if (needsPlan) {
          const mode = yield* Ref.get(modeRef)
          yield* awaitApproval(`requesting plan (mode: ${mode})`)
        }

        yield* maybeRequestPlan(planningRefs, planningServices, state, summary)

        // Check if spawning will happen (same condition as maybeSpawnSubagent)
        const planAfter = yield* Ref.get(planRef)
        const stepAfter = yield* Ref.get(stepRef)
        const noFiberAfter = (yield* Ref.get(subagentFiberRef)) === null
        if (noFiberAfter && planAfter && stepAfter < planAfter.steps.length) {
          const nextStep = planAfter.steps[stepAfter]
          yield* awaitApproval(`spawning subagent: [${nextStep.task}] ${nextStep.goal}`)
        }

        yield* maybeSpawnSubagent(subagentRefs, planRefs, timingRefs, spawnConfig, spawnServices, state, summary.situation)
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

        const investigationReport = yield* Ref.get(investigationReportRef)
        const targets = yield* Ref.get(procedureTargetsRef)
        const timingHistory = yield* Ref.get(stepTimingHistoryRef)
        const startState = yield* Ref.get(procedureStartStateRef)
        const currentState = yield* Ref.get(gameStateRef)
        const stateDiffSection = startState
          ? `\n## State Changes\n${renderer.stateDiff(startState, renderer.richSnapshot(currentState))}`
          : ""

        const timingSection = timingHistory.length > 0
          ? `\n## Step Timing\n${timingHistory.map(h => {
              let line = `- [${h.task}] "${h.goal}" — ${h.ticksConsumed}/${h.ticksBudgeted} ticks`
              if (h.succeeded !== undefined) line += ` → ${h.succeeded ? "SUCCESS" : "FAILED"}${h.reason ? `: ${h.reason}` : ""}`
              return line
            }).join("\n")}`
          : ""

        const diaryPrompt = `Update ./me/DIARY.md reflecting on what you accomplished, what you learned, and what to focus on next.

## Completed Procedure: ${mode}
${plan.reasoning}
${targets.length > 0 ? `\n## Targets\n${targets.join(", ")}` : ""}
${investigationReport ? `\n## Investigation Findings\n${investigationReport.slice(-1500)}` : ""}
## Steps Completed
${plan.steps.map((s, i) => `${i + 1}. [${s.task}] ${s.goal}`).join("\n")}
${timingSection}${stateDiffSection}

Write a brief diary entry summarizing outcomes and lessons learned. Append to the existing diary, don't replace it.`

        const charFsLocal = yield* CharacterFs
        const personality = yield* charFsLocal.readBackground(config.char)
        const values = yield* charFsLocal.readValues(config.char)
        const promptBuilder = yield* PromptBuilderTag
        const systemPromptText = promptBuilder.systemPrompt(mode, "diary")
        const state = yield* Ref.get(gameStateRef)
        const procedureSummary = classifier.summarize(state)

        const diaryStep = { task: "diary" as const, goal: diaryPrompt, model: "haiku" as const, successCondition: "diary updated", timeoutTicks: 3 }
        const diaryTurnPrompt = promptBuilder.subagentPrompt({
          step: diaryStep,
          state,
          situation: procedureSummary.situation,
          identity: {
            personality,
            values,
            tickIntervalSec: config.tickIntervalSec,
          },
          mode,
        })

        yield* runTurn({
          char: config.char,
          containerId: config.containerId,
          playerName: config.playerName,
          systemPrompt: systemPromptText,
          prompt: diaryTurnPrompt,
          model: "haiku",
          timeoutMs: 60_000,
          env: config.containerEnv,
          addDirs: config.addDirs,
          role: "brain",
        }).pipe(
          Effect.map((r) => r.output),
          Effect.catchAll((e) =>
            logToConsole(config.char.name, "error", `Diary subagent failed: ${e}`).pipe(Effect.as("")),
          ),
        )

        yield* logToConsole(config.char.name, "monitor", `Diary updated. Returning to 'select' mode.`)
        yield* Ref.set(modeRef, "select")
        yield* Ref.set(investigationReportRef, null)
        yield* Ref.set(procedureTargetsRef, [])

        if (hooks?.onProcedureComplete) {
          yield* hooks.onProcedureComplete(mode)
        }
      })

    /** Handle critical interrupts: kill subagent, ask brain for new plan. */
    const handleInterrupt = (criticals: Alert[], state: DomainState, summary: SituationSummary) =>
      Effect.gen(function* () {
        if (hooks?.onInterrupt) {
          yield* hooks.onInterrupt(criticals)
        }

        yield* logToConsole(config.char.name, "monitor", `INTERRUPT: ${criticals.map((a) => a.message).join("; ")}`)
        yield* awaitApproval(`INTERRUPT: ${criticals.map(a => a.message).join("; ")}`)

        yield* log.thought(config.char, {
          timestamp: new Date().toISOString(),
          source: "monitor",
          character: config.char.name,
          type: "interrupt",
          alerts: criticals,
          action: "killing subagent, replanning",
        }).pipe(Effect.catchAll(() => Effect.void))

        yield* killSubagent(subagentFiberRef)

        const mode = yield* Ref.get(modeRef)
        const procedureTargets = yield* Ref.get(procedureTargetsRef)
        const background = yield* charFs.readBackground(config.char)
        const newPlan = yield* brainInterrupt.execute({
          state,
          summary,
          alerts: criticals,
          currentPlan: yield* Ref.get(planRef),
          background,
          mode,
          procedureTargets: procedureTargets.length > 0 ? procedureTargets : undefined,
          containerId: config.containerId,
          playerName: config.playerName,
          char: config.char,
          containerEnv: config.containerEnv,
          addDirs: config.addDirs,
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

        // Reset mode — interrupts are "start fresh" events
        yield* Ref.set(modeRef, "select")
        yield* Ref.set(investigationReportRef, null)
        yield* Ref.set(procedureTargetsRef, [])
      })

    // --- Main event processing ---

    /** Process a state update: the core decision cycle. */
    const handleStateUpdateEvent = (state: DomainState) =>
      Effect.gen(function* () {
        const summary = classifier.summarize(state)

        renderer.logStateBar(config.char.name, summary.metrics)

        // Get current task for suppression
        const plan = yield* Ref.get(planRef)
        const step = yield* Ref.get(stepRef)
        const currentTask = plan && step < plan.steps.length ? plan.steps[step].task : undefined

        // Evaluate all rules once, partition
        const allAlerts = interrupts.evaluate(state, summary.situation, currentTask)
        const criticals = allAlerts.filter(a => a.priority === "critical")
        const softAlerts = allAlerts.filter(a => a.priority !== "critical")

        // Log evaluation results when any rules fired
        if (allAlerts.length > 0) {
          yield* log.thought(config.char, {
            timestamp: new Date().toISOString(),
            source: "monitor",
            character: config.char.name,
            type: "interrupt_evaluation",
            rulesEvaluated: interrupts.rules.length,
            rulesFired: allAlerts.length,
            criticalCount: criticals.length,
            softCount: softAlerts.length,
            suppressedTask: currentTask ?? null,
            alerts: allAlerts.map(a => ({
              ruleName: a.ruleName,
              priority: a.priority,
              message: a.message,
              suggestedAction: a.suggestedAction,
            })),
          }).pipe(Effect.catchAll(() => Effect.void))
        }

        // Critical → hard interrupt
        if (criticals.length > 0) {
          yield* handleInterrupt(criticals, state, summary)
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
            yield* trackStepOutcome()
            yield* maybeCompleteProcedure()
          }
        }

        // Plan + spawn cycle
        yield* planAndSpawn(state, summary)
      })

    /** Process a tick: heartbeat, timeout checks, and proactive plan/spawn. */
    const handleTickEvent = (tick: number) =>
      Effect.gen(function* () {
        yield* logTickReceived(config.char.name, tick)
        yield* Ref.set(lastProcessedTickRef, tick)
        yield* Ref.set(tickCountRef, tick)

        const state = yield* Ref.get(gameStateRef)
        const summary = classifier.summarize(state)

        yield* checkMidRun(subagentRefs, planRefs, timingRefs, { skills }, state, summary.situation)

        const currentFiber = yield* Ref.get(subagentFiberRef)
        if (currentFiber) {
          const poll = yield* Fiber.poll(currentFiber)
          if (poll._tag === "Some") {
            yield* evaluateCompletedSubagent(subagentRefs, planRefs, timingRefs, evalServices, state)
            yield* trackStepOutcome()
            yield* maybeCompleteProcedure()
          }
        }

        yield* planAndSpawn(state, summary)
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
        yield* Ref.set(consecutiveFailuresRef, 0)
        yield* Ref.set(replanBlockedUntilTickRef, 0)
      })

    // --- Event loop ---

    yield* logToConsole(config.char.name, "monitor", "Starting event loop...")

    // Initial planning on startup
    yield* Effect.gen(function* () {
      const state = yield* Ref.get(gameStateRef)
      const summary = classifier.summarize(state)
      yield* planAndSpawn(state, summary)
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

        // Run logging side effect
        if (result.log) {
          yield* Effect.sync(() => result.log!())
        }

        // Accumulate context (e.g. chat messages)
        if (result.context?.chatMessages) {
          yield* Ref.update(chatContextRef, (msgs) =>
            [...msgs, ...result.context!.chatMessages!.map(m => ({ channel: m.channel, sender: m.sender, content: m.content }))].slice(-20))
        }

        // Handle the different event result types via discriminated union
        yield* Effect.gen(function* () {
          const tag = result.category?._tag

          if (tag === "LifecycleReset") {
            yield* handleReset()
            return
          }

          if (tag === "StateChange") {
            const state = yield* Ref.get(gameStateRef)
            yield* handleStateUpdateEvent(state)
            return
          }

          if (result.category && result.category._tag === "Heartbeat") {
            const tick = result.category.tick
            yield* Ref.set(tickCountRef, tick)
            yield* handleTickEvent(tick)
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
