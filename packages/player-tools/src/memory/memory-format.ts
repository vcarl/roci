/**
 * Result formatting + embed-response parsing for the `memory` CLI (spec §8/§3).
 * Pure; mirrors the logic the generated in-container bun script embeds, so the
 * NDJSON contract and the embed-response validation are locked by unit tests.
 */

import { EMBED_DIM } from "./memory-sql.js"

/** A KNN/recent row as returned by the sqlite-vec join (tags is the raw db column). */
export interface MemoryRow {
  id: number
  /** vec0 distance; absent for `recent` (no embedding query). */
  distance?: number
  ts: string
  source: string
  /** Objective trust-tier (present post-migration). */
  provenance?: string
  /** Raw JSON dims column (`{drive: weight/5}`); null/absent for legacy/non-observe rows. */
  dims?: string | null
  /** Raw JSON of the MECHANICAL (A) vector — cosine against the axis glosses. */
  dims_a?: string | null
  /** Raw JSON of the PRODUCER (C) vector, or null when the pathway has no C. */
  dims_c?: string | null
  /** `base` | `adjudicated` | `legacy` — see STAGE_* in memory-sql.ts. */
  dims_stage?: string | null
  /** `scored` | `first` | `unknown` | `legacy` — see LINEAGE_* in memory-sql.ts. */
  lineage_state?: string | null
  /** The already-existing memory this one most resembled at write time. */
  lineage_prior_id?: number | null
  /** Raw vec0 (L2) distance to that memory. */
  lineage_distance?: number | null
  /** Cosine to that memory, from both stored vectors. */
  lineage_similarity?: number | null
  /** comma-joined tags, or null/empty when none. */
  tags: string | null
  text: string
}

/** Split the stored comma-joined tags column into an array (empty when none). */
export function splitTags(tags: string | null | undefined): string[] {
  if (!tags) return []
  return tags
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/**
 * Map a vec0 distance to a [0,1] similarity score (closer = higher). vec0's
 * default metric is L2; `1/(1+distance)` is a monotonic decreasing map that keeps
 * ranking identical to ascending-distance while giving the agent a friendlier
 * "higher is better" number.
 */
export function scoreFromDistance(distance: number): number {
  return 1 / (1 + distance)
}

/**
 * Version of the `search`/`recent` NDJSON line shape, stamped on EVERY line.
 *
 *  - v1 (unstamped): `id ts source provenance dims stage tags text [score]`.
 *  - v2: adds `dims_a` and `dims_c` — the two per-stage producer vectors.
 *  - v3: adds `lineage` — what this memory restated at the moment it was written.
 *
 * WHY A VERSION AND NOT JUST TOLERANCE. `parseResults` is a bare `JSON.parse`,
 * so unknown fields are already tolerated in both directions; adding fields
 * could not break anything. That is NOT the reason this exists. The hazard is
 * the other direction and it is silent: a long-lived container still running a
 * PRE-v2 provisioned bundle emits lines with no `dims_a`/`dims_c` at all, the
 * host reads `undefined`, and the study gets a column of nulls that reads as
 * "the C stage is empty" when the truth is "we never transmitted it". Those two
 * facts are opposite conclusions and nothing in the payload distinguishes them.
 *
 * With the stamp, a null is attributable: `wire >= 2` ⇒ the CLI looked and the
 * column really was empty; `wire` absent ⇒ a stale bundle, re-provision. The
 * host surfaces exactly that distinction per candidate (recall-telemetry.ts).
 *
 * The stamp is a NUMBER on every line rather than a one-off handshake because
 * there is no session here — each recall is a fresh `docker exec` of a static
 * bundle, and the only thing that ever crosses is these lines.
 *
 * EACH VERSION NEEDS ITS OWN TRANSMITTED FLAG HOST-SIDE. The v2 flag keys off
 * `wire >= 2`; the v3 lineage flag keys off `wire >= 3`. Reusing one for the
 * other would report a v2 bundle as having transmitted lineage it never had —
 * reintroducing, one field later, exactly the confusion the stamp prevents.
 */
export const RECALL_WIRE_VERSION = 3

/**
 * Parse one of the two DIAGNOSTIC dims columns (`dims_a`, `dims_c`), never
 * throwing. `null`/empty → null (genuinely absent: a legacy row, or a pathway
 * with no producer). Unparseable → null AND the column name is reported through
 * `onTorn`, so the line can say so rather than presenting corruption as absence.
 *
 * The asymmetry with `dims` below is deliberate. `dims` is what recall RANKS
 * with, so a torn `dims` is a real failure and keeps throwing. `dims_a`/`dims_c`
 * are observability: `dims_c` in particular is stored VERBATIM from
 * model-authored argv, and a torn one must not be able to sink a live recall
 * that would otherwise have worked perfectly.
 */
function parseDiagnosticDims(
  raw: string | null | undefined,
  column: string,
  onTorn: (column: string) => void,
): Record<string, number> | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      onTorn(column)
      return null
    }
    return v as Record<string, number>
  } catch {
    onTorn(column)
    return null
  }
}

