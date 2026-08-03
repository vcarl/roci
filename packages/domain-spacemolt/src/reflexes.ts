/**
 * The domain's two reflexes — the whole of what survives the deleted severity
 * system (design 2026-08-02 spec A §5a/§6).
 *
 * `interrupts.ts` had 10 rules across 4 priorities. `softAlerts()` has zero
 * production callers repo-wide, so 8 of them were log lines. Of the two that
 * could fire, `in_combat` was a LEVEL condition on the situation type with no
 * cooldown, and `hull_critical` was a death spiral: it fired below 20% hull,
 * every tick, and each firing killed the session and voided the plan — so the
 * condition that most needed sustained multi-step action was the one that
 * structurally prevented any plan from surviving a tick. It had no test.
 *
 * What is left is fight-or-flight, the snake in the grass:
 *
 *   COMBAT ONSET — a deterministic appraiser on the `interrupt` RUNG. Kills the
 *   turn, voids the plan, stays in the loop. EDGE-TRIGGERED: one firing per
 *   fight, which is the single most important property in this module.
 *
 *   YOUR OWN DEATH — the one surviving InterruptRule, an amygdala critical, and
 *   the one case with a real claim on the full phase exit.
 *
 * Everything else — hull, fuel, cargo, trades, chat, scans — goes through normal
 * appraisal, weighted by the character's own values rather than by a threshold
 * someone picked. ACCEPTED BEHAVIOR CHANGE: low hull no longer guarantees a
 * reaction. The signal does not disappear (the digest still stamps
 * `; ALERT: hull critical` and observe.md still maps it to weight 4) — it
 * becomes a forebrain steer into the RUNNING session instead of a session kill
 * and a plan-void phase restart, which is a better answer to "dock and repair"
 * by any reading.
 */

import { Layer } from "effect"
import type { InterruptRule } from "@roci/core/brain/limbic/amygdala/interrupt.js"
import { InterruptRegistryTag, createInterruptRegistry } from "@roci/core/brain/limbic/amygdala/interrupt.js"
import type { DeterministicAppraiser } from "@roci/core/brain/limbic/thalamus/event-processor.js"
import type { CombatState, GameState } from "./types.js"

/**
 * Quiet-tick backstop for re-arming the onset edge.
 *
 * The primary arm is `inCombat` going false: `battle_ended`, `battle_left`
 * (see `endsSelfCombat`) and `player_died` (`event-processor.ts`) all reset
 * `combat.lastEventTick` to `null` while
 * PRESERVING `onsetSeq`, and `nextCombatState` treats "was not in combat" as
 * the fresh-onset signal directly — it no longer infers freshness from tick
 * nullability, because three of the five combat frame types
 * (`battle_started`, `battle_joined`, `battle_alert`) never carry a `tick` at
 * all, and a null-means-fresh rule made every tickless participation frame
 * re-fire the reflex.
 *
 * This constant is a PARTIAL backstop for the case the primary arm misses: a
 * dropped `battle_ended` would otherwise leave `inCombat` (and therefore the
 * latch) stuck true forever, silencing the reflex for the rest of the
 * character's run — worse than one that occasionally re-fires. So a combat
 * frame carrying a tick that is this many ticks after the last TICKED frame
 * is treated as a FRESH onset even while `inCombat` still reads true. 12
 * ticks ≈ 2 minutes at the server's observed 10s tick rate — long enough
 * that a lull inside one real fight will not trip it, short enough that a
 * dropped end-frame costs one spurious escalation rather than permanent
 * silence.
 *
 * It only backstops the REFLEX, never `inCombat` itself: it re-arms `onsetSeq`
 * and needs a further TICKED combat frame to do even that. Once a fight is
 * genuinely over no such frame arrives, so a missed exit frame still leaves
 * `SituationType.InCombat` latched on the briefing and the state bar forever.
 * That is why `endsSelfCombat` — not this constant — is the real guarantee,
 * and why it errs toward clearing.
 */
export const COMBAT_REARM_QUIET_TICKS = 12

