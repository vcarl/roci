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
    `  dims_stage TEXT NOT NULL DEFAULT '${STAGE_LEGACY}'`,
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
 * dims_a, dims_c, dims_stage. id auto-assigned.
 *
 * The schema default for `dims_stage` is `'legacy'` (it exists for the MIGRATION
 * backfill); every insert therefore writes the stage EXPLICITLY, and a new row
 * is always `'base'`.
 */
export function buildInsertSql(): string {
  return (
    `INSERT INTO memories (ts, source, tags, text, provenance, dims, dims_a, dims_c, dims_stage) ` +
    `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
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
 */
export function buildKnnSql(k: number, tagFilter?: ReadonlyArray<string>): string {
  const effectiveK = tagFilter && tagFilter.length > 0 ? k * TAG_OVERFETCH : k
  return [
    `SELECT m.id AS id, m.ts AS ts, m.source AS source, m.provenance AS provenance, m.dims AS dims, m.dims_stage AS dims_stage, m.tags AS tags, m.text AS text, v.distance AS distance`,
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

/** The `recent` listing. Same field set as `buildKnnSql`, minus the distance. */
export function buildRecentSql(n: number): string {
  return (
    `SELECT id, ts, source, provenance, dims, dims_stage, tags, text ` +
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
