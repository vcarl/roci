/**
 * Pure arg parser for the `memory` CLI (spec §8). Mirrors the logic the generated
 * in-container bun script embeds; unit-tested here so the verb/flag grammar is
 * locked independent of the script string.
 *
 *   memory remember "<text>" [--tags a,b]
 *   memory search   "<query>" [-k N] [--tags a,b]
 *   memory recent   [-n N]
 */

export const MEMORY_USAGE =
  'usage: memory remember "<text>" [--tags a,b] | search "<query>" [-k N] [--tags a,b] | recent [-n N]'

export type MemoryArgs =
  | { verb: "remember"; text: string; tags?: string[]; source?: string }
  | { verb: "search"; query: string; k?: number; tags?: string[] }
  | { verb: "recent"; n?: number }

export type MemoryParse = MemoryArgs | { error: string }

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

function parseIntFlag(raw: string | undefined, flag: string): { n?: number } | { error: string } {
  if (raw === undefined) return {}
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return { error: `${flag} must be a positive integer (got "${raw}")` }
  return { n }
}

export function parseMemoryArgs(argv: ReadonlyArray<string>): MemoryParse {
  const [verb, ...rest0] = argv
  switch (verb) {
    case "remember": {
      const afterTags = takeFlag([...rest0], "--tags")
      const { value: source, rest } = takeFlag(afterTags.rest, "--source")
      const text = rest[0]
      if (!text) return { error: `remember needs text. ${MEMORY_USAGE}` }
      const tags = afterTags.value !== undefined ? parseTags(afterTags.value) : undefined
      const out: MemoryArgs = { verb: "remember", text }
      if (tags && tags.length > 0) out.tags = tags
      if (source !== undefined) out.source = source
      return out
    }
    case "search": {
      const afterK = takeFlag([...rest0], "-k")
      const { value: tagsRaw, rest } = takeFlag(afterK.rest, "--tags")
      const query = rest[0]
      if (!query) return { error: `search needs a query. ${MEMORY_USAGE}` }
      const k = parseIntFlag(afterK.value, "-k")
      if ("error" in k) return k
      const tags = tagsRaw !== undefined ? parseTags(tagsRaw) : undefined
      const out: MemoryArgs = { verb: "search", query }
      if (k.n !== undefined) out.k = k.n
      if (tags && tags.length > 0) out.tags = tags
      return out
    }
    case "recent": {
      const { value: nRaw } = takeFlag([...rest0], "-n")
      const n = parseIntFlag(nRaw, "-n")
      if ("error" in n) return n
      return n.n !== undefined ? { verb: "recent", n: n.n } : { verb: "recent" }
    }
    default:
      return { error: `unknown verb "${verb ?? ""}". ${MEMORY_USAGE}` }
  }
}