/**
 * Is THIS player a participant in the fight this frame describes?
 *
 * The distinction matters because most of these frames are also pushed to
 * bystanders at the POI: `battle_alert` in particular fired unprompted during
 * the 2026-08-02 production probe on a character doing nothing at all. Treating
 * it as participation would make the reflex fire on other people's fights.
 *
 * Keyed off the generated payload shapes:
 *   battle_joined  → `player_id` is the joiner
 *   battle_damage  → `attacker_id` / `target_id`
 *   battle_update  → `your_side_id` exists only on YOUR copy of the frame
 *   battle_started / battle_alert / battle_ended → search `participants[]`
 *
 * Pure; total; never throws on a malformed payload.
 */
export function isSelfParticipant(type: string, payload: unknown, playerId: string): boolean {
  if (playerId.length === 0) return false
  const p = (payload ?? {}) as Record<string, unknown>
  switch (type) {
    case "battle_joined":
      return p.player_id === playerId
    case "battle_damage":
      return p.target_id === playerId || p.attacker_id === playerId
    case "battle_update":
      return typeof p.your_side_id === "number"
    case "battle_started":
    case "battle_alert":
    case "battle_ended":
      return (
        Array.isArray(p.participants) &&
        p.participants.some((x) => (x as { player_id?: string } | null)?.player_id === playerId)
      )
    default:
      return false
  }
}

/**
 * Does this frame END this player's participation in a fight?
 *
 * A SEPARATE predicate from `isSelfParticipant`, and deliberately so: the two
 * ask opposite questions and must fail in opposite directions. Entering combat
 * demands positive evidence (a bystander's fight is not yours). LEAVING combat
 * must not: `inCombat` is a latch, and the only two writers of `false` were
 * `battle_ended` and `player_died` — so any exit this predicate misses leaves
 * the character reading `SituationType.InCombat` FOREVER
 * (`generateInCombatBriefing` replaces the whole briefing; the state bar shows
 * COMBAT), and `COMBAT_REARM_QUIET_TICKS` cannot rescue it because that
 * backstop re-arms `onsetSeq` only and needs a further TICKED combat frame
 * that will never arrive once the fight is over.
 *
 * The two frames, keyed off the generated payload shapes:
 *
 *   `battle_left` — `{player_id, reason, username}`, all required, one frame
 *   per departing pilot. This is the FLEE frame: the outcome the `interrupt`
 *   rung exists to make possible. It was unhandled entirely (it fell through
 *   the frame switch's `default: {}`), so a character that successfully fled
 *   stayed in combat for the rest of the run. Only YOUR departure ends YOUR
 *   fight, and `player_id` is unambiguous, so this arm is an exact match.
 *
 *   `battle_ended` — `participants` is OPTIONAL on the generated
 *   `NotificationBattleEnded` (the rest of the payload is battle-level:
 *   battle_id, duration, reason, winning_side, ships_destroyed, total_damage).
 *   When the server omits it there is NO field left that names you, so a
 *   membership test can only answer "no" — which is the answer that latches.
 *   An absent list therefore means "the battle is over", not "the fight
 *   continues": the frame is scoped to one battle_id and its arrival is itself
 *   the evidence. The cost of being wrong here is bounded and self-correcting
 *   — if you really were still fighting, the next `battle_damage` reads
 *   `inCombat: false`, is treated as a fresh onset, and the reflex fires once
 *   more. The cost of the other error is unbounded: silence for the rest of
 *   the session.
 *
 * Pure; total; never throws on a malformed payload.
 */
export function endsSelfCombat(type: string, payload: unknown, playerId: string): boolean {
  const p = (payload ?? {}) as Record<string, unknown>
  switch (type) {
    case "battle_left":
      return playerId.length > 0 && p.player_id === playerId
    case "battle_ended":
      return !Array.isArray(p.participants) || isSelfParticipant("battle_ended", payload, playerId)
    default:
      return false
  }
}

