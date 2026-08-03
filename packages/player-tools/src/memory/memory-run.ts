/**
 * The `memory` CLI's verb dispatch — the code that IS the shipped binary's body
 * (package-design spec §2b). It calls the tested modules DIRECTLY: the command
 * codec (`parseCommand`, the single owner of the arg grammar), `buildKnnSql`,
 * `formatResults`/`splitTags`, `classify`, and an injected retrying `embed` — so
 * the drift the spec §1a documents (a hand-copied `knnSql`, `fmt`, `classify`,
 * arg parser, and a retry-less `embed`) cannot exist: there is one source.
 *
 * The sqlite-touching glue (`new Database`, `loadExtension`, pragmas, the
 * migration loop) lives in `main.ts` behind the `MemoryDb` seam so THIS module is
 * host-testable with a fake db (bun:sqlite + vec0.so are container-only). `embed`,
 * `nowIso`, `readStdin`, and the output sinks are injected for the same reason.
 */

import {
  buildKnnSql,
  buildInsertSql,
  buildVecInsertSql,
  buildMetaGetSql,
  buildMetaSetSql,
  buildRecentSql,
  buildPendingSql,
  buildAdjudicateSql,
  PROMOTE_MARK_KEY,
  STAGE_BASE,
} from "./memory-sql.js"
import { formatResults, formatPending, splitTags, type MemoryRow } from "./memory-format.js"
import { classify } from "./memory-provenance.js"
import { parseCommand } from "./command-codec.js"
import {
  buildAxisSpecs,
  TEMPLATE_PALETTE,
  TEMPLATE_DRIVES,
  axisFingerprint,
  type AxisSpec,
} from "../salience/axis-vocab.js"
import {
  glossTextsFor,
  mechanicalVector,
  mergeBaseVector,
  type AxisGlossVectors,
} from "../salience/axis-score.js"

/** The minimal `bun:sqlite` prepared-statement surface the dispatch uses. */
export interface MemoryStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint }
  all(...params: unknown[]): Array<Record<string, unknown>>
  get(...params: unknown[]): Record<string, unknown> | undefined
}

/** The minimal opened-db surface (bun `Database` satisfies it structurally). */
export interface MemoryDb {
  prepare(sql: string): MemoryStatement
  query(sql: string): MemoryStatement
}

/**
 * How the CLI reaches the character's axis artifacts. Injected for the same
 * reason `db`/`embed`/`nowIso` are: this module stays host-testable, and the
 * filesystem resolution (which directory holds PALETTE.md relative to the db)
 * is a `main.ts` concern.
 *
 * Returns `null` when the artifacts are unreachable — a scratch container, a
 * character mid-scaffold. That is NOT an error: the write still lands, A is
 * simply empty, and the CLI says so on stderr.
 */
export interface AxisDeps {
  readonly readAxisArtifacts: () => { palette: string; drives: string } | null
}

export interface MemoryDeps {
  /** An opened, schema-migrated db (the sqlite glue in main.ts owns open/migrate). */
  db: MemoryDb
  /** Retrying embed against the final endpoint (main.ts binds MEMORY_EMBED_URL). */
  embed: (text: string) => Promise<number[]>
  /** Injected clock so the row timestamp is deterministic under test. */
  nowIso: () => string
  /** Reads the `promote` verb's base64 lines from stdin. */
  readStdin: () => Promise<string>
  /** Reads PALETTE.md + DRIVES.md for the mechanical (A) stage. */
  axes: AxisDeps
  out: (line: string) => void
  err: (line: string) => void
}

/**
 * `meta` key under which the embedded axis-gloss table is cached. Versioned in
 * the key itself: if the gloss-vector SHAPE ever changes, a new key retires the
 * old table without a migration.
 */
export const AXIS_GLOSS_META_KEY = "axis_gloss_v1"

/**
 * Resolve this character's axis specs, degrading loudly rather than failing.
 *
 * A missing artifact falls back to the SAME template the host falls back to
 * (`CharacterFs.readPalette`/`readDrives`), so host and CLI never disagree about
 * the axis list of a character who has no files yet. A MALFORMED artifact is a
 * different thing: `buildAxisSpecs` throws, and here — unlike at scaffold time,
 * where a loud abort is correct — the right answer is to warn and score nothing
 * mechanically. Refusing the write would lose the memory outright over a
 * cosmetic defect in a file the memory has nothing to do with.
 */
