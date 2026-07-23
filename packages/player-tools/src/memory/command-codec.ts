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
 * Grammar (frozen container contract, spec §4): `remember <text> [--tags a,b]
 * --source <s> [--dims <json>]`, `search <query> -k <k> [--tags a,b]`,
 * `recent [-n <n>]`, `mark-get`, `mark-set <json>`, `promote` (stdin). Defaults:
 * `--source` → "conscious", `-k` → 5, `-n` → 10. `--dims` is OMITTED when the
 * signature is empty/absent (→ NULL column → neutral salience at recall); a
 * present-but-malformed `--dims` value is a HARD parse error (loud, not silent).
 */

export const MEMORY_USAGE =
  'usage: memory remember "<text>" [--tags a,b] | search "<query>" [-k N] [--tags a,b] | recent [-n N]'

/** `--source` value stamped on a remember when none is passed. */
const DEFAULT_REMEMBER_SOURCE = "conscious"
/** Top-k default for `search` (frozen: shipped `intOr(a1.value, 5)`). */
const DEFAULT_SEARCH_K = 5
/** Row-count default for `recent` (frozen: shipped `intOr(a1.value, 10)`). */
const DEFAULT_RECENT_N = 10

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

/** A single memory to persist; `dims` empty/absent → the `--dims` flag is omitted. */
export interface RememberEntry {
  readonly text: string
  readonly source: string
  readonly tags: ReadonlyArray<string>
  readonly dims?: Record<string, number>
}

/**
 * Build the argv for `memory remember`. Flag order is FROZEN to the legacy
 * hand-concatenation (spec §4): `remember <text> [--tags <t>] --source <s>
 * [--dims <json>]` — `--source` is always emitted, `--tags`/`--dims` only when
 * non-empty. `shQuote` is applied host-side by the caller.
 */
export function encodeRememberArgs(entry: RememberEntry): string[] {
  const argv: string[] = ["remember", entry.text]
  if (entry.tags.length > 0) argv.push("--tags", entry.tags.join(","))
  argv.push("--source", entry.source)
  if (entry.dims && Object.keys(entry.dims).length > 0) argv.push("--dims", JSON.stringify(entry.dims))
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

// ─── Parsers (CLI argv → typed command) ──────────────────────────────────────

export interface RememberParsed {
  verb: "remember"
  text: string
  tags: string[]
  source: string
  /** Raw `--dims` JSON string (validated), or null when the flag was absent. */
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

export type ParsedCommand =
  | RememberParsed
  | SearchParsed
  | RecentParsed
  | MarkGetParsed
  | MarkSetParsed
  | PromoteParsed

export type ParseResult<T> = T | { error: string }

/** Parse `remember` argv (must include the leading verb). Applies the source default and validates `--dims`. */
export function parseRememberArgs(argv: ReadonlyArray<string>): ParseResult<RememberParsed> {
  const afterTags = takeFlag([...argv.slice(1)], "--tags")
  const afterSource = takeFlag(afterTags.rest, "--source")
  const afterDims = takeFlag(afterSource.rest, "--dims")
  const text = afterDims.rest[0]
  if (!text) return { error: `remember needs text. ${MEMORY_USAGE}` }
  const tags = afterTags.value !== undefined ? parseTags(afterTags.value) : []
  const source = afterSource.value ?? DEFAULT_REMEMBER_SOURCE
  // --dims: absent → null (neutral salience); present → must be valid JSON, else
  // a HARD error (loud, not a silently-stored corrupt signature).
  let dims: string | null = null
  if (afterDims.value !== undefined) {
    try {
      JSON.parse(afterDims.value)
    } catch {
      return { error: `--dims must be valid JSON (got ${JSON.stringify(afterDims.value)})` }
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
    default:
      return { error: `unknown verb "${argv[0] ?? ""}". ${MEMORY_USAGE}` }
  }
}
