/**
 * Write-time LINEAGE: which already-existing memory a new memory most resembles,
 * and how strongly.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The long-term store restates itself constantly — the same handful of facts
 * written down dozens of times by four tiers across a run. Four offline studies
 * dead-ended on it: a blind labeller could confidently judge only 197 of 825
 * records, namely the first clean statement of a fact and its obvious echoes.
 * The enormous ambiguous middle — the near-restatements — is exactly where any
 * decay or deduplication decision has to be made, and NOTHING in the store
 * recorded that memory 486 restates memory 234.
 *
 * With lineage, "first statement of a fact" stops being a human judgement call
 * and becomes a computable class: a row with no sufficiently-similar prior.
 *
 * ── THE TWO PROPERTIES THAT DECIDE WHETHER THE DATA IS WORTH HAVING ─────────
 *
 * 1. IT IS COMPUTED AS OF THE WRITE, NOT AS OF NOW. `computeLineage` runs
 *    BEFORE the row is inserted, so `memories_vec` contains exactly the memories
 *    that already existed. Recomputing the identical query a week later would
 *    search a store containing the row's own future and quietly re-point it at
 *    neighbours that did not exist when it was written — a different answer
 *    wearing the same name. This is also why the historical corpus is left at
 *    `legacy` rather than backfilled.
 *
 * 2. THE RAW SIMILARITY IS THE RECORD; NO THRESHOLD IS APPLIED. There is
 *    deliberately no `is_restatement` boolean here or in the schema. Measured on
 *    the live 825-row corpus, nearest-prior cosine ranks restatements well
 *    (AUC 0.94 against an independent lexical-overlap label) but the
 *    distribution has NO VALLEY: it is a single mode centred at 0.84, 70% of
 *    rows sit above 0.80, and the deduplication curve is smooth all the way
 *    down. Any boolean would be one corpus's arbitrary cut baked irreversibly
 *    into every future row. Storing the number costs 8 bytes and lets an
 *    analyst re-threshold for free.
 *
 * ── AND IT MUST NEVER COST A WRITE ──────────────────────────────────────────
 *
 * The whole routine is guarded: any failure yields `unknown`, the write
 * proceeds, and `unknown` is a DIFFERENT value from `first` ("the store was
 * empty") so the two can never be confused by a reader. See LINEAGE_* in
 * memory-sql.ts for the full four-state taxonomy.
 */

import { buildNearestPriorSql, buildEmbeddingsSql, LINEAGE_FIRST, LINEAGE_SCORED, LINEAGE_UNKNOWN } from "./memory-sql.js"
import { decodeEmbedding } from "./memory-format.js"
import { cosine } from "../salience/axis-score.js"
import type { MemoryDb } from "./memory-run.js"

/** The four lineage states. Mirrors LINEAGE_* in memory-sql.ts. */
export type LineageState = "scored" | "first" | "unknown" | "legacy"

/** What one write learned about its own ancestry. */
export interface LineageRecord {
  readonly state: LineageState
  /** The nearest memory that already existed. null unless `state === "scored"`. */
  readonly priorId: number | null
  /** Raw vec0 (L2) distance to that memory — the primitive the index returned. */
  readonly distance: number | null
  /**
   * Cosine to that same memory, from both STORED vectors. Null on a `scored`
   * row means only the DERIVED value was unavailable (the prior's vector could
   * not be read back, or a vector had zero norm) — the neighbour and the
   * distance are still real. It does not weaken `state`.
   */
  readonly similarity: number | null
}

/** The state a lookup that never ran produces. Not exported as a constant elsewhere. */
const UNKNOWN: LineageRecord = {
  state: LINEAGE_UNKNOWN as LineageState,
  priorId: null,
  distance: null,
  similarity: null,
}

/** The first memory in a store: a real, positive fact, and NOT `unknown`. */
const FIRST: LineageRecord = {
  state: LINEAGE_FIRST as LineageState,
  priorId: null,
  distance: null,
  similarity: null,
}

