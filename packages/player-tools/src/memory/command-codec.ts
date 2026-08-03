/**
 * The `memory` CLI command codec — the SINGLE owner of the arg grammar
 * (package-design spec, codec-seam decision 2026-07-23). One module holds both
 * halves so encoder and parser cannot drift:
 *
 *  - ENCODERS (`encode*Args`) run HOST-side: core's `longterm-store` composes an
 *    argv array here, then maps its `shQuote` over it to build the `bash -lc`
 *    string. Grammar knowledge lives ONLY here — core treats argv opaquely.
 *  - PARSERS (`parse*Args` / `parseCommand`) run IN the container entrypoint
 *    (`memory-run`), turning the CLI's `process.argv` back into a typed command.
 *
 * Grammar (container contract, spec §4): `remember <text> [--tags a,b]
 * --source <s> [--dims-c <json>]`, `search <query> -k <k> [--tags a,b]`,
 * `recent [-n <n>]`, `mark-get`, `mark-set <json>`, `promote` (stdin),
 * `pending [-n <n>]`, `adjudicate <id> <json>`,
 * `embeddings [--ids a,b,c] [-n <n>]`. Defaults: `--source` →
 * "conscious", `-k` → 5, `-n` → 10 (recent) / 25 (pending) / UNCAPPED
 * (embeddings). A present-but-malformed `--dims-c`, `adjudicate` JSON value or
 * `--ids` list is a HARD parse error (loud, not silent).
 *
 * ── `--dims` was RENAMED `--dims-c` in Phase 2 (design 2026-07-31 §3) ────────
 * It used to carry the memory's FINAL salience signature. It now carries the
 * PRODUCER (C) vector only — the authoring tier's own reading. The CLI computes
 * the mechanical (A) vector itself at insert, from the memory's embedding
 * against the axis-gloss embeddings, and writes `dims = mean(A, C)` with
 * `dims_stage = 'base'`.
 *
 * The NAME changed with the meaning, deliberately. The schema now has a `dims`
 * column (the EFFECTIVE vector — base, then adjudicated), a `dims_a` and a
 * `dims_c`. A flag still called `--dims` that populated `dims_c` would put three
 * meanings on one word inside one schema, and the next person to trace why
 * `dims` disagrees with what the host sent would have to discover that `--dims`
 * was never `dims`.
 *
 * The retired spelling is a HARD PARSE ERROR (see `LEGACY_DIMS_FLAG` below), not
 * an ignored token. `takeFlag` only strips flags it is asked for, so an
 * unhandled `--dims` would fall through into the positional remainder, the text
 * would still resolve, and the row would be written with NO producer vector —
 * successfully and silently. Version skew between a long-lived container's
 * provisioned bundle and a redeployed host is real, and that failure mode is
 * exactly the one this design exists to prevent.
 *
 * `--dims-c` is OMITTED when the producer vector is empty/absent — pathway 6
 * (the agent's own `memory remember`) and pathway 5 (reflection `promote`) have
 * no C at all. Those rows are NOT dimensionless: A always fires inside the CLI,
 * so `base = A`. A NULL `dims` is now only possible if the CLI itself failed.
 *
 * `promote` deliberately gains NO producer flag. Spec §4 pathway 5 imagines C
 * coming from "the reflection call that is already running", but at the
 * promotion seam (`planned-action.ts:72`) there is no such call: promote runs
 * BEFORE `dream.execute` so it captures raw diary text ahead of the rewrite, and
 * dream's output is a consolidated diary, not a per-entry vector. Pathway 5 is
 * A-only, and B supersedes.
 *
 * `MEMORY_USAGE` below is unchanged and must stay so: it is the text an AGENT
 * sees on a bad invocation, and neither the producer vector nor the sweep's
 * host-only verbs belong on that surface.
 */

export const MEMORY_USAGE =
  'usage: memory remember "<text>" [--tags a,b] | search "<query>" [-k N] [--tags a,b] | recent [-n N]'

/** `--source` value stamped on a remember when none is passed. */
const DEFAULT_REMEMBER_SOURCE = "conscious"
/** Top-k default for `search` (frozen: shipped `intOr(a1.value, 5)`). */
const DEFAULT_SEARCH_K = 5
/** Row-count default for `recent` (frozen: shipped `intOr(a1.value, 10)`). */
const DEFAULT_RECENT_N = 10
/** Row cap for one `pending` page — the adjudicator's per-sweep bound (design §10). */
const DEFAULT_PENDING_N = 25
export { DEFAULT_PENDING_N }

/** The producer-vector flag. One site, so encoder, parser and error text agree. */
const DIMS_C_FLAG = "--dims-c"

