/**
 * Host-side re-ranking for recall (design 2026-07-21 §4, Phase 1).
 *
 * sqlite-vec can only rank by distance, so `recall` over-fetches `k *
 * RERANK_OVERFETCH` nearest hits and this pure function re-orders them by
 *   relevance × reputationWeight(provenance)
 * then truncates to the caller's `k`. Relevance stays dominant (reputation is
 * bounded ≤ 1), so we down-weight low-trust memories without surfacing
 * irrelevant ones. Phase 3 extends compositeScore with a salience-decay term.
 */

import type { Provenance } from "./memory-provenance.js"
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

/** relevance(score) × reputation. NaN score → 0. */
export function compositeScore(hit: MemoryHit): number {
  const rel = Number.isFinite(hit.score) ? hit.score : 0
  return rel * reputationWeight(hit.provenance)
}

/** Re-order by composite score (desc) and keep the top `k`. Pure; input untouched. */
export function rerank(hits: ReadonlyArray<MemoryHit>, k: number): MemoryHit[] {
  return hits
    .map((h) => ({ h, s: compositeScore(h) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(0, k))
    .map((x) => x.h)
}
