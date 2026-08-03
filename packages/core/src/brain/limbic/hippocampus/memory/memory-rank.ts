/**
 * Host-side re-ranking for recall (design 2026-07-21 §4; design 2026-07-31 §5).
 *
 * sqlite-vec can only rank by distance, so `recall` over-fetches `k *
 * RERANK_OVERFETCH` nearest hits and this pure function re-orders them by
 *   relevance × reputationWeight(provenance) × recency(age, halfLife(salience))
 *            × situational(mood alignment)
 * then truncates to the caller's `k`.
 *
 * ONE VECTOR, TWO JOBS (design 2026-07-31 §5). A memory's `dims` is read twice:
 *  - its MAGNITUDE feeds decay. `salienceWeight` weights |dims| against the
 *    character's SALIENCE.md profile; `halfLife` geometrically interpolates that
 *    into a half-life; `recency` is the exponential decay. This reading stays
 *    age-gated: with no mood, a fresh trivial memory and a fresh salient one
 *    still rank equally.
 *  - its SIGN feeds surfacing. `moodMatch` cosines it against the character's
 *    smoothed emotional-state vector and `situational` turns that into a bounded
 *    positive factor. THIS ONE IS NOT AGE-GATED: it is precisely a fresh-memory
 *    rank effect, which is why the decay-only invariant this module used to
 *    assert was retired here rather than preserved.
 *
 * The situational factor is the only one that can exceed 1, so mood CAN outrank
 * provenance. Design §5 argues that position deliberately: this system simulates
 * organicity rather than enforcing an evidence hierarchy, and the mitigation is
 * that `formatRecall` still labels every injected line with its provenance —
 * ranking bends, the record does not lie.
 */

import type { Provenance } from "@roci/player-tools/memory-provenance"
import type { MemoryHit } from "./longterm-store.js"

/** Ask the vec index for this many × the caller's k, then re-rank down to k. */
export const RERANK_OVERFETCH = 4

/** Multiplicative trust weight per provenance tier. */
export const REPUTATION_WEIGHT: Record<Provenance, number> = {
  grounded: 1.0,
  episodic: 0.85,
  inferred: 0.6,
  asserted: 0.45,
}

export function reputationWeight(p: Provenance): number {
  return REPUTATION_WEIGHT[p] ?? REPUTATION_WEIGHT.asserted
}

// ---- Decay knobs (Phase 3 §9) — EXPERIMENTALLY TUNABLE, all in MILLISECONDS. ----
// These are first-guesses; validate + retune via a roci QA run (does a salient
// memory persist and a trivial one fade at psychologically plausible rates?).
// This is the ONE site — do not scatter copies.
/** Half-life of a maximally-trivial memory (salienceWeight = 0): 1 hour. */
export const HALF_LIFE_MIN = 3_600_000
/** Half-life of a maximally-salient memory (salienceWeight = 1): 30 days. */
export const HALF_LIFE_MAX = 2_592_000_000
/** Salience assigned to a memory with no dimensional signature (legacy/non-observe). */
export const NEUTRAL_SALIENCE = 0.4

