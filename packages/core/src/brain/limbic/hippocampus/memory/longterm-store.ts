import { Context, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import type { CharacterConfig } from "../../../../services/CharacterFs.js"
import { containerPlayerRoot } from "../../../../services/character-paths.js"
import { Docker } from "../../../../services/Docker.js"
import { MEMORY_CLI_PATH } from "./memory-cli.js"
import { DEFAULT_EMBED_BASE_URL, embedEndpoint } from "./embed-endpoint.js"
import type { Provenance } from "@roci/player-tools/memory-provenance"
import {
  encodeRememberArgs,
  encodeSearchArgs,
  encodeMarkGetArgs,
  encodeMarkSetArgs,
  encodePromoteArgs,
  encodePendingArgs,
  encodeAdjudicateArgs,
} from "@roci/player-tools/command-codec"
import { parseResults } from "@roci/player-tools/memory-format"

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
  /**
   * Which stage of the scoring pipeline produced `dims` (design 2026-07-31 §3):
   * `base` (the optimistic ⊕ of A and C, adjudication still owed),
   * `adjudicated` (B has run and superseded it), or `legacy` (pre-Phase-2 row,
   * never enqueued for a sweep). Carried through so "the adjudicator never ran"
   * is answerable from a recall; nothing in Phase 2 ranks on it.
   */
  readonly stage?: "base" | "adjudicated" | "legacy"
}

/**
 * One row awaiting adjudication — the adjudicator's input (design §3, stage B):
 * the memory text plus BOTH producer vectors, which B needs because it exists
 * precisely to reconcile them. `dimsC` is `null`, never `{}`, when the pathway
 * had no producer at all (the agent's own `memory remember`, and reflection
 * promotion): "nobody scored this" and "the producer scored every axis at zero"
 * are different facts and B is told which one it has.
 */
export interface PendingMemory {
  readonly id: number
  readonly text: string
  readonly dimsA: Record<string, number>
  readonly dimsC: Record<string, number> | null
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
    /** Rows still carrying the optimistic base vector, oldest first, capped (in-container `memory pending`). */
    readonly pending: (
      containerId: string,
      char: CharacterConfig,
      n?: number,
    ) => Effect.Effect<ReadonlyArray<PendingMemory>, Error>
    /** Write the adjudicator's authoritative vector over one row's base (in-container `memory adjudicate`). */
    readonly adjudicate: (
      containerId: string,
      char: CharacterConfig,
      id: number,
      dims: Record<string, number>,
    ) => Effect.Effect<void, Error>
  }
>() {}

/** Single-quote a string for safe inclusion in a `bash -lc` command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Build the `memory` CLI argument string from a codec-produced argv by quoting
 * each token. Core is GRAMMAR-BLIND here (the codec owns flag order/omission);
 * quoting every token — including the verb and flags — is uniform and provably
 * shell-equivalent to the legacy per-value hand-concatenation (the deployed
 * string-CLI reads the identical post-split `process.argv`). See
 * longterm-store.test.ts's shell-equivalence gate.
 */
export function buildMemoryCommand(argv: ReadonlyArray<string>): string {
  return argv.map(shQuote).join(" ")
}

/** The in-container player cwd the `memory` CLI resolves its `me/longterm.db` against. */
const playerCwd = (char: CharacterConfig): string => containerPlayerRoot(char)

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
    // Build the `${MEMORY_CLI_PATH} <args>` fragment from a codec argv. Grammar
    // (flag order/omission/defaults) lives in the codec; core stays grammar-blind.
    const cli = (argv: ReadonlyArray<string>) => `${MEMORY_CLI_PATH} ${buildMemoryCommand(argv)}`
    // The bundled `memory` binary reads its embed endpoint from MEMORY_EMBED_URL at
    // INVOCATION time (spec §3) — a static bundle can't bake a per-run value. The
    // loopback → host.docker.internal rewrite stays host-side (embed-endpoint.ts);
    // core composes the FINAL url here. `Docker.exec` has no `-e` seam, so it rides
    // an `export …&&` prefix on the `bash -lc` string (same shell as the `cd`),
    // applied to ALL exec calls — the entrypoint requires the var for every verb,
    // even the non-embedding mark-get/mark-set (config is resolved up-front).
    const embedUrl = embedEndpoint(DEFAULT_EMBED_BASE_URL)
    const withEnv = (body: string) => `export MEMORY_EMBED_URL=${shQuote(embedUrl)} && ${body}`
    return LongtermStore.of({
      readMark: (containerId, char) =>
        docker.exec(containerId, ["bash", "-lc", withEnv(`${cd(char)} && ${cli(encodeMarkGetArgs())}`)]).pipe(
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
            withEnv(`${cd(char)} && ${cli(encodeMarkSetArgs(JSON.stringify(mark)))}`),
          ])
          .pipe(Effect.mapError(fail), Effect.asVoid),
      promote: (containerId, char, entries) =>
        Effect.gen(function* () {
          if (entries.length === 0) return 0
          // Pass each entry as a base64 line on stdin via printf|pipe (Docker.exec
          // has no stdin seam). base64 tokens are shell-safe; still single-quoted.
          const b64s = entries.map((e) => `'${Buffer.from(e, "utf8").toString("base64")}'`).join(" ")
          const cmd = withEnv(`${cd(char)} && printf '%s\\n' ${b64s} | ${cli(encodePromoteArgs())}`)
          const out = yield* docker.exec(containerId, ["bash", "-lc", cmd]).pipe(Effect.mapError(fail))
          const n = Number(out.trim())
          return Number.isFinite(n) ? n : entries.length
        }),
      remember: (containerId, char, entry) => {
        // The codec owns flag order + the empty/absent-dims → omitted-flag rule
        // (→ NULL column → neutral salience at recall).
        const cmd = withEnv(`${cd(char)} && ${cli(encodeRememberArgs(entry))}`)
        return docker.exec(containerId, ["bash", "-lc", cmd]).pipe(Effect.mapError(fail), Effect.asVoid)
      },
      recall: (containerId, char, query, opts) =>
        Effect.gen(function* () {
          const cmd = withEnv(`${cd(char)} && ${cli(encodeSearchArgs({ query, k: opts?.k, tags: opts?.tags }))}`)
          const out = yield* docker.exec(containerId, ["bash", "-lc", cmd]).pipe(Effect.mapError(fail))
          // NDJSON row parsing lives in the package next to formatResults; a torn
          // line is logged (no longer silent) then dropped, never thrown.
          return parseResults(out) as unknown as ReadonlyArray<MemoryHit>
        }),
      pending: (containerId, char, n) =>
        Effect.gen(function* () {
          const cmd = withEnv(`${cd(char)} && ${cli(encodePendingArgs(n))}`)
          const out = yield* docker.exec(containerId, ["bash", "-lc", cmd]).pipe(Effect.mapError(fail))
          // Same NDJSON discipline as recall: a torn line is logged and dropped,
          // never thrown — one bad row must not cancel a whole sweep.
          return parseResults(out).map(
            (r): PendingMemory => ({
              id: r.id,
              text: r.text,
              dimsA: (r as { dims_a?: Record<string, number> }).dims_a ?? {},
              dimsC: (r as { dims_c?: Record<string, number> | null }).dims_c ?? null,
            }),
          )
        }),
      adjudicate: (containerId, char, id, dims) => {
        const cmd = withEnv(`${cd(char)} && ${cli(encodeAdjudicateArgs(id, dims))}`)
        return docker.exec(containerId, ["bash", "-lc", cmd]).pipe(Effect.mapError(fail), Effect.asVoid)
      },
    })
  }),
)
