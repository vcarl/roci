import { Args, Command, Options } from "@effect/cli"
import { Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import WebSocket from "ws"
import { Docker, DockerLive } from "./services/Docker.js"
import { CharacterFs, CharacterFsLive, makeCharacterConfig } from "./services/CharacterFs.js"
import { ClaudeLive } from "./services/Claude.js"
import { CharacterLogLive } from "./logging/log-writer.js"
import { ProjectRoot } from "./services/ProjectRoot.js"
import { runOrchestrator } from "./orchestrator.js"
import { logToConsole } from "./logging/console-renderer.js"
import { DOMAIN_REGISTRY, loadProjectConfig, resolveConfigs } from "./domains/registry.js"
import type { ProcedureMessage } from "./core/domain-bundle.js"

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

const manualApproval = Options.boolean("manual-approval").pipe(
  Options.withDefault(false),
  Options.withDescription("Pause for manual approval before each plan/subagent step (rings terminal bell)"),
)

// --- start command ---
const startCharacters = Args.text({ name: "characters" }).pipe(Args.repeated)

const startCommand = Command.make("start", { characters: startCharacters, tickInterval, domain: domainOption, manualApproval }, (args) =>
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

    yield* runOrchestrator(resolved, args.tickInterval, args.manualApproval)
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

// --- init command ---
const initDomain = Options.text("domain").pipe(
  Options.withDescription("Domain to initialize (e.g. github, spacemolt)"),
)

/** Log a ProcedureMessage to console with appropriate prefix. */
const logProcMsg = (msg: ProcedureMessage) => {
  const prefix = msg.level === "ok" ? "OK" : msg.level === "warning" ? "WARNING" : "ERROR"
  return logToConsole("init", "cli", `${prefix}: ${msg.text}`)
}

const initCommand = Command.make("init", { domain: initDomain }, (args) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const domainName = args.domain

    // 1. Look up domain in registry
    const factory = DOMAIN_REGISTRY[domainName]
    if (!factory) {
      yield* logToConsole("init", "cli", `Unknown domain: ${domainName}. Known domains: ${Object.keys(DOMAIN_REGISTRY).join(", ")}`)
      return
    }
    const domainConfig = factory(PROJECT_ROOT)

    // 2. Docker check (generic — all domains use containers)
    try {
      const dockerVersion = execSync("docker --version", { encoding: "utf-8" }).trim()
      yield* logToConsole("init", "cli", `Docker available: ${dockerVersion}`)
    } catch {
      yield* logToConsole("init", "cli", `WARNING: Docker not available — needed for 'start' command`)
    }

    // 3. Ensure config.json has an entry for this domain
    const configPath = path.resolve(PROJECT_ROOT, "config.json")
    const configExists = yield* fs.exists(configPath)
    if (!configExists) {
      yield* logToConsole("init", "cli", `No config.json found — creating with empty ${domainName} domain`)
      yield* fs.writeFileString(configPath, JSON.stringify({ [domainName]: { characters: [] } }, null, 2) + "\n")
    } else {
      const raw = yield* fs.readFileString(configPath)
      const config = JSON.parse(raw)
      if (!config[domainName]) {
        yield* logToConsole("init", "cli", `Adding ${domainName} domain to config.json`)
        config[domainName] = { characters: [] }
        yield* fs.writeFileString(configPath, JSON.stringify(config, null, 2) + "\n")
      } else {
        yield* logToConsole("init", "cli", `config.json already has ${domainName} domain`)
      }
    }

    // 4. Run domain's project-level init if present
    if (domainConfig.initProject) {
      const msgs = yield* domainConfig.initProject(PROJECT_ROOT)
      for (const msg of msgs) yield* logProcMsg(msg)
    }

    // 5. Read character list
    const projectConfig = loadProjectConfig(PROJECT_ROOT)
    const characters: string[] = projectConfig[domainName]?.characters ?? []

    if (characters.length === 0) {
      yield* logToConsole("init", "cli", `No characters configured in config.json ${domainName} domain.`)
      yield* logToConsole("init", "cli", `Add characters to config.json, create player directories, then run init again.`)
      yield* logToConsole("init", "cli", ``)
      const guide = domainConfig.characterSetupGuide ?? [
        `Each character needs:`,
        `  players/<name>/me/background.md — personality and identity`,
        `  players/<name>/me/VALUES.md     — working values`,
        `  players/<name>/me/DIARY.md      — empty diary template`,
      ]
      for (const line of guide) yield* logToConsole("init", "cli", line)
      return
    }

    // 6. Validate each character
    let allGood = true
    for (const charName of characters) {
      const charDir = path.resolve(PROJECT_ROOT, "players", charName, "me")
      const charDirExists = yield* fs.exists(charDir)
      if (!charDirExists) {
        yield* logToConsole("init", "cli", `MISSING: ${charDir} — create this directory with character files`)
        allGood = false
        continue
      }

      // Common files check (orchestrator concern)
      for (const file of ["background.md", "VALUES.md", "DIARY.md"]) {
        const filePath = path.resolve(charDir, file)
        const fileExists = yield* fs.exists(filePath)
        if (!fileExists) {
          yield* logToConsole("init", "cli", `MISSING: ${charName}/${file}`)
          allGood = false
        }
      }

      // Domain-specific init procedure
      if (domainConfig.initProcedure) {
        const msgs = yield* domainConfig.initProcedure.run({
          projectRoot: PROJECT_ROOT,
          characterName: charName,
          characterDir: charDir,
        })
        for (const msg of msgs) {
          if (msg.level !== "ok") allGood = false
          yield* logProcMsg(msg)
        }
      }
    }

    // 7. Report overall status
    if (allGood) {
      yield* logToConsole("init", "cli", ``)
      yield* logToConsole("init", "cli", `${domainName} domain is ready. Run: npx tsx src/main.ts start --domain ${domainName}`)
    } else {
      yield* logToConsole("init", "cli", ``)
      yield* logToConsole("init", "cli", `Fix the issues above before starting.`)
    }
  }),
).pipe(Command.withDescription("Initialize a domain — validate config, create directories"))

