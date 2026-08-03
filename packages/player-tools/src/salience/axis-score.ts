/**
 * The MECHANICAL (A) stage of the per-memory salience pipeline — pure math, no
 * I/O (design 2026-07-31 §3).
 *
 * A is the cosine of the memory's embedding against each AXIS-GLOSS embedding.
 * It runs inside the `memory` CLI at insert because that is the only place the
 * memory's embedding exists, and it is what makes "every write on every pathway
 * gets a vector" structurally true rather than a wiring promise: a NULL-dims row
 * is now only possible if the CLI itself failed. That matters — the last live
 * validation found 565/565 rows with NULL dims because ONE upstream signal went
 * quiet and nothing downstream could tell.
 *
 * A is deliberately WEAK and deliberately CHEAP. It knows nothing about what the
 * axes mean beyond gloss similarity; the adjudicator (stage B) owns the rubric.
 * A's job is to make sure no row is ever dimensionless.
 */

import type { AxisSpec } from "./axis-vocab.js"

/**
 * Cosine similarity, `∈ [-1, 1]`. Returns 0 — never NaN — for a zero-norm input,
 * matching the NEUTRAL_SALIENCE fall-through discipline: a degenerate vector
 * makes the axis inert, it does not poison the row.
 *
 * A DIMENSION MISMATCH returns 0 too, through the same door. Two vectors of
 * different lengths are two vectors from different EMBEDDING SPACES — a cached
 * gloss table that outlived an embedding-model change is the live case — and
 * there is no meaningful angle between them. Scoring the shared prefix (what this
 * used to do) turns that structural break into a plausible finite number: a
 * same-dimension swap would read as confident nonsense rather than as nothing at
 * all. Inert is the disciplined failure mode for this subsystem; wrong is not.
 * The embed client still validates dimension loudly at the boundary, so this is
 * the floor, not the alarm.
 */
export function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length) return 0
  const n = a.length
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb))
  return Number.isFinite(c) ? c : 0
}

/** Embedded gloss vectors, keyed `"<axis>:+"` (positive pole) / `"<axis>:-"`. */
export type AxisGlossVectors = Record<string, number[]>

/** The gloss-vector key for one pole of one axis. */
const glossKey = (axis: string, pole: "+" | "-"): string => `${axis}:${pole}`

/**
 * Every text that must be embedded for this axis list, with the key its vector
 * is cached under. One text per unipolar drive axis; TWO per bipolar palette
 * axis, one for each pole — A's reading of a bipolar axis is the DIFFERENCE
 * between the poles, which is what carries the sign (spec §6).
 *
 * The order is stable (axis order, positive pole first) so a caller can embed
 * them in a single deterministic pass.
 */
export function glossTextsFor(specs: ReadonlyArray<AxisSpec>): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = []
  for (const s of specs) {
    out.push({ key: glossKey(s.name, "+"), text: s.positiveGloss })
    if (s.polarity === "bipolar") out.push({ key: glossKey(s.name, "-"), text: s.negativeGloss })
  }
  return out
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/**
 * The A vector: where this memory's embedding sits on each axis.
 *
 *  - a UNIPOLAR drive axis scores `cos(memory, gloss)` clamped to `[0, 1]`. A
 *    negative cosine means "unrelated to this drive", not "negatively related" —
 *    there is no opposite of safety, so it floors at 0.
 *  - a BIPOLAR palette axis scores `cos(memory, positivePole) −
 *    cos(memory, negativePole)`, clamped to `[-1, +1]`. The difference is what
 *    makes the reading SIGNED, and the sign is the entire reason the palette
 *    tier is bipolar (spec §6): collapsing it to a magnitude here would throw
 *    away exactly what Phase 3's situational term needs.
 *
 * An axis whose gloss vector is missing from the table is SKIPPED, not scored 0.
 * A 0 is a real claim ("this memory sits at the neutral middle"); a missing
 * gloss is an absence of evidence, and the ⊕ merge treats the two differently.
 */
export function mechanicalVector(
  memVec: ReadonlyArray<number>,
  specs: ReadonlyArray<AxisSpec>,
  gloss: AxisGlossVectors,
): Record<string, number> {
  const out: Record<string, number> = {}
  if (memVec.length === 0) return out
  for (const s of specs) {
    const pos = gloss[glossKey(s.name, "+")]
    if (!pos) continue
    if (s.polarity === "bipolar") {
      const neg = gloss[glossKey(s.name, "-")]
      if (!neg) continue
      out[s.name] = clamp(cosine(memVec, pos) - cosine(memVec, neg), -1, 1)
    } else {
      out[s.name] = clamp(cosine(memVec, pos), 0, 1)
    }
  }
  return out
}

/**
 * ⊕ — the optimistically-written base vector (design §3):
 *
 *   base[axis] = mean(A[axis], C[axis])   where both scored
 *   base[axis] = A[axis]                  where C did not
 *   base[axis] = C[axis]                  where A did not
 *
 * The key set is the UNION of both producers, not the intersection, and that is
 * load-bearing. The CLI's axis list comes from files on disk that can be absent
 * — a scratch container, a character mid-scaffold, the byte-diff gate's /tmp —
 * and in that case A is `{}`. Intersecting would DELETE the vector the host had
 * just computed and hand back a dimensionless row: inert, clean, and unnoticed,
 * which is the failure class this whole design exists to prevent. The host is
 * authoritative about what it emitted; the CLI never silently drops it.
 *
 * A non-finite component from either side is dropped rather than averaged, so a
 * single bad number can never propagate into `salienceWeight` and NaN out an
 * entire composite score.
 *
 * The accumulator is PROTOTYPE-FREE. C arrives from model-authored `--dims-c`
 * through `JSON.parse`, which creates a genuine own property for a `"__proto__"`
 * key; assigning that onto a `{}` literal would hit `Object.prototype`'s setter
 * instead of storing anything, and the component would vanish from the stored
 * JSON without a word. Whatever the producer sent is either stored or visibly
 * dropped — never quietly swallowed.
 */
export function mergeBaseVector(
  a: Record<string, number>,
  c?: Record<string, number> | null,
): Record<string, number> {
  const out: Record<string, number> = Object.create(null) as Record<string, number>
  const cv = c ?? {}
  for (const key of new Set([...Object.keys(a), ...Object.keys(cv)])) {
    const av = a[key]
    const bv = cv[key]
    const aOk = typeof av === "number" && Number.isFinite(av)
    const bOk = typeof bv === "number" && Number.isFinite(bv)
    if (aOk && bOk) out[key] = (av + bv) / 2
    else if (aOk) out[key] = av
    else if (bOk) out[key] = bv
  }
  return out
}
