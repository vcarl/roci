import { Effect, Queue, Option, Fiber } from "effect"
import { CommandExecutor } from "@effect/platform"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterFs } from "../services/CharacterFs.js"
import { ModelService } from "../services/ModelService.js"
import { SpawnError, ReadinessError } from "../services/model-backend.js"
import { CharacterLog, logToConsole, logError } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { EventProcessorTag } from "../core/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../core/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../core/limbic/amygdala/interrupt.js"
import { StateRendererTag } from "../core/state-renderer.js"
import { PromptBuilderTag } from "../core/prompt-builder.js"
import { ConsciousThought } from "../conscious/conscious-thought.js"
import { consciousModelLabel } from "../conscious/opencode-config.js"
import type { TurnResult } from "../core/limbic/hypothalamus/types.js"
import { ModelClient } from "../model/client.js"
import type { ModelError } from "../model/errors.js"
import { DEFAULT_CORTEX_MODELS, resolveHandle, type CortexModelConfig } from "../model/handles.js"
import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "../core/model-config.js"
import { TEMPLATE_PALETTE } from "../core/palette.js"
import type { Cadence } from "../skills/cadence.js"
import type { Alert } from "../core/types.js"
import { Docker } from "../services/Docker.js"
import {
  runHindbrain,
  runForebrain,
  runConsciousDecide,
  runConsciousEvaluate,
  runDiaryTurn,
  type CortexRunnerConfig,
} from "./tiers.js"
import {
  freshCortexState,
  shouldForceOrient,
  planSteps,
  decideSteps,
  discoverToPlan,
  isWedgedEmptyPlan,
  isWellFormedDiscover,
  formatStepTask,
  formatExecutionReport,
  formatSteerDirective,
  detectCompletion,
  STEP_DONE_MARKER,
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
// workerTimeoutMs is reused as the per-turn wall-clock timeout in 4b.
// (Previously it bounded a whole delegation step; now it bounds each conscious turn.
// A dedicated consciousTurnTimeoutMs knob is deferred tuning — Phase 4c.)
const DEFAULT_WORKER_TIMEOUT_MS = 60 * 60 * 1000

/**
 * Push a `steer` line to the active session at most once every this-many ticks
 * (§7) — a knob alongside DEFAULT_ORIENT_INTERVAL. Exported so it is not an unused local.
 * Tunable per cadence profile (spec §11 open question).
 */
export const DEFAULT_STEER_CADENCE_TICKS = 3

const AVAILABLE_ACTIONS =
  "Each plan step is executed by the conscious agent (local LLM in an OpenCode session with full tool access). Plan concrete steps; each step.task names the action and step.goal describes the outcome."

export const runCortex = (config: CortexLoopConfig) =>
  Effect.gen(function* () {
    const eventProcessor = yield* EventProcessorTag
    const classifier = yield* SituationClassifierTag
    const interrupts = yield* InterruptRegistryTag
    const renderer = yield* StateRendererTag
    const promptBuilder = yield* PromptBuilderTag
    const consciousThought = yield* ConsciousThought
    const charFs = yield* CharacterFs

    const cadence: Cadence = config.cadence ?? "planned-action"
    const orientInterval = config.orientInterval ?? DEFAULT_ORIENT_INTERVAL
    const tickMs = config.tickIntervalMs ?? DEFAULT_TICK_MS
    const workerTimeoutMs = config.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS
    const palette = yield* charFs
      .readPalette(config.char)
      .pipe(Effect.catchAll(() => Effect.succeed(TEMPLATE_PALETTE)))
    const runnerConfig: CortexRunnerConfig = {
      char: config.char,
      cadence,
      models: config.cortexModels ?? DEFAULT_CORTEX_MODELS,
      palette,
    }

    // Issue 1 (fail loud): read an identity/memory file, but never silently
    // swallow a read failure. On error, emit a structured kind:"error" event
    // (so the model's loss of grounding is diagnosable) and degrade to "". The
    // log-write itself is swallowed so logging can never crash the loop.
    const readOrEmpty = (label: string, read: Effect.Effect<string, unknown, never>) =>
      read.pipe(
        Effect.catchAll((e) =>
          logError(config.char.name, "cortex", `${label} read failed; using empty: ${e}`).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.as(""),
          ),
        ),
      )

    let state = config.initialState
    const cortex = freshCortexState()
    let tick = 0
    let stepStartTick = 0
    // Self-drive: set when the loop drops to idle after a replan / plan-completion so the
    // next tick re-orients even with no inbound events (a quiet world would otherwise
    // never re-trigger the forebrain). Consumed (cleared) after forcing one orient.
    let forceOrientNext = false
    let stepStartSnapshot = renderer.richSnapshot(state as never)
    // Orient headline of the in-progress plan — context for every step.
    let planHeadline = ""

    // Conscious-session state (replaces delegationFiber / forkStep machinery).
    let consciousFiber: Fiber.RuntimeFiber<{ result: TurnResult; sessionId: string }, never> | null = null
    let sessionId: string | null = null
    let stepReport = ""
    let stepDoneSignaled = false
    // Steering state: capacity-1 coalescing (overwrite = newest wins).
    let pendingDirective: string | null = null
    let lastSteerTick = 0

    // Provision the conscious agent once before the first tick.
    const handle = resolveHandle(runnerConfig.models, "conscious")
    // `-m` label for body turns — the real mlx-served id. MUST match the agent file's
    // frontmatter `model:` (written from the same handle at provision time).
    const bodyModelLabel = consciousModelLabel(handle)
    const systemPrompt = promptBuilder.systemPrompt("select", "")
    yield* consciousThought.provision({
      containerId: config.containerId,
      char: config.char,
      handle,
      systemPrompt,
      frontierModel: (config.workerModels ?? DEFAULT_MODEL_CONFIG).tiers.reasoning,
      frontierTimeoutMs: workerTimeoutMs,
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
          }).pipe(
            Effect.catchAll((e) =>
              logError(config.char.name, "cortex", `event error: ${e}`).pipe(
                Effect.catchAll(() => Effect.void),
              ),
            ),
          )
          tickEvents.push(
            typeof event === "object" && event !== null
              ? `type: ${(event as Record<string, unknown>).type ?? "unknown"}\n${JSON.stringify(event)}`
              : String(event),
          )
        }
      }

      // 2. Classify + critical interrupts (the amygdala cuts the line).
      const summary = classifier.summarize(state as never)
      const bar = renderer.formatStateBar(summary.metrics)
      if (bar) yield* logToConsole(config.char.name, "state", bar)
      const criticals = interrupts.criticals(state as never, summary.situation)
      if (criticals.length > 0) {
        yield* logToConsole(
          config.char.name,
          "orchestrator",
          `Critical: ${criticals.map((a) => a.message).join("; ")}`,
        )
        if (consciousFiber) yield* Fiber.interrupt(consciousFiber)
        return { _tag: "Interrupted" as const, finalState: state, criticals }
      }

      // 3. If a conscious turn is in flight, check whether it finished.
      if (consciousFiber) {
        const done = yield* Fiber.poll(consciousFiber).pipe(Effect.map(Option.isSome))
        if (done) {
          const turnOutcome: { result: TurnResult; sessionId: string } = yield* Fiber.join(consciousFiber)
          consciousFiber = null
          sessionId = turnOutcome.sessionId
          // Append turn output to the accumulated step report.
          const turnOutput = turnOutcome.result.output ?? ""
          stepReport = stepReport ? `${stepReport}\n${turnOutput}` : turnOutput
          // Check whether the agent signaled completion.
          if (detectCompletion(turnOutput)) {
            stepDoneSignaled = true
          }
        }
        // While a turn runs, fall through to triage the world, then sleep.
      }

      // 4. HINDBRAIN triage — ungated: runs whenever there are events, even mid-session.
      let escalate = tick === 1
      if (forceOrientNext) {
        escalate = true
        forceOrientNext = false
      }
      let nonDiscard = false
      if (tickEvents.length > 0) {
        const observe = yield* runHindbrain(runnerConfig, tickEvents, cortex.waitState)
        yield* logToConsole(
          config.char.name,
          "cortex",
          `hindbrain: ${observe.disposition} ${observe.emotionalWeight}`,
        )
        cortex.emotionalWeight = observe.emotionalWeight
        if (observe.disposition !== "discard") {
          cortex.accumulatedEvents.push(...tickEvents)
          nonDiscard = true
        }
        if (observe.disposition === "escalate") escalate = true
      }
      if (!escalate && shouldForceOrient(cortex, tick, orientInterval)) escalate = true

      // 5. FOREBRAIN — two disjoint call sites, never both in the same tick.
      if (cortex.currentPlan === null) {
        // 5a. Idle path: orient → decide → plan (unchanged from pre-4b).
        if (escalate) {
          const background = yield* readOrEmpty("background", charFs.readBackground(config.char))
          const values = yield* readOrEmpty("values", charFs.readValues(config.char))
          const diary = yield* readOrEmpty("diary", charFs.readDiary(config.char))
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
          } else if (decide.decision === "discover" && isWellFormedDiscover(decide)) {
            // Discover reuses the plan/step path: translate to a synthetic
            // one-step plan and run it through the existing step executor.
            // isWellFormedDiscover guards against a partial model output
            // (`{"decision":"discover"}` with no `discover` object or a non-array
            // `questions`). A malformed payload falls through here (no plan set
            // this tick) — same graceful degradation as the empty-steps plan guard.
            cortex.currentPlan = discoverToPlan(decide)
            cortex.currentStepIndex = 0
            planHeadline = orient.headline
          } else if (decideSteps(decide).length > 0) {
            // decideSteps is array-safe: a parseable `{"decision":"plan"}` with
            // a missing/non-array/empty `steps` yields [] here (parseOr's
            // fallback is the `continue` variant, so `decide.steps` can be
            // undefined). A plan with no actionable steps is treated as no plan
            // started — never a crash on `decide.steps.length`.
            cortex.currentPlan = decide
            cortex.currentStepIndex = 0
            planHeadline = orient.headline
          } else if (decide.decision === "plan") {
            // Issue 4 (fail loud): the model decided "plan" but produced no
            // actionable steps. The guard above correctly keeps it from going
            // active, but dropping it silently hides a misbehaving model — an
            // agent that keeps emitting empty plans would spin invisibly. Warn
            // (not error): self-healing, since the next escalate tick re-orients.
            yield* logToConsole(
              config.char.name,
              "cortex",
              "decide=plan produced no actionable steps; dropped (will re-orient)",
              "warn",
            )
          }
        }
      } else {
        // 5b. In-session path: on a NON-DISCARD hindbrain disposition,
        // run forebrain → formatSteerDirective → store as pendingDirective (overwrite = coalesce).
        // Runs on EVERY non-discard tick (spec §3-5b / §4); the cadence throttle
        // (DEFAULT_STEER_CADENCE_TICKS) + capacity-1 coalescing bound the actual steer turns.
        if (nonDiscard) {
          const background = yield* readOrEmpty("background", charFs.readBackground(config.char))
          const values = yield* readOrEmpty("values", charFs.readValues(config.char))
          const diary = yield* readOrEmpty("diary", charFs.readDiary(config.char))
          const orient = yield* runForebrain(
            runnerConfig,
            cortex.accumulatedEvents,
            JSON.stringify(summary, null, 2),
            { background, values, diary },
            cortex.emotionalWeight,
          )
          yield* logToConsole(config.char.name, "cortex", `forebrain (in-session): ${orient.headline}`)
          // Laundered directive: formatSteerDirective formats model-generated forebrain output.
          pendingDirective = formatSteerDirective(orient)
          cortex.accumulatedEvents = []
          cortex.lastOrientTick = tick
        }
      }

      // 6. Step execution — when a plan is active and no conscious turn is in flight.
      if (cortex.currentPlan !== null && !consciousFiber) {
        const steps = planSteps(cortex.currentPlan)
        const step = steps[cortex.currentStepIndex]
        if (isWedgedEmptyPlan(cortex.currentPlan)) {
          // Issue 4 (structural invariant): an active plan with no executable
          // steps would wedge the loop forever (no step → no execute → no
          // evaluate → no advance). Unreachable via the guarded assignment site
          // above, but assert it defensively: fail loudly with a structured error
          // and self-heal by clearing the plan + forcing a fresh orient.
          yield* logError(
            config.char.name,
            "cortex",
            "invariant violation: active plan has no executable steps; resetting to re-orient",
          ).pipe(Effect.catchAll(() => Effect.void))
          cortex.currentPlan = null
          cortex.lastOrientTick = 0
        } else if (step) {
          const ticksConsumed = tick - stepStartTick
          // A step cannot be "over budget" before it has opened a session (forked its
          // first turn). Without this guard, a stale stepStartTick (e.g. a plan assigned
          // after a long idle) makes a brand-new step appear instantly elapsed and get
          // salvage-evaluated on the same tick it is assigned — its turn never forks.
          const budgetElapsed = sessionId !== null && ticksConsumed >= step.timeoutTicks

          // 6a. Evaluate now if the agent signaled done OR the tick-budget expired.
          if (stepDoneSignaled || budgetElapsed) {
            if (stepDoneSignaled) {
              yield* logToConsole(config.char.name, "orchestrator", `step done-marker detected; evaluating`)
            } else {
              yield* logToConsole(config.char.name, "orchestrator", `step tick-budget elapsed (${ticksConsumed}/${step.timeoutTicks}); salvage evaluate`)
            }
            const after = renderer.richSnapshot(state as never)
            const stepIdx = cortex.currentStepIndex
            const conditionCheck = stepDoneSignaled
              ? `Agent signaled completion (${STEP_DONE_MARKER}) after ${ticksConsumed} ticks`
              : `Tick budget elapsed: ${ticksConsumed} ticks consumed of ${step.timeoutTicks} budgeted; no completion signal`
            const evalResult = yield* runConsciousEvaluate(runnerConfig, {
              task: step.task,
              goal: step.goal,
              successCondition: step.successCondition,
              ticksBudgeted: step.timeoutTicks,
              ticksConsumed,
              executionReport: formatExecutionReport(stepReport),
              stateDiff: renderer.stateDiff(stepStartSnapshot, after),
              conditionCheck,
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
            // Dedicated diary turn — a separate model turn that always produces a
            // short first-person reflection on the step just completed (replaces the
            // old optional `diaryEntry` field the small conscious model omitted). The
            // turn is bounded and best-effort: a timeout or model error degrades to an
            // empty entry rather than stalling or crashing the loop.
            //
            // Issue 1 (fail loud): a timeout OR model error must NOT vanish — emit a
            // structured kind:"error" event (distinguishing the timeout tag from a
            // model error) before degrading to "". Losing one reflection is
            // tolerable; losing it invisibly is not.
            const diaryEntry = yield* runDiaryTurn(runnerConfig, {
              charName: config.char.name,
              task: step.task,
              goal: step.goal,
              judgment: evalResult.judgment,
              reasoning: evalResult.reasoning,
              executionReport: formatExecutionReport(stepReport),
              emotionalState: cortex.emotionalWeight,
            }).pipe(
              Effect.timeout("30 seconds"),
              Effect.catchAll((e) =>
                logError(
                  config.char.name,
                  "cortex",
                  `diary turn failed (${(e as { _tag?: string })._tag ?? "error"}); entry dropped: ${e}`,
                ).pipe(Effect.catchAll(() => Effect.void), Effect.as("")),
              ),
            )
            if (diaryEntry) {
              // Read the existing diary loudly too: a swallowed read here would
              // clobber prior entries (existing="" → overwrite with just the new one).
              const existing = yield* readOrEmpty("diary", charFs.readDiary(config.char))
              yield* charFs
                .writeDiary(config.char, existing ? `${existing}\n\n${diaryEntry}` : diaryEntry)
                .pipe(
                  Effect.catchAll((e) =>
                    logError(config.char.name, "cortex", `diary write failed: ${e}`).pipe(
                      Effect.catchAll(() => Effect.void),
                    ),
                  ),
                )
              yield* logToConsole(
                config.char.name,
                "cortex",
                `diary_entry_appended: (${diaryEntry.length} chars)`,
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
              // Self-drive a re-orient next tick — a quiet world has no event to retrigger.
              forceOrientNext = true
            } else {
              // next_step: advance and reset session state for the new step.
              cortex.currentStepIndex++
              if (cortex.currentStepIndex >= steps.length) {
                cortex.currentPlan = null
                // Plan complete → self-drive a re-orient next tick (same stall as replan).
                forceOrientNext = true
              }
            }
            // Reset per-step session state for the next step (or next plan).
            sessionId = null
            stepReport = ""
            stepDoneSignaled = false
            pendingDirective = null
            lastSteerTick = 0
            stepStartTick = tick
            stepStartSnapshot = renderer.richSnapshot(state as never)
          } else {
            // 6b. Budget not elapsed, no done-signal — fork the next turn.
            if (sessionId === null) {
              // Turn 1: open the session.
              stepStartTick = tick
              stepStartSnapshot = renderer.richSnapshot(state as never)
              yield* logToConsole(config.char.name, "orchestrator", `conscious turn 1: ${step.task}`)
              consciousFiber = yield* Effect.fork(
                consciousThought.turn(
                  {
                    containerId: config.containerId,
                    playerName: config.char.name,
                    char: config.char,
                    prompt: formatStepTask(step, planHeadline),
                    timeoutMs: workerTimeoutMs,
                    modelLabel: bodyModelLabel,
                  },
                  // No resume on turn 1.
                ),
              )
            } else if (
              pendingDirective !== null &&
              tick - lastSteerTick >= DEFAULT_STEER_CADENCE_TICKS
            ) {
              // Steer turn: send the latest coalesced directive to the existing session.
              const directive = pendingDirective
              pendingDirective = null
              lastSteerTick = tick
              yield* logToConsole(config.char.name, "orchestrator", `conscious steer turn (session ${sessionId})`)
              consciousFiber = yield* Effect.fork(
                consciousThought.turn(
                  {
                    containerId: config.containerId,
                    playerName: config.char.name,
                    char: config.char,
                    prompt: directive,
                    timeoutMs: workerTimeoutMs,
                    modelLabel: bodyModelLabel,
                  },
                  { sessionId },
                ),
              )
            }
            // Otherwise: session is open, waiting for turn result or cadence window.
          }
        }
      }

      // 7. Sleep one tick.
      yield* Effect.sleep(`${tickMs} millis`)
    }
  }) as Effect.Effect<
    CortexResult,
    ModelError | SpawnError | ReadinessError,
    | EventProcessorTag
    | SituationClassifierTag
    | InterruptRegistryTag
    | StateRendererTag
    | PromptBuilderTag
    | CharacterFs
    | CharacterLog
    | ModelClient
    | ModelService
    | ConsciousThought
    | Docker
    | CommandExecutor.CommandExecutor
    | OAuthToken
  >
