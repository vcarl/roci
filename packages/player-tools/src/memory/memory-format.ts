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
 * Render rows as NDJSON — one JSON object per line, no trailing newline. Empty
 * input renders as the empty string (no spurious blank line). `score` is omitted
 * when there is no distance (the `recent` verb does not embed).
 */
export function formatResults(rows: ReadonlyArray<MemoryRow>): string {
  return rows
    .map((r) => {
      const obj: Record<string, unknown> = {
        id: r.id,
        ts: r.ts,
        source: r.source,
        provenance: r.provenance,
        dims: r.dims ? JSON.parse(r.dims) : null,
        tags: splitTags(r.tags),
        text: r.text,
      }
      if (r.distance !== undefined) obj.score = scoreFromDistance(r.distance)
      return JSON.stringify(obj)
    })
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
