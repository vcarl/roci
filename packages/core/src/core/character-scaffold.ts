import { Effect } from "effect"
import { CommandExecutor } from "@effect/platform"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import * as path from "node:path"
import { Docker } from "../services/Docker.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { CharacterLog } from "../logging/log-writer.js"
import { makeCharacterConfig } from "../services/CharacterFs.js"
import { runTurn } from "./limbic/hypothalamus/process-runner.js"
import type { DomainConfig } from "./domain-bundle.js"
import { DEFAULT_MODEL_CONFIG, resolveModel, type ModelConfig } from "./model-config.js"

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

interface IdentityResult {
  background: string
  values: string
}

const buildIdentityPrompt = (
  characterName: string,
  characterDescription: string,
  identityTemplate?: { backgroundHints: string; valuesHints: string },
): string => {
  const domainContext = identityTemplate
    ? `\nDomain context for the background: ${identityTemplate.backgroundHints}\nDomain context for values: ${identityTemplate.valuesHints}\n`
    : ""

  return `You are generating identity files for an AI character named "${characterName}".

The user described this character as: ${characterDescription}
${domainContext}
Generate two documents for this character. Use the delimiters shown below exactly.

---BACKGROUND---
Write a rich identity narrative for this character. This is their background document — it defines who they are, how they think, what motivates them, and how they operate. It should be detailed enough to guide an AI agent's behavior and personality across many interactions. Write in a voice that fits the character. Aim for 300-800 words. Do NOT include the delimiter in the content itself.

---VALUES---
Write the character's working values and principles. These should be concrete, actionable guidelines that will shape the character's decisions — not generic platitudes. Each value should have a short heading and 1-3 sentences explaining it. Aim for 5-10 values. Do NOT include the delimiter in the content itself.

---END---

Output ONLY the two sections with the delimiters. No preamble, no commentary.`
}

const parseIdentityOutput = (output: string): IdentityResult | null => {
  const bgMatch = output.match(/---BACKGROUND---\s*([\s\S]*?)\s*---VALUES---/)
  const valMatch = output.match(/---VALUES---\s*([\s\S]*?)\s*---END---/)
  if (!bgMatch?.[1]?.trim() || !valMatch?.[1]?.trim()) return null
  return {
    background: bgMatch[1].trim() + "\n",
    values: valMatch[1].trim() + "\n",
  }
}

/**
 * Scaffold a new character's generic identity files.
 *
 * Creates `players/<name>/me/` and writes the four standard files
 * (background.md, VALUES.md, DIARY.md, SECRETS.md). Existing files are
 * never overwritten.
 *
 * When a characterDescription is provided, spins up a temporary Docker
 * container, calls runTurn to generate rich background/values content,
 * then tears the container down. Falls back to placeholder templates if
 * generation fails for any reason (graceful degradation).
 */
export const scaffoldCharacter = (opts: {
  projectRoot: string
  characterName: string
  identityTemplate?: {
    backgroundHints: string
    valuesHints: string
  }
  characterDescription?: string
  models?: ModelConfig
  domainConfig: DomainConfig
}): Effect.Effect<
  { results: string[]; summary?: string },
  unknown,
  Docker | CommandExecutor.CommandExecutor | CharacterLog | OAuthToken
> =>
  Effect.gen(function* () {
    const { projectRoot, characterName, identityTemplate, characterDescription, domainConfig } = opts
    const models = opts.models ?? DEFAULT_MODEL_CONFIG
    const identityModel = resolveModel(models, "scaffoldIdentity", "smart")
    const summaryModel = resolveModel(models, "scaffoldSummary", "fast")
    const charDir = path.resolve(projectRoot, "players", characterName, "me")
    const results: string[] = []

    if (!existsSync(charDir)) {
      mkdirSync(charDir, { recursive: true })
      results.push(`created directory: ${charDir}`)
    }

    let generated: IdentityResult | null = null
    let summary: string | undefined

    if (characterDescription) {
      results.push(`generating identity with AI...`)

      const aiResult = yield* Effect.acquireUseRelease(
        // acquire: build image (if needed), create + start temp container
        Effect.gen(function* () {
          const docker = yield* Docker
          if (domainConfig.dockerfilePath && domainConfig.dockerContext) {
            yield* docker.build(
              domainConfig.imageName,
              domainConfig.dockerfilePath,
              domainConfig.dockerContext,
            )
          }
          const containerName = `roci-scaffold-${characterName}-${Date.now()}`
          const containerId = yield* docker.create({
            name: containerName,
            image: domainConfig.imageName,
            mounts: domainConfig.containerMounts.map((m) => ({
              host: m.host,
              container: m.container,
              readonly: m.readonly,
            })),
            env: {
              ...(process.env.SKIP_FIREWALL ? { SKIP_FIREWALL: "1" } : {}),
            },
            cmd: [
              "bash",
              "-c",
              "if [ -z \"$SKIP_FIREWALL\" ]; then sudo /usr/local/bin/init-firewall.sh; fi && sleep infinity",
            ],
            capAdd: ["NET_ADMIN", "NET_RAW"],
          })
          yield* Effect.try({
            try: () => execSync(`docker start ${containerId}`, { stdio: "pipe" }),
            catch: (e) => new Error(`Failed to start scaffold container: ${e}`),
          })
          if (domainConfig.containerSetup) {
            try {
              domainConfig.containerSetup(containerId)
            } catch {
              // Non-fatal — scaffold should keep going.
            }
          }
          return containerId
        }),
        // use: do AI calls via runTurn; on failure return null for graceful fallback
        (containerId) =>
          Effect.gen(function* () {
            const char = makeCharacterConfig(projectRoot, characterName)
            const identityPrompt = buildIdentityPrompt(
              characterName,
              characterDescription,
              identityTemplate,
            )

            const identityTurn = yield* runTurn({
              containerId,
              playerName: characterName,
              char,
              prompt: identityPrompt,
              systemPrompt: "",
              model: identityModel,
              timeoutMs: 120_000,
              role: "brain",
              noTools: true,
              addDirs: domainConfig.containerAddDirs,
            }).pipe(Effect.catchAll(() => Effect.succeed(null)))

            if (!identityTurn) return null

            const parsed = parseIdentityOutput(identityTurn.output)
            if (!parsed) return null

            const summaryPrompt = `Here is the background document for an AI character named "${characterName}":\n\n${parsed.background}\n\nWrite exactly 4 sentences summarizing this character's identity, personality, and motivations. Be concise and vivid. Output ONLY the summary, no preamble.`

            const summaryTurn = yield* runTurn({
              containerId,
              playerName: characterName,
              char,
              prompt: summaryPrompt,
              systemPrompt: "",
              model: summaryModel,
              timeoutMs: 30_000,
              role: "brain",
              noTools: true,
              addDirs: domainConfig.containerAddDirs,
            }).pipe(Effect.catchAll(() => Effect.succeed(null)))

            const summaryText = summaryTurn?.output.trim() || undefined
            return { identity: parsed, summary: summaryText }
          }),
        // release: stop + remove temp container
        (containerId) =>
          Effect.gen(function* () {
            const docker = yield* Docker
            yield* docker.stop(containerId).pipe(Effect.catchAll(() => Effect.void))
            yield* docker.remove(containerId).pipe(Effect.catchAll(() => Effect.void))
          }),
      ).pipe(Effect.catchAll(() => Effect.succeed(null)))

      if (aiResult) {
        generated = aiResult.identity
        summary = aiResult.summary
        results.push(`AI-generated background and values for ${characterName}`)
      } else {
        results.push(`AI generation failed, using templates`)
      }
    }

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

    return { results, summary }
  })
