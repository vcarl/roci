import { Prompt } from "@effect/cli"
import { NodeTerminal } from "@effect/platform-node"
import { Effect } from "effect"
import * as path from "node:path"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { DOMAIN_REGISTRY, resolveConfigs } from "../domains/registry.js"
import type { ProcedureMessage } from "@roci/core/core/domain-bundle.js"
import { scaffoldCharacter, type ReviewDecision } from "@roci/core/core/character-scaffold.js"
import { makeCharacterConfig } from "@roci/core/services/CharacterFs.js"
import { meDir } from "@roci/core/services/character-paths.js"
import { logToConsole } from "@roci/core/logging/log-writer.js"
import { validateAndStart } from "./validate-and-start.js"
import { DEFAULT_MODEL_CONFIG } from "@roci/core/core/model-config.js"
import { ensureOAuthTokenInteractive } from "./oauth-token.js"

/** Log a ProcedureMessage to console with appropriate prefix. */
const logProcMsg = (msg: ProcedureMessage) => {
  const prefix = msg.level === "ok" ? "OK" : msg.level === "warning" ? "WARNING" : "ERROR"
  return logToConsole("setup", "cli", `${prefix}: ${msg.text}`)
}

/** Map a review answer + text fields to a ReviewDecision (pure; unit-tested). */
export const reviewDecisionFromAnswer = (
  answer: "accept" | "edit" | "regenerate" | "skip",
  original: string,
  edited: string,
  feedback: string,
): ReviewDecision => {
  switch (answer) {
    case "accept":
      return { action: "accept", content: original }
    case "edit":
      return { action: "accept", content: edited }
    case "regenerate":
      return { action: "regenerate", feedback: feedback.trim() || undefined }
    case "skip":
      return { action: "skip" }
  }
}

/** Interactive per-step review: show the artifact, ask accept/edit/regenerate/skip.
 *  Satisfies ReviewFn (Effect<ReviewDecision, never, never>) by:
 *  - using console.log directly (no CharacterLog service) for display
 *  - providing NodeTerminal.layer inline (satisfies Terminal requirement)
 *  - aborting the wizard on quit (Ctrl-C): Prompt fails only with QuitException;
 *    we exit rather than fabricate an accept, so cancelling never writes an
 *    unapproved artifact to disk. process.exit returns `never`, so this unifies
 *    with the success branch and preserves the `never` error channel. */
const interactiveReview: import("@roci/core/core/character-scaffold.js").ReviewFn = (step, content) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => console.log(`\n----- ${step} -----\n${content}\n-----------------`))
    const answer = yield* Prompt.select({
      message: `Review ${step}`,
      choices: [
        { title: "Accept", value: "accept" as const },
        { title: "Edit", value: "edit" as const },
        { title: "Regenerate (with feedback)", value: "regenerate" as const },
        { title: "Skip (use plain template)", value: "skip" as const },
      ],
    })
    let edited = content
    let feedback = ""
    if (answer === "edit") {
      edited = yield* Prompt.text({ message: "Edit the content", default: content })
    } else if (answer === "regenerate") {
      feedback = yield* Prompt.text({ message: "Feedback to steer the re-roll (optional)", default: "" })
    }
    return reviewDecisionFromAnswer(answer, content, edited, feedback)
  }).pipe(
    Effect.provide(NodeTerminal.layer),
    Effect.catchAll(() =>
      Effect.sync(() => {
        console.log("\nSetup cancelled.")
        return process.exit(130) // 128 + SIGINT; returns never, so the `never` channel holds
      }),
    ),
  )

/**
 * Interactive guided setup flow.
 *
 * Walks the user through domain selection, character creation, and optionally
 * validates and starts the orchestrator.
 */
