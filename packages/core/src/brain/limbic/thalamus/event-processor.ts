import { Context } from "effect"
import type { DomainState, DomainEvent, DomainSituation } from "../../../core/domain-types.js"
import type { ObserveResult } from "../../../skills/types.js"
import { appraiseDeterministic } from "#brain/stem/state.js"

export interface DomainContext {
  readonly chatMessages?: ReadonlyArray<{
    readonly channel: string
    readonly sender: string
    readonly content: string
  }>
}

export type EventCategory =
  | { readonly _tag: "Heartbeat"; readonly tick: number }
  | { readonly _tag: "StateChange" }
  | { readonly _tag: "LifecycleReset"; readonly reason: string }

/**
 * A domain rule expressed as a hand-built appraisal (design 2026-08-02 spec A §5b).
 *
 * Called ONCE PER TICK with the current domain state and the situation the
 * classifier just derived from it; returns an `ObserveResult` when the rule's
 * condition holds and `null` when it does not. A rule is therefore the same
 * object the loop's inert/duplicate fast paths already build, with a condition
 * attached — it flows through the tick's unchanged `appraiseTick` reduce, so the
 * ladder, the behavior event, the mood EMA and the memory write all treat it
 * identically to a model appraisal. Reach the hard-interrupt rung by setting
 * `interrupt: true`; weight alone caps at `reorient` (see `eventRung`).
 *
 * Pure and SYNCHRONOUS: it runs inline on the loop fiber, so it must not do IO
 * and must not block. It also must not throw — but if it does,
 * `runDeterministicAppraisers` swallows it rather than letting a domain bug take
 * down the tick.
 *
 * NOTE: this is a LEVEL condition evaluated against state, not an event handler.
 * A condition that stays true stays true, and re-fires every tick. A rule that
 * must fire once per episode has to carry its own edge detection — and it MUST,
 * because a rule's synthetic event text does NOT pass through the loop's dedup
 * window (`eventFingerprint`/`recentEventFps` only ever see DRAINED events).
 * There is no net under a level-triggered rule: it will push an identical line
 * into `accumulatedEvents` on every tick its condition holds. This is bounded,
 * not unbounded growth — `accumulatedEvents` drains on every orient
 * (`brain/stem/loop.ts`) and `shouldForceOrient` (`state.ts`) forces one once
 * the buffer is non-empty and `orientInterval` ticks have passed — so the cost
 * of a level-true rule with no edge detection is one orient window's worth of
 * duplicate-line prompt bloat, repeating every window for as long as the
 * condition holds, not an ever-growing array. That is still exactly the shape
 * of bug that made the deleted `hull_critical` rule a death spiral: a
 * degraded, repetitive prompt on every single orient. Edge-trigger, or do not
 * write the rule.
 */
export type DeterministicAppraiser = (
  state: DomainState,
  situation: DomainSituation,
) => ObserveResult | null

/**
 * Translates raw domain events into state machine operations.
 */
export interface EventProcessor {
  /** Process a single event, returning how the state machine should react. */
  processEvent(event: DomainEvent, currentState: DomainState): EventResult
  /**
   * OPTIONAL deterministic appraisers this domain contributes to every tick
   * (spec A §5b). Absent — the GitHub domain, the template domain, every test
   * stub — means "no rules", and the loop does nothing. Optional-on-the-existing
   * service rather than a new `DomainBundle` tag precisely so a domain with no
   * rules needs no edit.
   */
  readonly deterministicAppraisers?: ReadonlyArray<DeterministicAppraiser>
}

export interface EventResult {
  readonly category?: EventCategory
  readonly stateUpdate?: (prev: DomainState) => DomainState
  readonly context?: DomainContext
  readonly log?: () => void
}

/**
 * Effect service tag for the event processor.
 */
export class EventProcessorTag extends Context.Tag("EventProcessor")<
  EventProcessorTag,
  EventProcessor
>() {}

/**
 * The outcome of one tick's deterministic-appraiser pass.
 *
 * `errors` is not decoration. Before it existed, a throwing rule was caught and
 * skipped with ZERO telemetry — so a domain rule that threw on every tick was
 * indistinguishable, from the outside, from one whose condition was simply
 * false, forever. That was tolerable while the seam had no rules registered. It
 * is not tolerable now that a silent rule means a reflex is not firing.
 */
export interface DeterministicAppraisalRun {
  readonly results: ReadonlyArray<ObserveResult>
  /** One `"<index>: <message>"` per rule that threw, in registration order. */
  readonly errors: ReadonlyArray<string>
}

/**
 * Stringify a rule's thrown value for `DeterministicAppraisalRun.errors`, in a
 * way that itself cannot throw.
 *
 * `err instanceof Error ? err.message : String(err)` looks total but is not: a
 * null-prototype thrown object, a throwing `toString`, or a throwing `Error`
 * subclass `message` GETTER all make that expression raise — which would
 * escape this function's own `catch` and propagate out of
 * `runDeterministicAppraisers`, a function whose docblock promises it never
 * throws. That is precisely the failure this hazard exists to close,
 * relocated one level down. Never let the reporting path itself become the
 * next unreported throw.
 */
function describeThrown(index: number, err: unknown): string {
  try {
    return `${index}: ${err instanceof Error ? err.message : String(err)}`
  } catch {
    return `${index}: <unstringifiable throw>`
  }
}

/**
 * Run a processor's deterministic appraisers against one tick's state+situation.
 *
 * Returns the non-null results in registration order, each passed through
 * `appraiseDeterministic` — the same mechanical clamp every model appraisal gets
 * from `appraise()`, stamping `source: "deterministic"`. The stamp is applied
 * HERE rather than trusted from the rule, so a domain cannot mint an appraisal
 * that `appraiseTick`'s tie-break (`beatsDominant`) treats as model output; and
 * the CLAMP is applied here so a rule returning `weight: 99` or a bogus
 * disposition cannot reach the escalation ladder unchecked.
 *
 * A throwing rule is skipped and RECORDED. The loop calls this inline on its own
 * fiber and a domain bug must never stop the tick — but it must also never be
 * invisible.
 *
 * CALLED ONCE PER TICK, with one documented exception: on a tick where an
 * amygdala critical fires, the loop returns `Interrupted` BEFORE reaching this
 * call (`brain/stem/loop.ts`, the criticals block). That ordering is correct —
 * a critical exits the loop to the phase machine and nothing downstream would
 * consume the appraisal — but it means "every tick" is not literally true, and
 * a rule must not be written assuming it observes every single tick.
 *
 * Pure apart from whatever the rules read; never throws.
 */
export function runDeterministicAppraisers(
  processor: EventProcessor,
  state: DomainState,
  situation: DomainSituation,
): DeterministicAppraisalRun {
  const rules = processor.deterministicAppraisers
  if (!rules || rules.length === 0) return { results: [], errors: [] }
  const results: ObserveResult[] = []
  const errors: string[] = []
  for (let i = 0; i < rules.length; i++) {
    let result: ObserveResult | null = null
    try {
      result = rules[i]!(state, situation)
    } catch (err) {
      errors.push(describeThrown(i, err))
      continue
    }
    if (result !== null && result !== undefined) results.push(appraiseDeterministic(result))
  }
  return { results, errors }
}
