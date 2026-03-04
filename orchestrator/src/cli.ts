import { Args, Command, Options } from "@effect/cli"
import { Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import WebSocket from "ws"
import { Docker, DockerLive } from "./services/Docker.js"
import { CharacterFs, CharacterFsLive, makeCharacterConfig } from "./services/CharacterFs.js"
import { PromptTemplatesLive } from "./services/PromptTemplates.js"
import { ClaudeLive } from "./services/Claude.js"
import { CharacterLogLive } from "./logging/log-writer.js"
import { ProjectRoot } from "./services/ProjectRoot.js"
import { runOrchestrator } from "./pipeline/orchestrator.js"
import { logToConsole } from "./logging/console-renderer.js"
import { resolveConfigs } from "./domains/registry.js"

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..")

// Shared options
const tickInterval = Options.integer("tick-interval").pipe(
  Options.withDefault(30),
  Options.withDescription("Seconds between monitor ticks"),
)

const domainOption = Options.text("domain").pipe(
  Options.repeated,
  Options.withDescription("Domain(s) to run (e.g. spacemolt, github). If omitted, runs all from config.json."),
)

// --- start command ---
const startCharacters = Args.text({ name: "characters" }).pipe(Args.repeated)

const startCommand = Command.make("start", { characters: startCharacters, tickInterval, domain: domainOption }, (args) =>
  Effect.gen(function* () {
    const domains = [...args.domain]
    const characters = [...args.characters]

    const resolved = resolveConfigs(PROJECT_ROOT, domains, characters)

    if (resolved.length === 0) {
      yield* Effect.logError("No domains/characters matched. Check config.json and --domain / character args.")
      return
    }

    // Validate all characters exist
    const charFs = yield* CharacterFs
    for (const rd of resolved) {
      for (const name of rd.characters) {
        const char = makeCharacterConfig(PROJECT_ROOT, name)
        const exists = yield* charFs.characterExists(char)
        if (!exists) {
          yield* Effect.logError(`Character directory not found: ${char.dir}`)
          return
        }
      }
    }

    yield* runOrchestrator(resolved, args.tickInterval)
  }),
).pipe(Command.withDescription("Start character(s) running"))

// --- stop command ---
const stopDomain = Options.text("domain").pipe(
  Options.optional,
  Options.withDescription("Stop only this domain's container"),
)

const stopCommand = Command.make("stop", { domain: stopDomain }, (args) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    if (args.domain._tag === "Some") {
      yield* docker.stop(`roci-${args.domain.value}`)
      yield* logToConsole("orchestrator", "cli", `Container roci-${args.domain.value} stopped`)
    } else {
      const containers = yield* docker.listByLabel("roci-crew")
      if (containers.length === 0) {
        yield* logToConsole("orchestrator", "cli", "No roci containers found")
        return
      }
      for (const c of containers) {
        yield* docker.stop(c.name || c.id)
        yield* logToConsole("orchestrator", "cli", `Container ${c.name} stopped`)
      }
    }
  }),
).pipe(Command.withDescription("Stop roci container(s)"))

// --- pause command ---
const pauseDomain = Options.text("domain").pipe(
  Options.optional,
  Options.withDescription("Pause only this domain's container"),
)

const pauseCommand = Command.make("pause", { domain: pauseDomain }, (args) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    if (args.domain._tag === "Some") {
      yield* docker.pause(`roci-${args.domain.value}`)
      yield* logToConsole("orchestrator", "cli", `Container roci-${args.domain.value} paused`)
    } else {
      const containers = yield* docker.listByLabel("roci-crew")
      for (const c of containers) {
        if (c.status === "running") {
          yield* docker.pause(c.name || c.id)
          yield* logToConsole("orchestrator", "cli", `Container ${c.name} paused`)
        }
      }
    }
  }),
).pipe(Command.withDescription("Pause roci container(s)"))

// --- resume command ---
const resumeDomain = Options.text("domain").pipe(
  Options.optional,
  Options.withDescription("Resume only this domain's container"),
)

const resumeCommand = Command.make("resume", { domain: resumeDomain }, (args) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    if (args.domain._tag === "Some") {
      yield* docker.resume(`roci-${args.domain.value}`)
      yield* logToConsole("orchestrator", "cli", `Container roci-${args.domain.value} resumed`)
    } else {
      const containers = yield* docker.listByLabel("roci-crew")
      for (const c of containers) {
        if (c.status === "paused") {
          yield* docker.resume(c.name || c.id)
          yield* logToConsole("orchestrator", "cli", `Container ${c.name} resumed`)
        }
      }
    }
  }),
).pipe(Command.withDescription("Resume roci container(s)"))

// --- status command ---
const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const docker = yield* Docker
    const containers = yield* docker.listByLabel("roci-crew")

    if (containers.length === 0) {
      yield* Effect.log("No roci containers found.")
      return
    }

    for (const c of containers) {
      yield* Effect.log(`${c.name}: ${c.status} (${c.id.slice(0, 12)})`)
    }
  }),
).pipe(Command.withDescription("Show status of roci container(s)"))