/**
 * Advance combat bookkeeping for one participation frame. Pure.
 *
 * Bumps `onsetSeq` when this is a FRESH onset. Freshness is gated on
 * `prevInCombat`, NOT on tick nullability — three of the five combat frame
 * types (`battle_started`, `battle_joined`, `battle_alert`) never carry a
 * `tick` in the generated payload shapes, so a rule that inferred freshness
 * from "no tick recorded yet" fired on every tickless frame of an ongoing
 * fight (measured: a `battle_started` → `battle_joined` → 30×`battle_damage`
 * onset sequence fired 3 times, not 1). `!prevInCombat` is the direct
 * fresh-onset signal — it is true exactly when the caller was not already a
 * combat participant, regardless of what any frame's `tick` field says.
 *
 * The `COMBAT_REARM_QUIET_TICKS` backstop only applies when BOTH the previous
 * and current frame carry a numeric tick, so it can re-arm mid-"fight" (a
 * dropped `battle_ended` leaves `prevInCombat` stuck true) without ever being
 * fooled by a tickless frame into re-arming a fight that never actually
 * paused. A frame with no usable tick, arriving while already a participant,
 * advances neither the marker nor the counter — it is simply a no-op tick of
 * bookkeeping, not a fresh onset and not a lost one.
 */
export function nextCombatState(prev: CombatState, tick: number | undefined, prevInCombat: boolean): CombatState {
  const t = typeof tick === "number" && Number.isFinite(tick) ? tick : null
  const fresh =
    !prevInCombat ||
    (t !== null &&
      prev.lastEventTick !== null &&
      (t - prev.lastEventTick >= COMBAT_REARM_QUIET_TICKS || t < prev.lastEventTick))
  return {
    lastEventTick: t ?? prev.lastEventTick,
    onsetSeq: fresh ? prev.onsetSeq + 1 : prev.onsetSeq,
  }
}

/**
 * The combat-onset reflex, as a deterministic appraiser.
 *
 * EDGE-TRIGGERED, and this is the property the whole module exists for: it
 * fires exactly once per `onsetSeq` increment and then stays silent for the
 * duration of the fight, however many ticks that is.
 *
 * The latch is a Map keyed by PLAYER ID, not a plain variable, because
 * `spaceMoltEventProcessor` is a module-level singleton shared by every
 * character running in this host process — a bare closure variable would let
 * one character's fight suppress another's. `runDeterministicAppraisers` —
 * specifically the `runDeterministicAppraisers(eventProcessor, ...)` call site
 * in `brain/stem/loop.ts` (grep for it; the line has moved under this very
 * docblock before and will again) — is this function's only caller, so
 * mutating the latch here is safe; nothing else evaluates it speculatively the
 * way `InterruptRegistry.explain()` does for rules. That caller runs at most
 * once per tick, NOT once per tick unconditionally: on a tick where an
 * amygdala critical fires, the loop returns `Interrupted` before reaching it,
 * so this appraiser is skipped for that tick. That is harmless for the latch —
 * an onset that coincides with a critical tick is simply deferred to the next
 * tick that does reach here, never lost, because the equality latch below
 * compares against whatever `onsetSeq` the (unadvanced) state still carries.
 *
 * The comparison is EQUALITY (`prevSeq === seq`), not a high-water mark
 * (`prevSeq >= seq`). A high-water mark looks safer but isn't: `onsetSeq`
 * lives on `GameState`, and `initialGameState` (`account-socket.ts`) seeds a
 * fresh `GameState` with `onsetSeq: 0` on every reconnect/restart within the
 * same process. A high-water-mark latch would then compare the new,
 * low-numbered sequence against the OLD run's stale maximum and stay silent
 * until the new run's count climbed back past it — measured as zero firings
 * across an entire post-reset session. Equality only ever suppresses a
 * literal repeat of the same sequence number for the same player, which is
 * what "already reported this exact onset" means.
 *
 * CRITICAL DETAIL: `lastReported` is updated on EVERY call, not only when the
 * appraiser fires. The first fix round updated it only on fire, which left a
 * narrower version of the same bug: after a reconnect, the appraiser sees a
 * quiescent tick at `onsetSeq: 0` (short-circuited below, no fire, and
 * previously no record either) before the first post-reset fight arrives. If
 * that fight's `onsetSeq` happens to COINCIDE with whatever the map still
 * held from the previous run — likely with only a handful of fights per
 * run, not exotic — a fire-only-write latch compares the new sequence
 * against the stale value and wrongly suppresses it (measured: run 1 ends at
 * `onsetSeq: 1`; post-reconnect fight 1 is also `onsetSeq: 1` → silently
 * suppressed; fight 2 fires). Recording on every call means the `onsetSeq: 0`
 * quiescent tick itself resets the latch to `0`, so the next distinct value —
 * even one that coincidentally reuses an old number — reads as a change and
 * fires.
 *
 * Routes to the `interrupt` RUNG via `interrupt: true`, which `eventRung`
 * (`brain/stem/state.ts`) gates on explicitly rather than on weight. That rung kills
 * the conscious turn and drops the plan but STAYS IN THE LOOP — strictly
 * gentler than an amygdala critical, and correct: you are in a fight, not
 * between lives.
 */
