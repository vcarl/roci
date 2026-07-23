/**
 * Runtime config for the `memory` binary, read from env (package-design spec §3).
 * A static bundle can't bake a per-run value, so the three formerly generate-time
 * values move to env. Pure + host-testable (no bun import).
 *
 *   MEMORY_EMBED_URL  required  the FINAL, already-host-rewritten embeddings URL
 *                               (core composes it; this binary uses it verbatim).
 *   MEMORY_DB_PATH    default   `me/longterm.db`, relative to the container cwd.
 *   MEMORY_VEC_EXT    default   `/usr/local/lib/vec0.so`, the baked extension path.
 */

export const DEFAULT_MEMORY_DB_PATH = "me/longterm.db"
export const DEFAULT_MEMORY_VEC_EXT = "/usr/local/lib/vec0.so"

export interface MemoryConfig {
  embedUrl: string
  dbPath: string
  vecExt: string
}

/** Resolve config from an env bag; throws (loud) when the required embed URL is unset. */
export function resolveMemoryConfig(env: Record<string, string | undefined>): MemoryConfig {
  const embedUrl = env.MEMORY_EMBED_URL
  if (!embedUrl) {
    throw new Error("MEMORY_EMBED_URL is required (the final host-rewritten embeddings endpoint)")
  }
  return {
    embedUrl,
    dbPath: env.MEMORY_DB_PATH ?? DEFAULT_MEMORY_DB_PATH,
    vecExt: env.MEMORY_VEC_EXT ?? DEFAULT_MEMORY_VEC_EXT,
  }
}
