import * as readline from "node:readline"
import * as path from "node:path"
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
import { parseHarnessState, applyHarnessState } from "./harness-state.js"
import type { AgentStatusSnapshot } from "../../server/status-reporter.js"
import { readWindDown } from "../../operator/wind-down-file.js"
import { drainEdictInbox } from "../../operator/edict-inbox.js"
import { PrayerManager, parsePrayerScript, buildPrayerSummary } from "../../prayer/prayer-manager.js"
import type { AnyModel } from "../../services/Claude.js"

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
  /**
   * Optional callback invoked after each state update and tick.
   * Use to write status snapshots for Overlord monitoring.
   * Fire-and-forget — errors are silently swallowed.
   */
  onStatusUpdate?: (snapshot: AgentStatusSnapshot) => void
  /**
   * Prayer DSL backend URL. If set, agents can emit PRAYER_SET/PRAYER_END blocks
   * to offload grind loops to the Prayer HTTP service (zero Claude tokens).
   * Omit to disable Prayer — body turns handle all game actions.
   */
  prayerBaseUrl?: string
  /** Absolute path to Prayer.csproj for auto-start. Omit to skip auto-start. */
  prayerCsprojPath?: string
  /**
   * Model for brain planning turns (brainPlan, brainInterrupt).
   * Anthropic aliases ("sonnet", "haiku") use Docker exec.
   * Any other string routes to OpenRouter via HTTP.
   * Defaults to "sonnet".
   */
  brainModel?: AnyModel
  /**
   * Model for step evaluation turns (brainEvaluate).
   * Defaults to "haiku".
   */
  evalModel?: AnyModel
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

    // --- Prayer state ---
    // prayerManager is mutable — created lazily on first PRAYER_SET
    let prayerManager: PrayerManager | null = null
    const prayerRunningRef = yield* Ref.make(false)
    const prayerSummaryRef = yield* Ref.make<string | null>(null)
    // Timing for non-blocking Prayer status checks: 5s after start, then every 60s
    let prayerStartedAt = 0
    let prayerLastCheckedAt = 0
    // Cooldown: if PrayerManager.create() returns null, don't retry for 5 minutes
    let prayerManagerFailedAt = 0

    // --- Failure cap state ---
    // Track consecutive step failures to prevent runaway replan loops.
    let consecutiveFailures = 0
    let replanBlockedUntilTick = 0

    // Read credentials once for Prayer session creation
    let prayerCreds: { username: string; password: string } | null = null
    if (config.prayerBaseUrl) {
      prayerCreds = yield* charFs.readCredentials(config.char).pipe(
        Effect.map((c) => ({ username: c.username, password: c.password })),
        Effect.catchAll(() => Effect.succeed(null)),
      )
    }

    // --- Eager Prayer connection: establish session at startup so agents know status from turn 1 ---
    if (config.prayerBaseUrl && prayerCreds) {
      const agentId = config.char.name.toLowerCase()
      prayerManager = yield* Effect.promise(() =>
        PrayerManager.create(config.prayerBaseUrl!, config.prayerCsprojPath),
      )
      if (prayerManager) {
        const sessionOk = yield* Effect.promise(async () => {
          try {
            await prayerManager!.ensureSession(agentId, prayerCreds!.username, prayerCreds!.password)
            return true
          } catch (e) {
            prayerManager = null
            prayerManagerFailedAt = Date.now()
            return `${e}`
          }
        })
        if (sessionOk === true) {
          yield* logToConsole(config.char.name, "monitor", `Prayer connected — session ready for ${agentId}`)
          yield* Ref.update(softAlertAccRef, (acc) => {
            const next = new Map(acc)
            next.set("prayer:status", { priority: "low", message: "Prayer is connected and ready. You may use PRAYER_SET blocks to offload physical grind tasks.", suggestedAction: "use Prayer for mining/travel loops", ruleName: "prayer:status" })
            return next
          })
        } else {
          yield* logToConsole(config.char.name, "monitor", `Prayer session setup failed: ${sessionOk}`)
          yield* Ref.update(softAlertAccRef, (acc) => {
            const next = new Map(acc)
            next.set("prayer:status", { priority: "low", message: "Prayer is offline. Do not use PRAYER_SET blocks — they will be skipped.", suggestedAction: "use direct sm-cli commands for all actions", ruleName: "prayer:status" })
            return next
          })
        }
      } else {
        prayerManagerFailedAt = Date.now()
        yield* logToConsole(config.char.name, "monitor", "Prayer unavailable at startup — body turns only")
        yield* Ref.update(softAlertAccRef, (acc) => {
          const next = new Map(acc)
          next.set("prayer:status", { priority: "low", message: "Prayer is offline. Do not use PRAYER_SET blocks — they will be skipped.", suggestedAction: "use direct sm-cli commands for all actions", ruleName: "prayer:status" })
          return next
        })
      }
    }

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
    const planningServices = { char: config.char, containerId: config.containerId, playerName: config.playerName, containerEnv: config.containerEnv, addDirs: config.addDirs, tickIntervalSec: config.tickIntervalSec, hooks, renderer, brainModel: config.brainModel }
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
      evalModel: config.evalModel,
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

    /** Plan + spawn cycle with manual approval gates. */
    const planAndSpawn = (state: DomainState, summary: SituationSummary) =>
      Effect.gen(function* () {
        // Check if planning will happen (same condition as maybeRequestPlan)
        const plan = yield* Ref.get(planRef)
        const step = yield* Ref.get(stepRef)
        const noFiber = (yield* Ref.get(subagentFiberRef)) === null
        const needsPlan = noFiber && (!plan || step >= (plan?.steps.length ?? 0))

        // Failure cap: if consecutive failures exceeded threshold, block new plans until ticks pass
        if (needsPlan && replanBlockedUntilTick > 0) {
          const currentTick = yield* Ref.get(tickCountRef)
          if (currentTick <= replanBlockedUntilTick) {
            yield* logToConsole(config.char.name, "monitor", `Replan blocked (failure cap) — tick ${currentTick}/${replanBlockedUntilTick}`)
            return
          }
          // Block expired — reset and allow replan
          replanBlockedUntilTick = 0
          consecutiveFailures = 0
          yield* logToConsole(config.char.name, "monitor", "Replan block expired — resuming")
        }

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

    // --- Prayer helper ---

    /**
     * Attempt to start a Prayer grind script for a PRAYER_SET block found in agent output.
     * Returns true if Prayer was started, false if unavailable or no script found.
     */
    const maybeStartPrayer = (report: string) =>
      Effect.gen(function* () {
        if (!config.prayerBaseUrl) return false
        const script = parsePrayerScript(report)
        if (!script) return false
        if (!prayerCreds) {
          yield* logToConsole(config.char.name, "monitor", "PRAYER_SET found but no credentials — skipping")
          return false
        }

        // Lazily create PrayerManager on first use (with 5-minute cooldown on failure)
        if (!prayerManager) {
          const cooldownMs = 5 * 60_000
          if (prayerManagerFailedAt && Date.now() - prayerManagerFailedAt < cooldownMs) {
            yield* logToConsole(config.char.name, "monitor", "Prayer unavailable (cooldown active) — skipping")
            return false
          }
          prayerManager = yield* Effect.promise(() =>
            PrayerManager.create(config.prayerBaseUrl!, config.prayerCsprojPath),
          )
          if (!prayerManager) {
            prayerManagerFailedAt = Date.now()
          }
        }
        if (!prayerManager) {
          yield* logToConsole(config.char.name, "monitor", "Prayer unavailable — falling back to body turns")
          return false
        }

        const agentId = config.char.name.toLowerCase()
        const started = yield* Effect.promise(async () => {
          try {
            await prayerManager!.ensureSession(agentId, prayerCreds!.username, prayerCreds!.password)
            await prayerManager!.startScript(agentId, script)
            return true
          } catch (e) {
            const err = e as Error
            // Check if this is a parse error (script syntax wrong) — try LLM repair before giving up
            const errMsg = err.message ?? ""
            const isParseError = /parse|syntax|invalid|unexpected|format/i.test(errMsg)
            if (isParseError && prayerManager) {
              try {
                const repaired = await prayerManager.repairScript(agentId, script, errMsg)
                if (repaired) {
                  await prayerManager.startScript(agentId, repaired)
                  return "repaired"
                }
              } catch {
                // repair also failed — fall through to full reset
              }
            }
            // Prayer went down after manager was created — reset and set cooldown so next PRAYER_SET doesn't tight-loop
            prayerManager = null
            prayerManagerFailedAt = Date.now()
            return err
          }
        })
        if (started !== true && started !== "repaired") {
          yield* logToConsole(config.char.name, "monitor", `Prayer start failed (will retry): ${started}`)
          return false
        }
        if (started === "repaired") {
          yield* logToConsole(config.char.name, "monitor", "Prayer script auto-repaired and started")
        }
        yield* Ref.set(prayerRunningRef, true)
        prayerStartedAt = Date.now()
        prayerLastCheckedAt = Date.now()
        yield* logToConsole(config.char.name, "monitor", `Prayer started — grind offloaded (${script.split("\n").length} lines)`)
        return true
      })

    // --- Status snapshot helper ---

    /** Build and emit a status snapshot if onStatusUpdate is configured. */
    const emitStatus = (state: DomainState, summary: SituationSummary, phase: string) =>
      Effect.gen(function* () {
        if (!config.onStatusUpdate) return
        const plan = yield* Ref.get(planRef)
        const step = yield* Ref.get(stepRef)
        const mode = yield* Ref.get(modeRef)
        const turnCount = yield* Ref.get(turnCountRef)
        const softAlerts = yield* Ref.get(softAlertAccRef)
        const currentStep = plan && step < plan.steps.length ? plan.steps[step] : null
        const snapshot: AgentStatusSnapshot = {
          name: config.char.name.toLowerCase(),
          domain: "spacemolt",
          phase,
          mode,
          plan: plan?.reasoning ?? null,
          currentGoal: currentStep?.goal ?? null,
          stepIndex: step,
          situation: String((summary.metrics as Record<string, unknown>).situationType ?? "unknown"),
          metrics: summary.metrics as Record<string, number | boolean | string>,
          turnCount,
          lastUpdated: new Date().toISOString(),
          recentAlerts: [...softAlerts.values()].map((a) => a.message).slice(-5),
        }
        try { config.onStatusUpdate(snapshot) } catch { /* silent */ }
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
          model: config.brainModel,
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
            // Apply HARNESS_STATE from report before evaluation so brain sees current state
            const report = yield* Ref.get(subagentReportRef)
            const harnessTag = parseHarnessState(report)
            if (harnessTag) {
              yield* Ref.update(gameStateRef, (s) => applyHarnessState(s, harnessTag))
            }
            // Check for PRAYER_SET — if found, start Prayer and skip evaluation
            const prayerStarted = yield* maybeStartPrayer(report)
            if (prayerStarted) {
              // Prayer is now running — clear the fiber ref so state machine doesn't re-evaluate
              yield* Ref.set(subagentFiberRef, null)
              consecutiveFailures = 0
              replanBlockedUntilTick = 0
              // Advance step: Prayer owns the grind. Free agent for social/next-step tasks.
              yield* Ref.update(stepRef, (s) => s + 1)
              // Inject low-priority alert so planner generates social tasks, not more grind
              yield* Ref.update(softAlertAccRef, (acc) => {
                const next = new Map(acc)
                next.set("prayer:active", {
                  priority: "low",
                  message: "Prayer is running and handling the grind autonomously. Use this time for social engagement: post to forums, reply to threads, check DMs, advance faction diplomacy, accept or complete missions. Do NOT plan mining, travel-to-mine, or crafting tasks — Prayer is handling those. Wait for prayer:summary before resuming economic tasks.",
                  suggestedAction: "Plan social tasks: forum posts, DMs, faction diplomacy, mission check-ins. Prayer will notify when grind is complete.",
                  ruleName: "prayer:active",
                })
                return next
              })
              yield* logToConsole(config.char.name, "monitor", "Prayer started — step advanced, social stage begins")
            } else {
              const evalState = yield* Ref.get(gameStateRef)
              const planBeforeEval = yield* Ref.get(planRef)
              yield* evaluateCompletedSubagent(subagentRefs, planRefs, timingRefs, evalServices, evalState)
              yield* maybeCompleteProcedure()
              const planAfterEval = yield* Ref.get(planRef)
              if (planBeforeEval !== null && planAfterEval === null) {
                // Step failed — plan was cleared
                consecutiveFailures++
                const currentTick = yield* Ref.get(tickCountRef)
                if (consecutiveFailures >= 5) {
                  yield* logToConsole(config.char.name, "monitor", `Step failed ${consecutiveFailures}× consecutively — halting replan. Awaiting Overmind or state change.`)
                  yield* Ref.update(softAlertAccRef, (acc) => {
                    const next = new Map(acc)
                    next.set("replan:blocked", {
                      priority: "high",
                      message: `Replan loop halted after ${consecutiveFailures} consecutive failures. Last failure recorded in previousFailure. Overmind intervention or significant state change required.`,
                      suggestedAction: "Diagnose why the step keeps failing. Change approach or accept a different task.",
                      ruleName: "replan:blocked",
                    })
                    return next
                  })
                  replanBlockedUntilTick = currentTick + 999  // hard block until reset
                } else if (consecutiveFailures >= 3) {
                  yield* logToConsole(config.char.name, "monitor", `Step failed ${consecutiveFailures}× consecutively — pausing replan for 5 ticks`)
                  yield* Ref.update(softAlertAccRef, (acc) => {
                    const next = new Map(acc)
                    next.set("replan:blocked", {
                      priority: "low",
                      message: `Step has failed ${consecutiveFailures} times consecutively. Pausing replan briefly. Consider a different approach.`,
                      suggestedAction: "Change strategy — the current step keeps failing.",
                      ruleName: "replan:blocked",
                    })
                    return next
                  })
                  replanBlockedUntilTick = currentTick + 5
                }
              } else if (planBeforeEval !== null && planAfterEval !== null) {
                // Step succeeded
                consecutiveFailures = 0
                replanBlockedUntilTick = 0
                yield* Ref.update(softAlertAccRef, (acc) => {
                  const next = new Map(acc)
                  next.delete("replan:blocked")
                  return next
                })
              }
            }
          }
        }

        // Plan + spawn cycle — runs concurrently with Prayer
        yield* planAndSpawn(state, summary)

        // Emit status snapshot for Overlord monitoring
        yield* emitStatus(state, summary, "active").pipe(Effect.catchAll(() => Effect.void))
      })

    /** Process a tick: heartbeat, timeout checks, and proactive plan/spawn. */
    const handleTickEvent = (tick: number) =>
      Effect.gen(function* () {
        yield* logTickReceived(config.char.name, tick)
        yield* Ref.set(lastProcessedTickRef, tick)
        yield* Ref.set(tickCountRef, tick)

        // --- Operator IPC: wind-down check ---
        const playersDir = path.resolve(config.char.dir, "../..")
        const windDown = yield* Effect.sync(() => readWindDown(playersDir))
        if (windDown) {
          yield* logToConsole(config.char.name, "monitor", `Wind-down signal received: ${windDown.reason}`)
          yield* Deferred.succeed(exitSignal, { _tag: "ExternalSignal", reason: `wind-down: ${windDown.reason}` })
          return
        }

        // --- Operator IPC: drain edict inbox ---
        const playerDir = path.resolve(config.char.dir, "..")
        const edicts = yield* Effect.sync(() => drainEdictInbox(playerDir))
        if (edicts.length > 0) {
          yield* logToConsole(config.char.name, "monitor", `Drained ${edicts.length} edict(s) from inbox`)
          for (const edict of edicts) {
            const alert: import("../types.js").Alert = {
              priority: edict.priority === "critical" ? "critical" : edict.priority === "high" ? "high" : "low",
              message: edict.content.slice(0, 500),
              suggestedAction: "respond to operator edict",
              ruleName: `edict:${edict.id}`,
            }
            yield* Ref.update(softAlertAccRef, (acc) => {
              const next = new Map(acc)
              next.set(alert.ruleName ?? alert.message, alert)
              return next
            })
          }
          // Critical edicts: kill subagent immediately so brain replans with edict context
          const criticalEdicts = edicts.filter((e) => e.priority === "critical")
          if (criticalEdicts.length > 0) {
            yield* logToConsole(config.char.name, "monitor", `Critical edict received — killing subagent for replan`)
            yield* killSubagent(subagentFiberRef)
            yield* Ref.set(planRef, null)
            yield* Ref.set(stepRef, 0)
          }
        }

        // --- Prayer status check (non-blocking: 5s after start, then every 60s) ---
        // Prayer runs concurrently with body turns — agents handle social/mental tasks while Prayer grinds.
        const prayerActive = yield* Ref.get(prayerRunningRef)
        if (prayerActive && prayerManager) {
          const agentId = config.char.name.toLowerCase()
          const now = Date.now()
          const firstCheckDue = prayerLastCheckedAt === prayerStartedAt && now - prayerStartedAt >= 5_000
          const periodicCheckDue = prayerLastCheckedAt !== prayerStartedAt && now - prayerLastCheckedAt >= 60_000
          if (firstCheckDue || periodicCheckDue) {
            prayerLastCheckedAt = now
            const result = yield* Effect.promise(() => prayerManager!.pollOnce(agentId)).pipe(
              Effect.catchAll((e) => {
                return logToConsole(config.char.name, "monitor", `Prayer poll error (treating as halted): ${e}`).pipe(
                  Effect.as({ isHalted: true, hasActiveCommand: false, snapshot: { sessionId: "", isHalted: true, hasActiveCommand: false } } as import("../../prayer/prayer-manager.js").PrayerPollResult),
                )
              }),
            )

            if (!result.isHalted) {
              // Check for combat threats — halt Prayer immediately if found
              const threats = yield* Effect.promise(() => prayerManager!.checkThreats(agentId)).pipe(
                Effect.catchAll(() => Effect.succeed([] as import("../../prayer/prayer-manager.js").PrayerThreat[])),
              )
              if (threats.length > 0) {
                yield* Effect.promise(() => prayerManager!.halt(agentId)).pipe(Effect.catchAll(() => Effect.void))
                yield* Ref.set(prayerRunningRef, false)
                const threatSummary = `Prayer halted: combat threat (${threats[0]!.summary})`
                yield* Ref.set(prayerSummaryRef, threatSummary)
                yield* logToConsole(config.char.name, "monitor", threatSummary)
                yield* Ref.update(softAlertAccRef, (acc) => {
                  const next = new Map(acc)
                  next.delete("prayer:active")
                  return next
                })
              } else {
                yield* logToConsole(config.char.name, "monitor", `Prayer check: running (fuel=${result.fuel ?? "?"} credits=${result.credits ?? "?"})`)
              }
            }

            if (result.isHalted) {
              // Prayer finished — build resume summary, inject into softAlerts so brain sees it
              const fullState = yield* Effect.promise(() => prayerManager!.getFullStateForResume(agentId)).pipe(
                Effect.catchAll(() => Effect.succeed(null)),
              )
              const prayerSummary = buildPrayerSummary(result, fullState)
              // Save the (prompt → script) pair back to Prayer's RAG store if generation was used
              if (fullState?.lastGenerationPrompt) {
                const snapshot = result.snapshot
                if (snapshot.currentScript) {
                  yield* Effect.promise(() =>
                    prayerManager!.saveExample(agentId, fullState.lastGenerationPrompt!, snapshot.currentScript!)
                  ).pipe(Effect.catchAll(() => Effect.void))
                }
              }
              yield* Ref.set(prayerRunningRef, false)
              yield* Ref.set(prayerSummaryRef, prayerSummary)
              yield* Ref.update(softAlertAccRef, (acc) => {
                const next = new Map(acc)
                next.delete("prayer:active")
                next.set("prayer:summary", {
                  priority: "high",
                  message: prayerSummary,
                  suggestedAction: "review Prayer results and plan next steps",
                  ruleName: "prayer:summary",
                })
                return next
              })
              yield* logToConsole(config.char.name, "monitor", `Prayer halted — grind complete, summary injected`)
            }
          }
        }

        const state = yield* Ref.get(gameStateRef)
        const summary = classifier.summarize(state)

        yield* checkMidRun(subagentRefs, planRefs, timingRefs, { skills }, state, summary.situation)

        const currentFiber = yield* Ref.get(subagentFiberRef)
        if (currentFiber) {
          const poll = yield* Fiber.poll(currentFiber)
          if (poll._tag === "Some") {
            // Apply HARNESS_STATE from report before evaluation so brain sees current state
            const report = yield* Ref.get(subagentReportRef)
            const harnessTag = parseHarnessState(report)
            if (harnessTag) {
              yield* Ref.update(gameStateRef, (s) => applyHarnessState(s, harnessTag))
            }
            // Check for PRAYER_SET — if found, start Prayer and skip evaluation
            const prayerStarted = yield* maybeStartPrayer(report)
            if (prayerStarted) {
              yield* Ref.set(subagentFiberRef, null)
            } else {
              const evalState = yield* Ref.get(gameStateRef)
              const planBeforeEval = yield* Ref.get(planRef)
              yield* evaluateCompletedSubagent(subagentRefs, planRefs, timingRefs, evalServices, evalState)
              yield* maybeCompleteProcedure()
              const planAfterEval = yield* Ref.get(planRef)
              if (planBeforeEval !== null && planAfterEval === null) {
                consecutiveFailures++
                const currentTick = yield* Ref.get(tickCountRef)
                if (consecutiveFailures >= 5) {
                  yield* logToConsole(config.char.name, "monitor", "Step failed " + consecutiveFailures + "x consecutively -- halting replan.")
                  yield* Ref.update(softAlertAccRef, (acc) => {
                    const next = new Map(acc)
                    next.set("replan:blocked", { priority: "high", message: "Replan loop halted after " + consecutiveFailures + " consecutive failures.", suggestedAction: "Diagnose why the step keeps failing. Change approach or accept a different task.", ruleName: "replan:blocked" })
                    return next
                  })
                  replanBlockedUntilTick = currentTick + 999
                } else if (consecutiveFailures >= 3) {
                  yield* logToConsole(config.char.name, "monitor", "Step failed " + consecutiveFailures + "x consecutively -- pausing replan for 5 ticks")
                  yield* Ref.update(softAlertAccRef, (acc) => {
                    const next = new Map(acc)
                    next.set("replan:blocked", { priority: "low", message: "Step has failed " + consecutiveFailures + " times. Pausing replan briefly.", suggestedAction: "Change strategy -- the current step keeps failing.", ruleName: "replan:blocked" })
                    return next
                  })
                  replanBlockedUntilTick = currentTick + 5
                }
              } else if (planBeforeEval !== null && planAfterEval !== null) {
                consecutiveFailures = 0
                replanBlockedUntilTick = 0
                yield* Ref.update(softAlertAccRef, (acc) => { const next = new Map(acc); next.delete("replan:blocked"); return next })
              }
            }
          }
        }

        // Plan + spawn cycle — runs concurrently with Prayer
        yield* planAndSpawn(state, summary)

        // Emit status snapshot for Overlord monitoring
        yield* emitStatus(state, summary, "active").pipe(Effect.catchAll(() => Effect.void))
      })

    /** Process a reset event (e.g. death): kill everything, start fresh. */
    const handleReset = () =>
      Effect.gen(function* () {
        if (hooks?.onReset) {
          yield* hooks.onReset()
        }
        yield* killSubagent(subagentFiberRef)
        // Halt Prayer if running (death → Prayer session is stale)
        if (prayerManager) {
          const agentId = config.char.name.toLowerCase()
          yield* Effect.promise(() => prayerManager!.halt(agentId)).pipe(Effect.catchAll(() => Effect.void))
          yield* Ref.set(prayerRunningRef, false)
        }
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
