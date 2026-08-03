import { Context } from "effect"
import type { DomainState, DomainEvent, DomainSituation } from "../../../core/domain-types.js"
import type { ObserveResult } from "../../../skills/types.js"

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
 * must fire once per episode has to carry its own edge detection.
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
 * Run a processor's deterministic appraisers against one tick's state+situation
 * and return the non-null results in registration order, each stamped
 * `source: "deterministic"`.
 *
 * The stamp is applied HERE rather than trusted from the rule, so a domain
 * cannot — by accident or otherwise — mint an appraisal that `appraiseTick`'s
 * tie-break (`beatsDominant`, `brain/stem/state.ts`) treats as model output.
 *
 * A throwing rule is swallowed and skipped. The loop calls this inline on its own
 * fiber with no error channel of its own here, and a domain bug must never be
 * able to stop the tick. Pure apart from whatever the rules read; never throws.
 */
export function runDeterministicAppraisers(
  processor: EventProcessor,
  state: DomainState,
  situation: DomainSituation,
): ReadonlyArray<ObserveResult> {
  const rules = processor.deterministicAppraisers
  if (!rules || rules.length === 0) return []
  const out: ObserveResult[] = []
  for (const rule of rules) {
    let result: ObserveResult | null = null
    try {
      result = rule(state, situation)
    } catch {
      continue
    }
    if (result !== null && result !== undefined) out.push({ ...result, source: "deterministic" })
  }
  return out
}
