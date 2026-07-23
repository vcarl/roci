/**
 * Memory provenance taxonomy (design 2026-07-21 §1).
 *
 * `provenance` is an OBJECTIVE trust-tier derived from the write path — never a
 * model self-report (a confabulating model is confident in its confabulations).
 *
 * Single source of truth: unit-tested here AND interpolated verbatim into the
 * generated in-container `memory` CLI (memory-cli.ts), the same generate-time
 * reuse the SQL builders use, so the two can never drift.
 */

/** Trust-tier, ordered high→low: grounded > episodic > inferred > asserted. */
export type Provenance = "grounded" | "episodic" | "inferred" | "asserted"

/** Unknown / self-authored sources get the lowest-trust default. */
export const PROVENANCE_DEFAULT: Provenance = "asserted"

/** Objective source→tier map. Keys are the `source` strings the write paths use. */
export const SOURCE_PROVENANCE: Record<string, Provenance> = {
  observe: "grounded",
  orient: "inferred",
  evaluate: "inferred",
  decide: "inferred",
  promotion: "episodic",
  conscious: "asserted",
}

/** Derive the trust tier for a memory from the source that wrote it. */
export function classify(source: string): Provenance {
  return SOURCE_PROVENANCE[source] ?? PROVENANCE_DEFAULT
}

/**
 * Idempotent migration columns for dbs created before provenance existed.
 * `ALTER TABLE ADD COLUMN` has no `IF NOT EXISTS`, so the CLI guards each with a
 * `PRAGMA table_info` presence check. The `DEFAULT` backfills legacy rows to the
 * safe-but-not-privileged episodic tier. (provenance + dims.)
 */
export const MIGRATION_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "provenance", ddl: "ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'episodic'" },
  // dims is nullable with NO default — legacy rows stay NULL → neutral salience
  // at recall (Phase 3). No backfill: an un-scored old memory has no signature.
  { name: "dims", ddl: "ALTER TABLE memories ADD COLUMN dims TEXT" },
]
