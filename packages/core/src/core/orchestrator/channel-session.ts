import { Effect, Queue, Option } from "effect"
import type { CharacterConfig } from "../../services/CharacterFs.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { CommandExecutor } from "@effect/platform"
import { EventProcessorTag } from "../limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../limbic/amygdala/interrupt.js"
import { PromptBuilderTag } from "../prompt-builder.js"
import { StateRendererTag } from "../state-renderer.js"
import { SkillRegistryTag } from "../skill.js"
import { runSession } from "../limbic/hypothalamus/session-runner.js"
import type { SessionHandle } from "../limbic/hypothalamus/session-runner.js"
import { OAuthToken } from "../../services/OAuthToken.js"
import { CharacterLog, logToConsole } from "../../logging/log-writer.js"
import type { Alert } from "../types.js"
import type { Cadence } from "../../skills/cadence.js"
import type { ModelConfig } from "../model-config.js"
import { DEFAULT_MODEL_CONFIG } from "../model-config.js"
import {
  runObserve, runOrient, runDecide, runEvaluate,
  formatExecutionReport,
  type OodaRunnerConfig, type OodaState,
} from "../ooda-runner.js"
import type { DecideResult, WaitState } from "../../skills/types.js"
import { dream } from "../limbic/hippocampus/dream.js"

// ── Types ────────────────────────────────────────────────────

export interface ChannelSessionConfig {
  char: CharacterConfig
  containerId: string
  containerEnv?: Record<string, string>
  addDirs?: string[]
  events: Queue.Queue<unknown>
  initialState: unknown
  /** Model to use for the persistent session (e.g. "sonnet", "opus"). Default: "sonnet". */
  sessionModel?: string
  sessionTimeoutMs?: number
  channelPort?: number
  /** Domain cadence: "real-time" or "planned-action". Affects OODA skill behavior. */
  cadence?: Cadence
  /** Model config for OODA skill invocations. */
  models?: ModelConfig
  /** Dream configuration. If provided, enables dream as a step within the OODA loop. */
  dream?: {
    /** Run dream every N completed OODA cycles. Default: 2. */
    cycleInterval?: number
    /** Maximum ticks between dreams regardless of OODA cycle count. Default: 120 (~60 min). */
    maxIntervalTicks?: number
  }
  /** How many ticks of accumulated events before forcing an orient, even without escalation. Default: 5. */
  orientInterval?: number
}

export type ChannelSessionResult =
  | { readonly _tag: "Completed"; readonly finalState: unknown }
  | { readonly _tag: "Interrupted"; readonly finalState: unknown; readonly criticals: Alert[] }

// ── Default constants ────────────────────────────────────────

const DEFAULT_SESSION_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour
const TICK_INTERVAL_MS = 30_000 // 30 seconds
const POST_SPAWN_DELAY_MS = 2_000 // 2 seconds after spawning before pushing task
const DEFAULT_ORIENT_INTERVAL = 5

// ── runChannelSession ────────────────────────────────────────

