/**
 * SQL builders for the append-only long-term memory store (spec §9).
 *
 * The store is a single sqlite-vec db file at `players/<name>/me/longterm.db`
 * (per-character, co-located with the diary), opened in WAL mode. Rows are NEVER
 * updated or deleted — the whole point is durable episodic ground truth. The ONE
 * deliberate, narrowly-scoped exception is `buildAdjudicateSql` below: the
 * salience adjudicator (design §3, stage B) UPDATEs only `dims`/`dims_stage` on
 * a row it has re-scored, never the log-of-record fields (ts/source/text/
 * provenance) and never `dims_a`/`dims_c`.
 *
 * These pure builders produce the exact SQL strings the generated in-container
 * `memory` bun CLI embeds (Unit 4). Keeping them here lets the SQL shape be
 * unit-tested without a db, and lets the CLI generator interpolate them so the
 * two can never drift (the same generate-time reuse the frontier CLI does with
 * the sdk-payload framing builders).
 */

/**
 * Embedding dimension. Proven by the spike: `mlx-community/bge-small-en-v1.5-bf16`
 * emits 384-dim vectors. The vec0 table and the embed-response validator both key
 * off this single constant.
 */
export const EMBED_DIM = 384

/**
 * The three values of the per-row salience STAGE marker (design 2026-07-31 §3).
 * ONE site — the CLI, the sweep and the migration all read these.
 *
 *  - `base`        the optimistic ⊕ of A and C, written with the row. The
 *                  adjudicator's work queue is exactly `dims_stage = 'base'`.
 *  - `adjudicated` B has run and its output SUPERSEDED the base.
 *  - `legacy`      the row predates Phase 2 (a one-hot `{drive: weight/5}` or a
 *                  NULL). The spec names only the first two; this third exists
 *                  so the migration's backfill does not silently enqueue the
 *                  entire historical corpus for one model call each — design §8
 *                  is explicit that v1 rows keep scoring and no re-score is
 *                  scheduled.
 */
export const STAGE_BASE = "base"
export const STAGE_ADJUDICATED = "adjudicated"
export const STAGE_LEGACY = "legacy"

/**
 * The four values of the per-row LINEAGE state (2026-08-03). Lineage records,
 * at write time, which already-existing memory a new memory most resembles.
 *
 * They exist as four distinct values rather than "a prior id or null" because
 * a null prior id has FOUR different causes and collapsing them is the exact
 * class of error the wire stamp already exists to prevent:
 *
 *  - `scored`   the KNN ran and found a nearest prior. `lineage_prior_id`,
 *               `lineage_distance` and `lineage_similarity` are all populated.
 *  - `first`    the KNN ran and there was NO prior memory at all — this row is
 *               the first in the store. A real, positive fact.
 *  - `unknown`  the lookup was attempted and FAILED. The write still landed.
 *               Nothing may read this as "no near neighbour".
 *  - `legacy`   the row predates lineage entirely (the ADD COLUMN backfill).
 *               Also unknown, but for a different and permanent reason: no
 *               lookup was ever attempted and none can be, honestly, after the
 *               fact — the store has grown since, so a lookup today would
 *               answer a different question (see `buildNearestPriorSql`).
 *
 * `unknown` and `legacy` are both "lineage unknown"; `first` is NOT. A study
 * filtering for un-restated memories wants `first`, never the other two.
 */
export const LINEAGE_SCORED = "scored"
export const LINEAGE_FIRST = "first"
export const LINEAGE_UNKNOWN = "unknown"
export const LINEAGE_LEGACY = "legacy"

/**
 * The two DDL statements: the append-only `memories` log of record, and the
 * `vec0` virtual table that indexes the embedding keyed by the same id. `IF NOT
 * EXISTS` so schema creation is idempotent (run on every CLI invocation).
 *
 * Phase 2 adds three derived columns beside `dims`. `dims` is the CURRENT BEST
 * vector — the one recall ranks with — while `dims_a` and `dims_c` retain the
 * two producers separately, because the adjudicator (design §3, stage B) takes
 * both as inputs and cannot reconstruct them from their mean.
 */
