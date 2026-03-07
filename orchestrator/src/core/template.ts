import { Effect } from "effect"
import { FileSystem } from "@effect/platform"

/**
 * Strip YAML frontmatter (---…---) from the beginning of a string.
 * Returns the body after the closing `---`.
 */
export function stripFrontmatter(raw: string): string {
  const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)
  return match ? match[1].trimStart() : raw
}

/**
 * Parse YAML frontmatter from a raw string.
 * Handles simple types: strings, numbers, booleans, and comma-separated string arrays.
 */
export function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: raw }

  const meta: Record<string, unknown> = {}
  for (const line of match[1].split("\n")) {
    const kvMatch = line.match(/^(\S[\w-]*)\s*:\s*(.*)$/)
    if (!kvMatch) continue
    const [, key, rawValue] = kvMatch
    const value = rawValue.trim()

    // Boolean
    if (value === "true") { meta[key] = true; continue }
    if (value === "false") { meta[key] = false; continue }

    // Number
    const num = Number(value)
    if (value !== "" && !isNaN(num)) { meta[key] = num; continue }

    // Comma-separated array (if it contains commas)
    if (value.includes(",")) {
      meta[key] = value.split(",").map(s => s.trim()).filter(Boolean)
      continue
    }

    // String (strip quotes if present)
    meta[key] = value.replace(/^["']|["']$/g, "")
  }

  return { meta, body: match[2].trimStart() }
}

/**
 * Replace `{{key}}` placeholders with values from a record.
 * Unknown keys are replaced with the empty string.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "")
}

/**
 * Effect-based file read + frontmatter stripping.
 * Requires `FileSystem` from `@effect/platform`.
 */
export const loadTemplate = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const raw = yield* fs.readFileString(filePath)
    return stripFrontmatter(raw)
  })

/**
 * Effect-based file read + frontmatter parsing.
 * Returns both parsed metadata and the template body.
 */
export const loadTemplateWithMeta = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const raw = yield* fs.readFileString(filePath)
    return parseFrontmatter(raw)
  })