// --- auth command ---
const authCommand = Command.make("auth", {}, () =>
  Effect.gen(function* () {
    yield* logToConsole("orchestrator", "cli", "Starting interactive auth...")
    const docker = yield* Docker
    const containers = yield* docker.listByLabel("roci-crew")
    if (containers.length === 0) {
      yield* Effect.log("No roci containers found. Start a domain first.")
      return
    }
    for (const c of containers) {
      yield* Effect.log(`Run: docker exec -it ${c.name} sh -c 'claude && touch /tmp/auth-ready'`)
    }
  }),
).pipe(Command.withDescription("Authenticate Claude in roci containers"))

// --- destroy command ---
const destroyDomain = Options.text("domain").pipe(
  Options.optional,
  Options.withDescription("Destroy only this domain's container"),
)

const destroyCommand = Command.make("destroy", { domain: destroyDomain }, (args) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    if (args.domain._tag === "Some") {
      yield* docker.remove(`roci-${args.domain.value}`)
      yield* logToConsole("orchestrator", "cli", `Container roci-${args.domain.value} destroyed`)
    } else {
      const containers = yield* docker.listByLabel("roci-crew")
      if (containers.length === 0) {
        yield* logToConsole("orchestrator", "cli", "No roci containers found")
        return
      }
      for (const c of containers) {
        yield* docker.remove(c.name || c.id)
        yield* logToConsole("orchestrator", "cli", `Container ${c.name} destroyed`)
      }
    }
  }),
).pipe(Command.withDescription("Remove roci container(s)"))

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

// --- ws-test command ---
const wsTestCharacter = Args.text({ name: "character" })

const wsTestCommand = Command.make("ws-test", { character: wsTestCharacter }, (args) =>
  Effect.gen(function* () {
    const charFs = yield* CharacterFs
    const char = makeCharacterConfig(PROJECT_ROOT, args.character)
    const creds = yield* charFs.readCredentials(char)

    const WS_URL = "wss://game.spacemolt.com/ws"
    console.log(`[ws-test] Connecting to ${WS_URL} as ${creds.username}...`)

    yield* Effect.async<void, never>((resume) => {
      const sock = new WebSocket(WS_URL)
      let msgCount = 0

      sock.on("open", () => {
        console.log(`[ws-test] Connected`)
      })

      sock.on("message", (data) => {
        const raw = data.toString()
        const chunks = raw.split("\n").filter((s) => s.trim().length > 0)
        for (const chunk of chunks) {
        msgCount++
        try {
          const parsed = JSON.parse(chunk)
          const type = parsed.type ?? "unknown"
          const payloadKeys = parsed.payload ? Object.keys(parsed.payload).join(", ") : "(no payload)"
          console.log(`[ws-test] #${msgCount} ${type} — keys: ${payloadKeys}`)

          if (type === "welcome") {
            console.log(`[ws-test] Got welcome, sending login...`)
            sock.send(JSON.stringify({
              type: "login",
              payload: { username: creds.username, password: creds.password },
            }))
          }

          if (type === "logged_in") {
            console.log(`[ws-test] Logged in! Sending get_status every 10s...`)
            const poll = setInterval(() => {
              console.log(`[ws-test] Sending get_status`)
              sock.send(JSON.stringify({ type: "get_status" }))
            }, 10000)
            // Send one immediately
            sock.send(JSON.stringify({ type: "get_status" }))
            sock.on("close", () => clearInterval(poll))
          }
        } catch {
          console.log(`[ws-test] #${msgCount} (parse error) ${chunk.slice(0, 200)}`)
        }
        }
      })

      sock.on("close", (code, reason) => {
        console.log(`[ws-test] Closed: code=${code} reason=${reason.toString()}`)
        resume(Effect.void)
      })

      sock.on("error", (err) => {
        console.error(`[ws-test] Error: ${err.message}`)
      })

      sock.on("ping", () => {
        console.log(`[ws-test] Received ping`)
      })

      // Keep alive for 60 seconds then close
      setTimeout(() => {
        console.log(`[ws-test] 60s elapsed, ${msgCount} messages received total. Closing.`)
        sock.close()
        resume(Effect.void)
      }, 60000)
    })
  }),
).pipe(Command.withDescription("Bare WebSocket connectivity test — no Effect queue, just raw ws"))

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
    wsTestCommand,
  ]),
  Command.withDescription("Rocinante crew orchestrator"),
)

// --- provide services ---
const projectRootLayer = Layer.succeed(ProjectRoot, PROJECT_ROOT)

const serviceLayer = Layer.mergeAll(
  DockerLive,
  ClaudeLive,
  CharacterFsLive,
  PromptTemplatesLive,
  projectRootLayer,
  CharacterLogLive.pipe(Layer.provide(projectRootLayer)),
)

export { rociCommand, serviceLayer }