/**
 * The spelling `--dims-c` replaced in Phase 2. Exported so the rejection below
 * and its test name the same string.
 *
 * It is REJECTED rather than ignored. `takeFlag` only consumes flags it is asked
 * for, so an unhandled `--dims` would fall through into the positional
 * remainder, `rest[0]` would still resolve to the memory text, and the row would
 * be written with no producer vector at all — successfully, silently, and
 * indistinguishably from a pathway-6 write. A stale bundle in a long-lived
 * container against a redeployed host is a real way to reach that state, and
 * silence is the one failure mode this design cannot tolerate.
 */
export const LEGACY_DIMS_FLAG = "--dims"

/** Split a `--tags a,b , ,c` value into trimmed, non-empty tags. */
export function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** Pull a named flag's value out of argv, returning the value and the rest. */
function takeFlag(argv: string[], ...names: string[]): { value?: string; rest: string[] } {
  const rest: string[] = []
  let value: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (names.includes(argv[i]) && i + 1 < argv.length) {
      value = argv[i + 1]
      i++ // skip the consumed value
    } else {
      rest.push(argv[i])
    }
  }
  return { value, rest }
}

/** Parse an integer flag, applying `dflt` when the flag is absent; positive-int only. */
function parseIntFlag(
  raw: string | undefined,
  flag: string,
  dflt: number,
): { n: number } | { error: string } {
  if (raw === undefined) return { n: dflt }
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return { error: `${flag} must be a positive integer (got "${raw}")` }
  return { n }
}

// ─── Encoders (host → CLI argv) ──────────────────────────────────────────────

/** A single memory to persist; `dims` empty/absent → the `--dims-c` flag is omitted. */
export interface RememberEntry {
  readonly text: string
  readonly source: string
  readonly tags: ReadonlyArray<string>
  /** The PRODUCER (C) vector — the authoring tier's own reading of this memory
   *  across the character's axis namespace. NOT the final signature: the CLI
   *  merges it with the mechanical (A) vector it computes at insert. Travels on
   *  the wire as `--dims-c`; the FIELD keeps the name `dims` because it is the
   *  host-side entry object, not the wire token, and renaming it would push the
   *  rename through `MemoryWrite`, `LongtermStore.remember` and four extractors
   *  for no gain. */
  readonly dims?: Record<string, number>
}

/**
 * Build the argv for `memory remember`. Flag ORDER is frozen: `remember <text>
 * [--tags <t>] --source <s> [--dims-c <json>]` — `--source` is always emitted,
 * `--tags`/`--dims-c` only when non-empty. `shQuote` is applied host-side by the
 * caller.
 *
 * The producer-vector flag was `--dims` before Phase 2. The output of this
 * function is therefore NOT byte-identical to Phase 1's, by design — see the
 * module header for why the name moved with the meaning.
 */
export function encodeRememberArgs(entry: RememberEntry): string[] {
  const argv: string[] = ["remember", entry.text]
  if (entry.tags.length > 0) argv.push("--tags", entry.tags.join(","))
  argv.push("--source", entry.source)
  if (entry.dims && Object.keys(entry.dims).length > 0) {
    argv.push(DIMS_C_FLAG, JSON.stringify(entry.dims))
  }
  return argv
}

/** Build the argv for `memory search`. `-k` is always emitted (defaulted); `--tags` only when non-empty. */
export function encodeSearchArgs(opts: {
  readonly query: string
  readonly k?: number
  readonly tags?: ReadonlyArray<string>
}): string[] {
  const argv: string[] = ["search", opts.query, "-k", String(opts.k ?? DEFAULT_SEARCH_K)]
  if (opts.tags && opts.tags.length > 0) argv.push("--tags", opts.tags.join(","))
  return argv
}

// NOTE: no `encodeRecentArgs` — `recent` has no host-side caller (nothing shells
// `memory recent`); only its PARSER (`parseRecentArgs`, used by the entrypoint) is
// load-bearing. An encoder is added if/when a host caller appears.

/** Build the argv for `memory mark-get`. */
export function encodeMarkGetArgs(): string[] {
  return ["mark-get"]
}

/** Build the argv for `memory mark-set <json>` (the opaque high-water mark). */
export function encodeMarkSetArgs(markJson: string): string[] {
  return ["mark-set", markJson]
}

/** Build the argv for `memory promote` (entries arrive as base64 lines on stdin). */
export function encodePromoteArgs(): string[] {
  return ["promote"]
}

/**
 * Build the argv for `memory pending` — the adjudicator's work queue (design §3,
 * stage B). The cap is ALWAYS emitted: B costs one model call per row, so an
 * unbounded page is a way to stall a whole reflection cycle behind a burst of
 * agent-authored writes.
 */