function resolveAxisSpecs(deps: MemoryDeps): AxisSpec[] {
  const read = deps.axes.readAxisArtifacts()
  if (!read) {
    deps.err(
      "[memory] axis artifacts unreadable (no PALETTE.md / DRIVES.md beside the db) — " +
        "storing the producer vector only; the mechanical stage is inert for this row",
    )
    return []
  }
  try {
    return buildAxisSpecs(read.drives || TEMPLATE_DRIVES, read.palette || TEMPLATE_PALETTE)
  } catch (e) {
    deps.err(
      `[memory] could not derive the salience axes (${e instanceof Error ? e.message : String(e)}) — ` +
        "storing the producer vector only; fix PALETTE.md / DRIVES.md and the next write recovers",
    )
    return []
  }
}

/**
 * The embedded gloss table for these specs, from the `meta` cache when the axis
 * FINGERPRINT still matches, otherwise embedded once and cached.
 *
 * Caching is not an optimization detail — it is what makes A affordable. Without
 * it every insert would embed ~14 extra texts against a model the whole system
 * shares. The fingerprint covers the gloss TEXTS, not just the axis names, so a
 * reworded drive description invalidates the table rather than silently scoring
 * every subsequent memory against words nobody wrote.
 *
 * Throws if any gloss embed fails; `loadGlossVectors` below is the seam that
 * decides what that costs.
 */
async function embedGlossTable(
  deps: MemoryDeps,
  specs: ReadonlyArray<AxisSpec>,
): Promise<AxisGlossVectors> {
  const fp = axisFingerprint(specs)
  const row = deps.db.query(buildMetaGetSql()).get(AXIS_GLOSS_META_KEY)
  if (row && typeof row.value === "string") {
    try {
      const cached = JSON.parse(row.value) as { fp?: string; vecs?: AxisGlossVectors }
      if (cached.fp === fp && cached.vecs) return cached.vecs
    } catch {
      // A torn cache row is not fatal — fall through and re-embed.
    }
  }
  const vecs: AxisGlossVectors = {}
  for (const { key, text } of glossTextsFor(specs)) {
    vecs[key] = await deps.embed(text)
  }
  deps.db.prepare(buildMetaSetSql()).run(AXIS_GLOSS_META_KEY, JSON.stringify({ fp, vecs }))
  return vecs
}

/**
 * The gloss table, or `{}` — this function NEVER throws.
 *
 * That is the whole point. The gloss embeds only happen on a cache MISS: the
 * first write for a character, and the first write after any PALETTE.md /
 * DRIVES.md edit. Those are exactly the moments a transient embed failure is
 * most likely (the host embed server loads its model lazily and the client
 * already burns ~23s of backoff before giving up), and letting that throw would
 * mean the CLI loses the MEMORY over a failure to score it. Losing the salience
 * vector is a cost; losing the log-of-record entry is a different category of
 * failure, and this module exists to prevent the quiet kind.
 *
 * So it degrades exactly like `resolveAxisSpecs` does for a malformed artifact:
 * warn on stderr, return an empty table, let A be inert for this row and let the
 * write land. Nothing is cached on the failure path — a partially embedded table
 * must never become the durable answer — so the next write retries cleanly.
 *
 * The stderr line is a weak signal (the host's `runDockerCommand` only surfaces
 * stderr on a NON-ZERO exit, and this path deliberately exits 0). The DURABLE
 * signal is `dims_a = '{}'` on the row, which stays queryable forever.
 */
async function loadGlossVectors(
  deps: MemoryDeps,
  specs: ReadonlyArray<AxisSpec>,
): Promise<AxisGlossVectors> {
  if (specs.length === 0) return {}
  try {
    return await embedGlossTable(deps, specs)
  } catch (e) {
    deps.err(
      `[memory] could not embed the salience axis glosses (${e instanceof Error ? e.message : String(e)}) — ` +
        "the row still lands with its producer vector; the mechanical stage is inert " +
        "for it (dims_a = '{}') and the next write retries the gloss table",
    )
    return {}
  }
}

/**
 * The whole A ⊕ C computation for one memory, given its already-computed
 * embedding. Returns the three JSON strings the insert binds, in column order.
 * `dimsC` is the raw `--dims-c` string (or null) — it is stored VERBATIM so the
 * adjudicator sees exactly what the producer said, not a re-serialization.
 */
function scoreRow(
  specs: ReadonlyArray<AxisSpec>,
  gloss: AxisGlossVectors,
  memVec: ReadonlyArray<number>,
  dimsC: string | null,
): { dims: string; dimsA: string; dimsC: string | null } {
  const a = mechanicalVector(memVec, specs, gloss)
  let c: Record<string, number> | null = null
  if (dimsC !== null) {
    try {
      const parsed = JSON.parse(dimsC) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        c = parsed as Record<string, number>
      }
    } catch {
      // Unreachable in practice: the codec already hard-errors on invalid JSON.
      c = null
    }
  }
  return { dims: JSON.stringify(mergeBaseVector(a, c)), dimsA: JSON.stringify(a), dimsC }
}