/**
 * How salient THIS memory is to THIS character: the character's caring × how far
 * from neutral the event sat, summed over the memory's dims and clamped to [0,1].
 * The character's profile MUST affect the result — that is the whole point.
 * Empty/absent dims → NEUTRAL_SALIENCE. A memory whose every dim is absent from
 * the profile (e.g. a domain-drive memory under a core-only template fallback)
 * can't be scored → NEUTRAL_SALIENCE (never NaN).
 *
 * THIS IS THE MAGNITUDE READING (design 2026-07-31 §5, job 1). It takes
 * `|dims[d]|`, not `dims[d]`, and that is load-bearing rather than defensive.
 * Since the axis redesign a memory's vector is SIGNED on every bipolar palette
 * axis: `burdened-exhilarated: -0.9` means "hard toward burdened". Sitting hard
 * on EITHER pole is salient; the neutral middle of the gradient is what is not.
 * A signed sum reads the negative pole as un-salience, so a memory the character
 * feels strongly about could reach `salienceWeight = 0` and be handed
 * `halfLife(0) = HALF_LIFE_MIN` — the 1-hour floor reserved for a maximally
 * TRIVIAL memory — and a negative component could cancel a positive one on a
 * different axis outright. The sign is not discarded, only unread here: the
 * SITUATIONAL job (`situational` below) is where it does its work.
 *
 * `Math.max(0, …)` is retained as a floor even though profile weights are
 * clamped to [0,1] by `parseSalience` and every term is now non-negative: it
 * costs nothing and keeps the stated [0,1] range true of a hand-edited profile.
 *
 * NOTE: the spec §3 boxed formula divides by `Σ salience[d]`; that normalization
 * cancels salience for single-drive dims (see the plan's Resolved-ambiguity note)
 * and contradicts the spec's own prose. The weighted sum below is the intent.
 */
export function salienceWeight(hit: MemoryHit, salience: Record<string, number>): number {
  const dims = hit.dims
  if (!dims) return NEUTRAL_SALIENCE
  const keys = Object.keys(dims)
  if (keys.length === 0) return NEUTRAL_SALIENCE
  let sum = 0
  let scored = 0
  for (const d of keys) {
    const s = salience[d]
    if (typeof s !== "number" || !Number.isFinite(s)) continue
    const v = dims[d]
    if (typeof v !== "number" || !Number.isFinite(v)) continue
    sum += Math.abs(v) * s
    scored += 1
  }
  if (scored === 0) return NEUTRAL_SALIENCE
  return Math.min(1, Math.max(0, sum))
}

/** Geometric interpolation MIN→MAX over salience s ∈ [0,1]. s=0→MIN, s=1→MAX. */
export function halfLife(s: number): number {
  return HALF_LIFE_MIN * (HALF_LIFE_MAX / HALF_LIFE_MIN) ** s
}

/** Exponential decay: 0.5 at one half-life. Fresh/future/unknown age → 1 (no decay). */
export function recency(ageMs: number, s: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1
  return 0.5 ** (ageMs / halfLife(s))
}

// ---- Situational surfacing knob (design 2026-07-31 §5 job 2, §10) ----
// UNTUNED first guess, at the ONE site, like every knob above it.
/**
 * How hard the character's current mood bends ranking, as `1 + w·match`. At
 * `w = 0.5` the factor runs [0.5, 1.5]: a mood-opposed memory is halved, a
 * mood-aligned one is boosted by half again.
 *
 * Load-bearing in both directions. Too high and recall becomes mood-locked (the
 * character can only remember things that agree with how it feels); too low and
 * the second reading of the vector is invisible. This is the ONLY factor in
 * `compositeScore` that can exceed 1, and that is the point — it is a boost, not
 * only a discount, so a mood-aligned `asserted` memory CAN outrank a
 * mood-opposed `grounded` one. Design §5 argues that position at length and
 * rejects both mitigations (capping w, boost-only); the mitigation that IS in
 * place is that `formatRecall` still labels every recalled line with its
 * provenance, so ranking bends while truth-status survives into the prompt.
 *
 * For whoever tunes this later: at equal relevance and age the ordering inverts
 * when `REPUTATION_WEIGHT[lo] × (1 + w) > REPUTATION_WEIGHT[hi] × (1 − w)`. For
 * the widest gap in the table (asserted 0.45 vs grounded 1.0) at full ±1
 * alignment that crosses at w ≈ 0.379. Recorded so the behaviour is predictable
 * — NOT as a bound on w.
 */
export const SITUATIONAL_WEIGHT = 0.5

