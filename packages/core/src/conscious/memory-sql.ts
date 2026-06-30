/**
 * SQL builders for the append-only long-term memory store (spec §9).
 *
 * The store is a single sqlite-vec db file at `players/<name>/me/longterm.db`
 * (per-character, co-located with the diary), opened in WAL mode. Rows are NEVER
 * updated or deleted — the whole point is durable episodic ground truth.
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
 * The two DDL statements: the append-only `memories` log of record, and the
 * `vec0` virtual table that indexes the embedding keyed by the same id. `IF NOT
 * EXISTS` so schema creation is idempotent (run on every CLI invocation).
 */
export function buildSchemaSql(dim: number = EMBED_DIM): string {
  return [
    `CREATE TABLE IF NOT EXISTS memories (`,
    `  id INTEGER PRIMARY KEY,`,
    `  ts TEXT NOT NULL,`,
    `  source TEXT NOT NULL,`,
    `  tags TEXT,`,
    `  text TEXT NOT NULL`,
    `);`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(`,
    `  id INTEGER PRIMARY KEY,`,
    `  embedding FLOAT[${dim}]`,
    `);`,
    // 1-row key/value meta table holding the bounded promotion high-water mark
    // (spec §9). The value is a host-computed opaque JSON marker — the CLI never
    // interprets it, so there is no cross-runtime hashing contract here.
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

/** Append a record row. Bind order: ts, source, tags, text. id auto-assigned. */
export function buildInsertSql(): string {
  return `INSERT INTO memories (ts, source, tags, text) VALUES (?, ?, ?, ?)`
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
 */
export function buildKnnSql(k: number, tagFilter?: ReadonlyArray<string>): string {
  const effectiveK = tagFilter && tagFilter.length > 0 ? k * TAG_OVERFETCH : k
  return [
    `SELECT m.id AS id, m.ts AS ts, m.source AS source, m.tags AS tags, m.text AS text, v.distance AS distance`,
    `FROM memories_vec v`,
    `JOIN memories m ON m.id = v.id`,
    `WHERE v.embedding MATCH ? AND k = ${effectiveK}`,
    `ORDER BY v.distance`,
  ].join("\n")
}
