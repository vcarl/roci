#!/home/node/.bun/bin/bun
// Long-term memory CLI — the SHIPPED binary (package-design spec). Append-only
// sqlite-vec store. Laundering (Vector-A): the argv text is model-authored —
// author the query/text yourself, never paste raw inbound event text.
//
// This file is the bun entrypoint: it owns ONLY the container-only glue (open the
// db, load vec0, migrate) + env/stdin/clock wiring. All dispatch logic lives in
// the host-tested ./memory-run.js, and every SQL/format/embed/provenance concern
// comes from the tested mirror modules — so the shipped code IS the tested code.
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { buildSchemaSql } from "./memory-sql.js"
import { MIGRATION_COLUMNS } from "./memory-provenance.js"
import { embed } from "./memory-embed.js"
import { resolveMemoryConfig } from "./memory-config.js"
import { runMemory, type MemoryDb } from "./memory-run.js"

/** Open + migrate the per-character db. Mirrors the frozen container invariants
 * (spec §4): WAL + busy_timeout pragmas, the REQUIRED explicit vec0 entrypoint,
 * and the idempotent PRAGMA-guarded ADD COLUMN loop. */
function openDb(dbPath: string, vecExt: string): Database {
  const db = new Database(dbPath)
  db.exec("PRAGMA journal_mode=WAL;")
  db.exec("PRAGMA busy_timeout=5000;")
  // The explicit entrypoint is REQUIRED — bun's filename-derived default
  // (sqlite3_vec0_init) does not match the extension's sqlite3_vec_init.
  db.loadExtension(vecExt, "sqlite3_vec_init")
  db.exec(buildSchemaSql())
  // Idempotent migration: ADD COLUMN has no IF NOT EXISTS, so guard on the live
  // column set. New dbs already have the columns (schema) → no-op.
  const cols = new Set(
    (db.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((r) => r.name),
  )
  for (const c of MIGRATION_COLUMNS) {
    if (!cols.has(c.name)) db.exec(c.ddl)
  }
  return db
}

async function main(): Promise<number> {
  const cfg = resolveMemoryConfig(process.env)
  const db = openDb(cfg.dbPath, cfg.vecExt)
  return runMemory(process.argv.slice(2), {
    db: db as unknown as MemoryDb,
    embed: (text: string) => embed(text, cfg.embedUrl),
    nowIso: () => new Date().toISOString(),
    // fd 0 = stdin; readFileSync(0) works under both bun and node.
    readStdin: async () => {
      try {
        return readFileSync(0, "utf8")
      } catch {
        return ""
      }
    },
    out: (line: string) => console.log(line),
    err: (line: string) => console.error(line),
  })
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