export function buildSchemaSql(dim: number = EMBED_DIM): string {
  return [
    `CREATE TABLE IF NOT EXISTS memories (`,
    `  id INTEGER PRIMARY KEY,`,
    `  ts TEXT NOT NULL,`,
    `  source TEXT NOT NULL,`,
    `  tags TEXT,`,
    `  text TEXT NOT NULL,`,
    `  provenance TEXT NOT NULL DEFAULT 'episodic',`,
    `  dims TEXT,`,
    `  dims_a TEXT,`,
    `  dims_c TEXT,`,
    `  dims_stage TEXT NOT NULL DEFAULT '${STAGE_LEGACY}',`,
    // Lineage (2026-08-03): what this memory restated AT THE MOMENT IT WAS
    // WRITTEN. See LINEAGE_* above for why the state is its own column, and
    // `buildNearestPriorSql` for why this cannot be recomputed later.
    `  lineage_state TEXT NOT NULL DEFAULT '${LINEAGE_LEGACY}',`,
    `  lineage_prior_id INTEGER,`,
    `  lineage_distance REAL,`,
    `  lineage_similarity REAL`,
    `);`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(`,
    `  id INTEGER PRIMARY KEY,`,
    `  embedding FLOAT[${dim}]`,
    `);`,
    // 1-row key/value meta table holding the bounded promotion high-water mark
    // (spec §9) and, since Phase 2, the cached axis-gloss embedding table. The
    // value is opaque JSON; the CLI owns both keys' shapes.
    `CREATE TABLE IF NOT EXISTS meta (`,
    `  key TEXT PRIMARY KEY,`,
    `  value TEXT`,
    `);`,
  ].join("\n")
}

/** The meta key under which the promotion high-water mark is stored. */
export const PROMOTE_MARK_KEY = "promote_mark"

/** Read the meta value for a key. Bind: key. */
export function buildMetaGetSql(): string {
  return `SELECT value FROM meta WHERE key = ?`
}

/** Upsert a meta key/value (1-row mark). Bind order: key, value. */
export function buildMetaSetSql(): string {
  return `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`
}

/**
 * Append a record row. Bind order: ts, source, tags, text, provenance, dims,
 * dims_a, dims_c, dims_stage, lineage_state, lineage_prior_id, lineage_distance,
 * lineage_similarity. id auto-assigned.
 *
 * The schema defaults for `dims_stage` and `lineage_state` are both `'legacy'`
 * (they exist for the MIGRATION backfill); every insert therefore writes them
 * EXPLICITLY. A new row is always `dims_stage = 'base'`, and its lineage state
 * is whatever the nearest-prior lookup actually produced — including `'unknown'`
 * when that lookup failed. A row inserted by this statement is NEVER
 * `lineage_state = 'legacy'`; that value means "written before lineage existed"
 * and nothing but the ALTER TABLE default may ever produce it.
 */
export function buildInsertSql(): string {
  return (
    `INSERT INTO memories (ts, source, tags, text, provenance, dims, dims_a, dims_c, dims_stage, ` +
    `lineage_state, lineage_prior_id, lineage_distance, lineage_similarity) ` +
    `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
}

/**
 * The nearest ALREADY-EXISTING memory to a query vector, by the index's own
 * metric. Bind: the query vector (JSON array). Returns 0 rows on an empty store.
 *
 * WHY THIS RUNS BEFORE THE INSERT, AND WHY THAT IS THE WHOLE POINT.
 *
 * Lineage must mean "what did this memory restate AT THE TIME IT WAS WRITTEN".
 * Every row in `memories_vec` when this runs is, by construction, a row that
 * already existed — so no ordering filter is needed and none is possible to get
 * wrong. Recomputing the same query later against a fuller store would answer a
 * different question (a memory can only restate its past, but a later store
 * contains its future), and would silently re-point rows at neighbours that did
 * not exist yet. That is why there is no backfill for the historical corpus and
 * why `LINEAGE_LEGACY` is permanent rather than a TODO.
 *
 * `k = 1` is a LITERAL for the same reason `buildKnnSql`'s is: sqlite-vec
 * requires a constant. Only the id and distance come back — the row's text is
 * not needed to record lineage, and joining `memories` would double the work on
 * a path that runs on EVERY insert.
 *
 * The neighbour is nearest by the vec0 metric (L2). `lineage_similarity` is the
 * cosine to THAT row — not, in general, the maximum cosine over the store. For
 * unit-normalised embeddings (bge-small-en-v1.5, the production embedder, emits
 * norm 1.000000 on all 825 rows of the live corpus — measured, not assumed) the
 * two orderings are identical, since L2² = 2(1−cos). For a future embedder that
 * does not normalise they could differ, which is exactly why both the raw
 * distance and the cosine are stored: an analyst can see the disagreement.
 */
export function buildNearestPriorSql(): string {
  return [
    `SELECT v.id AS id, v.distance AS distance`,
    `FROM memories_vec v`,
    `WHERE v.embedding MATCH ? AND k = 1`,
    `ORDER BY v.distance`,
  ].join("\n")
}

/** Insert the embedding for an already-inserted row. Bind order: id, embedding (JSON string). */
export function buildVecInsertSql(): string {
  return `INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`
}

/**
 * Over-fetch multiplier used when a tag filter is active: sqlite-vec applies `k`
 * at the index level before any post-filtering, so we ask the index for more
 * rows and let the CLI drop tag-mismatches in JS while still returning ~k.
 */
export const TAG_OVERFETCH = 8

/**
 * KNN query. `k` is baked as a LITERAL — sqlite-vec requires `k = <constant>`
 * (proven by the spike, which used a literal, not a bound param); only the query
 * vector is bound (`MATCH ?`, a JSON-stringified array). Joins the vec table back
 * to `memories` so the ranked rows carry their ts/source/tags/text. When a tag
 * filter is supplied the literal k is multiplied so JS post-filtering still nets
 * ~k matches (sqlite-vec can't AND an arbitrary tag predicate with k).
 *
 * The stage marker is selected under its COLUMN name, `dims_stage`, not under
 * the wire name `stage`. Every builder here returns raw column names (`dims`,
 * `dims_a`, `dims_c`, `dims_stage`) and `formatResults` owns the single rename
 * to `stage` on the NDJSON line. An `AS stage` alias here read as harmless and
 * was not: `formatResults` looks up `r.dims_stage`, so the aliased row made
 * every recall line ship `stage: null` while both this module's tests and the
 * formatter's tests stayed green — the seam between them is now covered by
 * memory-format.test.ts's derived-key tests.
 *
 * `dims_a` and `dims_c` ride along as of wire v2. The comment they replace said
 * shipping B's inputs on every hit would be "dead weight on the hottest path" —
 * that reasoning was about the EMBEDDING (384 floats). These are AXIS vectors:
 * one float per axis, ~8 keys for a real character, a few hundred bytes. And the
 * cost of NOT shipping them was total: `dims` is the adjudicated ⊕ of A and C,
 * so with only `dims` on the wire the C stage — the authoring model's own
 * reading — cannot be compared against anything, ever, on any recall.
 *
 * The four `lineage_*` columns ride along as of wire v3, for the same reason and
 * at a far smaller cost (four scalars). Without them there is no read path to
 * lineage at all short of opening the db by hand, and the corpus study that
 * motivates lineage runs off `recent`, which shares this formatter.
 */
export function buildKnnSql(k: number, tagFilter?: ReadonlyArray<string>): string {
  const effectiveK = tagFilter && tagFilter.length > 0 ? k * TAG_OVERFETCH : k
  return [
    `SELECT m.id AS id, m.ts AS ts, m.source AS source, m.provenance AS provenance, m.dims AS dims, m.dims_a AS dims_a, m.dims_c AS dims_c, m.dims_stage AS dims_stage, m.lineage_state AS lineage_state, m.lineage_prior_id AS lineage_prior_id, m.lineage_distance AS lineage_distance, m.lineage_similarity AS lineage_similarity, m.tags AS tags, m.text AS text, v.distance AS distance`,
    `FROM memories_vec v`,
    `JOIN memories m ON m.id = v.id`,
    `WHERE v.embedding MATCH ? AND k = ${effectiveK}`,
    `ORDER BY v.distance`,
  ].join("\n")
}

/** Guard an integer used as a SQL LITERAL. There is no bind seam on the read path. */
function intLiteral(n: number, what: string): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${what} must be a positive integer (got ${String(n)})`)
  }
  return n
}

/**
 * The `recent` listing. Same field set as `buildKnnSql`, minus the distance —
 * and "same" is load-bearing, because both feed the SAME formatter. A column
 * `formatResults` reads but this builder omits does not error; it renders as
 * `null`, which is indistinguishable from a genuinely empty stage.
 */
export function buildRecentSql(n: number): string {
  return (
    `SELECT id, ts, source, provenance, dims, dims_a, dims_c, dims_stage, ` +
    `lineage_state, lineage_prior_id, lineage_distance, lineage_similarity, tags, text ` +
    `FROM memories ORDER BY id DESC LIMIT ${intLiteral(n, "recent n")}`
  )
}

/**
 * The adjudicator's work queue (design §3, stage B): rows still carrying the
 * optimistic base, oldest first, capped. Returns exactly what B needs — the
 * memory text and the two producer vectors — and nothing else.
 *
 * `dims_stage = 'base'` deliberately EXCLUDES `'legacy'`: the historical corpus
 * is not re-scored in v1 (§8).
 */
export function buildPendingSql(n: number): string {
  return (
    `SELECT id, text, dims_a, dims_c FROM memories ` +
    `WHERE dims_stage = '${STAGE_BASE}' ORDER BY id ASC LIMIT ${intLiteral(n, "pending n")}`
  )
}

/**
 * Read stored embeddings back out of the vec0 table — the ONLY select that ever
 * touches `memories_vec.embedding`.
 *
 * WHY IT IS A SEPARATE VERB AND NOT PART OF RECALL. This is 384 floats per row.
 * `buildKnnSql` runs several times per tick on the hottest path in the system;
 * widening it by 1.5 KB of vector per candidate to serve offline analysis would
 * be a permanent runtime tax for a use that runs at most once per study. So the
 * embedding is retrievable only here, by explicit invocation, and never rides a
 * recall.
 *
 * WHY IT EXISTS AT ALL. The embeddings have been written since day one
 * (`buildVecInsertSql`) and nothing has ever SELECTed them, so every offline
 * study re-embedded the whole corpus — slow, and irreproducible the moment the
 * embedding model moves, because the re-embedding uses TODAY's model against
 * vectors written by whatever model was live at insert.
 *
 * `ids` selects an explicit set (ascending, deduped); omit it for the whole
 * table. `n` caps the row count; omit for no cap, which is the normal offline
 * "dump everything" call. Both are SQL LITERALS — vec0's read path has no bind
 * seam here — so both are integer-guarded.
 *
 * The `embedding` column comes back as the raw float32 BLOB, NOT `vec_to_json`.
 * `vec_to_json` formats at six decimal places, which silently rounds a float32
 * (a 2.5e-7 change on a 0.02-magnitude bge component). `decodeEmbedding` in
 * memory-format.ts decodes the blob to the EXACT stored float32 values instead.
 */
export function buildEmbeddingsSql(opts?: {
  readonly ids?: ReadonlyArray<number>
  readonly n?: number
}): string {
  const parts = [`SELECT id, embedding FROM memories_vec`]
  const ids = opts?.ids
  if (ids && ids.length > 0) {
    const uniq = [...new Set(ids.map((id) => intLiteral(id, "embeddings id")))].sort((a, b) => a - b)
    parts.push(`WHERE id IN (${uniq.join(", ")})`)
  }
  parts.push(`ORDER BY id ASC`)
  if (opts?.n !== undefined) parts.push(`LIMIT ${intLiteral(opts.n, "embeddings n")}`)
  return parts.join(" ")
}

/**
 * Write B's authoritative vector over the base. Bind order: dims, id.
 *
 * This is the ONE `UPDATE` in the store, and it touches ONLY the two derived
 * salience columns. The append-only invariant at the top of this file protects
 * the LOG OF RECORD — ts, source, text, provenance — and none of those is
 * writable after insert. `dims_a`/`dims_c` are also left alone: they are B's
 * inputs, and keeping them makes an adjudication auditable after the fact.
 */
export function buildAdjudicateSql(): string {
  return `UPDATE memories SET dims = ?, dims_stage = '${STAGE_ADJUDICATED}' WHERE id = ?`
}
