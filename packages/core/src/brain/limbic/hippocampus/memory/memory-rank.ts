/**
 * Host-side re-ranking for recall (design 2026-07-21 §4, Phases 1 & 3).
 *
 * sqlite-vec can only rank by distance, so `recall` over-fetches `k *
 * RERANK_OVERFETCH` nearest hits and this pure function re-orders them by
 *   relevance × reputationWeight(provenance) × recency(age, halfLife(salience))
 * then truncates to the caller's `k`. Relevance stays dominant (the other two
 * factors are bounded ≤ 1), so we down-weight low-trust / faded memories without
 * surfacing irrelevant ones.
 *
 * Salience enters ONLY as the decay-rate knob (Phase 3): a fresh trivial memory
 * and a fresh salient memory rank equally when fresh — the difference is staying
 * power as they age. `salienceWeight` maps a memory's dimensional signature
 * against the character's salience profile; `halfLife` geometrically interpolates
 * that into a decay half-life; `recency` is the exponential decay.
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
 * How salient THIS memory is to THIS character: the character's caring × the
 * event's intensity, summed over the memory's dims (a dot product of the memory's
 * `dims` against the character's `salience` profile), clamped to [0,1]. The
 * character's profile MUST affect the result — that is the whole point of Phase 2.
 * Empty/absent dims → NEUTRAL_SALIENCE. A memory whose every dim is absent from
 * the profile (e.g. a domain-drive memory under a core-only template fallback)
 * can't be scored → NEUTRAL_SALIENCE (never NaN). For v1's single-drive observe
 * dims this is exactly `salience[drive] × (weight/5)`.
 *
 * NOTE: the spec §3 boxed formula divides by `Σ salience[d]`; that normalization
 * cancels salience for single-drive dims (see the plan's Resolved-ambiguity note)
 * and contradicts the spec's own prose. The dot product below is the intent.
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
    sum += dims[d] * s
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

/** relevance(score) × reputation × recency(age, salience-modulated half-life). NaN score → 0. */
export function compositeScore(hit: MemoryHit, nowMs: number, salience: Record<string, number>): number {
  const rel = Number.isFinite(hit.score) ? hit.score : 0
  const s = salienceWeight(hit, salience)
  const rec = recency(nowMs - Date.parse(hit.ts), s)
  return rel * reputationWeight(hit.provenance) * rec
}

/** Re-order by composite score (desc) and keep the top `k`. Pure; input untouched. */
export function rerank(
  hits: ReadonlyArray<MemoryHit>,
  k: number,
  nowMs: number,
  salience: Record<string, number>,
): MemoryHit[] {
  return hits
    .map((h) => ({ h, s: compositeScore(h, nowMs, salience) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(0, k))
    .map((x) => x.h)
}
