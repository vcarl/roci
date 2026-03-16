import { Prompt } from "@effect/cli"
import { Effect } from "effect"
import * as path from "node:path"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { DOMAIN_REGISTRY, resolveConfigs } from "../domains/registry.js"
import type { ProcedureMessage } from "@signal/core/core/domain-bundle.js"
import { scaffoldCharacter, generateNameSuggestions } from "@signal/core/core/character-scaffold.js"
import { logToConsole } from "@signal/core/logging/console-renderer.js"
import { validateAndStart } from "./validate-and-start.js"
import { ensureOAuthTokenInteractive } from "./oauth-token.js"

/** Log a ProcedureMessage to console with appropriate prefix. */
const logProcMsg = (msg: ProcedureMessage) => {
  const prefix = msg.level === "ok" ? "OK" : msg.level === "warning" ? "WARNING" : "ERROR"
  return logToConsole("setup", "cli", `${prefix}: ${msg.text}`)
}

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
        const charDescription: string = yield* Prompt.text({
          message: `Describe this character's role and personality for ${DOMAIN_REGISTRY[domainName].displayName}`,
        })

        if (!charDescription.trim()) {
          yield* logToConsole("setup", "cli", "Empty description, skipping.")
          break
        }

        // Generate name suggestions from description
        yield* logToConsole("setup", "cli", "\nGenerating name suggestions...")
        const suggestions = generateNameSuggestions(charDescription.trim())

        let name: string
        if (suggestions && suggestions.length > 0) {
          yield* logToConsole("setup", "cli", "")
          for (let i = 0; i < suggestions.length; i++) {
            yield* logToConsole("setup", "cli", `  ${i + 1}. ${suggestions[i]}`)
          }
          yield* logToConsole("setup", "cli", `  0. (enter my own)`)
          yield* logToConsole("setup", "cli", "")

          const pick: string = yield* Prompt.text({
            message: `Pick a number (1-${suggestions.length}) or 0 for custom`,
          })

          const pickNum = parseInt(pick.trim(), 10)
          if (pickNum === 0 || isNaN(pickNum) || pickNum < 0 || pickNum > suggestions.length) {
            const custom: string = yield* Prompt.text({
              message: "Enter character name",
            })
            name = custom.trim().toLowerCase()
          } else {
            name = suggestions[pickNum - 1]
          }
        } else {
          yield* logToConsole("setup", "cli", "Name generation failed, enter manually.")
          const manual: string = yield* Prompt.text({
            message: "Enter character name",
          })
          name = manual.trim().toLowerCase()
        }

        if (!name) {
          yield* logToConsole("setup", "cli", "No name provided, skipping.")
          break
        }

        const charDir = path.resolve(projectRoot, "players", name, "me")

        yield* logToConsole("setup", "cli", `\nScaffolding ${name}...`)

        // Scaffold generic identity files
        const { results: _scaffoldResults, summary } = yield* scaffoldCharacter({
          projectRoot,
          characterName: name,
          identityTemplate: domainConfig.identityTemplate,
          characterDescription: charDescription.trim(),
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
      yield* logToConsole("setup", "cli", "No characters were added. Run 'signal setup' again when ready.")
      return
    }

    const startNow: boolean = yield* Prompt.confirm({
      message: "Validate configuration and start now?",
      initial: true,
    })

    if (startNow) {
      const resolved = resolveConfigs(projectRoot, [], [])
      yield* validateAndStart(projectRoot, resolved, 30, false)
    } else {
      yield* logToConsole("setup", "cli", "Setup complete. Run 'signal' or 'signal start' to begin.")
    }
  })