export function encodePendingArgs(n?: number): string[] {
  return ["pending", "-n", String(n ?? DEFAULT_PENDING_N)]
}

/**
 * Build the argv for `memory adjudicate <id> <json>` — write B's authoritative
 * vector over the base on one row. Positional, not flagged: both arguments are
 * required and neither has a sensible default (an id you have to guess, and a
 * vector whose absence should never mean `{}`).
 */
export function encodeAdjudicateArgs(id: number, dims: Record<string, number>): string[] {
  return ["adjudicate", String(id), JSON.stringify(dims)]
}

// ─── Parsers (CLI argv → typed command) ──────────────────────────────────────

export interface RememberParsed {
  verb: "remember"
  text: string
  tags: string[]
  source: string
  /** Raw `--dims-c` JSON string (validated) — the PRODUCER (C) vector — or null
   *  when the flag was absent (pathways 5 and 6 have no producer). */
  dims: string | null
}
export interface SearchParsed {
  verb: "search"
  query: string
  k: number
  tags: string[]
}
export interface RecentParsed {
  verb: "recent"
  n: number
}
export interface MarkGetParsed {
  verb: "mark-get"
}
export interface MarkSetParsed {
  verb: "mark-set"
  value: string
}
export interface PromoteParsed {
  verb: "promote"
}
export interface PendingParsed {
  verb: "pending"
  n: number
}
export interface AdjudicateParsed {
  verb: "adjudicate"
  id: number
  /** Raw adjudicated-vector JSON string (validated), mirroring RememberParsed.dims. */
  dims: string
}
export interface EmbeddingsParsed {
  verb: "embeddings"
  /** Explicit row ids to dump; empty means "every row". */
  ids: number[]
  /** Row cap, or null for UNCAPPED — see `parseEmbeddingsArgs` for why null is the default. */
  n: number | null
}

export type ParsedCommand =
  | RememberParsed
  | SearchParsed
  | RecentParsed
  | MarkGetParsed
  | MarkSetParsed
  | PromoteParsed
  | PendingParsed
  | AdjudicateParsed
  | EmbeddingsParsed

export type ParseResult<T> = T | { error: string }

/** Parse `remember` argv (must include the leading verb). Applies the source default and validates `--dims-c`. */
export function parseRememberArgs(argv: ReadonlyArray<string>): ParseResult<RememberParsed> {
  // Reject the retired spelling BEFORE any flag is consumed. Exact token match,
  // so a memory whose TEXT merely mentions the old flag is unaffected.
  if (argv.slice(1).includes(LEGACY_DIMS_FLAG)) {
    return {
      error:
        `${LEGACY_DIMS_FLAG} was replaced by ${DIMS_C_FLAG} (it carries the PRODUCER vector, ` +
        `which the CLI merges with the mechanical one it computes at insert). ` +
        `This usually means a stale host or a stale provisioned bundle — rebuild ` +
        `@roci/player-tools and re-provision.`,
    }
  }
  const afterTags = takeFlag([...argv.slice(1)], "--tags")
  const afterSource = takeFlag(afterTags.rest, "--source")
  const afterDims = takeFlag(afterSource.rest, DIMS_C_FLAG)
  const text = afterDims.rest[0]
  if (!text) return { error: `remember needs text. ${MEMORY_USAGE}` }
  const tags = afterTags.value !== undefined ? parseTags(afterTags.value) : []
  const source = afterSource.value ?? DEFAULT_REMEMBER_SOURCE
  // --dims-c: absent → null (no producer; the row still gets its mechanical
  // vector); present → must be valid JSON, else a HARD error (loud, not a
  // silently-stored corrupt signature).
  let dims: string | null = null
  if (afterDims.value !== undefined) {
    try {
      JSON.parse(afterDims.value)
    } catch {
      return { error: `${DIMS_C_FLAG} must be valid JSON (got ${JSON.stringify(afterDims.value)})` }
    }
    dims = afterDims.value
  }
  return { verb: "remember", text, tags, source, dims }
}

/** Parse `search` argv (must include the leading verb). Applies the k default. */
export function parseSearchArgs(argv: ReadonlyArray<string>): ParseResult<SearchParsed> {
  const afterK = takeFlag([...argv.slice(1)], "-k")
  const afterTags = takeFlag(afterK.rest, "--tags")
  const query = afterTags.rest[0]
  if (!query) return { error: `search needs a query. ${MEMORY_USAGE}` }
  const k = parseIntFlag(afterK.value, "-k", DEFAULT_SEARCH_K)
  if ("error" in k) return k
  const tags = afterTags.value !== undefined ? parseTags(afterTags.value) : []
  return { verb: "search", query, k: k.n, tags }
}