/** A number, or null when the column is absent/NULL/not a finite number. */
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null

/**
 * The `lineage` block for one recall line: what this memory restated at the
 * moment it was WRITTEN.
 *
 * `state` is emitted VERBATIM and is never defaulted. The column is
 * `NOT NULL DEFAULT 'legacy'`, so a null here can only mean a SELECT list that
 * forgot the column — and a null state is loudly wrong, whereas a silently
 * substituted `'legacy'` would be indistinguishable from a real pre-lineage row.
 *
 * Read the four states as: `scored` ⇒ prior_id/distance/similarity are real;
 * `first` ⇒ the store was empty, a positive fact; `unknown` ⇒ the lookup failed;
 * `legacy` ⇒ the row predates lineage. The last two are both "we do not know",
 * and NEITHER means "this memory restated nothing".
 */
function lineageOf(r: MemoryRow): Record<string, unknown> {
  return {
    state: r.lineage_state ?? null,
    prior_id: numOrNull(r.lineage_prior_id),
    distance: numOrNull(r.lineage_distance),
    similarity: numOrNull(r.lineage_similarity),
  }
}

/**
 * Render rows as NDJSON — one JSON object per line, no trailing newline. Empty
 * input renders as the empty string (no spurious blank line). `score` is omitted
 * when there is no distance (the `recent` verb does not embed).
 *
 * Wire v2 adds `dims_a` (the MECHANICAL vector — cosine against the axis
 * glosses) and `dims_c` (the PRODUCER vector — the authoring tier's own
 * reading) beside the merged `dims` that recall actually ranks on. All three
 * are per-AXIS vectors — one float per axis, order-of-ten keys — not the 384-float
 * embedding, which is retrievable only through the `embeddings` verb.
 *
 * `dims_c` renders as `null`, never `{}`, when the pathway had no producer at
 * all: "nobody scored this" and "the producer scored every axis at zero" are
 * different facts and the adjudicator already depends on telling them apart
 * (see `formatPending`). The same distinction now survives to the host.
 */
export function formatResults(rows: ReadonlyArray<MemoryRow>): string {
  return rows
    .map((r) => {
      const torn: string[] = []
      const onTorn = (c: string): void => {
        torn.push(c)
      }
      const obj: Record<string, unknown> = {
        id: r.id,
        ts: r.ts,
        source: r.source,
        provenance: r.provenance,
        dims: r.dims ? JSON.parse(r.dims) : null,
        dims_a: parseDiagnosticDims(r.dims_a, "dims_a", onTorn),
        dims_c: parseDiagnosticDims(r.dims_c, "dims_c", onTorn),
        // The stage marker rides the recall line so "the adjudicator never ran"
        // is answerable from the HOST too, not only by opening the db (§3).
        stage: r.dims_stage ?? null,
        // Wire v3. Four scalars, so unlike the embedding this is affordable on
        // the hot path — and without it there is no read path to lineage at all
        // short of opening the db by hand.
        lineage: lineageOf(r),
        tags: splitTags(r.tags),
        text: r.text,
        wire: RECALL_WIRE_VERSION,
      }
      // Present ONLY when something was actually torn, so the normal line pays
      // nothing and a study can filter on the key's mere existence.
      if (torn.length > 0) obj.dims_parse_errors = torn
      if (r.distance !== undefined) obj.score = scoreFromDistance(r.distance)
      return JSON.stringify(obj)
    })
    .join("\n")
}

