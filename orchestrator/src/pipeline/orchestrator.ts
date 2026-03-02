import { Effect, Fiber } from "effect"
import { Docker, DockerError } from "../services/Docker.js"
import { characterLoop, type CharacterLoopConfig } from "./character-loop.js"
import { logToConsole } from "../logging/console-renderer.js"
import { ProjectRoot } from "../services/ProjectRoot.js"
import * as path from "node:path"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

const SHARED_CONTAINER_NAME = "roci-crew"

/** Read a key=value .env file, returning a Record. */
function loadDotenv(projectRoot: string): Record<string, string> {
  try {
    const content = readFileSync(path.resolve(projectRoot, ".env"), "utf-8")
    const env: Record<string, string> = {}
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      env[key] = val
    }
    return env
  } catch {
    return {}
  }
}

/**
 * Ensure the shared `roci-crew` container exists and is running.
 * Returns the container ID.
 */
const ensureSharedContainer = (imageName: string) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    const projectRoot = yield* ProjectRoot

    const existing = yield* docker.status(SHARED_CONTAINER_NAME)

    if (existing && existing.status === "running") {
      yield* logToConsole("orchestrator", "main", `Shared container ${SHARED_CONTAINER_NAME} already running`)
      return existing.id
    }

    if (existing && existing.status === "paused") {
      yield* docker.resume(SHARED_CONTAINER_NAME)
      yield* logToConsole("orchestrator", "main", `Shared container ${SHARED_CONTAINER_NAME} resumed`)
      return existing.id
    }

    // Remove old container if exists (exited/created)
    if (existing) {
      yield* docker.remove(SHARED_CONTAINER_NAME)
    }

    // Create the shared container with all mounts
    const containerId = yield* docker.create({
      name: SHARED_CONTAINER_NAME,
      image: imageName,
      mounts: [
        {
          host: path.resolve(projectRoot, "players"),
          container: "/work/players",
        },
        {
          host: path.resolve(projectRoot, "shared-resources/workspace"),
          container: "/work/shared/workspace",
        },
        {
          host: path.resolve(projectRoot, "shared-resources/spacemolt-docs"),
          container: "/work/shared/spacemolt-docs",
        },
        {
          host: path.resolve(projectRoot, "docs"),
          container: "/work/shared/docs",
        },
        {
          host: path.resolve(projectRoot, "shared-resources/sm-cli"),
          container: "/work/sm-cli",
        },
        {
          host: path.resolve(projectRoot, ".claude"),
          container: "/work/.claude",
          readonly: true,
        },
        {
          host: path.resolve(projectRoot, ".devcontainer"),
          container: "/opt/devcontainer",
          readonly: true,
        },
        {
          host: path.resolve(projectRoot, "harness"),
          container: "/opt/harness",
          readonly: true,
        },
        {
          host: path.resolve(projectRoot, "scripts"),
          container: "/opt/scripts",
          readonly: true,
        },
      ],
      env: {},
      cmd: ["bash", "-c", "sudo /usr/local/bin/init-firewall.sh && sleep infinity"],
      capAdd: ["NET_ADMIN", "NET_RAW"],
    })

    // Start the container
    yield* Effect.try({
      try: () => {
        execSync(`docker start ${containerId}`, { stdio: "pipe" })
      },
      catch: (e) => new DockerError("Failed to start shared container", e),
    })

    // Create sm symlink (runs as root so it can write to /usr/local/bin)
    yield* Effect.try({
      try: () => {
        execSync(`docker exec -u root ${containerId} ln -sf /work/sm-cli/sm /usr/local/bin/sm`, { stdio: "pipe" })
      },
      catch: (e) => new DockerError("Failed to create sm symlink", e),
    })

    yield* logToConsole("orchestrator", "main", `Shared container ${SHARED_CONTAINER_NAME} created and started`)

    return containerId
  })

/**
 * Multi-character orchestrator. Ensures a single shared container,
 * spawns a Fiber per character, and waits for all to complete (or be interrupted).
 */
export const runOrchestrator = (configs: CharacterLoopConfig[]) =>
  Effect.gen(function* () {
    const projectRoot = yield* ProjectRoot

    yield* logToConsole("orchestrator", "main", `Starting ${configs.length} character(s)...`)

    // Load CLAUDE_CODE_OAUTH_TOKEN from .env (read fresh each start, passed at exec time)
    const dotenv = loadDotenv(projectRoot)
    const oauthToken = dotenv.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (!oauthToken) {
      yield* logToConsole("orchestrator", "main", "ERROR: CLAUDE_CODE_OAUTH_TOKEN not found in .env or environment")
      return yield* Effect.fail(
        new DockerError("CLAUDE_CODE_OAUTH_TOKEN not found in .env or environment"),
      )
    }
    const containerEnv = { CLAUDE_CODE_OAUTH_TOKEN: oauthToken }

    // Ensure the shared container is running (once for all characters)
    const containerId = yield* ensureSharedContainer(configs[0].imageName)

    // Fork each character loop as a fiber, passing the shared container ID + env
    const fibers = yield* Effect.forEach(configs, (config) =>
      characterLoop({ ...config, containerId, containerEnv }).pipe(
        Effect.catchAll((e) =>
          logToConsole(config.char.name, "orchestrator", `Fatal error: ${e}`),
        ),
        Effect.fork,
      ),
    )

    yield* logToConsole(
      "orchestrator",
      "main",
      `All ${fibers.length} character(s) running. Press Ctrl-C to stop.`,
    )

    // Wait for all fibers (they run indefinitely until interrupted)
    yield* Fiber.joinAll(fibers)
  })
