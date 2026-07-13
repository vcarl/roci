import { Effect, Queue, Option, Fiber } from "effect"
import { CommandExecutor } from "@effect/platform"
import type { CharacterConfig } from "../../services/CharacterFs.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { ModelService } from "../../services/ModelService.js"
import { SpawnError, ReadinessError } from "../../services/model-backend.js"
import { CharacterLog, logToConsole, logError, logBehavior } from "../../logging/log-writer.js"
import { OAuthToken } from "../../services/OAuthToken.js"
import { EventProcessorTag } from "#brain/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "#brain/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "#brain/limbic/amygdala/interrupt.js"
import { StateRendererTag } from "../../core/state-renderer.js"
import { PromptBuilderTag } from "../../core/prompt-builder.js"
import { ConsciousThought } from "#brain/cortex/conscious/conscious-thought.js"
import { makeConsciousSession } from "#brain/cortex/conscious/conscious-session.js"
import { consciousModelLabel } from "../../model/conscious-label.js"
import { ModelClient } from "../../model/client.js"
import type { ModelError } from "../../model/errors.js"
import { DEFAULT_CORTEX_MODELS, resolveHandle, type CortexModelConfig } from "../../model/handles.js"
import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "../../core/model-config.js"
import { TEMPLATE_PALETTE } from "../../core/palette.js"
import { TEMPLATE_DRIVES } from "#brain/limbic/hypothalamus/drives.js"
import type { Cadence } from "#brain/limbic/hypothalamus/cadence.js"
import type { Alert } from "../../core/types.js"
import type { ObserveResult, OrientResult, DecideResult } from "../../skills/types.js"
import { Docker } from "../../services/Docker.js"
import {
  MemoryGateway,
  orientMemories,
  decideMemories,
  evaluateMemories,
  decideQuery,
  evaluateQuery,
} from "#brain/limbic/hippocampus/memory/memory-gateway.js"
import { runForebrain } from "#brain/limbic/tiers-limbic.js"
import { makeReflexScheduler } from "#brain/limbic/reflex-scheduler.js"
import { runConsciousDecide } from "#brain/cortex/conscious/tiers-conscious.js"
import type { ActivationRunnerConfig } from "./tier-config.js"
import {
  freshActivationState,
  shouldForceOrient,
  planSteps,
  decideSteps,
  discoverToPlan,
  isWedgedEmptyPlan,
  isWellFormedDiscover,
  formatStepTask,
  formatSteerDirective,
  appraiseTick,
  emptyEscalation,
  DEFAULT_APPRAISAL_THRESHOLDS,
  STEP_DONE_MARKER,
  eventFingerprint,
  isChatEventType,
  countRecentFingerprints,
  summarizeEventText,
  planTitleFromHeadline,
  DEDUP_WINDOW_TICKS,
  type DedupWindowEntry,
} from "./state.js"
import {
  appendStepEnd,
  appendStepStart,
  appendWmDeltas,
  beginEpisodeEpoch,
  captureEpisodeAttribution,
  episodeContext,
  mintStepId,
  setEpisodeStep,
  setEpisodeTick,
  type EpisodeAttribution,
} from "../../logging/episodes.js"
import { discardDeadPlanTodos, drainWmDeltas } from "#brain/limbic/wm/wm-store.js"
import { makePlanTodoTracker } from "#brain/limbic/wm/plan-todos.js"
import { renderSkillIndex, type SkillMeta } from "../../services/skills-core.js"
import { readIdentityContext } from "#brain/limbic/hippocampus/identity-context.js"

