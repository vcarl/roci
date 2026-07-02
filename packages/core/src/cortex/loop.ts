import { Effect, Queue, Option, Fiber } from "effect"
import { CommandExecutor } from "@effect/platform"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterFs } from "../services/CharacterFs.js"
import { ModelService } from "../services/ModelService.js"
import { SpawnError, ReadinessError } from "../services/model-backend.js"
import { CharacterLog, logToConsole, logError, logBehavior } from "../logging/log-writer.js"
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
import { TEMPLATE_DRIVES } from "../core/drives.js"
import type { Cadence } from "../skills/cadence.js"
import type { Alert } from "../core/types.js"
import type { ObserveResult } from "../skills/types.js"
import { Docker } from "../services/Docker.js"
import {
  MemoryGateway,
  observeMemories,
  orientMemories,
  decideMemories,
  evaluateMemories,
  orientQuery,
  decideQuery,
  evaluateQuery,
} from "../conscious/memory-gateway.js"
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
  appraiseTick,
  emptyEscalation,
  DEFAULT_APPRAISAL_THRESHOLDS,
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

/**
 * The deterministic appraisal for an INERT event — one that produced no
 * `stateUpdate` (§3.2a fast-path). Tagged `discard`/weight-0 WITHOUT a model
 * call (habituation to non-salient stimuli), so noise costs nothing and never
 * escalates. Only state-changing events reach the 2B per-event observe.
 */
