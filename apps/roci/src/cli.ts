import { Args, Command, Options } from "@effect/cli"
import { Effect, Layer, Option } from "effect"
import { FileSystem } from "@effect/platform"
import * as path from "node:path"
import { execSync } from "node:child_process"
import { createGitHubApp } from "@roci/domain-github/create-app.js"
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { Docker, DockerLive } from "@roci/core/services/Docker.js"
import { CharacterFs, CharacterFsLive, makeCharacterConfig } from "@roci/core/services/CharacterFs.js"
import { ClaudeLive } from "@roci/core/services/Claude.js"
import { CharacterLogLive } from "@roci/core/logging/log-writer.js"
import { ProjectRoot } from "@roci/core/services/ProjectRoot.js"
import { runOrchestrator } from "./orchestrator.js"
import { logToConsole } from "@roci/core/logging/console-renderer.js"
import { DOMAIN_REGISTRY, loadProjectConfig, resolveConfigs } from "./domains/registry.js"
import type { ProcedureMessage } from "@roci/core/core/domain-bundle.js"
import { scaffoldCharacter } from "@roci/core/core/character-scaffold.js"
import { runGuidedSetup } from "./setup/guided-setup.js"
import { validateAndStart } from "./setup/validate-and-start.js"
import { OAuthTokenLive } from "@roci/core/services/OAuthToken.js"

const isDev = import.meta.url.endsWith(".ts")
const PROJECT_ROOT = isDev
  ? path.resolve(import.meta.dirname, "../..")  // dev: orchestrator/src/ -> repo root
  : process.cwd()                                // published: user runs from project root

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
    const registryEntry = DOMAIN_REGISTRY[domainName]
    if (!registryEntry) {
      yield* logToConsole("init", "cli", `Unknown domain: ${domainName}. Known domains: ${Object.keys(DOMAIN_REGISTRY).join(", ")}`)
      return
    }
    const domainConfig = registryEntry.factory(PROJECT_ROOT)

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
  Options.optional,
)

