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
export interface ScoreBreakdown {
  /** Relevance — the container's `1/(1+distance)`, or 0 when non-finite. */
  readonly rel: number
  /** Reputation weight of the provenance tier. */
  readonly rep: number
  /** Recency decay at the salience-modulated half-life. */
  readonly rec: number
  /** Situational (mood) factor ∈ [0.5, 1.5] — the only factor that can exceed 1. */
  readonly sit: number
  /** The MAGNITUDE reading of `dims`; an INPUT to `rec`, not a factor of the product. */
  readonly salience: number
  /** `nowMs − Date.parse(hit.ts)`. NaN when the row's ts is unparseable (→ `rec` = 1). */
  readonly ageMs: number
  /** `rel × rep × rec × sit`. */
  readonly composite: number
  /** The same score with each term neutralised in turn. OBSERVATION ONLY. */
  readonly counterfactual: ScoreCounterfactuals
}

// ---- Per-term counterfactuals (instrumentation, 2026-08-03) ----------------
//
// WHY THIS IS COMPUTED FOR EVERY CANDIDATE ON EVERY RECALL, rather than sampled.
// The original design for measuring a term's contribution was a decay-EXEMPT
// holdout cohort. That justification does not survive contact with the store:
// **nothing is ever deleted.** There is no DELETE, no pruning and no retention
// policy anywhere in the memory subsystem; decay is purely a ranking multiplier
// applied here, at rank time, to data that is already in hand. So the
// counterfactual "what would this have scored without term X" needs no cohort,
// no sampling and no perturbation of the agent — it is a handful of extra
// multiplications over inputs already computed, at 100% coverage.
//
// What that buys, which a cohort could not: each term's marginal contribution to
// ORDERING becomes directly measurable per recall (see `counterfactualEffects`).
// Live evidence says three of the four terms are inert in production — salience
// falls through to NEUTRAL_SALIENCE on every row of a corpus with no `dims`,
// recency has saturated to ≈3e-6 across whole pools, and mood is absent so `sit`
// is exactly 1 — which would make `rel × rep` the entire ranking function. These
// fields turn that inference into a measurement.
//
// NEUTRAL VALUES ARE DERIVED, NEVER LITERAL. A knob retune must move the
// counterfactual with the real score or the two silently describe different
// worlds; `NEUTRAL_RECENCY` comes from `recency` itself and the no-mood
// situational factor from `situational` itself, so neither can drift.

/**
 * A term removed from a product is a term replaced by the multiplicative
 * identity. This is algebra, not a knob — there is no "neutral reputation"
 * constant to track, and keying off `REPUTATION_WEIGHT.grounded` would silently
 * change meaning the day that tier stops being 1.0.
 */
export const NEUTRAL_REPUTATION = 1

/**
 * What `recency` returns when no decay applies — derived from the real function
 * (its fresh/unknown-age path) rather than written as `1`, so a change to the
 * decay curve cannot leave the counterfactual behind.
 */
export const NEUTRAL_RECENCY = recency(0, NEUTRAL_SALIENCE)

/**
 * The mood under which `situational` is inert. Passing this to the REAL
 * `situational` is what produces the neutral factor, so the counterfactual
 * inherits any future change to how "no mood" is handled.
 */
const NO_MOOD: Record<string, number> = Object.freeze({})

/**
 * The composite with each term neutralised in turn. Every one of these is the
 * score the ranker WOULD have sorted on in a world without that term; none of
 * them is ever sorted on for real.
 *
 * Key names are snake_case on purpose — they are the analyst-facing names, they
 * ride the telemetry stream verbatim, and they are what a study greps for.
 */
export interface ScoreCounterfactuals {
  /** `rec` forced to `NEUTRAL_RECENCY`: what this would score if memories never decayed. */
  readonly composite_no_decay: number
  /**
   * `rec` recomputed at `NEUTRAL_SALIENCE`: decay still applies, but the memory's
   * own dims no longer modulate its half-life. Salience is an INPUT to `rec`, not
   * a factor of the product, so neutralising it means re-deriving `rec` — not
   * multiplying anything out.
   */
  readonly composite_no_salience: number
  /** `sit` forced to its no-mood value: what this would score for a moodless character. */
  readonly composite_no_situational: number
  /** `rep` forced to `NEUTRAL_REPUTATION`: provenance stops being a trust weight. */
  readonly composite_no_reputation: number
  /** Every term but relevance neutralised — the container's KNN score, alone. */
  readonly composite_relevance_only: number
}

/**
 * The same maths as `compositeScore`, with every factor kept instead of
 * discarded (instrumentation, 2026-08-03). The product is written in the
 * original left-to-right order so the float result is bit-identical to what the
 * scalar form returned — this exists to make scoring OBSERVABLE, never to
 * change it.
 *
 * `salience` and `ageMs` are reported as inputs to `rec` rather than as factors:
 * multiplying the six numbers below would NOT give `composite`.
 */
