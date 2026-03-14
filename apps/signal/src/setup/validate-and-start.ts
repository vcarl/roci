import { Effect } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import type { ResolvedDomain } from "../domains/registry.js"
import type { ProcedureMessage } from "@signal/core/core/domain-bundle.js"
import { CharacterFs, makeCharacterConfig } from "@signal/core/services/CharacterFs.js"
import { runOrchestrator } from "../orchestrator.js"
import { logToConsole } from "@signal/core/logging/console-renderer.js"

/** Log a ProcedureMessage to console with appropriate prefix. */
export const logProcMsg = (msg: ProcedureMessage) => {
  const prefix = msg.level === "ok" ? "OK" : msg.level === "warning" ? "WARNING" : "ERROR"
  return logToConsole("roci", "cli", `${prefix}: ${msg.text}`)
}

/**
 * Validate all resolved domains/characters and start execution if valid.
 * Extracted so both `runAutoDetect` and `runGuidedSetup` can share this logic.
 */
export const validateAndStart = (
  projectRoot: string,
  resolved: ResolvedDomain[],
  tickInterval: number,
  manualApproval: boolean,
  nonstop = false,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    let allGood = true

    for (const rd of resolved) {
      yield* logToConsole("roci", "cli", `Validating ${rd.name} domain...`)
      const domainConfig = rd.config

      // Run domain's project-level init if present
      if (domainConfig.initProject) {
        const msgs = yield* domainConfig.initProject(projectRoot)
        for (const msg of msgs) yield* logProcMsg(msg)
      }

      // Validate each character
      for (const charName of rd.characters) {
        const charDir = path.resolve(projectRoot, "players", charName, "me")
        const charDirExists = yield* fs.exists(charDir)
        if (!charDirExists) {
          yield* logToConsole("roci", "cli", `MISSING: ${charDir} — create this directory with character files`)
          allGood = false
          continue
        }

        // Common files check
        for (const file of ["background.md", "VALUES.md", "DIARY.md"]) {
          const filePath = path.resolve(charDir, file)
          const fileExists = yield* fs.exists(filePath)
          if (!fileExists) {
            yield* logToConsole("roci", "cli", `MISSING: ${charName}/${file}`)
            allGood = false
          }
        }

        // Domain-specific init procedure
        if (domainConfig.initProcedure) {
          const msgs = yield* domainConfig.initProcedure.run({
            projectRoot,
            characterName: charName,
            characterDir: charDir,
          })
          for (const msg of msgs) {
            if (msg.level === "error") allGood = false
            yield* logProcMsg(msg)
          }
        }
      }
    }

    if (!allGood) {
      yield* logToConsole("roci", "cli", "")
      yield* logToConsole("roci", "cli", "Fix the issues above before starting.")
      return
    }

    // Validation passed — start execution
    yield* logToConsole("roci", "cli", "Validation passed. Starting execution...")

    // Validate all character directories exist
    const charFs = yield* CharacterFs
    for (const rd of resolved) {
      for (const name of rd.characters) {
        const char = makeCharacterConfig(projectRoot, name)
        const exists = yield* charFs.characterExists(char)
        if (!exists) {
          yield* Effect.logError(`Character directory not found: ${char.dir}`)
          return
        }
      }
    }

    yield* runOrchestrator(resolved, tickInterval, manualApproval, nonstop)
  })
