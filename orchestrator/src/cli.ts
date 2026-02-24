import { Args, Command, Options } from "@effect/cli"
import { Effect, Layer } from "effect"
import { NodeContext } from "@effect/platform-node"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import { Docker, DockerLive } from "./services/Docker.js"
import { CharacterFs, CharacterFsLive, makeCharacterConfig } from "./services/CharacterFs.js"
import { makePromptTemplatesLive } from "./services/PromptTemplates.js"
import { makeGameApiLive } from "./services/GameApi.js"
import { Claude, ClaudeLive } from "./services/Claude.js"
import { makeCharacterLogLive } from "./logging/log-writer.js"
import { runOrchestrator } from "./pipeline/orchestrator.js"
import { logToConsole } from "./logging/console-renderer.js"

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..")
const IMAGE_NAME = "spacemolt-player"

// Shared options
const tickInterval = Options.integer("tick-interval").pipe(
  Options.withDefault(30),
  Options.withDescription("Seconds between monitor ticks"),
)

// --- start command ---
const startCharacters = Args.text({ name: "characters" }).pipe(Args.repeated)

const startCommand = Command.make("start", { characters: startCharacters, tickInterval }, (args) =>
  Effect.gen(function* () {
    const characters = args.characters
    if (characters.length === 0) {
      yield* Effect.logError("No characters specified. Usage: roci start <character> [character...]")
      return
    }

    // Validate all characters exist
    const charFs = yield* CharacterFs
    const configs = []
    for (const name of characters) {
      const char = makeCharacterConfig(PROJECT_ROOT, name)
      const exists = yield* charFs.characterExists(char)
      if (!exists) {
        yield* Effect.logError(`Character directory not found: ${char.dir}`)
        return
      }
      configs.push({
        char,
        projectRoot: PROJECT_ROOT,
        tickIntervalSeconds: args.tickInterval,
        imageName: IMAGE_NAME,
      })
    }

    // Build docker image
    const docker = yield* Docker
    yield* logToConsole("orchestrator", "main", "Building Docker image...")
    yield* docker.build(
      IMAGE_NAME,
      path.resolve(PROJECT_ROOT, ".devcontainer/Dockerfile"),
      path.resolve(PROJECT_ROOT, ".devcontainer"),
    )

    // Run orchestrator
    yield* runOrchestrator(configs)
  }),
).pipe(Command.withDescription("Start character(s) running"))

// --- stop command ---
const stopCharacter = Args.text({ name: "character" })

const stopCommand = Command.make("stop", { character: stopCharacter }, (args) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    const containerName = `roci-${args.character}`
    yield* docker.stop(containerName)
    yield* logToConsole(args.character, "cli", "Stopped")
  }),
).pipe(Command.withDescription("Stop a character's container"))

// --- pause command ---
const pauseCharacter = Args.text({ name: "character" })

const pauseCommand = Command.make("pause", { character: pauseCharacter }, (args) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    yield* docker.pause(`roci-${args.character}`)
    yield* logToConsole(args.character, "cli", "Paused")
  }),
).pipe(Command.withDescription("Pause a character's container"))

// --- resume command ---
const resumeCharacter = Args.text({ name: "character" })

const resumeCommand = Command.make("resume", { character: resumeCharacter }, (args) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    yield* docker.resume(`roci-${args.character}`)
    yield* logToConsole(args.character, "cli", "Resumed")
  }),
).pipe(Command.withDescription("Resume a paused character's container"))

// --- status command ---
const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const docker = yield* Docker
    const containers = yield* docker.listByLabel("roci-crew")

    if (containers.length === 0) {
      yield* Effect.log("No roci-crew containers found.")
      return
    }

    yield* Effect.log("Character containers:")
    for (const c of containers) {
      const name = c.name.replace(/^roci-/, "")
      yield* Effect.log(`  ${name}: ${c.status} (${c.id.slice(0, 12)})`)
    }
  }),
).pipe(Command.withDescription("Show status of all character containers"))

// --- auth command ---
const authCharacter = Args.text({ name: "character" })

const authCommand = Command.make("auth", { character: authCharacter }, (args) =>
  Effect.gen(function* () {
    const containerName = `roci-${args.character}`
    yield* logToConsole(args.character, "cli", "Starting interactive auth...")
    yield* Effect.log(`Run: docker exec -it ${containerName} sh -c 'claude && touch /tmp/auth-ready'`)
  }),
).pipe(Command.withDescription("Authenticate Claude in a character's container"))

// --- destroy command ---
const destroyCharacter = Args.text({ name: "character" })

const destroyCommand = Command.make("destroy", { character: destroyCharacter }, (args) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    const containerName = `roci-${args.character}`
    yield* docker.remove(containerName)
    yield* logToConsole(args.character, "cli", "Destroyed")
  }),
).pipe(Command.withDescription("Remove a character's container entirely"))

// --- logs command ---
const logsCharacter = Args.text({ name: "character" })

const logsCommand = Command.make("logs", { character: logsCharacter }, (args) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const thoughtsPath = path.resolve(
      PROJECT_ROOT,
      "players",
      args.character,
      "logs",
      "thoughts.jsonl",
    )
    const content = yield* fs.readFileString(thoughtsPath).pipe(
      Effect.catchAll(() => Effect.succeed("(no thoughts log found)")),
    )
    // Show last 50 entries
    const lines = content.split("\n").filter(Boolean).slice(-50)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        const ts = (entry.timestamp as string)?.slice(11, 19) ?? ""
        const source = entry.source ?? "?"
        const text = entry.text ?? entry.type ?? JSON.stringify(entry)
        console.log(`[${ts}] [${source}] ${typeof text === "string" ? text.slice(0, 200) : JSON.stringify(text)}`)
      } catch {
        console.log(line)
      }
    }
  }),
).pipe(Command.withDescription("Show recent thoughts for a character"))

// --- root command ---
const rociCommand = Command.make("roci").pipe(
  Command.withSubcommands([
    startCommand,
    stopCommand,
    pauseCommand,
    resumeCommand,
    statusCommand,
    authCommand,
    destroyCommand,
    logsCommand,
  ]),
  Command.withDescription("Rocinante crew orchestrator"),
)

// --- provide services ---
const serviceLayer = Layer.mergeAll(
  DockerLive,
  ClaudeLive,
  CharacterFsLive,
  makePromptTemplatesLive(PROJECT_ROOT),
  makeGameApiLive(),
  makeCharacterLogLive(PROJECT_ROOT),
)

export { rociCommand, serviceLayer }