/** Parse `recent` argv (must include the leading verb). Applies the n default. */
export function parseRecentArgs(argv: ReadonlyArray<string>): ParseResult<RecentParsed> {
  const afterN = takeFlag([...argv.slice(1)], "-n")
  const n = parseIntFlag(afterN.value, "-n", DEFAULT_RECENT_N)
  if ("error" in n) return n
  return { verb: "recent", n: n.n }
}

/** Parse `pending` argv (must include the leading verb). Applies the n default. */
export function parsePendingArgs(argv: ReadonlyArray<string>): ParseResult<PendingParsed> {
  const afterN = takeFlag([...argv.slice(1)], "-n")
  const n = parseIntFlag(afterN.value, "-n", DEFAULT_PENDING_N)
  if ("error" in n) return n
  return { verb: "pending", n: n.n }
}

/**
 * Parse `adjudicate <id> <json>` (must include the leading verb). Both positional
 * arguments are REQUIRED and both are validated hard: the id must be a positive
 * integer because it targets a real `UPDATE`, and the vector must be valid JSON
 * for the same reason `--dims-c` is — an invalid signature must never reach the
 * store, and it must certainly never OVERWRITE a good one.
 */
export function parseAdjudicateArgs(argv: ReadonlyArray<string>): ParseResult<AdjudicateParsed> {
  const rawId = argv[1]
  const rawDims = argv[2]
  if (rawId === undefined || rawDims === undefined) {
    return { error: `adjudicate needs an id and a JSON vector. ${MEMORY_USAGE}` }
  }
  const id = Number(rawId)
  if (!Number.isInteger(id) || id <= 0) {
    return { error: `adjudicate id must be a positive integer (got "${rawId}")` }
  }
  try {
    JSON.parse(rawDims)
  } catch {
    return { error: `adjudicate vector must be valid JSON (got ${JSON.stringify(rawDims)})` }
  }
  return { verb: "adjudicate", id, dims: rawDims }
}

/**
 * Parse `embeddings [--ids 1,2,3] [-n N]` — the OFFLINE embedding dump.
 *
 * Two deliberate departures from the other row-listing verbs:
 *
 *  - `-n` defaults to NULL (uncapped), not to a number. Every other verb feeds
 *    something on a live path where an unbounded page is a hazard; this one
 *    exists to dump a whole corpus once, for analysis, and a silent default cap
 *    would truncate a study's dataset while looking like it succeeded. It is not
 *    reachable from any tick.
 *  - `--ids` is validated element by element. The ids become SQL LITERALS
 *    (`buildEmbeddingsSql`; vec0's read path has no bind seam), so a
 *    non-integer element is rejected here rather than interpolated.
 *
 * Like `recent`, this has no host-side ENCODER: nothing in core shells it. It is
 * invoked by hand for a study. An encoder is added if/when a host caller appears.
 */
export function parseEmbeddingsArgs(argv: ReadonlyArray<string>): ParseResult<EmbeddingsParsed> {
  const afterIds = takeFlag([...argv.slice(1)], "--ids")
  const afterN = takeFlag(afterIds.rest, "-n")
  const ids: number[] = []
  if (afterIds.value !== undefined) {
    const raw = afterIds.value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (raw.length === 0) return { error: `--ids needs at least one id (got "${afterIds.value}")` }
    for (const s of raw) {
      const id = Number(s)
      if (!Number.isInteger(id) || id <= 0) {
        return { error: `--ids entries must be positive integers (got "${s}")` }
      }
      ids.push(id)
    }
  }
  if (afterN.value === undefined) return { verb: "embeddings", ids, n: null }
  const n = parseIntFlag(afterN.value, "-n", 0)
  if ("error" in n) return n
  return { verb: "embeddings", ids, n: n.n }
}

/**
 * Dispatch a full CLI argv to its typed command. The container entrypoint calls
 * this; unknown/empty verbs and malformed value flags surface `{ error }`.
 */
export function parseCommand(argv: ReadonlyArray<string>): ParseResult<ParsedCommand> {
  switch (argv[0]) {
    case "remember":
      return parseRememberArgs(argv)
    case "search":
      return parseSearchArgs(argv)
    case "recent":
      return parseRecentArgs(argv)
    case "mark-get":
      return { verb: "mark-get" }
    case "mark-set":
      return { verb: "mark-set", value: argv[1] ?? "" }
    case "promote":
      return { verb: "promote" }
    case "pending":
      return parsePendingArgs(argv)
    case "adjudicate":
      return parseAdjudicateArgs(argv)
    case "embeddings":
      return parseEmbeddingsArgs(argv)
    default:
      return { error: `unknown verb "${argv[0] ?? ""}". ${MEMORY_USAGE}` }
  }
}