/**
 * Render the adjudicator's work queue as NDJSON — one row per line, no trailing
 * newline. Deliberately a DIFFERENT shape from `formatResults`: B needs the
 * memory text and its two producer vectors and nothing else, and `formatResults`
 * carries neither `dims_a` nor `dims_c`.
 *
 * A missing C renders as `null`, never `{}`: pathway 6 (the agent's own `memory
 * remember`, which the host never observes) genuinely has no producer vector,
 * and B must be able to tell that apart from a producer that scored every axis
 * at zero.
 */
export function formatPending(rows: ReadonlyArray<MemoryRow>): string {
  return rows
    .map((r) =>
      JSON.stringify({
        id: r.id,
        text: r.text,
        dims_a: r.dims_a ? JSON.parse(r.dims_a) : null,
        dims_c: r.dims_c ? JSON.parse(r.dims_c) : null,
      }),
    )
    .join("\n")
}

/**
 * A parsed NDJSON recall row — the inverse of `formatResults`. `dims` comes back
 * as the parsed object (or null), `tags` as the split array, `score` present only
 * for `search` rows. This is the host-side contract `longterm-store` consumes; it
 * is intentionally structural (core casts it to its own `MemoryHit`).
 */
export interface ParsedMemoryHit {
  id: number
  ts: string
  source: string
  provenance?: string
  tags: string[]
  text: string
  score?: number
  dims?: Record<string, number> | null
  /** `base` | `adjudicated` | `legacy`; absent on a pre-Phase-2 CLI's output. */
  stage?: string | null
  /**
   * Line-shape version (`RECALL_WIRE_VERSION`). **Absent means a pre-v2 CLI**,
   * which is the only honest way to read `dims_a`/`dims_c` being missing: on a
   * v2 line a null is a real empty stage, on an unstamped line it is a stale
   * provisioned bundle. Do not default it — the absence IS the signal.
   */
  wire?: number
  /** MECHANICAL (A) vector; null when absent, torn, or the CLI predates v2. */
  dims_a?: Record<string, number> | null
  /** PRODUCER (C) vector; null when the pathway had no producer at all. */
  dims_c?: Record<string, number> | null
  /** Names of dims columns the CLI could not parse. Present only when non-empty. */
  dims_parse_errors?: string[]
  /**
   * What this memory restated AT WRITE TIME. **Absent means a pre-v3 CLI** —
   * the same reading rule as `dims_a`/`dims_c` and `wire`. Do not default it.
   */
  lineage?: ParsedLineage
}

/** The `lineage` block on a v3 recall line. See `lineageOf`. */
export interface ParsedLineage {
  /** `scored` | `first` | `unknown` | `legacy`; null ⇒ a SELECT list dropped the column. */
  state: string | null
  /** The memory this one most resembled among those that already existed. */
  prior_id: number | null
  /** Raw vec0 (L2) distance to `prior_id`. */
  distance: number | null
  /** Cosine to `prior_id`. Null on a `scored` row ⇒ only the derived value was unavailable. */
  similarity: number | null
}

/** One row of the `embeddings` dump — the stored vector, exactly as written. */
export interface ParsedEmbeddingRow {
  id: number
  /** Length of `embedding`; carried so a dimension change is visible per row. */
  dim: number
  embedding: number[]
}

/**
 * Decode a stored vec0 embedding BLOB into its exact float32 values.
 *
 * sqlite-vec stores a `FLOAT[N]` column as N little-endian IEEE-754 float32s and
 * nothing else, so this is a straight reinterpretation — the values that come
 * back ARE the values on disk, not a re-rendering of them. (`vec_to_json`, the
 * documented alternative, formats at six decimal places and would quietly round
 * every component; adjacent float32s can share a rendering.)
 *
 * Two different failures, handled two different ways ON PURPOSE:
 *
 *  - A length that is not a whole number of float32s, or a value that is not a
 *    blob at all, THROWS. Those bytes cannot be interpreted; emitting whatever
 *    a misaligned read produced would poison the one artifact whose entire
 *    value is being trustworthy enough to skip re-embedding.
 *  - A well-formed blob of an UNEXPECTED dimension is a finding, not a fault.
 *    Pass `expectedDim` to assert one (the callers that know); omit it to derive
 *    the dimension from the bytes, which is what `formatEmbeddings` does so that
 *    a dimension change shows up as a `dim` field in the dump rather than
 *    aborting it. A dump that stops on row 1 tells a study nothing.
 */