/**
 * Cosine of the memory's SIGNED vector against the character's smoothed
 * emotional-state vector, in [-1, +1] (design 2026-07-31 §5, job 2).
 *
 * This is the SIGN reading of the same number `salienceWeight` reads as a
 * magnitude. Both axis tiers participate: a unipolar drive component is
 * non-negative on both sides and can only ever align, while a bipolar palette
 * component carries direction — a memory at `burdened-exhilarated: -0.7`
 * surfaces when the character is burdened and recedes when they are exhilarated.
 *
 * NORMALIZED, so it is scale-invariant in each argument. That is deliberate
 * insurance rather than a nicety: the A/C mean that produced `dims` is a
 * known-miscalibrated knob (design §3), and normalizing means this reading does
 * not inherit that miscalibration.
 *
 * ZERO NORM ON EITHER SIDE → 0 → an inert factor of 1, matching the
 * NEUTRAL_SALIENCE fall-through discipline above. The state check comes FIRST
 * and costs one `Object.keys`: an empty mood is the expected steady state until
 * the producing tiers are shown to emit real vectors, so it must be the cheapest
 * path through this function, not the most expensive.
 *
 * Pure. Never NaN: non-finite components on either side are skipped.
 */
export function moodMatch(
  dims: Record<string, number> | undefined,
  state: Record<string, number>,
): number {
  const stateKeys = Object.keys(state)
  if (stateKeys.length === 0) return 0
  if (!dims) return 0
  let normM = 0
  for (const k of Object.keys(dims)) {
    const v = dims[k]
    if (typeof v === "number" && Number.isFinite(v)) normM += v * v
  }
  if (normM === 0) return 0
  let dot = 0
  let normS = 0
  for (const k of stateKeys) {
    const s = state[k]
    if (typeof s !== "number" || !Number.isFinite(s)) continue
    normS += s * s
    const v = dims[k]
    if (typeof v === "number" && Number.isFinite(v)) dot += v * s
  }
  if (normS === 0) return 0
  // Clamped against float drift only; the maths already bounds this to [-1,+1].
  return Math.min(1, Math.max(-1, dot / Math.sqrt(normM * normS)))
}

/**
 * The situational surfacing factor: `1 + w·match`, in [1−w, 1+w] = [0.5, 1.5].
 *
 * BOUNDED STRICTLY POSITIVE (design §5): an anti-aligned memory is down-weighted,
 * never zeroed out of recall — a memory that cuts against the current mood is
 * exactly the kind of thing that should still surface on strong relevance.
 */
export function situational(hit: MemoryHit, state: Record<string, number>): number {
  const m = moodMatch(hit.dims, state)
  return m === 0 ? 1 : 1 + SITUATIONAL_WEIGHT * m
}

/**
 * relevance(score) × reputation × recency(age, salience-modulated half-life)
 * × situational(mood alignment). NaN score → 0.
 *
 * `state` is REQUIRED, not defaulted. A default would let a caller silently rank
 * without a mood forever, and "is the mood actually wired in?" would stop being
 * a question the type checker answers. Pass `{}` to mean "no mood" explicitly —
 * which yields a situational factor of exactly 1.
 */
export function compositeScore(
  hit: MemoryHit,
  nowMs: number,
  salience: Record<string, number>,
  state: Record<string, number>,
): number {
  const rel = Number.isFinite(hit.score) ? hit.score : 0
  const s = salienceWeight(hit, salience) // MAGNITUDE reading — decay
  const rec = recency(nowMs - Date.parse(hit.ts), s)
  const sit = situational(hit, state) // SIGNED reading — 1 + w·match ∈ [0.5, 1.5]
  return rel * reputationWeight(hit.provenance) * rec * sit
}

/** Re-order by composite score (desc) and keep the top `k`. Pure; input untouched. */
export function rerank(
  hits: ReadonlyArray<MemoryHit>,
  k: number,
  nowMs: number,
  salience: Record<string, number>,
  state: Record<string, number>,
): MemoryHit[] {
  return hits
    .map((h) => ({ h, s: compositeScore(h, nowMs, salience, state) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(0, k))
    .map((x) => x.h)
}
