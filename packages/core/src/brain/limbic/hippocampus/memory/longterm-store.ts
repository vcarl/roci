import { Context, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import type { CharacterConfig } from "../../../../services/CharacterFs.js"
import { Docker } from "../../../../services/Docker.js"
import { MEMORY_CLI_PATH } from "./memory-cli.js"
import type { Provenance } from "./memory-provenance.js"

export { MEMORY_CLI_PATH }

/**
 * The long-term store seam used by the deterministic pre-cull promotion hook
 * (spec §5 Route 2). The db is touched ONLY inside the container (it Bus-errors
 * if opened by host-side bun on macOS), so every operation here shells the
 * in-container `memory` CLI over `docker exec`.
 *
 * Promotion captures RAW episodic entries (the per-step diary appends), read at
 * the reflection seam BEFORE consolidate rewrites the diary. The loop only ever
 * APPENDS `\n\n`-separated entries during a session (brain/stem/loop.ts:518-520:
 * `existing + "\n\n" + entry`), so the diary left by the previous reflection is a
 * verbatim PREFIX of the current one. A bounded high-water mark — the length +
 * sha256 of that previous diary — therefore isolates exactly the new appends,
 * with no full-history scan and no re-promotion across cycles. The mark is
 * computed and validated entirely host-side (node crypto) and stored opaquely in
 * the db's meta table; the CLI never interprets it (no cross-runtime hash).
 */

/** The bounded promotion high-water mark: length + sha256 of the last-marked diary. */
export interface DiaryMark {
  len: number
  hash: string
}

/** Split a diary into entries on blank-line boundaries; trims, drops empties. */
export function splitDiaryEntries(diary: string): string[] {
  return diary
    .split(/\n\s*\n/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex")

/** Compute the high-water mark for a diary snapshot (its length + content hash). */
export function diaryMark(diary: string): DiaryMark {
  return { len: diary.length, hash: sha256(diary) }
}

/**
 * The entries appended SINCE the marked diary. Normal path: the current diary
 * starts with the marked prefix (loop is append-only during a session), so the
 * new tail is `diary.slice(mark.len)`. No mark → first promotion, promote it all.
 * Prefix mismatch / mark longer than diary (external rewrite, fresh db over an
 * existing diary) → promote the WHOLE diary and re-baseline: anti-loss beats
 * occasional duplication, and this is logged loud by the caller.
 */
export function newSinceMark(diary: string, mark: DiaryMark | null): string[] {
  if (mark && diary.length >= mark.len && sha256(diary.slice(0, mark.len)) === mark.hash) {
    return splitDiaryEntries(diary.slice(mark.len))
  }
  return splitDiaryEntries(diary)
}

/** A ranked recall hit — one NDJSON line from the in-container `memory search`. */
export interface MemoryHit {
  readonly id: number
  readonly ts: string
  readonly source: string
  /** Objective trust-tier derived from `source` at write time (see memory-provenance). */
  readonly provenance: Provenance
  readonly tags: ReadonlyArray<string>
  readonly text: string
  readonly score: number
  /**
   * Per-memory salience signature `{ drive: weight/5 }`, captured at write time
   * from the hindbrain observe signal (Phase 3 §3). Absent/NULL for legacy rows
   * and non-observe writes → neutral salience at recall. Parsed from NDJSON.
   */
  readonly dims?: Record<string, number>
}

export class LongtermStore extends Context.Tag("LongtermStore")<
  LongtermStore,
  {
    /** Read the bounded promotion high-water mark (in-container `memory mark-get`). */
    readonly readMark: (
      containerId: string,
      char: CharacterConfig,
    ) => Effect.Effect<DiaryMark | null, Error>
    /** Persist the high-water mark after the cull (in-container `memory mark-set`). */
    readonly writeMark: (
      containerId: string,
      char: CharacterConfig,
      mark: DiaryMark,
    ) => Effect.Effect<void, Error>
    /** Promote new raw entries with source='promotion' (in-container `memory promote`); returns count. */
    readonly promote: (
      containerId: string,
      char: CharacterConfig,
      entries: ReadonlyArray<string>,
    ) => Effect.Effect<number, Error>
    /** Persist a single memory with an explicit source + tags + optional dims signature (in-container `memory remember`). */
    readonly remember: (
      containerId: string,
      char: CharacterConfig,
      entry: {
        readonly text: string
        readonly source: string
        readonly tags: ReadonlyArray<string>
        readonly dims?: Record<string, number>
      },
    ) => Effect.Effect<void, Error>
    /** Semantic recall of top-k memories (in-container `memory search`); parses NDJSON. */
    readonly recall: (
      containerId: string,
      char: CharacterConfig,
      query: string,
      opts?: { readonly k?: number; readonly tags?: ReadonlyArray<string> },
    ) => Effect.Effect<ReadonlyArray<MemoryHit>, Error>
  }
>() {}

/** Single-quote a string for safe inclusion in a `bash -lc` command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The in-container player cwd the `memory` CLI resolves its `me/longterm.db` against. */
const playerCwd = (char: CharacterConfig): string => `/work/players/${char.name}`

/**
 * Production layer: every op shells the in-container `memory` CLI. Captures Docker
 * at build time so the service methods are R=never. Failures map to a plain Error
 * (the promotion hook wraps them in `catchAll`→`logError`, best-effort).
 */
export const LongtermStoreLive: Layer.Layer<LongtermStore, never, Docker> = Layer.effect(
  LongtermStore,
  Effect.gen(function* () {
    const docker = yield* Docker
    const fail = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
    const cd = (char: CharacterConfig) => `cd ${shQuote(playerCwd(char))}`
    return LongtermStore.of({
      readMark: (containerId, char) =>
        docker.exec(containerId, ["bash", "-lc", `${cd(char)} && ${MEMORY_CLI_PATH} mark-get`]).pipe(
          Effect.mapError(fail),
          Effect.map((out): DiaryMark | null => {
            const t = out.trim()
            if (!t) return null
            try {
              const m = JSON.parse(t) as DiaryMark
              return typeof m.len === "number" && typeof m.hash === "string" ? m : null
            } catch {
              return null
            }
          }),
        ),
      writeMark: (containerId, char, mark) =>
        docker
          .exec(containerId, [
            "bash",
            "-lc",
            `${cd(char)} && ${MEMORY_CLI_PATH} mark-set ${shQuote(JSON.stringify(mark))}`,
          ])
          .pipe(Effect.mapError(fail), Effect.asVoid),
      promote: (containerId, char, entries) =>
        Effect.gen(function* () {
          if (entries.length === 0) return 0
          // Pass each entry as a base64 line on stdin via printf|pipe (Docker.exec
          // has no stdin seam). base64 tokens are shell-safe; still single-quoted.
          const b64s = entries.map((e) => `'${Buffer.from(e, "utf8").toString("base64")}'`).join(" ")
          const cmd = `${cd(char)} && printf '%s\\n' ${b64s} | ${MEMORY_CLI_PATH} promote`
          const out = yield* docker.exec(containerId, ["bash", "-lc", cmd]).pipe(Effect.mapError(fail))
          const n = Number(out.trim())
          return Number.isFinite(n) ? n : entries.length
        }),
      remember: (containerId, char, entry) => {
        const tagsArg = entry.tags.length > 0 ? ` --tags ${shQuote(entry.tags.join(","))}` : ""
        // Only pass --dims when there is a non-empty signature; an empty/absent
        // dims → NULL column → neutral salience at recall.
        const dimsArg =
          entry.dims && Object.keys(entry.dims).length > 0
            ? ` --dims ${shQuote(JSON.stringify(entry.dims))}`
            : ""
        const cmd =
          `${cd(char)} && ${MEMORY_CLI_PATH} remember ${shQuote(entry.text)}` +
          `${tagsArg} --source ${shQuote(entry.source)}${dimsArg}`
        return docker.exec(containerId, ["bash", "-lc", cmd]).pipe(Effect.mapError(fail), Effect.asVoid)
      },
      recall: (containerId, char, query, opts) =>
        Effect.gen(function* () {
          const k = opts?.k ?? 5
          const tagsArg = opts?.tags && opts.tags.length > 0 ? ` --tags ${shQuote(opts.tags.join(","))}` : ""
          const cmd = `${cd(char)} && ${MEMORY_CLI_PATH} search ${shQuote(query)} -k ${k}${tagsArg}`
          const out = yield* docker.exec(containerId, ["bash", "-lc", cmd]).pipe(Effect.mapError(fail))
          return out
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .flatMap((l) => {
              try {
                return [JSON.parse(l) as MemoryHit]
              } catch {
                return []
              }
            })
        }),
    })
  }),
)
