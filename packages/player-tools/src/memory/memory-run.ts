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

import { buildKnnSql, buildInsertSql, buildVecInsertSql, buildMetaGetSql, buildMetaSetSql, PROMOTE_MARK_KEY } from "./memory-sql.js"
import { formatResults, splitTags, type MemoryRow } from "./memory-format.js"
import { classify } from "./memory-provenance.js"
import { parseCommand } from "./command-codec.js"

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

export interface MemoryDeps {
  /** An opened, schema-migrated db (the sqlite glue in main.ts owns open/migrate). */
  db: MemoryDb
  /** Retrying embed against the final endpoint (main.ts binds MEMORY_EMBED_URL). */
  embed: (text: string) => Promise<number[]>
  /** Injected clock so the row timestamp is deterministic under test. */
  nowIso: () => string
  /** Reads the `promote` verb's base64 lines from stdin. */
  readStdin: () => Promise<string>
  out: (line: string) => void
  err: (line: string) => void
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
      const info = db.prepare(buildInsertSql()).run(nowIso(), cmd.source, tags, cmd.text, prov, cmd.dims)
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
      const rows = db
        .query(`SELECT id, ts, source, provenance, dims, tags, text FROM memories ORDER BY id DESC LIMIT ${cmd.n}`)
        .all() as unknown as MemoryRow[]
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
      for (const b64 of lines) {
        const text = Buffer.from(b64, "base64").toString("utf8")
        const vec = await embed(text)
        const prov = classify("promotion")
        const info = db.prepare(buildInsertSql()).run(nowIso(), "promotion", "promotion", text, prov, null)
        db.prepare(buildVecInsertSql()).run(Number(info.lastInsertRowid), JSON.stringify(vec))
        n++
      }
      out(String(n))
      return 0
    }
  }
}