export const runGuidedSetup = (projectRoot: string) =>
  Effect.gen(function* () {
    // Ensure OAuth token is available before anything else
    yield* ensureOAuthTokenInteractive(projectRoot)

    yield* logToConsole("setup", "cli", "Welcome to Rocinante crew orchestrator setup!")
    yield* logToConsole("setup", "cli", "")

    // 1. Domain selection
    const domainEntries = Object.entries(DOMAIN_REGISTRY)
    const domainChoices = domainEntries.map(([key, entry]) => ({
      title: `${entry.displayName} — ${entry.description}`,
      value: key,
      description: key,
    }))

    const selectedDomains: string[] = yield* Prompt.multiSelect({
      message: "Select domain(s) to set up",
      choices: domainChoices,
      min: 1,
    })

    if (selectedDomains.length === 0) {
      yield* logToConsole("setup", "cli", "No domains selected. Exiting setup.")
      return
    }

    // 2. For each domain, run project init and character creation loop
    const configPath = path.resolve(projectRoot, "config.json")
    let config: Record<string, { characters: string[] }> = {}
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, "utf-8"))
      } catch {
        // Start fresh if invalid
      }
    }

    for (const domainName of selectedDomains) {
      yield* logToConsole("setup", "cli", "")
      yield* logToConsole("setup", "cli", `--- Setting up ${DOMAIN_REGISTRY[domainName].displayName} domain ---`)

      const registryEntry = DOMAIN_REGISTRY[domainName]
      const domainConfig = registryEntry.factory(projectRoot)

      // Run project-level init
      if (domainConfig.initProject) {
        const msgs = yield* domainConfig.initProject(projectRoot)
        for (const msg of msgs) yield* logProcMsg(msg)
      }

      // Ensure domain entry exists in config
      if (!config[domainName]) {
        config[domainName] = { characters: [] }
      }

      // Character creation loop
      let addMore = true
      while (addMore) {
        const charName: string = yield* Prompt.text({
          message: `Enter character name for ${DOMAIN_REGISTRY[domainName].displayName}`,
        })

        if (!charName.trim()) {
          yield* logToConsole("setup", "cli", "Empty name, skipping.")
          break
        }

        const name = charName.trim()
        const charDir = meDir(makeCharacterConfig(projectRoot, name))

        const charDescription: string = yield* Prompt.text({
          message: "Describe this character in a sentence or two (or press Enter to skip)",
          default: "",
        })

        yield* logToConsole("setup", "cli", `\nScaffolding ${name}...`)

        // Scaffold generic identity files
        // Generates identity locally via the conscious cortex tier, reviewed per-step.
        const { results: _scaffoldResults, summary } = yield* scaffoldCharacter({
          projectRoot,
          characterName: name,
          identityTemplate: domainConfig.identityTemplate,
          characterDescription: charDescription.trim() || undefined,
          domainConfig,
          review: interactiveReview,
        })
        if (summary) {
          yield* logToConsole("setup", "cli", summary)
        }

        // Domain-specific setup
        if (domainConfig.setupCharacter) {
          const msgs = yield* domainConfig.setupCharacter.run({
            projectRoot,
            characterName: name,
            characterDir: charDir,
          })
          for (const msg of msgs) yield* logProcMsg(msg)

          if (msgs.some(m => m.level === "error")) {
            yield* logToConsole("setup", "cli", `Skipping config.json registration for ${name} due to errors`)
          } else {
            if (!config[domainName].characters.includes(name)) {
              config[domainName].characters.push(name)
            }
          }
        } else {
          // No domain-specific setup — just register
          if (!config[domainName].characters.includes(name)) {
            config[domainName].characters.push(name)
          }
        }

        addMore = yield* Prompt.confirm({
          message: `Add another character for ${DOMAIN_REGISTRY[domainName].displayName}?`,
          initial: false,
        })
      }
    }

    // 3. Write config.json
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
    yield* logToConsole("setup", "cli", "")
    yield* logToConsole("setup", "cli", `Updated config.json:`)
    for (const [domain, entry] of Object.entries(config)) {
      if (entry.characters.length > 0) {
        yield* logToConsole("setup", "cli", `  ${domain}: ${entry.characters.join(", ")}`)
      }
    }

    // 4. Optionally validate and start
    const totalChars = Object.values(config).reduce((sum, e) => sum + e.characters.length, 0)
    if (totalChars === 0) {
      yield* logToConsole("setup", "cli", "No characters were added. Run 'roci setup' again when ready.")
      return
    }

    const startNow: boolean = yield* Prompt.confirm({
      message: "Validate configuration and start now?",
      initial: true,
    })

    if (startNow) {
      const resolved = resolveConfigs(projectRoot, [], [])
      yield* validateAndStart(projectRoot, resolved, 30, false, DEFAULT_MODEL_CONFIG)
    } else {
      yield* logToConsole("setup", "cli", "Setup complete. Run 'roci' or 'roci start' to begin.")
    }
  })