const INERT_APPRAISAL: ObserveResult = {
  disposition: "discard",
  emotionalWeight: "😐",
  drive: null,
  weight: 0,
  interrupt: false,
  reason: "inert event — no state change (fast-path discard)",
}

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
    const memory = yield* MemoryGateway

    const cadence: Cadence = config.cadence ?? "planned-action"
    const orientInterval = config.orientInterval ?? DEFAULT_ORIENT_INTERVAL
    const tickMs = config.tickIntervalMs ?? DEFAULT_TICK_MS
    const workerTimeoutMs = config.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS
    const palette = yield* charFs
      .readPalette(config.char)
      .pipe(Effect.catchAll(() => Effect.succeed(TEMPLATE_PALETTE)))
    const drives = yield* charFs
      .readDrives(config.char)
      .pipe(Effect.catchAll(() => Effect.succeed(TEMPLATE_DRIVES)))
    const runnerConfig: CortexRunnerConfig = {
      char: config.char,
      cadence,
      models: config.cortexModels ?? DEFAULT_CORTEX_MODELS,
      palette,
      drives,
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
    // Priority-steer flag: a `steer`-rung in-session escalation bypasses the
    // DEFAULT_STEER_CADENCE_TICKS throttle so the directive is pushed immediately (§3.2).
    let bypassSteerCadence = false

    // Drop the active plan and clear all per-session steering state, so the loop
    // re-orients from a clean slate. Shared by the in-session `reorient` and
    // `interrupt` rungs (§3.2); a closure so it can reset the loop-local lets, not
    // just `cortex`. (The `interrupt` rung additionally kills the in-flight fiber
    // before calling this; `reorient` lets the current turn finish naturally.)
    const resetPlanState = () => {
      cortex.currentPlan = null
      cortex.lastOrientTick = 0
      sessionId = null
      stepReport = ""
      stepDoneSignaled = false
      pendingDirective = null
      lastSteerTick = 0
      bypassSteerCadence = false
    }

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

      // 1. Drain world events into state. Track per-event whether it produced a
      // `stateUpdate` — an event that changed nothing is INERT and gets the
      // deterministic fast-path (no model call), bounding N_model to
      // state-changing events (§3.2a). An event whose processing threw produced
      // no state update either, so it is treated as inert (and logged loudly).
      const tickEvents: Array<{ text: string; inert: boolean }> = []
      let draining = true
      while (draining) {
        const maybe = yield* Queue.poll(config.events)
        if (Option.isNone(maybe)) {
          draining = false
        } else {
          const event = maybe.value
          let inert = true
          yield* Effect.try(() => {
            const r = eventProcessor.processEvent(event as never, state as never)
            if (r.stateUpdate) {
              state = r.stateUpdate(state as never)
              inert = false
            }
            if (r.log) r.log()
          }).pipe(
            Effect.catchAll((e) =>
              logError(config.char.name, "cortex", `event error: ${e}`).pipe(
                Effect.catchAll(() => Effect.void),
              ),
            ),
          )
          tickEvents.push({
            text:
              typeof event === "object" && event !== null
                ? `type: ${(event as Record<string, unknown>).type ?? "unknown"}\n${JSON.stringify(event)}`
                : String(event),
            inert,
          })
        }
      }

      // 2. Classify + critical interrupts (the amygdala cuts the line).
      const summary = classifier.summarize(state as never)
      const bar = renderer.formatStateBar(summary.metrics)
      if (bar) yield* logToConsole(config.char.name, "state", bar)
      const criticals = interrupts.criticals(state as never, summary.situation)
      if (criticals.length > 0) {
        yield* logBehavior(config.char.name, "cortex", "amygdala", {
          type: "note",
          label: "critical",
          severity: "warn",
          data: { messages: criticals.map((a) => a.message) },
        })
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

      // 4. HINDBRAIN per-event triage — ungated: runs whenever there are events,
      // even mid-session. Each state-changing event is appraised once by the 2B;
      // inert events are fast-pathed deterministically (no model call). The
      // per-event results are aggregated into one HindbrainEscalation (§4.4).
      let escalate = tick === 1
      if (forceOrientNext) {
        escalate = true
        forceOrientNext = false
      }
      const appraisals: Array<{ event: string; observe: ObserveResult }> = []
      for (const ev of tickEvents) {
        if (ev.inert) {
          appraisals.push({ event: ev.text, observe: INERT_APPRAISAL })
        } else {
          const observe = yield* runHindbrain(runnerConfig, ev.text, cortex.waitState)
          appraisals.push({ event: ev.text, observe })
          for (const w of observeMemories(observe)) {
            yield* memory.remember(config.containerId, config.char, w)
          }
        }
      }
      const esc =
        tickEvents.length > 0 ? appraiseTick(appraisals, DEFAULT_APPRAISAL_THRESHOLDS) : emptyEscalation()
      const nonDiscard = esc.accumulated.length > 0
      if (tickEvents.length > 0) {
        yield* logBehavior(config.char.name, "cortex", "hindbrain", {
          type: "appraisal",
          disposition: esc.rung,
          weight: esc.maxWeight,
          escalated: esc.escalate,
        })
        // Tick mood = the dominant (highest-weight) event's mood (§4.4).
        if (esc.dominant) cortex.emotionalWeight = esc.dominant.emotionalWeight
        if (esc.accumulated.length > 0) cortex.accumulatedEvents.push(...esc.accumulated)
        if (esc.escalate) escalate = true
      }
      if (!escalate && shouldForceOrient(cortex, tick, orientInterval)) escalate = true

      // Will section 6a evaluate this tick? Mirrors 6a's guard exactly (same
      // step, stepStartTick, sessionId — none mutated between here and 6a on any
      // path that reaches 6a). If true, a 5b steer forebrain call would be
      // wasted: 6a resets pendingDirective, discarding whatever directive it
      // produced. Computed here so 5b can skip that ~9B call. (Meaningful only
      // when a plan is active + no turn is in flight; false otherwise.)
      let willEvaluate = false
      if (cortex.currentPlan !== null && !consciousFiber && !isWedgedEmptyPlan(cortex.currentPlan)) {
        const step = planSteps(cortex.currentPlan)[cortex.currentStepIndex]
        if (step) {
          const budgetElapsed = sessionId !== null && tick - stepStartTick >= step.timeoutTicks
          willEvaluate = stepDoneSignaled || budgetElapsed
        }
      }

      // 5. FOREBRAIN — two disjoint call sites, never both in the same tick.
      if (cortex.currentPlan === null) {
        // 5a. Idle path: orient → decide → plan (unchanged from pre-4b).
        if (escalate) {
          const background = yield* readOrEmpty("background", charFs.readBackground(config.char))
          const values = yield* readOrEmpty("values", charFs.readValues(config.char))
          const diary = yield* readOrEmpty("diary", charFs.readDiary(config.char))
          const orientRecall = yield* memory.recall(
            config.containerId,
            config.char,
            orientQuery(cortex.accumulatedEvents, cortex.emotionalWeight),
            { k: 2, label: "You recall", maxChars: 300 },
          )
          const orient = yield* runForebrain(
            runnerConfig,
            cortex.accumulatedEvents,
            JSON.stringify(summary, null, 2),
            { background, values, diary },
            cortex.emotionalWeight,
            orientRecall,
          )
          yield* logBehavior(config.char.name, "cortex", "forebrain", { type: "orient", headline: orient.headline })
          for (const w of orientMemories(orient)) {
            yield* memory.remember(config.containerId, config.char, w)
          }
          const decideRecall = yield* memory.recall(
            config.containerId,
            config.char,
            decideQuery(orient),
            { k: 5, label: "Relevant memories" },
          )
          const decide = yield* runConsciousDecide(runnerConfig, orient, "No active plan.", AVAILABLE_ACTIONS, decideRecall)
          for (const w of decideMemories(decide)) {
            yield* memory.remember(config.containerId, config.char, w)
          }
          yield* (decide.decision === "plan" || decide.decision === "wait" || decide.decision === "terminate"
            ? logBehavior(config.char.name, "cortex", "conscious", { type: "decision", disposition: decide.decision })
            : logBehavior(config.char.name, "cortex", "conscious", { type: "note", label: `decision:${decide.decision}` }))
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
        // 5b. In-session path: apply the graded escalation ladder (§3.2, §4.4).
        // This is the in-session escalation consumption the pre-A loop lacked
        // (§1.2/§8.1). The amygdala critical path (section 2) is unchanged and
        // still owns hard-interrupt-to-EXIT; this is the in-LOOP graded route.
        if (esc.rung === "reorient" || esc.rung === "interrupt") {
          // Reorient — drop the plan so the idle path re-orients next tick. The
          // `interrupt` rung is exactly this plus a fiber-kill: gated behind an
          // explicit per-event interrupt:true (the 2B caps at reorient; it fires
          // for a genuine physical attack the amygdala would also catch, or a
          // future stronger tier), it kills the in-flight turn FIRST rather than
          // letting the current turn finish naturally. Both then drop the plan
          // and re-orient identically. Distinct from the amygdala critical, which
          // EXITS the loop to the break phase.
          if (esc.rung === "interrupt") {
            yield* logToConsole(
              config.char.name,
              "cortex",
              `hindbrain interrupt (in-session): ${esc.dominant?.reason ?? "drop-everything"}`,
              "warn",
            )
            if (consciousFiber) {
              yield* Fiber.interrupt(consciousFiber)
              consciousFiber = null
            }
          } else {
            yield* logToConsole(
              config.char.name,
              "cortex",
              `hindbrain reorient (in-session): ${esc.dominant?.reason ?? "high salience"}`,
            )
          }
          resetPlanState()
        } else if (esc.rung === "steer" || nonDiscard) {
          // steer / accumulate → run forebrain → formatSteerDirective → store as
          // pendingDirective (overwrite = coalesce). A `steer`-rung event bypasses
          // the cadence throttle (priority steer); an `accumulate`-rung event
          // steers on the normal throttle. The `esc.rung === "steer"` arm of the
          // gate (Nit 1) closes an asymmetry: an event with weight ≥ STEER but a
          // `discard` disposition computes rung "steer"/escalate:true (and the idle
          // path would orient), so the in-session path must steer on it too — even
          // though it never joined `accumulatedEvents` (so `nonDiscard` is false).
          // Skip the forebrain call entirely when this tick will evaluate (6a):
          // 6a resets pendingDirective, so the directive would be thrown away —
          // the whole ~9B call wasted. The bookkeeping (drain accumulatedEvents,
          // advance lastOrientTick) still runs so state is identical to the
          // non-skipped path minus the discarded model output.
          if (!willEvaluate) {
            const background = yield* readOrEmpty("background", charFs.readBackground(config.char))
            const values = yield* readOrEmpty("values", charFs.readValues(config.char))
            const diary = yield* readOrEmpty("diary", charFs.readDiary(config.char))
            const orientRecall = yield* memory.recall(
              config.containerId,
              config.char,
              orientQuery(cortex.accumulatedEvents, cortex.emotionalWeight),
              { k: 2, label: "You recall", maxChars: 300 },
            )
            const orient = yield* runForebrain(
              runnerConfig,
              cortex.accumulatedEvents,
              JSON.stringify(summary, null, 2),
              { background, values, diary },
              cortex.emotionalWeight,
              orientRecall,
            )
            yield* logBehavior(config.char.name, "cortex", "forebrain", { type: "orient", headline: orient.headline })
            for (const w of orientMemories(orient)) {
              yield* memory.remember(config.containerId, config.char, w)
            }
            // Laundered directive: formatSteerDirective formats model-generated forebrain output.
            pendingDirective = formatSteerDirective(orient)
            if (esc.rung === "steer") bypassSteerCadence = true
          }
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
              yield* logBehavior(config.char.name, "cortex", "step", { type: "step", phase: "done", task: step.task })
            } else {
              yield* logBehavior(config.char.name, "cortex", "step", { type: "step", phase: "salvage", task: step.task })
            }
            const after = renderer.richSnapshot(state as never)
            const stepIdx = cortex.currentStepIndex
            const conditionCheck = stepDoneSignaled
              ? `Agent signaled completion (${STEP_DONE_MARKER}) after ${ticksConsumed} ticks`
              : `Tick budget elapsed: ${ticksConsumed} ticks consumed of ${step.timeoutTicks} budgeted; no completion signal`
            const evalRecall = yield* memory.recall(
              config.containerId,
              config.char,
              evaluateQuery(step.task, step.goal),
              { k: 5, label: "Relevant memories" },
            )
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
              recalledMemories: evalRecall,
            })
            yield* logBehavior(config.char.name, "cortex", "conscious", {
              type: "note",
              label: "evaluate",
              data: { judgment: evalResult.judgment, transition: evalResult.transition.transition },
            })
            for (const w of evaluateMemories(evalResult)) {
              yield* memory.remember(config.containerId, config.char, w)
            }
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
            bypassSteerCadence = false
            stepStartTick = tick
            stepStartSnapshot = renderer.richSnapshot(state as never)
          } else {
            // 6b. Budget not elapsed, no done-signal — fork the next turn.
            if (sessionId === null) {
              // Turn 1: open the session.
              stepStartTick = tick
              stepStartSnapshot = renderer.richSnapshot(state as never)
              yield* logBehavior(config.char.name, "cortex", "step", { type: "step", phase: "start", turn: 1, task: step.task })
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
              (bypassSteerCadence || tick - lastSteerTick >= DEFAULT_STEER_CADENCE_TICKS)
            ) {
              // Steer turn: send the latest coalesced directive to the existing session.
              // A priority steer (steer rung) bypasses the cadence throttle.
              const directive = pendingDirective
              pendingDirective = null
              lastSteerTick = tick
              bypassSteerCadence = false
              yield* logBehavior(config.char.name, "cortex", "conscious", { type: "note", label: "steer_turn", data: { sessionId } })
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
    | MemoryGateway
  >
