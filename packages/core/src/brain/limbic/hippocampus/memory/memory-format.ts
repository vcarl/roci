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