export const runChannelSession = (config: ChannelSessionConfig) =>
  Effect.gen(function* () {
    const eventProcessor = yield* EventProcessorTag
    const classifier = yield* SituationClassifierTag
    const interruptRegistry = yield* InterruptRegistryTag
    const promptBuilder = yield* PromptBuilderTag
    const renderer = yield* StateRendererTag
    const skillRegistry = yield* SkillRegistryTag
    const charFs = yield* CharacterFs

    let currentState = config.initialState
    let prevSnapshot = renderer.richSnapshot(currentState)
    let sessionHandle: SessionHandle | null = null
    let tickNumber = 0

    const sessionTimeoutMs = config.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS
    const sessionModel = config.sessionModel ?? "sonnet"
    const orientInterval = config.orientInterval ?? DEFAULT_ORIENT_INTERVAL
    const models = config.models ?? DEFAULT_MODEL_CONFIG
    const cadence = config.cadence ?? "planned-action"

    // OODA state
    const oodaState: OodaState = {
      accumulatedEvents: [],
      emotionalWeight: "",
      currentPlan: null,
      currentStepIndex: 0,
      stepStartTick: 0,
      waitState: null,
      lastOrientTick: 0,
    }
    let stepStartSnapshot: Record<string, unknown> | null = null
    let oodaCycleCount = 0
    let lastDreamCycle = 0
    let lastDreamTick = 0

    // OODA runner config
    const oodaConfig: OodaRunnerConfig = {
      containerId: config.containerId,
      playerName: config.char.name,
      char: config.char,
      cadence,
      models,
      addDirs: config.addDirs,
      env: config.containerEnv,
    }

    // Determine system prompt
    const systemPrompt = promptBuilder.systemPrompt("select", "")

    while (true) {
      tickNumber++

      // ── 1. Drain event queue (non-blocking) ──────────────────

      const tickEvents: string[] = []
      let queueDrained = false
      let pendingAlert: string | undefined
      while (!queueDrained) {
        const maybeEvent = yield* Queue.poll(config.events)
        if (Option.isNone(maybeEvent)) {
          queueDrained = true
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
            if (result.alert) {
              pendingAlert = result.alert
            }
            // Format event for observe input
            const eventStr = typeof event === "object" && event !== null
              ? `type: ${(event as Record<string, unknown>).type ?? "unknown"}\n${JSON.stringify(event)}`
              : String(event)
            tickEvents.push(eventStr)
          }).pipe(
            Effect.catchAll((e) =>
              logToConsole(config.char.name, "error", `Event processing error: ${e}`),
            ),
          )
        }
      }

      // ── 1b. Push any immediate alerts from event processing ──

      if (pendingAlert !== undefined && sessionHandle !== null) {
        yield* sessionHandle.pushEvent(pendingAlert, { type: "alert" }).pipe(
          Effect.catchAll((e) =>
            logToConsole(config.char.name, "error", `pushEvent (alert) failed: ${e}`),
          ),
        )
      }

      // ── 2. Evaluate interrupts ───────────────────────────────

      const summary = classifier.summarize(currentState)
      const allAlerts = interruptRegistry.evaluate(currentState, summary.situation)
      const criticals = allAlerts.filter((a) => a.priority === "critical")

      if (criticals.length > 0) {
        yield* logToConsole(
          config.char.name,
          "orchestrator",
          `Critical interrupt: ${criticals.map((a) => a.message).join("; ")} — stopping session`,
        )
        if (sessionHandle !== null) {
          yield* sessionHandle.interrupt
        }
        return {
          _tag: "Interrupted" as const,
          finalState: currentState,
          criticals,
        }
      }

      // ── 2b. Check if session has completed ──────────────────

      if (sessionHandle !== null) {
        const isComplete = yield* sessionHandle.join.pipe(
          Effect.timeoutOption("0 millis"),
          Effect.map(Option.isSome),
        )

        if (isComplete) {
          yield* logToConsole(
            config.char.name,
            "orchestrator",
            `Session completed naturally — tick ${tickNumber}`,
          )
          return {
            _tag: "Completed" as const,
            finalState: currentState,
          }
        }
      }

      // ── 3. OBSERVE — classify event batch ───────────────────

      let escalate = tickNumber === 1 // Force orient+decide on first tick
      let observeDisposition: "discard" | "accumulate" | "escalate" = "accumulate"

      if (tickEvents.length > 0 && sessionHandle !== null) {
        const observeResult = yield* runObserve(oodaConfig, tickEvents, oodaState.waitState)
        observeDisposition = observeResult.disposition

        yield* logToConsole(
          config.char.name,
          "ooda",
          `observe: ${observeResult.disposition} ${observeResult.emotionalWeight} — ${observeResult.reason}`,
        )

        if (observeResult.disposition === "escalate") {
          escalate = true
          oodaState.emotionalWeight = observeResult.emotionalWeight
          oodaState.accumulatedEvents.push(...tickEvents)
        } else if (observeResult.disposition === "accumulate") {
          oodaState.emotionalWeight = observeResult.emotionalWeight
          oodaState.accumulatedEvents.push(...tickEvents)
        }
        // discard: don't add to buffer
      }

      // Check orient interval — force orient if enough ticks accumulated without one
      if (
        sessionHandle !== null &&
        !escalate &&
        tickNumber - oodaState.lastOrientTick >= orientInterval &&
        oodaState.accumulatedEvents.length > 0
      ) {
        escalate = true
        yield* logToConsole(
          config.char.name,
          "ooda",
          `orient interval reached (${tickNumber - oodaState.lastOrientTick} ticks since last orient)`,
        )
      }

      // ── 4. ORIENT + DECIDE ──────────────────────────────────

      if (escalate && sessionHandle !== null) {
        // Read identity for orient
        const background = yield* charFs.readBackground(config.char).pipe(
          Effect.catchAll(() => Effect.succeed("")),
        )
        const values = yield* charFs.readValues(config.char).pipe(
          Effect.catchAll(() => Effect.succeed("")),
        )
        const diary = yield* charFs.readDiary(config.char).pipe(
          Effect.catchAll(() => Effect.succeed("")),
        )

        const domainState = JSON.stringify(summary, null, 2)

        // 4a. Run ORIENT
        const orientResult = yield* runOrient(
          oodaConfig,
          oodaState.accumulatedEvents,
          domainState,
          { background, values, diary },
          oodaState.emotionalWeight,
        )

        yield* logToConsole(
          config.char.name,
          "ooda",
          `orient: ${orientResult.headline}`,
        )

        // 4b. Run DECIDE
        const currentPlanState = oodaState.currentPlan
          ? `Active plan (step ${oodaState.currentStepIndex + 1}/${oodaState.currentPlan.decision === "plan" ? oodaState.currentPlan.steps.length : "?"})`
          : "No active plan."

        const decideResult = yield* runDecide(
          oodaConfig,
          orientResult,
          currentPlanState,
          skillRegistry.taskList(),
        )

        yield* logToConsole(
          config.char.name,
          "ooda",
          `decide: ${decideResult.decision} — ${decideResult.reasoning.slice(0, 100)}`,
        )

        // 4c. Act on decide result
        if (decideResult.decision === "plan") {
          oodaState.currentPlan = decideResult
          oodaState.currentStepIndex = 0
          oodaState.stepStartTick = tickNumber
          oodaState.waitState = null
          stepStartSnapshot = renderer.richSnapshot(currentState)

          // Push first step instructions to session
          const step = decideResult.steps[0]
          const stepContent = `## New Plan\n\n**Headline:** ${orientResult.headline}\n\n### Step 1: ${step.task}\n**Goal:** ${step.goal}\n**Success condition:** ${step.successCondition}\n\nBegin working on this step.`
          yield* sessionHandle.pushEvent(stepContent, { type: "task" }).pipe(
            Effect.catchAll((e) =>
              logToConsole(config.char.name, "error", `pushEvent (plan) failed: ${e}`),
            ),
          )
        } else if (decideResult.decision === "continue") {
          // Push status update
          yield* sessionHandle.pushEvent(
            `## Status Update\n\n${orientResult.headline}\n\nCurrent work remains valid. Continue.`,
            { type: "tick" },
          ).pipe(
            Effect.catchAll((e) =>
              logToConsole(config.char.name, "error", `pushEvent (continue) failed: ${e}`),
            ),
          )
        } else if (decideResult.decision === "wait") {
          oodaState.waitState = decideResult.wait
          oodaState.currentPlan = null
          yield* sessionHandle.pushEvent(
            `## Waiting\n\n${decideResult.reasoning}\n\nWaiting for: ${decideResult.wait.waitingFor}`,
            { type: "tick" },
          ).pipe(
            Effect.catchAll((e) =>
              logToConsole(config.char.name, "error", `pushEvent (wait) failed: ${e}`),
            ),
          )
          if (decideResult.wait.disposition === "terminate") {
            yield* logToConsole(config.char.name, "orchestrator", "Wait disposition=terminate — ending session")
            yield* sessionHandle.interrupt
            return { _tag: "Completed" as const, finalState: currentState }
          }
        } else if (decideResult.decision === "terminate") {
          yield* logToConsole(config.char.name, "orchestrator", `Terminate: ${decideResult.summary}`)
          yield* sessionHandle.interrupt
          return { _tag: "Completed" as const, finalState: currentState }
        }

        // Clear accumulation buffer, update orient tick
        oodaState.accumulatedEvents = []
        oodaState.lastOrientTick = tickNumber
        oodaCycleCount++
      } else if (sessionHandle !== null && observeDisposition !== "escalate") {
        // No orient — push heartbeat or minimal update
        if (observeDisposition === "discard") {
          // Minimal heartbeat
          yield* sessionHandle.pushEvent(
            JSON.stringify({ type: "heartbeat", tick: tickNumber }),
            { type: "tick" },
          ).pipe(
            Effect.catchAll((e) =>
              logToConsole(config.char.name, "error", `pushEvent (heartbeat) failed: ${e}`),
            ),
          )
        } else {
          // Accumulate — push lightweight state update via fallback
          const currentSnapshot = renderer.richSnapshot(currentState)
          const stateDiff = renderer.stateDiff(prevSnapshot, currentSnapshot)
          const softAlerts = allAlerts.filter((a) => a.priority !== "critical")

          const channelEventContent =
            promptBuilder.channelEvent?.({
              summary,
              stateDiff: stateDiff || undefined,
              softAlerts: softAlerts.length > 0 ? softAlerts : undefined,
              tickNumber,
            }) ?? JSON.stringify({ summary: summary.headline, stateDiff, tickNumber })

          yield* sessionHandle.pushEvent(channelEventContent, { type: "tick" }).pipe(
            Effect.catchAll((e) =>
              logToConsole(config.char.name, "error", `pushEvent (tick) failed: ${e}`),
            ),
          )

          prevSnapshot = currentSnapshot
        }
      }

      // ── 5. EVALUATE — check step budget ─────────────────────

      if (
        sessionHandle !== null &&
        oodaState.currentPlan !== null &&
        oodaState.currentPlan.decision === "plan"
      ) {
        const currentStep = oodaState.currentPlan.steps[oodaState.currentStepIndex]
        const ticksConsumed = tickNumber - oodaState.stepStartTick

        if (currentStep && ticksConsumed >= currentStep.timeoutTicks) {
          yield* logToConsole(
            config.char.name,
            "ooda",
            `evaluate: step ${oodaState.currentStepIndex + 1} budget expired (${ticksConsumed}/${currentStep.timeoutTicks} ticks)`,
          )

          // Build evaluate inputs
          const currentSnapshot = renderer.richSnapshot(currentState)
          const stateDiff = stepStartSnapshot != null
            ? renderer.stateDiff(stepStartSnapshot, currentSnapshot)
            : null

          // Drain tool events for execution report
          const toolEvents = yield* sessionHandle.drainEvents()
          const executionReport = formatExecutionReport(
            toolEvents.map((e) => {
              const ev = e as unknown as Record<string, unknown>
              return {
                kind: e.kind,
                tool: ev.tool as string | undefined,
                input: ev.input,
                output: ev.output,
              }
            }),
          )

          // Deterministic condition check
          const conditionCheck = skillRegistry.isStepComplete(
            { task: currentStep.task, goal: currentStep.goal, successCondition: currentStep.successCondition, tier: currentStep.tier, timeoutTicks: currentStep.timeoutTicks },
            currentState as Record<string, unknown>,
            summary.situation,
          )
          const conditionStr = `${conditionCheck.complete ? "PASS" : "ADVISORY"}: ${conditionCheck.reason}`

          // Remaining steps
          const remainingSteps = oodaState.currentPlan.steps
            .slice(oodaState.currentStepIndex + 1)
            .map((s, i) => `${oodaState.currentStepIndex + 2 + i}. ${s.task}: ${s.goal}`)
            .join("\n")

          const evalResult = yield* runEvaluate(oodaConfig, {
            task: currentStep.task,
            goal: currentStep.goal,
            successCondition: currentStep.successCondition,
            ticksBudgeted: currentStep.timeoutTicks,
            ticksConsumed,
            executionReport,
            stateDiff: stateDiff || "No state changes observed.",
            conditionCheck: conditionStr,
            emotionalState: oodaState.emotionalWeight,
            remainingSteps: remainingSteps || "None — this is the last step.",
          })

          yield* logToConsole(
            config.char.name,
            "ooda",
            `evaluate: ${evalResult.judgment} → ${evalResult.transition.transition}`,
          )

          // Persist diary entry if present
          if (evalResult.diaryEntry) {
            yield* Effect.gen(function* () {
              const currentDiary = yield* charFs.readDiary(config.char).pipe(
                Effect.catchAll(() => Effect.succeed("")),
              )
              const updatedDiary = currentDiary
                ? `${currentDiary}\n\n${evalResult.diaryEntry}`
                : evalResult.diaryEntry!
              yield* charFs.writeDiary(config.char, updatedDiary)
            }).pipe(
              Effect.catchAll((e) =>
                logToConsole(config.char.name, "error", `Diary write failed: ${e}`),
              ),
            )
          }

          // Act on transition
          if (evalResult.transition.transition === "next_step") {
            oodaState.currentStepIndex++
            oodaState.stepStartTick = tickNumber
            stepStartSnapshot = renderer.richSnapshot(currentState)

            const nextStep = oodaState.currentPlan.steps[oodaState.currentStepIndex]
            if (nextStep) {
              yield* sessionHandle.pushEvent(
                `## Next Step (${oodaState.currentStepIndex + 1}/${oodaState.currentPlan.steps.length})\n\n**Task:** ${nextStep.task}\n**Goal:** ${nextStep.goal}\n**Success condition:** ${nextStep.successCondition}\n\nBegin working on this step.`,
                { type: "task" },
              ).pipe(
                Effect.catchAll((e) =>
                  logToConsole(config.char.name, "error", `pushEvent (next_step) failed: ${e}`),
                ),
              )
            } else {
              // Plan complete
              yield* logToConsole(config.char.name, "ooda", "Plan complete — all steps finished")
              oodaState.currentPlan = null
            }
          } else if (evalResult.transition.transition === "replan") {
            yield* logToConsole(config.char.name, "ooda", `Replanning: ${evalResult.transition.reason}`)
            oodaState.currentPlan = null
            // Force orient+decide on next tick
            oodaState.lastOrientTick = 0
            yield* sessionHandle.pushEvent(
              `## Replanning\n\n${evalResult.transition.reason}\n\nA new plan will be provided shortly.`,
              { type: "tick" },
            ).pipe(
              Effect.catchAll((e) =>
                logToConsole(config.char.name, "error", `pushEvent (replan) failed: ${e}`),
              ),
            )
          } else if (evalResult.transition.transition === "wait") {
            oodaState.waitState = evalResult.transition.wait
            oodaState.currentPlan = null
            yield* sessionHandle.pushEvent(
              `## Waiting\n\nWaiting for: ${evalResult.transition.wait.waitingFor}`,
              { type: "tick" },
            ).pipe(
              Effect.catchAll((e) =>
                logToConsole(config.char.name, "error", `pushEvent (eval-wait) failed: ${e}`),
              ),
            )
          } else if (evalResult.transition.transition === "terminate") {
            yield* logToConsole(config.char.name, "orchestrator", `Evaluate terminate: ${evalResult.transition.summary}`)
            yield* sessionHandle.interrupt
            return { _tag: "Completed" as const, finalState: currentState }
          }
        }
      }

      // ── 6. DREAM — memory consolidation ─────────────────────

      if (config.dream && sessionHandle !== null) {
        const cycleInterval = config.dream.cycleInterval ?? 2
        const maxIntervalTicks = config.dream.maxIntervalTicks ?? 120
        const cyclesDue = oodaCycleCount - lastDreamCycle >= cycleInterval
        const timeDue = tickNumber - lastDreamTick >= maxIntervalTicks

        if (cyclesDue || timeDue) {
          const reason = cyclesDue
            ? `${oodaCycleCount - lastDreamCycle} OODA cycles since last dream`
            : `${tickNumber - lastDreamTick} ticks since last dream (ceiling)`
          yield* logToConsole(config.char.name, "orchestrator", `Dream — ${reason}`)
          yield* dream.execute({
            char: config.char,
            containerId: config.containerId,
            playerName: config.char.name,
            addDirs: config.addDirs,
            env: config.containerEnv,
            models,
          }).pipe(
            Effect.catchAll((e) =>
              logToConsole(config.char.name, "error", `Dream failed: ${e}`),
            ),
          )
          lastDreamCycle = oodaCycleCount
          lastDreamTick = tickNumber
        }
      }

      // ── 7. If no session: start one ──────────────────────────

      if (sessionHandle === null) {
        yield* logToConsole(
          config.char.name,
          "orchestrator",
          `Starting channel session (model=${sessionModel})`,
        )

        // Read identity
        const background = yield* charFs.readBackground(config.char).pipe(
          Effect.catchAll(() => Effect.succeed("")),
        )
        const values = yield* charFs.readValues(config.char).pipe(
          Effect.catchAll(() => Effect.succeed("")),
        )
        const diary = yield* charFs.readDiary(config.char).pipe(
          Effect.catchAll(() => Effect.succeed("")),
        )

        // Build task prompt content — fallback to promptBuilder if no OODA yet
        const taskContent =
          promptBuilder.taskPrompt?.({
            state: currentState,
            summary,
            diary,
            background,
            values,
          }) ?? "Begin working."

        // Spawn session
        const handle = yield* runSession({
          containerId: config.containerId,
          playerName: config.char.name,
          systemPrompt,
          model: sessionModel,
          sessionTimeoutMs,
          env: config.containerEnv,
          addDirs: config.addDirs,
          char: config.char,
          channelPort: config.channelPort,
        })

        sessionHandle = handle

        // Wait 2 seconds then push the task as first channel event
        yield* Effect.sleep(`${POST_SPAWN_DELAY_MS} millis`)
        yield* sessionHandle.pushEvent(taskContent, { type: "task" }).pipe(
          Effect.catchAll((e) =>
            logToConsole(config.char.name, "error", `pushEvent (task) failed: ${e}`),
          ),
        )

        yield* logToConsole(
          config.char.name,
          "orchestrator",
          `Session started — task event pushed`,
        )
      }

      // ── 8. Sleep tick interval ───────────────────────────────

      yield* Effect.sleep(`${TICK_INTERVAL_MS} millis`)
    }
  })
