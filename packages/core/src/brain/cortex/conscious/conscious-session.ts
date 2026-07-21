import { Context, Effect, Fiber, Option } from "effect"
import type { CommandExecutor } from "@effect/platform"
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import type { CharacterLog } from "../../../logging/log-writer.js"
import { logBehavior } from "../../../logging/log-writer.js"
import type { OAuthToken } from "../../../services/OAuthToken.js"
import type { ModelClient } from "../../../model/client.js"
import type { ModelService } from "../../../services/ModelService.js"
import type { SpawnError, ReadinessError } from "../../../services/model-backend.js"
import type { ModelError } from "../../../model/errors.js"
import type { EvaluateResult } from "../../../skills/types.js"
import type { TurnResult } from "#brain/stem/transport/types.js"
import type { ActivationRunnerConfig } from "#brain/stem/tier-config.js"
import { detectCompletion, formatExecutionReport } from "#brain/stem/state.js"
import { episodeContext, readCurrentStepToolEpisodes } from "../../../logging/episodes.js"
import type { ConsciousThought } from "./conscious-thought.js"
import { renderToolTrace } from "./tool-trace.js"
import { runConsciousEvaluate, runDiaryTurn, type EvaluateInput, type DiaryTurnInput } from "./tiers-conscious.js"

/**
 * Steer cadence throttle (§7): a `steer` line is pushed to the active session at
 * most once every this-many ticks. Owned here now that the session lifecycle
 * lives behind this interface; re-exported from the loop for the characterization
 * test that pins the named knob's value + location.
 */
export const DEFAULT_STEER_CADENCE_TICKS = 3

/** The conscious/evaluate context the loop assembles minus the session-owned
 * fields: the session owns `stepReport` (→ `executionReport`) and reads the
 * step's tool episodes itself (→ `toolTrace`), so the loop never touches the
 * turn transcript or the mechanical trace. */
export type SessionEvaluateInput = Omit<EvaluateInput, "executionReport" | "toolTrace">
/** As {@link SessionEvaluateInput}: the diary context minus the session-owned report. */
export type SessionDiaryInput = Omit<DiaryTurnInput, "executionReport">

/**
 * The conscious-session lifecycle owner (Phase A1). Encapsulates the state the
 * tick loop used to spread inline: the in-flight turn fiber, the OpenCode
 * session id, the accumulated step report, the done-signal, and the steering
 * coalesce/cadence state. The loop drives it through this narrow interface and
 * keeps ALL wm/memory/episode bookkeeping loop-side (§3 constraint) — this
 * module imports NO limbic code; it is pure cortex + transport + loop helpers.
 *
 * State (was the loop's "Conscious-session state" let-block):
 *  - `consciousFiber` — the in-flight body turn (null ⇒ no turn running).
 *  - `sessionId` — the OpenCode session id (null ⇒ session not yet opened).
 *  - `stepReport` — turn outputs concatenated across the step's turns.
 *  - `stepDoneSignaled` — the agent emitted the completion marker.
 *  - `pendingDirective` — capacity-1 coalescing steer buffer (newest wins).
 *  - `lastSteerTick` / `bypassSteerCadence` — the steer cadence throttle + its
 *    priority-steer bypass.
 *
 * Fiber-ordering equivalence (plan §8): the loop calls `interrupt` (amygdala /
 * interrupt-rung), then `poll` (turn-join), then `openTurn`/`steer` in the same
 * sequence it used inline — the Fiber operations on the turn fiber are unchanged
 * in order, so there is no new interrupt↔join race and no one-tick lag.
 */
export interface ConsciousSession {
  // ── pacing reads (synchronous, over closure state) ──
  /** A body turn is in flight (`consciousFiber !== null`). */
  readonly turnInFlight: () => boolean
  /** The OpenCode session has been opened (`sessionId !== null`). */
  readonly isOpen: () => boolean
  /** The agent signaled completion for the current step. */
  readonly doneSignaled: () => boolean

  // ── lifecycle ──
  /**
   * Poll the in-flight turn; if it landed, join it, adopt the returned
   * sessionId, append its output to the step report, and set the done-signal if
   * the output carries the completion marker. No-op when no turn is in flight.
   */
  readonly poll: () => Effect.Effect<void>
  /** Turn 1: fork the body turn on a fresh session (no resume). */
  readonly openTurn: (
    prompt: string,
  ) => Effect.Effect<void, never, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken>
  /**
   * Steer turn: if a directive is buffered AND the cadence window is open (or a
   * priority steer bypasses it), fork a resume turn carrying the latest coalesced
   * directive and clear the buffer. No-op otherwise. `tick` is the current loop tick.
   */
  readonly steer: (
    tick: number,
  ) => Effect.Effect<void, never, CommandExecutor.CommandExecutor | CharacterLog | OAuthToken>
  /**
   * Buffer a steer directive (capacity-1 coalesce, overwrite = newest wins).
   * `priority` (a `steer`-rung escalation) bypasses the cadence throttle so the
   * directive is pushed on the next in-session tick regardless of the window.
   */
  readonly stageDirective: (directive: string, priority: boolean) => void
  /** Run the conscious evaluate model call; fills `executionReport` from the session-owned step report. */
  readonly evaluate: (
    input: SessionEvaluateInput,
  ) => Effect.Effect<EvaluateResult, ModelError | SpawnError | ReadinessError, ModelClient | ModelService | CharacterLog>
  /** Run the diary model call; fills `executionReport` from the session-owned step report. */
  readonly diary: (
    input: SessionDiaryInput,
  ) => Effect.Effect<string, ModelError | SpawnError | ReadinessError, ModelClient | ModelService | CharacterLog>
  /** Interrupt the in-flight turn (if any) and clear the fiber handle. Amygdala critical + interrupt-rung. */
  readonly interrupt: () => Effect.Effect<void>
  /**
   * Clear all per-session state for a fresh step or plan: sessionId, step report,
   * done-signal, pending directive, and the steer cadence state. Shared by the
   * per-step advance and `resetPlanState`'s session half.
   */
  readonly reset: () => void
}