export function scoreBreakdown(
  hit: MemoryHit,
  nowMs: number,
  salience: Record<string, number>,
  state: Record<string, number>,
): ScoreBreakdown {
  const rel = Number.isFinite(hit.score) ? hit.score : 0
  const s = salienceWeight(hit, salience) // MAGNITUDE reading — decay
  const ageMs = nowMs - Date.parse(hit.ts)
  const rec = recency(ageMs, s)
  const sit = situational(hit, state) // SIGNED reading — 1 + w·match ∈ [0.5, 1.5]
  const rep = reputationWeight(hit.provenance)
  // THE REAL SCORE, first and untouched: the same four factors in the same
  // left-to-right order the scalar form always used, so the float is
  // bit-identical. Nothing below may participate in it.
  const composite = rel * rep * rec * sit
  // Counterfactuals: same inputs, same multiplication order, one factor swapped
  // for its derived neutral. No extra IO, no extra queries.
  const recNeutralSalience = recency(ageMs, NEUTRAL_SALIENCE)
  const sitNoMood = situational(hit, NO_MOOD)
  return {
    rel,
    rep,
    rec,
    sit,
    salience: s,
    ageMs,
    composite,
    counterfactual: {
      composite_no_decay: rel * rep * NEUTRAL_RECENCY * sit,
      composite_no_salience: rel * rep * recNeutralSalience * sit,
      composite_no_situational: rel * rep * rec * sitNoMood,
      composite_no_reputation: rel * NEUTRAL_REPUTATION * rec * sit,
      composite_relevance_only: rel * NEUTRAL_REPUTATION * NEUTRAL_RECENCY * sitNoMood,
    },
  }
}

export function compositeScore(
  hit: MemoryHit,
  nowMs: number,
  salience: Record<string, number>,
  state: Record<string, number>,
): number {
  return scoreBreakdown(hit, nowMs, salience, state).composite
}

// ---- Scoring-context identity (instrumentation, 2026-08-03) -----------------

/**
 * ⚠ HAND-MAINTAINED. **Bump this whenever the SHAPE of the maths above changes**
 * — a new factor, a removed factor, a different combination rule, a changed
 * fall-through (e.g. `NEUTRAL_SALIENCE` applied under a new condition), or a
 * change to `halfLife`/`recency`/`moodMatch`/`situational`/`salienceWeight`.
 *
 * It is stamped on every recall telemetry record so pooled data can be split by
 * scoring epoch. NOTHING ENFORCES THE BUMP. Forgetting it silently merges two
 * scoring regimes into one dataset, which is exactly the failure this stamp
 * exists to prevent — so treat it as part of the edit, not as bookkeeping after
 * it.
 *
 * The one thing it does NOT need to cover is the *values* of the knobs below:
 * `scorerConstants()` is hashed alongside it and changes on its own when a
 * constant moves. This constant is only for changes a value hash cannot see.
 *
 * v1 — the state at the instrumentation commit: rel × rep × rec × sit, with
 *      salience read twice (magnitude → half-life, sign → mood cosine).
 */
export const SCORER_VERSION = "rank-v1"

/**
 * Every tunable that participates in a composite score, by value. Hashed into
 * the recall telemetry stamp so a knob change is detectable WITHOUT anyone
 * remembering to bump `SCORER_VERSION`. Derived from the live constants, so it
 * cannot drift from them.
 */
export function scorerConstants(): Record<string, number> {
  return {
    RERANK_OVERFETCH,
    HALF_LIFE_MIN,
    HALF_LIFE_MAX,
    NEUTRAL_SALIENCE,
    SITUATIONAL_WEIGHT,
    ...Object.fromEntries(
      Object.entries(REPUTATION_WEIGHT).map(([k, v]) => [`REPUTATION_WEIGHT.${k}`, v]),
    ),
  }
}

/** One scored candidate, in final rank order, with `returned` marking the top `k`. */
export interface RankedCandidate {
  readonly hit: MemoryHit
  readonly score: ScoreBreakdown
  /** Survived `slice(0, k)` — i.e. reached the prompt. */
  readonly returned: boolean
  /**
   * Position in the INPUT array — i.e. the in-container KNN's L2-distance order,
   * before this module re-ordered anything.
   *
   * It is not decoration: the sort below is stable over an array built in input
   * order, so the real ranking is exactly "composite desc, then input index
   * asc". A counterfactual re-sort must break its ties the same way or it would
   * report an ordering change that is really just a different tie resolution.
   */
  readonly index: number
}

/**
 * The FULL scored pool, sorted desc, with the top `k` flagged `returned`.
 *
 * `rerank` used to drop the losers and every score inside one expression; this
 * keeps them so recall telemetry can record what lost and why. Same comparator,
 * same (stable) sort, so the returned prefix is exactly what `rerank` yielded.
 * Pure; input untouched.
 */
export function rerankScored(
  hits: ReadonlyArray<MemoryHit>,
  k: number,
  nowMs: number,
  salience: Record<string, number>,
  state: Record<string, number>,
): RankedCandidate[] {
  const keep = Math.max(0, k)
  return hits
    .map((h, index) => ({ hit: h, score: scoreBreakdown(h, nowMs, salience, state), index }))
    .sort((a, b) => b.score.composite - a.score.composite)
    .map((c, i) => ({ ...c, returned: i < keep }))
}