const setupCommand = Command.make("setup", { characters: setupCharacters, domain: setupDomain }, (args) =>
  Effect.gen(function* () {
    const characters = [...args.characters]

    // If no --domain and no characters, run interactive guided setup
    if (Option.isNone(args.domain) && characters.length === 0) {
      yield* runGuidedSetup(PROJECT_ROOT)
      return
    }

    // If --domain was provided but no characters, show usage
    if (Option.isNone(args.domain)) {
      yield* logToConsole("setup", "cli", "No domain specified. Usage: roci setup <character> [character...] --domain <domain>")
      yield* logToConsole("setup", "cli", "Or run 'roci setup' with no arguments for guided setup.")
      return
    }

    const domainName = args.domain.value

    if (characters.length === 0) {
      yield* logToConsole("setup", "cli", "No characters specified. Usage: roci setup <character> [character...] --domain <domain>")
      return
    }

    // 1. Look up domain
    const registryEntry = DOMAIN_REGISTRY[domainName]
    if (!registryEntry) {
      yield* logToConsole("setup", "cli", `Unknown domain: ${domainName}. Known domains: ${Object.keys(DOMAIN_REGISTRY).join(", ")}`)
      return
    }
    const domainConfig = registryEntry.factory(PROJECT_ROOT)

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

      // Scaffold generic identity files (background.md, VALUES.md, DIARY.md, SECRETS.md)
      const { summary } = yield* scaffoldCharacter({
        projectRoot: PROJECT_ROOT,
        characterName: charName,
        identityTemplate: domainConfig.identityTemplate,
      })
      if (summary) {
        yield* logToConsole("setup", "cli", summary)
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

// --- create-app command ---
const createAppCharacters = Args.text({ name: "characters" }).pipe(Args.repeated)
const createAppOrg = Options.text("org").pipe(
  Options.optional,
  Options.withDescription("GitHub org to create apps under (default: personal account)"),
)

const createAppCommand = Command.make("create-app", { characters: createAppCharacters, org: createAppOrg }, (args) =>
  Effect.gen(function* () {
    const characters = [...args.characters]

    if (characters.length === 0) {
      // Fall back to all github characters from config.json
      const projectConfig = loadProjectConfig(PROJECT_ROOT)
      const ghChars: string[] = projectConfig.github?.characters ?? []
      if (ghChars.length === 0) {
        yield* logToConsole("create-app", "cli", "No characters specified and none in config.json github domain.")
        return
      }
      characters.push(...ghChars)
    }

    const org = args.org._tag === "Some" ? args.org.value : undefined

    for (const charName of characters) {
      const charDir = path.resolve(PROJECT_ROOT, "players", charName, "me")
      const appJsonPath = path.resolve(charDir, "github-app.json")

      if (existsSync(appJsonPath)) {
        yield* logToConsole("create-app", "cli", `${charName} — github-app.json already exists, skipping`)
        continue
      }

      if (!existsSync(charDir)) {
        mkdirSync(charDir, { recursive: true })
      }

      yield* logToConsole("create-app", "cli", `Creating GitHub App for ${charName}...`)
      yield* logToConsole("create-app", "cli", `Confirm the app name in your browser, then click "Create GitHub App".`)

      const creds = yield* Effect.tryPromise({
        try: () => createGitHubApp(charName, org),
        catch: (err) => new Error(`Failed to create app for ${charName}: ${err}`),
      })

      writeFileSync(appJsonPath, JSON.stringify(creds, null, 2) + "\n")
      yield* logToConsole("create-app", "cli", `${charName} — saved github-app.json (appId: ${creds.appId}, slug: ${creds.slug})`)

      // Show install link
      yield* logToConsole("create-app", "cli", `Install the app on your repos: https://github.com/apps/${creds.slug}/installations/new`)

      if (characters.indexOf(charName) < characters.length - 1) {
        yield* logToConsole("create-app", "cli", ``)
      }
    }

    yield* logToConsole("create-app", "cli", `\nDone. Install each app on the relevant repos, then run 'init --domain github' to validate.`)
  }),
).pipe(Command.withDescription("Create GitHub Apps for character identities via manifest flow"))

// --- default (no subcommand) handler ---
// Reuse the same options as `start` so `roci` and `roci start` accept the same filters.
const defaultCharacters = Args.text({ name: "characters" }).pipe(Args.repeated)

const defaultTickInterval = Options.integer("tick-interval").pipe(
  Options.withDefault(30),
  Options.withDescription("Seconds between monitor ticks"),
)

const defaultDomainOption = Options.text("domain").pipe(
  Options.repeated,
  Options.withDescription("Domain(s) to run (e.g. spacemolt, github). If omitted, runs all from config.json."),
)

const defaultManualApproval = Options.boolean("manual-approval").pipe(
  Options.withDefault(false),
  Options.withDescription("Pause for manual approval before each plan/subagent step (rings terminal bell)"),
)

/**
 * Auto-detect flow: if characters are configured, validate and start.
 * Otherwise, launch interactive guided setup.
 */
const runAutoDetect = (args: {
  characters: ReadonlyArray<string>
  tickInterval: number
  domain: ReadonlyArray<string>
  manualApproval: boolean
}) =>
  Effect.gen(function* () {
    const configPath = path.resolve(PROJECT_ROOT, "config.json")

    // 1. Check if config.json exists
    if (!existsSync(configPath)) {
      yield* runGuidedSetup(PROJECT_ROOT)
      return
    }

    // 2. Load config and resolve domains/characters
    const domains = [...args.domain]
    const characters = [...args.characters]

    let resolved: ReturnType<typeof resolveConfigs>
    try {
      resolved = resolveConfigs(PROJECT_ROOT, domains, characters)
    } catch {
      yield* runGuidedSetup(PROJECT_ROOT)
      return
    }

    // 3. Check if any characters are actually configured
    const totalCharacters = resolved.reduce((sum, rd) => sum + rd.characters.length, 0)
    if (totalCharacters === 0) {
      yield* runGuidedSetup(PROJECT_ROOT)
      return
    }

    // 4. Validate and start
    yield* validateAndStart(PROJECT_ROOT, resolved, args.tickInterval, args.manualApproval)
  })

// --- root command ---
const rociCommand = Command.make(
  "roci",
  { characters: defaultCharacters, tickInterval: defaultTickInterval, domain: defaultDomainOption, manualApproval: defaultManualApproval },
  (args) => runAutoDetect(args),
).pipe(
  Command.withSubcommands([
    setupCommand,
    initCommand,
    startCommand,
    stopCommand,
    pauseCommand,
    resumeCommand,
    statusCommand,
    destroyCommand,
    createAppCommand,
  ]),
  Command.withDescription("Rocinante crew orchestrator"),
)

// --- provide services ---
const projectRootLayer = Layer.succeed(ProjectRoot, PROJECT_ROOT)

const oauthTokenLayer = OAuthTokenLive.pipe(Layer.provide(projectRootLayer))

const serviceLayer = Layer.mergeAll(
  DockerLive,
  oauthTokenLayer,
  ClaudeLive.pipe(Layer.provide(oauthTokenLayer)),
  CharacterFsLive,
  projectRootLayer,
  CharacterLogLive.pipe(Layer.provide(projectRootLayer)),
)

export { rociCommand, serviceLayer }