/**
 * The four `buildInsertSql` bind values for a lineage record, in column order
 * (`lineage_state, lineage_prior_id, lineage_distance, lineage_similarity`).
 *
 * One function so the two insert sites (`remember`, `promote`) cannot disagree
 * about the order, which is the one mistake here that no test of this module
 * would catch and no runtime error would report — sqlite would happily store the
 * distance in the similarity column.
 */
export function lineageBindValues(
  rec: LineageRecord,
): [string, number | null, number | null, number | null] {
  return [rec.state, rec.priorId, rec.distance, rec.similarity]
}

/**
 * The cosine between a new memory's vector and its stored prior's, read back
 * from the vec0 table. Returns null — never throws — when the vector cannot be
 * read or the cosine is not finite.
 *
 * Read back rather than derived from the L2 distance on purpose. `cos = 1 −
 * d²/2` is exact for unit-normalised vectors and wrong for anything else, and
 * nothing in this store enforces normalisation; the production embedder happens
 * to normalise today, and a study should not silently inherit that assumption
 * from a future one that does not.
 */
function cosineToPrior(db: MemoryDb, priorId: number, vec: ReadonlyArray<number>): number | null {
  try {
    const rows = db.query(buildEmbeddingsSql({ ids: [priorId] })).all() as Array<{
      embedding?: unknown
    }>
    if (rows.length === 0) return null
    const prior = decodeEmbedding(rows[0].embedding)
    if (prior.length !== vec.length) return null
    const c = cosine(vec, prior)
    return Number.isFinite(c) ? c : null
  } catch {
    return null
  }
}

/**
 * Lineage for a memory about to be inserted, given its embedding. NEVER THROWS.
 *
 * MUST be called BEFORE the row's own INSERT — the "prior" set is defined by
 * what is in `memories_vec` at the instant of the query, and there is no
 * ordering predicate to get wrong precisely because of that ordering.
 *
 * On any failure it returns `unknown` and reports through `onWarn`. The stderr
 * line is a weak signal (the host's `runDockerCommand` surfaces stderr only on a
 * non-zero exit, and this path exits 0 by design); the durable signal is
 * `lineage_state = 'unknown'` on the row, which stays queryable forever — the
 * same arrangement `loadGlossVectors` uses for `dims_a = '{}'`.
 *
 * NOT CANCELLABLE. `bun:sqlite` queries are synchronous, so there is no seam at
 * which a slow KNN could be timed out; the guard here is the try/catch plus the
 * fact that the query is a k=1 scan whose cost is bounded by the store size.
 * Measured at 825 rows on the live corpus it is ~1 ms — see the task report. If
 * a store ever grows to where that matters, the fix is a real index (sqlite-vec
 * brute-forces), not a timeout that cannot be implemented here.
 */
export function computeLineage(
  db: MemoryDb,
  vec: ReadonlyArray<number>,
  onWarn: (line: string) => void,
): LineageRecord {
  try {
    const rows = db.query(buildNearestPriorSql()).all(JSON.stringify(vec)) as Array<{
      id?: unknown
      distance?: unknown
    }>
    // An empty store. The ONLY way to reach `first`, and it is not a failure.
    if (rows.length === 0) return FIRST
    const id = Number(rows[0].id)
    const distance = Number(rows[0].distance)
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(distance)) {
      onWarn(
        `[memory] nearest-prior lookup returned an uninterpretable row ` +
          `(id=${String(rows[0].id)}, distance=${String(rows[0].distance)}) — ` +
          `recording lineage as unknown; the memory itself is unaffected`,
      )
      return UNKNOWN
    }
    return {
      state: LINEAGE_SCORED as LineageState,
      priorId: id,
      distance,
      similarity: cosineToPrior(db, id, vec),
    }
  } catch (e) {
    onWarn(
      `[memory] nearest-prior lookup failed (${e instanceof Error ? e.message : String(e)}) — ` +
        `recording lineage as unknown (NOT as "nothing was restated"); the write still lands`,
    )
    return UNKNOWN
  }
}