// ---- Did neutralising a term actually change what came back? ---------------

/** The five neutralisations, in a fixed order, as an analyst names them. */
export const COUNTERFACTUAL_TERMS = [
  "composite_no_decay",
  "composite_no_salience",
  "composite_no_situational",
  "composite_no_reputation",
  "composite_relevance_only",
] as const

export type CounterfactualTerm = (typeof COUNTERFACTUAL_TERMS)[number]

/**
 * What one neutralisation did to THIS recall's outcome.
 *
 * The number that matters is `changedReturnedSet`: a term that shifts every
 * score but never changes which memories come back is doing nothing to the
 * character, however large its numerical effect looks. Score deltas are already
 * on every candidate; this is the part that cannot be recovered from them
 * without re-implementing the sort.
 */
export interface CounterfactualEffect {
  /** Did the SET of memories that would reach the prompt change at all? */
  readonly changedReturnedSet: boolean
  /** How many of the real top-k are still in the counterfactual top-k. */
  readonly returnedOverlap: number
  /**
   * Did the top-`k` come back as a different SEQUENCE? True whenever the set
   * changed OR the same memories came back in a different order — so
   * `changedReturnedOrder && !changedReturnedSet` is exactly "a reshuffle of the
   * same winners", which matters for a prompt whose first line is read hardest.
   */
  readonly changedReturnedOrder: boolean
  /** Did the ordering of the WHOLE pool change, winners or not? */
  readonly changedPoolOrder: boolean
  /**
   * Spearman rank correlation between the real and counterfactual orderings of
   * the whole pool. 1 = identical ordering. Null for a pool of fewer than 2.
   * Ties are impossible: both orderings break them on the input index.
   */
  readonly spearman: number | null
  /** Memory ids that WOULD have reached the prompt without this term. */
  readonly entered: ReadonlyArray<number>
  /** Memory ids that would have lost their place. */
  readonly displaced: ReadonlyArray<number>
}

/**
 * For each term, re-sort the ALREADY-SCORED pool on the counterfactual composite
 * and compare the outcome with the real one.
 *
 * Costs five sorts of a pool that is at most `k × RERANK_OVERFETCH` (48 at the
 * largest call site). No IO, no re-scoring — every number was computed in
 * `scoreBreakdown`.
 *
 * The tie-break on `index` is load-bearing, not tidiness: `rerankScored` gets
 * its real ordering from a stable sort over an array in input order, so ties
 * there resolve to input order. Re-sorting an already-rank-ordered array without
 * the same tie-break would resolve ties to RANK order and report the difference
 * as an ordering change caused by the neutralisation, which it is not. That is
 * precisely the failure mode for an inert term — where ties are commonest and a
 * false positive would be most misleading.
 *
 * `scored` must be the PRE-injection ranker output. Randomised injection changes
 * what reaches the prompt for reasons that have nothing to do with the scoring
 * terms, and folding it in here would attribute a coin flip to a term.
 */
export function counterfactualEffects(
  scored: ReadonlyArray<RankedCandidate>,
  k: number,
): Record<CounterfactualTerm, CounterfactualEffect> {
  const n = scored.length
  const keep = Math.min(Math.max(0, k), n)
  const realIds = scored.map((c) => c.hit.id)
  const realTop = new Set(realIds.slice(0, keep))
  // Real rank by input index, so both orderings can be compared position-wise.
  const realRank = new Map<number, number>()
  for (let i = 0; i < n; i += 1) realRank.set(scored[i].index, i)

  const out = {} as Record<CounterfactualTerm, CounterfactualEffect>
  for (const term of COUNTERFACTUAL_TERMS) {
    const alt = [...scored].sort(
      (a, b) => b.score.counterfactual[term] - a.score.counterfactual[term] || a.index - b.index,
    )
    const altIds = alt.map((c) => c.hit.id)
    const altTop = altIds.slice(0, keep)
    const altTopSet = new Set(altTop)
    let overlap = 0
    for (const id of altTop) if (realTop.has(id)) overlap += 1
    let sumD2 = 0
    alt.forEach((c, i) => {
      const d = i - (realRank.get(c.index) ?? i)
      sumD2 += d * d
    })
    out[term] = {
      changedReturnedSet: overlap !== keep,
      returnedOverlap: overlap,
      changedReturnedOrder: altTop.some((id, i) => id !== realIds[i]),
      changedPoolOrder: altIds.some((id, i) => id !== realIds[i]),
      spearman: n < 2 ? null : 1 - (6 * sumD2) / (n * (n * n - 1)),
      entered: altTop.filter((id) => !realTop.has(id)),
      displaced: realIds.slice(0, keep).filter((id) => !altTopSet.has(id)),
    }
  }
  return out
}

/** Re-order by composite score (desc) and keep the top `k`. Pure; input untouched. */
export function rerank(
  hits: ReadonlyArray<MemoryHit>,
  k: number,
  nowMs: number,
  salience: Record<string, number>,
  state: Record<string, number>,
): MemoryHit[] {
  return rerankScored(hits, k, nowMs, salience, state)
    .filter((c) => c.returned)
    .map((c) => c.hit)
}