export interface ActivationConfig {
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

export type ActivationResult =
  | { readonly _tag: "Completed"; readonly finalState: unknown }
  | { readonly _tag: "Interrupted"; readonly finalState: unknown; readonly criticals: Alert[] }

const DEFAULT_TICK_MS = 30_000
const DEFAULT_ORIENT_INTERVAL = 5
// workerTimeoutMs is reused as the per-turn wall-clock timeout in 4b.
// (Previously it bounded a whole delegation step; now it bounds each conscious turn.
// A dedicated consciousTurnTimeoutMs knob is deferred tuning — Phase 4c.)
const DEFAULT_WORKER_TIMEOUT_MS = 60 * 60 * 1000

/**
 * The in-session steer cadence throttle (§7) now lives with the conscious-session
 * owner that enforces it (`cortex/conscious/conscious-session.ts`). Re-exported
 * here so the loop's characterization test keeps its `./loop.js` import path.
 */
export { DEFAULT_STEER_CADENCE_TICKS } from "#brain/cortex/conscious/conscious-session.js"

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

/**
 * The deterministic appraisal for an event that is an exact/near-identical
 * REPEAT of one already appraised within the dedup window (Task 1). Tagged
 * `discard`/weight-0 WITHOUT a model call — mechanical habituation upstream of
 * the 2B: run-3 appraised the same "New station … in-system" observation ~35×
 * at w=2, flooding accumulatedEvents/WM and burning inference. Never escalates,
 * never accumulates; still flows through the tick's `appraiseTick` reduce so the
 * normal appraisal behavior event still fires (observability). `nTimes` is the
 * running occurrence count within the window, surfaced in the reason.
 */
const duplicateAppraisal = (nTimes: number): ObserveResult => ({
  disposition: "discard",
  emotionalWeight: "😐",
  drive: null,
  weight: 0,
  interrupt: false,
  reason: `duplicate of recent event (${nTimes}x)`,
})

const AVAILABLE_ACTIONS =
  "Each plan step is executed by the conscious agent (local LLM in an OpenCode session with full tool access). Plan concrete steps; each step.task names the action and step.goal describes the outcome."

/**
 * The fork-time snapshot the idle deliberation runs over (spec: non-blocking
 * idle path). Captured on the LOOP fiber at fork time; the fork reads ONLY this,
 * never live `cortex.*`, so a slow deliberation appraises a coherent moment even
 * as the loop keeps ticking and mutating state under it.
 */
interface DeliberationContext {
  summaryJson: string
  accumulatedEvents: string[]
  emotionalWeight: string
  attribution: EpisodeAttribution
}

/**
 * The pure model output of a forked deliberation (orient + decide). The fork
 * produces this; the LOOP fiber's land point applies it (seeds currentPlan / wm
 * / episode). No mutation lives in the result.
 */
interface DeliberationResult {
  orient: OrientResult
  decide: DecideResult
}

export const runActivation = (config: ActivationConfig) =>
  Effect.gen(function* () {
    // Episode substrate (spec §1): the per-character tick/step context is a
    // module-level map that outlives this run (mirrors behavior-digest.ts).
    // Both exit paths above the per-step reset (evaluate→terminate, critical
    // interrupt) can leave a dangling stepId from a prior invocation, and a
    // fresh session's tick restarts at 0 — so without this reset, this run's
    // first orient/decide tier records could be stamped with a stale stepId,
    // corrupting the substrate's join key. beginEpisodeEpoch clears the context
    // once, here, before anything else stamps it — AND issues the run epoch
    // that prefixes every stepId this run mints. The epoch is derived from the
    // on-disk episode streams (max cited epoch + 1; timestamp fallback on scan
    // failure), so ids stay unique across the retained multi-cycle window even
    // though `tick` restarts at 0 each run AND across process restarts (the
    // streams are append-mode across restarts; rotation is by cycle, not session).
    const runEpoch = beginEpisodeEpoch(config.char.name)

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
    const runnerConfig: ActivationRunnerConfig = {
      char: config.char,
      cadence,
      models: config.cortexModels ?? DEFAULT_CORTEX_MODELS,
      palette,
      drives,
    }

    // Conscious body-model handle + its `-m` label. Resolved once here (no side
    // effects) so both the session owner (below) and provision (later) share it.
    const handle = resolveHandle(runnerConfig.models, "conscious")
    // `-m` label for body turns — the real mlx-served id. MUST match the agent file's
    // frontmatter `model:` (written from the same handle at provision time).
    const bodyModelLabel = consciousModelLabel(handle)

    // Limbic-owned reflex scheduler (B2): forks per-event hindbrain appraisal
    // (+ its memory write) off the conductor's hot path so a slow 2B reflex
    // can't freeze the tick loop. The loop submits non-inert events and drains
    // landed appraisals into the tick's escalation reduce; the reduce +
    // escalation consumption stay loop-side. See reflex-scheduler.ts for the
    // ordering contract (escalations queue, never drop; amygdala stays sync).
    const reflex = makeReflexScheduler(runnerConfig, config.containerId)

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
    // NOTE: kept as `cortex` (not renamed to match ActivationState) — an internal
    // plan/wm bookkeeping variable referenced ~30x in this function; renaming it
    // would balloon this diff without a clarity gain (rename-phase judgment call).
    const cortex = freshActivationState()
    let tick = 0
    let stepStartTick = 0
    // Self-drive: set when the loop drops to idle after a replan / plan-completion so the
    // next tick re-orients even with no inbound events (a quiet world would otherwise
    // never re-trigger the forebrain). Consumed (cleared) after forcing one orient.
    let forceOrientNext = false
    // Sliding-window fingerprint history for mechanical event dedup (Task 1).
    // Entries older than DEDUP_WINDOW_TICKS are pruned each tick after use.
    let recentEventFps: DedupWindowEntry[] = []
    let stepStartSnapshot = renderer.richSnapshot(state as never)
    // Orient headline of the in-progress plan — context for every step.
    let planHeadline = ""
    // Worn skill (spec §3): the decide-chosen skill for the in-progress plan —
    // its name (stamped on step episode records) and body (injected into the
    // step task). Mirrors planHeadline's lifecycle: set at plan assignment,
    // read only while a plan is active, overwritten by the next assignment.
    // Init via `as` (not a `: T | null` annotation): the sole assignment now lives
    // in the applyDeliberation closure (the relocated seed), and a plain `= null`
    // annotated let assigned only inside a nested closure collapses to `never` at
    // outer read sites (TS CFA quirk). The `as` initializer keeps the union type live.
    let wornSkill = null as { name: string; body: string } | null
    // Working memory (spec §2): the harness-seeded plan todos (headline + one
    // child per step) are owned by a tracker that co-locates the seeded ids with
    // the composite wm sequences that settle/discard them (limbic/wm/plan-todos).
    // It returns the applied deltas; the loop records them on episode records.
    const planTodos = makePlanTodoTracker(config.char)

    // Conscious-session lifecycle owner (Phase A1). Encapsulates the in-flight
    // turn fiber, the OpenCode session id, the accumulated step report, the
    // done-signal, and the steer coalesce/cadence state — the "Conscious-session
    // state" the loop used to spread inline. The loop drives it via a narrow
    // interface (poll/openTurn/steer/stageDirective/evaluate/diary/interrupt/reset)
    // and keeps all wm/memory/episode bookkeeping loop-side; the owner imports NO
    // limbic code. See conscious-session.ts for the fiber-ordering equivalence.
    const session = makeConsciousSession({
      consciousThought,
      runnerConfig,
      containerId: config.containerId,
      char: config.char,
      bodyModelLabel,
      turnTimeoutMs: workerTimeoutMs,
    })

    // Deliberation fork (spec: non-blocking idle path). Mirrors consciousFiber and is
    // mutually exclusive with it (a deliberation produces the plan; the body turn runs
    // only once currentPlan !== null). Non-null ⇒ a deliberation is in flight.
    let deliberationFiber: Fiber.RuntimeFiber<DeliberationResult, never> | null = null
    // # of accumulatedEvents fed to the in-flight orient (the snapshot prefix to drain on apply).
    let deliberationSnapshotCount = 0
    // Guards against forking a fresh deliberation on the same tick one just landed/discarded.
    let deliberationSettledThisTick = false

    // Drop the active plan and clear all per-session steering state, so the loop
    // re-orients from a clean slate. Shared by the in-session `reorient` and
    // `interrupt` rungs (§3.2); a closure so it can reset the loop-local lets, not
    // just `cortex`. (The `interrupt` rung additionally kills the in-flight fiber
    // before calling this; `reorient` lets the current turn finish naturally.)
    const resetPlanState = () =>
      Effect.gen(function* () {
        // Deferred Stage-1 fix: a reorient/interrupt can abandon a step whose
        // step-start was emitted but whose evaluate (and step-end) never ran,
        // leaving an unclosed step in the episode substrate. Close it here with
        // transition:"replan" and NO verdict — nothing was evaluated. Guard on
        // the episode context's stepId: the normal evaluate path clears it
        // immediately after emitting its own step-end (per-step reset below),
        // so a non-null stepId means exactly "in-flight, not yet closed" — a
        // double emission is impossible.
        const ctx = episodeContext(config.char.name)
        const step = planSteps(cortex.currentPlan)[cortex.currentStepIndex]
        // wm (spec §2): the dropped plan's seeded todos are orphans — discard
        // them, and drain any agent-journaled deltas from the abandoned step,
        // so the abandoned step-end carries the full wm story.
        const orphanDeltas = yield* planTodos.discardOrphans()
        const agentDeltas = yield* drainWmDeltas(config.char)
        const wmDeltas = [...agentDeltas, ...orphanDeltas]
        if (ctx.stepId !== null && step) {
          yield* appendStepEnd(config.char.name, {
            tick,
            stepId: ctx.stepId,
            task: step.task,
            goal: step.goal,
            transition: "replan",
            skill: wornSkill?.name ?? null,
            wmDeltas,
          })
        } else {
          yield* appendWmDeltas(config.char.name, tick, wmDeltas)
        }
        cortex.currentPlan = null
        cortex.lastOrientTick = 0
        session.reset()
        setEpisodeStep(config.char.name, null)
      })

    // The idle deliberation (spec: non-blocking idle path), lifted onto a fork.
    // Runs the whole identity-read → orient → recall → decide chain over the
    // fork-time SNAPSHOT (never live cortex.*), so a slow conscious turn no longer
    // freezes the loop. PURE model computation: it writes no cortex/state/episode
    // context — it returns a DeliberationResult the LOOP fiber applies on land.
    // Never-fail (catchAll ⇒ <DeliberationResult, never>): a decide/orient error
    // degrades to a no-plan "continue" result rather than crashing the fiber.
    const runDeliberation = (snap: DeliberationContext) =>
      Effect.gen(function* () {
        const identity = yield* readIdentityContext({
          char: config.char,
          containerId: config.containerId,
          accumulatedEvents: snap.accumulatedEvents,
          emotionalWeight: snap.emotionalWeight,
        })
        const skillMetas = yield* charFs
          .listSkills(config.char)
          .pipe(Effect.catchAll(() => Effect.succeed([] as SkillMeta[])))
        const skillIndex = renderSkillIndex(skillMetas)
        const orient = yield* runForebrain(
          runnerConfig,
          snap.accumulatedEvents,
          snap.summaryJson,
          identity,
          snap.emotionalWeight,
          identity.recalledMemories,
          identity.workingMemory,
          "plan",
          snap.attribution,
        )
        yield* logBehavior(config.char.name, "cortex", "forebrain", { type: "orient", headline: orient.headline })
        for (const w of orientMemories(orient)) yield* memory.remember(config.containerId, config.char, w)
        const decideRecall = yield* memory.recall(
          config.containerId,
          config.char,
          decideQuery(orient),
          { k: 5, label: "Relevant memories" },
        )
        const decide = yield* runConsciousDecide(
          runnerConfig,
          orient,
          "No active plan.",
          AVAILABLE_ACTIONS,
          decideRecall,
          identity.workingMemory,
          skillIndex,
          snap.attribution,
          // D2: hand decide the same ground-truth snapshot the orient ran over so it
          // grounds its choice in the live world, not the synthesis's narrative.
          snap.summaryJson,
        )
        for (const w of decideMemories(decide)) yield* memory.remember(config.containerId, config.char, w)
        yield* (decide.decision === "plan" || decide.decision === "wait" || decide.decision === "terminate"
          ? logBehavior(config.char.name, "cortex", "conscious", { type: "decision", disposition: decide.decision })
          : logBehavior(config.char.name, "cortex", "conscious", { type: "note", label: `decision:${decide.decision}` }))
        return { orient, decide } satisfies DeliberationResult
      }).pipe(
        // Never-fail: a model error inside the fork degrades to a no-plan result (Task 5
        // adds the re-orient follow-up). The apply branch treats "continue" as no plan.
        Effect.catchAll((e) =>
          logError(config.char.name, "cortex", `deliberation failed; no plan seeded: ${e}`).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.as({
              orient: { headline: "deliberation failed", sections: [], whatChanged: "", emotionalState: snap.emotionalWeight, confidence: "low", metrics: {} },
              decide: { decision: "continue", reasoning: "deliberation failed" },
            } as DeliberationResult),
          ),
        ),
      )

    // Apply a landed deliberation ON THE LOOP FIBER — the relocated atomic seed
    // (currentPlan / wornSkill / wm / episode). Task 2 applies UNCONDITIONALLY
    // (Task 3 gates on staleness; Task 4 refines the drain to a slice). Returns
    // the loop's Completed result on terminate (so the caller can `return` it),
    // null otherwise. The seed branches are byte-for-byte the pre-fork idle path.
    const applyDeliberation = (outcome: DeliberationResult) =>
      Effect.gen(function* () {
        const orient = outcome.orient
        const decide = outcome.decide
        // Resolve the chosen skill to its body (spec §3 Selection): a missing
        // or non-string skill, or one naming a file not on disk (the agent can
        // edit skill files directly), resolves to null → the step runs plain.
        // Deferred to an Effect (not run here): terminate/wait never wear a
        // skill, so this real readSkill call (plus its "unknown skill" warn)
        // only actually runs on the plan/discover branches below that assign
        // wornSkill.
        const resolveWornSkill = Effect.gen(function* () {
          const chosenSkill =
            typeof decide.skill === "string" && decide.skill.trim() ? decide.skill.trim() : null
          const resolvedSkill = chosenSkill
            ? yield* charFs.readSkill(config.char, chosenSkill).pipe(Effect.catchAll(() => Effect.succeed(null)))
            : null
          if (chosenSkill && !resolvedSkill) {
            yield* logToConsole(
              config.char.name,
              "cortex",
              `decide named unknown skill "${chosenSkill}"; step runs without it`,
              "warn",
            ).pipe(Effect.catchAll(() => Effect.void))
          }
          return resolvedSkill ? { name: resolvedSkill.name, body: resolvedSkill.body } : null
        })
        // Drain ONLY the events fed to this deliberation's orient; retain any that
        // accumulated DURING the deliberation so they feed the next orient (spec: reconciliation).
        cortex.accumulatedEvents = cortex.accumulatedEvents.slice(deliberationSnapshotCount)
        cortex.lastOrientTick = tick
        deliberationSnapshotCount = 0

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
          wornSkill = yield* resolveWornSkill
          // wm (spec §2): seed the plan's steps as todos under a headline
          // todo, so intent survives replans. Seeding is best-effort — a wm
          // failure yields empty ids and the plan proceeds regardless. The
          // headline is prefixed "(assessment) " (Task 3) so a confabulated
          // orient narrative can't masquerade in WM.md as a committed plan.
          const seededDeltas = yield* planTodos.seed(
            planTitleFromHeadline(orient.headline),
            planSteps(cortex.currentPlan),
          )
          yield* appendWmDeltas(config.char.name, tick, seededDeltas)
        } else if (decideSteps(decide).length > 0) {
          // decideSteps is array-safe: a parseable `{"decision":"plan"}` with
          // a missing/non-array/empty `steps` yields [] here (parseOr's
          // fallback is the `continue` variant, so `decide.steps` can be
          // undefined). A plan with no actionable steps is treated as no plan
          // started — never a crash on `decide.steps.length`.
          cortex.currentPlan = decide
          cortex.currentStepIndex = 0
          planHeadline = orient.headline
          wornSkill = yield* resolveWornSkill
          // wm (spec §2): seed the plan's steps as todos under a headline
          // todo, so intent survives replans. Seeding is best-effort — a wm
          // failure yields empty ids and the plan proceeds regardless. The
          // headline is prefixed "(assessment) " (Task 3) so a confabulated
          // orient narrative can't masquerade in WM.md as a committed plan.
          const seededDeltas = yield* planTodos.seed(
            planTitleFromHeadline(orient.headline),
            planSteps(cortex.currentPlan),
          )
          yield* appendWmDeltas(config.char.name, tick, seededDeltas)
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
        return null
      })

    // Provision the conscious agent once before the first tick. `handle` +
    // `bodyModelLabel` were resolved above (shared with the session owner).
    const systemPrompt = promptBuilder.systemPrompt("select", "")
    yield* consciousThought.provision({
      containerId: config.containerId,
      char: config.char,
      handle,
      systemPrompt,
      frontierModel: (config.workerModels ?? DEFAULT_MODEL_CONFIG).tiers.reasoning,
      frontierTimeoutMs: workerTimeoutMs,
    })

    // wm (spec §2 cross-session lifecycle): sweep dead-plan orphans before the
    // first tick. No plan is active at loop entry, so any OPEN harness-seeded
    // todo is a leftover from a prior/dead session (its own in-loop discard
    // only knew that session's plan ids) — it would otherwise sit open forever
    // and be rendered into every orient/decide prompt. Agent-authored (CLI)
    // todos are deliberate memory and survive. ensureWmFiles (in provision)
    // ran first, so WM.md is fresh; the sweep re-renders it again on any hit.
    const sweptOrphans = yield* discardDeadPlanTodos(config.char)
    if (sweptOrphans.length > 0) {
      yield* logToConsole(
        config.char.name,
        "cortex",
        `discarded ${sweptOrphans.length} stale plan todo(s) orphaned by a prior session`,
      ).pipe(Effect.catchAll(() => Effect.void))
      yield* appendWmDeltas(config.char.name, tick, sweptOrphans)
    }

    while (true) {
      tick++

      // Stamp the episode context so tool/tier records carry the current tick.
      setEpisodeTick(config.char.name, tick)

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
      // Amygdala audit trail: which rules matched this tick, and what became of
      // each (fired / suppressed / below-threshold) + destination tier. Emitted
      // only on ticks where at least one rule matched, so a rule that condition-
      // matched every tick yet never drove a replan (e.g. a low-priority soft
      // alert) is now visibly accounted for instead of silently invisible.
      const currentStepTask =
        cortex.currentPlan !== null
          ? planSteps(cortex.currentPlan)[cortex.currentStepIndex]?.task
          : undefined
      const interruptEvals = interrupts.explain(state as never, summary.situation, currentStepTask)
      if (interruptEvals.length > 0) {
        yield* logBehavior(config.char.name, "cortex", "amygdala", {
          type: "note",
          label: "interrupt_eval",
          data: { tick, evaluations: interruptEvals },
        })
      }
      const criticals = interrupts.criticals(state as never, summary.situation)
      if (criticals.length > 0) {
        yield* logBehavior(config.char.name, "cortex", "amygdala", {
          type: "note",
          label: "critical",
          severity: "warn",
          data: { messages: criticals.map((a) => a.message) },
        })
        yield* session.interrupt()
        if (deliberationFiber) {
          yield* Fiber.interrupt(deliberationFiber)
          deliberationFiber = null
        }
        // A dropped session's in-flight reflexes are moot — interrupt them so the
        // amygdala "cut-the-line" exit leaves no orphaned 2B calls (mirrors the
        // consciousFiber/deliberationFiber interrupts above).
        yield* reflex.interruptAll()
        // wm (spec §2): this exit skips resetPlanState (unlike reorient/interrupt,
        // nothing continues afterward for this session), so an active plan's
        // seeded orphans must be discarded here too — otherwise they leak into
        // WM.md permanently (uncapped, injected on every request, forever).
        if (cortex.currentPlan !== null) {
          const orphanDeltas = yield* planTodos.discardOrphans()
          yield* appendWmDeltas(config.char.name, tick, orphanDeltas)
        }
        return { _tag: "Interrupted" as const, finalState: state, criticals }
      }

      // 3. If a conscious turn is in flight, check whether it finished (session
      // owner: join, adopt sessionId, append to the step report, set the
      // done-signal on the completion marker). No-op when no turn is in flight.
      // While a turn runs, fall through to triage the world, then sleep.
      yield* session.poll()

      // 4. HINDBRAIN per-event triage — ungated: runs whenever there are events,
      // even mid-session. Each state-changing event is appraised once by the 2B;
      // inert events are fast-pathed deterministically (no model call). Since B2
      // the per-event appraisal is FORKED off the hot path (limbic reflex
      // scheduler): the loop submits non-inert events (no await) and drains the
      // appraisals that have LANDED — this tick's fast reflexes plus any earlier
      // tick's slow reflex that only just finished. Inert events are appraised
      // deterministically loop-side (no model call) and reduced immediately.
      // Ordering contract (reflex-scheduler.ts): a reflex not ready by its own
      // tick's reduce is consumed on the tick it lands; escalations queue, never
      // drop; the amygdala critical path (§2 above) stays synchronous.
      let escalate = tick === 1
      if (forceOrientNext) {
        escalate = true
        forceOrientNext = false
      }
      const appraisals: Array<{ event: string; observe: ObserveResult }> = []
      for (const ev of tickEvents) {
        if (ev.inert) {
          appraisals.push({ event: ev.text, observe: INERT_APPRAISAL })
          continue
        }
        // Mechanical dedup UPSTREAM of the 2B (Task 1): fingerprint the event,
        // count its recent exact + type-family occurrences within the window,
        // then record this occurrence.
        const fp = eventFingerprint(ev.text)
        const { exactCount, typeCount } = countRecentFingerprints(
          recentEventFps,
          fp,
          tick,
          DEDUP_WINDOW_TICKS,
        )
        recentEventFps.push({ full: fp.full, type: fp.type, tick })
        const isChat = isChatEventType(fp.type)
        if (!isChat && exactCount > 0) {
          // Exact/near-identical repeat → synthesize a discard@0 appraisal with
          // NO model call. Still pushed to `appraisals` so the normal per-tick
          // appraisal behavior event fires (observability), exactly like INERT.
          appraisals.push({ event: ev.text, observe: duplicateAppraisal(exactCount + 1) })
        } else {
          // First-time-or-changed (or a chat, which is NEVER deduped-to-discard):
          // pass through to the hindbrain. Annotate the event text with a
          // `(seen Nx recently)` suffix when the type-family has been seen before
          // — CONTRACT with the observe rubric: exactly this human-readable form.
          const seenN = typeCount + 1
          const text = seenN > 1 ? `${ev.text} (seen ${seenN}x recently)` : ev.text
          yield* reflex.submit(text, cortex.waitState)
        }
      }
      // Prune history entries that have aged out of the window (post-use, so this
      // tick's count saw the full window; keeps the array bounded).
      recentEventFps = recentEventFps.filter((e) => tick - e.tick <= DEDUP_WINDOW_TICKS)
      // Collect landed appraisals (this tick's + any earlier slow reflex). The
      // remember write moved into the scheduler, so nothing here awaits the 2B.
      const landed = yield* reflex.drainReady()
      // Task 4b: a reflex that degraded on a hindbrain endpoint failure flags the
      // tick's appraisal behavior event so the silent accumulate fallback is visible.
      const anyDegraded = landed.some((l) => l.degraded === true)
      appraisals.push(...landed.map(({ event, observe }) => ({ event, observe })))
      const esc =
        appraisals.length > 0 ? appraiseTick(appraisals, DEFAULT_APPRAISAL_THRESHOLDS) : emptyEscalation()
      const nonDiscard = esc.accumulated.length > 0
      if (appraisals.length > 0) {
        yield* logBehavior(config.char.name, "cortex", "hindbrain", {
          type: "appraisal",
          disposition: esc.rung,
          weight: esc.maxWeight,
          escalated: esc.escalate,
          // Task 4a: the dominant event's model reason + a compact type/summary,
          // so distribution QA reads the "why" off the behavior stream without
          // mining raw observe exchanges.
          reason: esc.dominant?.reason ?? "",
          summary: summarizeEventText(esc.dominantEvent),
          ...(anyDegraded ? { degraded: true } : {}),
        })
        // Tick mood = the dominant (highest-weight) event's mood (§4.4).
        if (esc.dominant) cortex.emotionalWeight = esc.dominant.emotionalWeight
        if (esc.accumulated.length > 0) cortex.accumulatedEvents.push(...esc.accumulated)
        if (esc.escalate) escalate = true
      }
      if (!escalate && shouldForceOrient(cortex, tick, orientInterval)) escalate = true

      // Poll the in-flight deliberation. The ladder governs it: a reorient/interrupt-rung
      // event means the world moved materially, so the fork-time snapshot is stale —
      // discard it (interrupt if still cooking, join-and-drop if it landed this same
      // tick) and re-orient. Otherwise, on completion, apply on the LOOP fiber — the
      // relocated atomic seed (Task 4 refines the drain to a slice).
      deliberationSettledThisTick = false
      if (deliberationFiber !== null) {
        const stale = esc.rung === "reorient" || esc.rung === "interrupt"
        if (stale) {
          const done = yield* Fiber.poll(deliberationFiber).pipe(Effect.map(Option.isSome))
          if (done) yield* Fiber.join(deliberationFiber)
          else yield* Fiber.interrupt(deliberationFiber)
          deliberationFiber = null
          deliberationSnapshotCount = 0
          deliberationSettledThisTick = true
          forceOrientNext = true
          yield* logToConsole(
            config.char.name,
            "cortex",
            `deliberation superseded (${esc.rung}): ${esc.dominant?.reason ?? "world moved"}`,
          ).pipe(Effect.catchAll(() => Effect.void))
        } else {
          const done = yield* Fiber.poll(deliberationFiber).pipe(Effect.map(Option.isSome))
          if (done) {
            const outcome: DeliberationResult = yield* Fiber.join(deliberationFiber)
            deliberationFiber = null
            deliberationSettledThisTick = true
            const maybeCompleted = yield* applyDeliberation(outcome) // returns ActivationResult on terminate, else null
            if (maybeCompleted) return maybeCompleted
            // Never-fail degrade / no-op decide (continue/failed/malformed/empty-plan) seeded no
            // plan — self-drive a re-orient next tick so a quiet world does not stall. But a
            // `wait`/hold land ALSO leaves currentPlan null and is a DELIBERATE idle (it sets
            // waitState); forcing a re-orient on it would turn the hold into a per-tick
            // orient→decide busy-loop. Exclude it — mirroring the sibling step-end wait handler,
            // which likewise does not force a re-orient on a wait transition.
            if (cortex.currentPlan === null && outcome.decide.decision !== "wait") forceOrientNext = true
          }
        }
      }

      // Will section 6a evaluate this tick? Mirrors 6a's guard exactly (same
      // step, stepStartTick, sessionId — none mutated between here and 6a on any
      // path that reaches 6a). If true, a 5b steer forebrain call would be
      // wasted: 6a resets pendingDirective, discarding whatever directive it
      // produced. Computed here so 5b can skip that ~9B call. (Meaningful only
      // when a plan is active + no turn is in flight; false otherwise.)
      let willEvaluate = false
      if (cortex.currentPlan !== null && !session.turnInFlight() && !isWedgedEmptyPlan(cortex.currentPlan)) {
        const step = planSteps(cortex.currentPlan)[cortex.currentStepIndex]
        if (step) {
          const budgetElapsed = session.isOpen() && tick - stepStartTick >= step.timeoutTicks
          willEvaluate = session.doneSignaled() || budgetElapsed
        }
      }

      // 5. FOREBRAIN — two disjoint call sites, never both in the same tick.
      if (cortex.currentPlan === null) {
        // 5a. Idle path: fork a deliberation (non-blocking). Mutually exclusive with an
        // in-flight deliberation (guard) and with a body turn (currentPlan !== null → else).
        // The land point (poll/join above, next tick or two) applies the seed on the loop
        // fiber; here we only capture the fork-time snapshot and spawn the fork.
        if (deliberationFiber === null && !deliberationSettledThisTick && escalate) {
          const snapshot: DeliberationContext = {
            summaryJson: JSON.stringify(summary, null, 2),
            accumulatedEvents: [...cortex.accumulatedEvents],
            emotionalWeight: cortex.emotionalWeight,
            attribution: captureEpisodeAttribution(config.char.name),
          }
          deliberationSnapshotCount = snapshot.accumulatedEvents.length
          deliberationFiber = yield* Effect.fork(runDeliberation(snapshot))
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
            yield* session.interrupt()
          } else {
            yield* logToConsole(
              config.char.name,
              "cortex",
              `hindbrain reorient (in-session): ${esc.dominant?.reason ?? "high salience"}`,
            )
          }
          yield* resetPlanState()
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
            // Same single assembly seam as the idle path (identity-context.ts) —
            // identical reads, identical empty-block placeholders, so the two
            // paths can never drift.
            const identity = yield* readIdentityContext({
              char: config.char,
              containerId: config.containerId,
              accumulatedEvents: cortex.accumulatedEvents,
              emotionalWeight: cortex.emotionalWeight,
            })
            const orient = yield* runForebrain(
              runnerConfig,
              cortex.accumulatedEvents,
              JSON.stringify(summary, null, 2),
              identity,
              cortex.emotionalWeight,
              identity.recalledMemories,
              identity.workingMemory,
              "steer",
            )
            yield* logBehavior(config.char.name, "cortex", "forebrain", { type: "orient", headline: orient.headline })
            for (const w of orientMemories(orient)) {
              yield* memory.remember(config.containerId, config.char, w)
            }
            // Laundered directive: formatSteerDirective formats model-generated
            // forebrain output. Buffer it on the session (coalesce = newest wins);
            // a `steer`-rung escalation is a priority steer that bypasses cadence.
            session.stageDirective(formatSteerDirective(orient), esc.rung === "steer")
          }
          cortex.accumulatedEvents = []
          cortex.lastOrientTick = tick
        }
      }