export function createCombatOnsetAppraiser(): DeterministicAppraiser {
  const lastReported = new Map<string, number>()
  return (state) => {
    const s = state as GameState
    const seq = s.combat?.onsetSeq ?? 0
    const key = s.player?.id ?? s.player?.username ?? ""
    const prevSeq = lastReported.get(key)
    lastReported.set(key, seq)
    if (seq === 0 || prevSeq === seq) return null
    return {
      disposition: "escalate",
      emotionalWeight: "😱",
      drive: "safety",
      weight: 5,
      interrupt: true,
      reason: "combat started — you are in a fight",
    }
  }
}

/** The domain's single deterministic appraiser instance. */
export const combatOnsetAppraiser: DeterministicAppraiser = createCombatOnsetAppraiser()

/**
 * Your own death — the ONE surviving interrupt rule, and the only condition in
 * this domain with a real claim on the full phase exit (`loop.ts` returns
 * `Interrupted`, `phases.ts:184-186` restarts `active` carrying only
 * `finalState`). The plan is genuinely void: the ship is gone, you respawned at
 * a clone base, and nothing you were doing still applies.
 *
 * A pure LEVEL condition on `deathPending`, which is safe here precisely
 * because the phase machine clears it. `InterruptRegistry` evaluates conditions
 * twice per tick (`explain()` then `criticals()`), so a self-consuming latch in
 * a rule's condition would be eaten by the audit call before the firing call
 * ever ran — which is exactly the class of bug that made `suppressWhenTaskIs`
 * inert. The clear lives at the point the exit is consumed instead.
 *
 * No `suppressWhenTaskIs`: `runActivation`'s call to `interrupts.criticals()`
 * (`brain/stem/loop.ts` — grep for it; the line has moved under this docblock
 * before and will again) is made without `currentStepTask`, unlike the
 * neighboring `interrupts.explain()` call, so suppression is inert, and there
 * is no task during which being dead is acceptable anyway.
 */
export const playerDeathRule: InterruptRule = {
  name: "player_died",
  priority: "critical",
  condition: (state) => (state as GameState).deathPending === true,
  message: () => "You were destroyed. Your ship is gone and you have respawned — take stock before acting.",
  suggestedAction: "get_status",
}

/**
 * The domain's interrupt registry: exactly one rule.
 *
 * It stays a registry rather than being deleted because `runActivation`
 * (`brain/stem/loop.ts`) resolves `InterruptRegistryTag` and calls
 * `interrupts.explain()`/`interrupts.criticals()` unconditionally — grep for
 * those symbols rather than trust a line number here, it has drifted before —
 * and because death genuinely wants the amygdala's cut-the-line exit, which is
 * the one thing the appraisal ladder deliberately does not offer.
 */
export const spaceMoltInterruptRegistry = createInterruptRegistry([playerDeathRule])

/** Layer providing the SpaceMolt interrupt registry. */
export const SpaceMoltInterruptRegistryLive = Layer.succeed(
  InterruptRegistryTag,
  spaceMoltInterruptRegistry,
)