/** Construction dependencies, all resolved by the loop before the tick loop starts. */
export interface ConsciousSessionDeps {
  /** The resolved `ConsciousThought` service value (its turn/provision surface). */
  readonly consciousThought: Context.Tag.Service<ConsciousThought>
  readonly runnerConfig: ActivationRunnerConfig
  readonly containerId: string
  readonly char: CharacterConfig
  /** The `-m` body model label (`consciousModelLabel(handle)`); constant per run. */
  readonly bodyModelLabel: string
  /** Per-turn wall-clock timeout (the loop's `workerTimeoutMs`). */
  readonly turnTimeoutMs: number
}

/**
 * Build a fresh conscious-session owner for one `runActivation` invocation. Holds the
 * session state in closure lets (mirrors `makeReflexScheduler`); the loop drives
 * it via the interface above.
 */
export function makeConsciousSession(deps: ConsciousSessionDeps): ConsciousSession {
  const { consciousThought, runnerConfig, containerId, char, bodyModelLabel, turnTimeoutMs } = deps

  let consciousFiber: Fiber.RuntimeFiber<{ result: TurnResult; sessionId: string }, never> | null = null
  let sessionId: string | null = null
  let stepReport = ""
  let stepDoneSignaled = false
  // Steering: capacity-1 coalescing buffer (overwrite = newest wins).
  let pendingDirective: string | null = null
  let lastSteerTick = 0
  // Priority-steer flag: a `steer`-rung escalation bypasses the cadence throttle.
  let bypassSteerCadence = false

  const forkTurn = (prompt: string, resume?: { sessionId: string }) =>
    Effect.fork(
      consciousThought.turn(
        {
          containerId,
          playerName: char.name,
          char,
          prompt,
          timeoutMs: turnTimeoutMs,
          modelLabel: bodyModelLabel,
        },
        resume,
      ),
    )

  const poll = () =>
    Effect.gen(function* () {
      if (!consciousFiber) return
      const done = yield* Fiber.poll(consciousFiber).pipe(Effect.map(Option.isSome))
      if (!done) return
      const turnOutcome: { result: TurnResult; sessionId: string } = yield* Fiber.join(consciousFiber)
      consciousFiber = null
      sessionId = turnOutcome.sessionId
      // Append turn output to the accumulated step report.
      const turnOutput = turnOutcome.result.output ?? ""
      stepReport = stepReport ? `${stepReport}\n${turnOutput}` : turnOutput
      // Check whether the agent signaled completion.
      if (detectCompletion(turnOutput)) stepDoneSignaled = true
    })

  const openTurn = (prompt: string) =>
    Effect.gen(function* () {
      consciousFiber = yield* forkTurn(prompt)
    })

  const steer = (tick: number) =>
    Effect.gen(function* () {
      if (pendingDirective === null) return
      if (!(bypassSteerCadence || tick - lastSteerTick >= DEFAULT_STEER_CADENCE_TICKS)) return
      // Send the latest coalesced directive to the existing session. A priority
      // steer (steer rung) bypasses the cadence throttle.
      const directive = pendingDirective
      pendingDirective = null
      lastSteerTick = tick
      bypassSteerCadence = false
      yield* logBehavior(char.name, "cortex", "conscious", { type: "note", label: "steer_turn", data: { sessionId } })
      consciousFiber = yield* forkTurn(directive, sessionId !== null ? { sessionId } : undefined)
    })

  const stageDirective = (directive: string, priority: boolean) => {
    // Laundered directive text produced by the loop-side forebrain steer call.
    pendingDirective = directive
    if (priority) bypassSteerCadence = true
  }

  const evaluate = (input: SessionEvaluateInput) =>
    Effect.gen(function* () {
      // Read THIS step's mechanical tool trace (the loop's episode context still
      // holds the current stepId at evaluate time — it advances only after the
      // step-end record). The trace is a bounded read of the current cycle's tool
      // episodes filtered to the step; a missing stepId/root degrades to empty.
      const stepId = episodeContext(char.name).stepId
      const episodes = stepId === null ? [] : yield* readCurrentStepToolEpisodes(char.name, stepId)
      return yield* runConsciousEvaluate(runnerConfig, {
        ...input,
        executionReport: formatExecutionReport(stepReport),
        toolTrace: renderToolTrace(episodes),
      })
    })

  const diary = (input: SessionDiaryInput) =>
    runDiaryTurn(runnerConfig, { ...input, executionReport: formatExecutionReport(stepReport) })

  const interrupt = () =>
    Effect.gen(function* () {
      if (consciousFiber) {
        yield* Fiber.interrupt(consciousFiber)
        consciousFiber = null
      }
    })

  const reset = () => {
    sessionId = null
    stepReport = ""
    stepDoneSignaled = false
    pendingDirective = null
    lastSteerTick = 0
    bypassSteerCadence = false
  }

  return {
    turnInFlight: () => consciousFiber !== null,
    isOpen: () => sessionId !== null,
    doneSignaled: () => stepDoneSignaled,
    poll,
    openTurn,
    steer,
    stageDirective,
    evaluate,
    diary,
    interrupt,
    reset,
  }
}