// --- setup command ---
const setupCharacters = Args.text({ name: "characters" }).pipe(Args.repeated)
const setupDomain = Options.text("domain").pipe(
  Options.withDescription("Domain to set up characters for (e.g. github, spacemolt)"),
)

const setupCommand = Command.make("setup", { characters: setupCharacters, domain: setupDomain }, (args) =>
  Effect.gen(function* () {
    const characters = [...args.characters]
    const domainName = args.domain

    if (characters.length === 0) {
      yield* logToConsole("setup", "cli", "No characters specified. Usage: roci setup <character> [character...] --domain <domain>")
      return
    }

    // 1. Look up domain
    const factory = DOMAIN_REGISTRY[domainName]
    if (!factory) {
      yield* logToConsole("setup", "cli", `Unknown domain: ${domainName}. Known domains: ${Object.keys(DOMAIN_REGISTRY).join(", ")}`)
      return
    }
    const domainConfig = factory(PROJECT_ROOT)

    // 2. Run project-level init once
    if (domainConfig.initProject) {
      const msgs = yield* domainConfig.initProject(PROJECT_ROOT)
      for (const msg of msgs) yield* logProcMsg(msg)
    }

    // 3. Process each character
    const configPath = path.resolve(PROJECT_ROOT, "config.json")
    const addedCharacters: string[] = []

    for (const charName of characters) {
      yield* logToConsole("setup", "cli", `\n--- Setting up ${charName} ---`)
      const charDir = path.resolve(PROJECT_ROOT, "players", charName, "me")

      // Create character dir if missing
      if (!existsSync(charDir)) {
        mkdirSync(charDir, { recursive: true })
        yield* logToConsole("setup", "cli", `Created ${charDir}`)
      }

      // Check required files
      const bgPath = path.resolve(charDir, "background.md")
      const valuesPath = path.resolve(charDir, "VALUES.md")
      if (!existsSync(bgPath) || !existsSync(valuesPath)) {
        yield* logToConsole("setup", "cli", `ERROR: ${charName} is missing background.md or VALUES.md — skipping`)
        yield* logToConsole("setup", "cli", `  Create these files first, then re-run setup.`)
        continue
      }

      // Create empty supporting files if missing
      for (const file of ["DIARY.md", "SECRETS.md"]) {
        const filePath = path.resolve(charDir, file)
        if (!existsSync(filePath)) {
          writeFileSync(filePath, "")
          yield* logToConsole("setup", "cli", `Created empty ${file}`)
        }
      }

      // Domain-specific setup
      if (domainConfig.setupCharacter) {
        const msgs = yield* domainConfig.setupCharacter.run({
          projectRoot: PROJECT_ROOT,
          characterName: charName,
          characterDir: charDir,
        })
        for (const msg of msgs) yield* logProcMsg(msg)
        // Check if any errors occurred
        if (msgs.some(m => m.level === "error")) {
          yield* logToConsole("setup", "cli", `Skipping config.json registration for ${charName} due to errors`)
          continue
        }
      }

      addedCharacters.push(charName)
    }

    // 4. Update config.json
    if (addedCharacters.length > 0) {
      let config: Record<string, { characters: string[] }> = {}
      if (existsSync(configPath)) {
        try {
          config = JSON.parse(readFileSync(configPath, "utf-8"))
        } catch {
          // Start fresh if invalid
        }
      }
      if (!config[domainName]) {
        config[domainName] = { characters: [] }
      }
      for (const name of addedCharacters) {
        if (!config[domainName].characters.includes(name)) {
          config[domainName].characters.push(name)
        }
      }
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
      yield* logToConsole("setup", "cli", `\nUpdated config.json — ${domainName} characters: ${config[domainName].characters.join(", ")}`)
    }

    yield* logToConsole("setup", "cli", `\nSetup complete. Run: npx tsx src/main.ts init --domain ${domainName} to validate.`)
  }),
).pipe(Command.withDescription("Set up character(s) for a domain — create files and config"))

// --- root command ---
const rociCommand = Command.make("roci").pipe(
  Command.withSubcommands([
    setupCommand,
    initCommand,
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
  projectRootLayer,
  CharacterLogLive.pipe(Layer.provide(projectRootLayer)),
)

export { rociCommand, serviceLayer }
