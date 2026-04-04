import { Effect } from "effect"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import * as path from "node:path"
import { claudeBaseArgs } from "../services/Claude.js"

const BACKGROUND_TEMPLATE = `# Background

<!-- Write your character's background here. This is their identity narrative —
     who they are, how they think, what drives them. The AI reads this on every
     planning cycle to stay in character. -->
`

const VALUES_TEMPLATE = `# Values

<!-- Write your character's working values here. These define how the character
     operates — their priorities, principles, and decision-making framework. -->
`

const DIARY_TEMPLATE = `# Diary
`

const SECRETS_TEMPLATE = `# Secrets
`

/**
 * Generate background.md and VALUES.md content using Claude CLI.
 *
 * Spawns `claude -p` as a subprocess with a prompt that includes the
 * character name, user description, and domain identity hints. Returns
 * the generated content split into { background, values }, or null if
 * generation fails for any reason.
 */
function generateIdentityWithClaude(opts: {
  characterName: string
  characterDescription: string
  identityTemplate?: { backgroundHints: string; valuesHints: string }
  containerId: string
}): { background: string; values: string } | null {
  const { characterName, characterDescription, identityTemplate, containerId } = opts

  const domainContext = identityTemplate
    ? `\nDomain context for the background: ${identityTemplate.backgroundHints}\nDomain context for values: ${identityTemplate.valuesHints}\n`
    : ""

  const prompt = `You are generating identity files for an AI character named "${characterName}".

The user described this character as: ${characterDescription}
${domainContext}
Generate two documents for this character. Use the delimiters shown below exactly.

---BACKGROUND---
Write a rich identity narrative for this character. This is their background document — it defines who they are, how they think, what motivates them, and how they operate. It should be detailed enough to guide an AI agent's behavior and personality across many interactions. Write in a voice that fits the character. Aim for 300-800 words. Do NOT include the delimiter in the content itself.

---VALUES---
Write the character's working values and principles. These should be concrete, actionable guidelines that will shape the character's decisions — not generic platitudes. Each value should have a short heading and 1-3 sentences explaining it. Aim for 5-10 values. Do NOT include the delimiter in the content itself.

---END---

Output ONLY the two sections with the delimiters. No preamble, no commentary.`

  try {
    const output = execFileSync("docker", [
      "exec", "-i", containerId,
      "claude", ...claudeBaseArgs("sonnet"),
    ], {
      encoding: "utf-8",
      input: prompt,
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const bgMatch = output.match(/---BACKGROUND---\s*([\s\S]*?)\s*---VALUES---/)
    const valMatch = output.match(/---VALUES---\s*([\s\S]*?)\s*---END---/)

    if (!bgMatch?.[1]?.trim() || !valMatch?.[1]?.trim()) {
      return null
    }

    return {
      background: bgMatch[1].trim() + "\n",
      values: valMatch[1].trim() + "\n",
    }
  } catch {
    return null
  }
}

/**
 * Generate a brief summary of a character's identity using Claude CLI.
 * Returns a 4-sentence summary string, or null on failure.
 */
function generateSummaryWithClaude(characterName: string, background: string, containerId: string): string | null {
  const prompt = `Here is the background document for an AI character named "${characterName}":\n\n${background}\n\nWrite exactly 4 sentences summarizing this character's identity, personality, and motivations. Be concise and vivid. Output ONLY the summary, no preamble.`

  try {
    const output = execFileSync("docker", [
      "exec", "-i", containerId,
      "claude", ...claudeBaseArgs("haiku"),
    ], {
      encoding: "utf-8",
      input: prompt,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const trimmed = output.trim()
    return trimmed || null
  } catch {
    return null
  }
}

/**
 * Scaffold a new character's generic identity files.
 *
 * Creates `players/<name>/me/` and writes the four standard files
 * (background.md, VALUES.md, DIARY.md, SECRETS.md). Existing files are
 * never overwritten — they are skipped and noted in the returned list
 * with a "skipped:" prefix.
 *
 * When a characterDescription is provided, uses Claude to generate
 * rich background and values content. Falls back to placeholder
 * templates if generation fails.
 *
 * @returns object with results (file creation messages) and optional summary
 */
export const scaffoldCharacter = (opts: {
  projectRoot: string
  characterName: string
  identityTemplate?: {
    backgroundHints: string
    valuesHints: string
  }
  characterDescription?: string
  containerId: string
}): Effect.Effect<{ results: string[], summary?: string }, never, never> =>
  Effect.sync(() => {
    const { projectRoot, characterName, identityTemplate, characterDescription, containerId } = opts
    const charDir = path.resolve(projectRoot, "players", characterName, "me")
    const results: string[] = []

    // Ensure directory exists
    if (!existsSync(charDir)) {
      mkdirSync(charDir, { recursive: true })
      results.push(`created directory: ${charDir}`)
    }

    // Try AI generation if a description was provided
    let generated: { background: string; values: string } | null = null
    if (characterDescription) {
      results.push(`generating identity with Claude...`)
      generated = generateIdentityWithClaude({
        characterName,
        characterDescription,
        identityTemplate,
        containerId,
      })
      if (generated) {
        results.push(`AI-generated background and values for ${characterName}`)
      } else {
        results.push(`AI generation failed, using templates`)
      }
    }

    // Build file contents
    const backgroundContent = generated
      ? generated.background
      : identityTemplate
        ? BACKGROUND_TEMPLATE + `\n## Domain Context\n\n${identityTemplate.backgroundHints}\n`
        : BACKGROUND_TEMPLATE

    const valuesContent = generated
      ? generated.values
      : identityTemplate
        ? VALUES_TEMPLATE + `\n## Domain Context\n\n${identityTemplate.valuesHints}\n`
        : VALUES_TEMPLATE

    const files: Array<{ name: string; content: string }> = [
      { name: "background.md", content: backgroundContent },
      { name: "VALUES.md", content: valuesContent },
      { name: "DIARY.md", content: DIARY_TEMPLATE },
      { name: "SECRETS.md", content: SECRETS_TEMPLATE },
    ]

    for (const file of files) {
      const filePath = path.resolve(charDir, file.name)
      if (existsSync(filePath)) {
        results.push(`skipped: ${filePath} (already exists)`)
      } else {
        writeFileSync(filePath, file.content)
        results.push(`created: ${filePath}`)
      }
    }

    // Generate a brief summary if AI generation succeeded
    let summary: string | undefined
    if (generated) {
      summary = generateSummaryWithClaude(characterName, generated.background, containerId) ?? undefined
    }

    return { results, summary }
  })