/**
 * Run one `memory` invocation. Returns the process exit code (0 ok, 2 usage /
 * malformed-flag error); embed/db failures propagate as thrown errors (the caller
 * maps them to a non-zero exit) — a corrupt vector must never be written silently.
 *
 * A malformed `--dims` value is a HARD error here: `parseCommand` returns
 * `{ error }`, we print it to stderr and exit 2 (codec-seam loudness decision) —
 * an invalid salience signature never reaches the store.
 */
export async function runMemory(argv: ReadonlyArray<string>, deps: MemoryDeps): Promise<number> {
  const { db, embed, nowIso, readStdin, out, err } = deps

  const cmd = parseCommand(argv)
  if ("error" in cmd) {
    err(cmd.error)
    return 2
  }

  switch (cmd.verb) {
    case "remember": {
      const tags = cmd.tags.length > 0 ? cmd.tags.join(",") : null
      const vec = await embed(cmd.text)
      const prov = classify(cmd.source)
      // A runs HERE, on every pathway, because this is the only place the
      // embedding exists (design §3). `cmd.dims` is the PRODUCER (C) vector; the
      // stored `dims` is their optimistic mean, and the stage says so.
      const specs = resolveAxisSpecs(deps)
      const gloss = await loadGlossVectors(deps, specs)
      const scored = scoreRow(specs, gloss, vec, cmd.dims)
      const info = db
        .prepare(buildInsertSql())
        .run(
          nowIso(),
          cmd.source,
          tags,
          cmd.text,
          prov,
          scored.dims,
          scored.dimsA,
          scored.dimsC,
          STAGE_BASE,
        )
      const id = Number(info.lastInsertRowid)
      db.prepare(buildVecInsertSql()).run(id, JSON.stringify(vec))
      out(String(id))
      return 0
    }

    case "search": {
      const wantTags = cmd.tags
      const vec = await embed(cmd.query)
      const sql = buildKnnSql(cmd.k, wantTags.length > 0 ? wantTags : undefined)
      let rows = db.query(sql).all(JSON.stringify(vec)) as unknown as MemoryRow[]
      if (wantTags.length > 0) {
        rows = rows
          .filter((r) => {
            const have = splitTags(r.tags)
            return wantTags.some((t) => have.includes(t))
          })
          .slice(0, cmd.k)
      }
      out(formatResults(rows))
      return 0
    }

    case "recent": {
      const rows = db.query(buildRecentSql(cmd.n)).all() as unknown as MemoryRow[]
      out(formatResults(rows))
      return 0
    }

    case "mark-get": {
      const row = db.query(buildMetaGetSql()).get(PROMOTE_MARK_KEY)
      const value = row && typeof row.value === "string" ? row.value : null
      if (value) out(value)
      return 0
    }

    case "mark-set": {
      db.prepare(buildMetaSetSql()).run(PROMOTE_MARK_KEY, cmd.value)
      return 0
    }

    case "promote": {
      const input = await readStdin()
      const lines = input
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      let n = 0
      // Pathway 5 has NO producer vector (see the codec header: at the promotion
      // seam there is no model call to read one from), so `base = A`. Resolving
      // the specs and the gloss table ONCE outside the loop matters: a promotion
      // can carry dozens of entries.
      const specs = resolveAxisSpecs(deps)
      const gloss = await loadGlossVectors(deps, specs)
      for (const b64 of lines) {
        const text = Buffer.from(b64, "base64").toString("utf8")
        const vec = await embed(text)
        const prov = classify("promotion")
        const scored = scoreRow(specs, gloss, vec, null)
        const info = db
          .prepare(buildInsertSql())
          .run(
            nowIso(),
            "promotion",
            "promotion",
            text,
            prov,
            scored.dims,
            scored.dimsA,
            null,
            STAGE_BASE,
          )
        db.prepare(buildVecInsertSql()).run(Number(info.lastInsertRowid), JSON.stringify(vec))
        n++
      }
      out(String(n))
      return 0
    }

    case "pending": {
      // The adjudicator's work queue (design §3, stage B). Read-only; no embed.
      const rows = db.query(buildPendingSql(cmd.n)).all() as unknown as MemoryRow[]
      out(formatPending(rows))
      return 0
    }

    case "adjudicate": {
      // The ONE update in the store, and the ONE place B's output supersedes the
      // base. Only `dims` and `dims_stage` move; `dims_a`/`dims_c` are kept so an
      // adjudication stays auditable, and the log of record is never touched.
      db.prepare(buildAdjudicateSql()).run(cmd.dims, cmd.id)
      return 0
    }
  }
}