      // 6. Step execution — when a plan is active and no conscious turn is in flight.
      if (cortex.currentPlan !== null && !session.turnInFlight()) {
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
          const budgetElapsed = session.isOpen() && ticksConsumed >= step.timeoutTicks
          const doneSignaled = session.doneSignaled()

          // 6a. Evaluate now if the agent signaled done OR the tick-budget expired.
          if (doneSignaled || budgetElapsed) {
            if (doneSignaled) {
              yield* logBehavior(config.char.name, "cortex", "step", { type: "step", phase: "done", task: step.task })
            } else {
              yield* logBehavior(config.char.name, "cortex", "step", { type: "step", phase: "salvage", task: step.task })
            }
            const after = renderer.richSnapshot(state as never)
            const stepIdx = cortex.currentStepIndex
            const conditionCheck = doneSignaled
              ? `Agent signaled completion (${STEP_DONE_MARKER}) after ${ticksConsumed} ticks`
              : `Tick budget elapsed: ${ticksConsumed} ticks consumed of ${step.timeoutTicks} budgeted; no completion signal`
            const evalRecall = yield* memory.recall(
              config.containerId,
              config.char,
              evaluateQuery(step.task, step.goal),
              { k: 5, label: "Relevant memories" },
            )
            // Model call behind the session owner; it fills executionReport from
            // its own accumulated step report (the loop never touches the transcript).
            const evalResult = yield* session.evaluate({
              task: step.task,
              goal: step.goal,
              successCondition: step.successCondition,
              ticksBudgeted: step.timeoutTicks,
              ticksConsumed,
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
            // wm (spec §2): the tracker marks the step's seeded todo done FIRST,
            // then — on a plan-dropping transition (replan/wait/terminate) or a
            // completed plan (last step) — discards the remaining OPEN step todos
            // and settles the headline (done-if-any-child-done, discarded else),
            // and finally drains the agent journal. It returns the full step wm
            // story (agent deltas + done + plan-close, in that order) to ride the
            // step-end record's wmDeltas.
            const stepWmDeltas = yield* planTodos.settleStep(
              stepIdx,
              evalResult.transition.transition,
              steps.length,
            )
            // Episode substrate (spec §1): step-end with the evaluate verdict.
            // skill is the worn skill's name (spec §3); wmDeltas is Stage 2's payload.
            yield* appendStepEnd(config.char.name, {
              tick,
              stepId: episodeContext(config.char.name).stepId ?? mintStepId(runEpoch, stepStartTick, stepIdx),
              task: step.task,
              goal: step.goal,
              verdict: evalResult.judgment,
              transition: evalResult.transition.transition,
              skill: wornSkill?.name ?? null,
              wmDeltas: stepWmDeltas,
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
            const diaryEntry = yield* session.diary({
              charName: config.char.name,
              task: step.task,
              goal: step.goal,
              judgment: evalResult.judgment,
              reasoning: evalResult.reasoning,
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
            session.reset()
            setEpisodeStep(config.char.name, null)
            stepStartTick = tick
            stepStartSnapshot = renderer.richSnapshot(state as never)
          } else {
            // 6b. Budget not elapsed, no done-signal — fork the next turn.
            if (!session.isOpen()) {
              // Turn 1: emit the step-start episode + log (loop-owned bookkeeping),
              // then open the session's first turn through the owner.
              stepStartTick = tick
              stepStartSnapshot = renderer.richSnapshot(state as never)
              const episodeStepId = mintStepId(runEpoch, tick, cortex.currentStepIndex)
              setEpisodeStep(config.char.name, episodeStepId)
              yield* appendStepStart(config.char.name, {
                tick,
                stepId: episodeStepId,
                task: step.task,
                goal: step.goal,
                skill: wornSkill?.name ?? null,
              })
              yield* logBehavior(config.char.name, "cortex", "step", { type: "step", phase: "start", turn: 1, task: step.task })
              yield* session.openTurn(formatStepTask(step, planHeadline, wornSkill?.body))
            } else {
              // Steer turn: push the latest coalesced directive to the existing
              // session if the cadence window is open (or a priority steer bypasses
              // it). No-op otherwise — session is open, waiting for a turn result or
              // the cadence window.
              yield* session.steer(tick)
            }
          }
        }
      }

      // 7. Sleep one tick.
      yield* Effect.sleep(`${tickMs} millis`)
    }
  }) as Effect.Effect<
    ActivationResult,
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