export function decodeEmbedding(raw: unknown, expectedDim?: number): number[] {
  let bytes: Uint8Array
  if (raw instanceof Uint8Array) bytes = raw
  else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw)
  else if (ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  else throw new Error(`embedding column was not a blob (got ${typeof raw})`)

  if (bytes.byteLength % 4 !== 0) {
    throw new Error(`embedding blob was ${bytes.byteLength} bytes — not a whole number of float32s`)
  }
  const dim = bytes.byteLength / 4
  if (expectedDim !== undefined && dim !== expectedDim) {
    throw new Error(
      `embedding blob was ${bytes.byteLength} bytes (${dim} float32s); expected ${expectedDim}`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Array<number>(dim)
  for (let i = 0; i < dim; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}

/** A raw `embeddings` row as the vec0 select returns it. */
export interface EmbeddingRow {
  id: number
  embedding: unknown
}

/**
 * Render the `embeddings` dump as NDJSON — one row per line, no trailing
 * newline. A DIFFERENT shape from `formatResults` on purpose: this verb answers
 * "what vector is actually stored for row N", and carrying the text/tags/dims
 * beside 384 floats would just make an already-large offline artifact larger.
 * Join back to `search`/`recent` on `id`.
 *
 * `dim` is DERIVED per row (see `decodeEmbedding`) and emitted, rather than
 * asserted against `EMBED_DIM`. A store written under a different embedding
 * width is something a study needs to SEE, per row, in the data — not something
 * that should abort the dump on the first row and leave it guessing.
 */
export function formatEmbeddings(rows: ReadonlyArray<EmbeddingRow>): string {
  return rows
    .map((r) => {
      const embedding = decodeEmbedding(r.embedding)
      return JSON.stringify({ id: r.id, dim: embedding.length, embedding })
    })
    .join("\n")
}

/** Default drop-logger for `parseResults`: warn (no longer fully silent) before dropping a bad line. */
const warnDropped = (line: string, err: unknown): void => {
  const reason = err instanceof Error ? err.message : String(err)
  console.warn(`[memory] dropped unparseable NDJSON recall line (${reason}): ${line}`)
}

/**
 * Parse `memory search`/`recent` NDJSON output — one JSON object per line — into
 * rows, the exact inverse of `formatResults`. Colocated with the emitter so the
 * wire contract (field set, dims-as-object, tags-as-array) has one home.
 *
 * Robustness: a malformed line is DROPPED, never thrown (a single torn line must
 * not sink an entire recall). But it is no longer SILENT — `onError` is invoked
 * (default: `console.warn`) before the drop, so drift/corruption is observable
 * instead of vanishing (codec-seam decision 2026-07-23, loudness change).
 */
export function parseResults(
  ndjson: string,
  onError: (line: string, err: unknown) => void = warnDropped,
): ParsedMemoryHit[] {
  return ndjson
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as ParsedMemoryHit]
      } catch (err) {
        onError(l, err)
        return []
      }
    })
}

/**
 * Extract and validate the embedding vector from an OpenAI-shape embeddings
 * response: `{ data: [{ embedding: number[] }] }`. Throws (loud, not silent) on
 * any shape/dimension/element mismatch — a bad embedding must fail the call, not
 * silently corrupt the store.
 */
export function parseEmbedResponse(json: unknown, dim: number = EMBED_DIM): number[] {
  if (!json || typeof json !== "object") {
    throw new Error("embed response was not an object")
  }
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("embed response had no data[]")
  }
  const embedding = (data[0] as { embedding?: unknown }).embedding
  if (!Array.isArray(embedding)) {
    throw new Error("embed response data[0].embedding was not an array")
  }
  if (embedding.length !== dim) {
    throw new Error(`embed dimension mismatch: expected ${dim}, got ${embedding.length}`)
  }
  for (const x of embedding) {
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw new Error("embed vector contained a non-finite element")
    }
  }
  return embedding as number[]
}
