import { Effect } from "effect"
import { Docker, DockerError } from "../services/Docker.js"
import { GameApi } from "../services/GameApi.js"
import { CharacterFs, type CharacterConfig } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import { tickLoop } from "../monitor/tick-loop.js"
import { dream } from "../ai/dream.js"
import { logToConsole } from "../logging/console-renderer.js"
import * as path from "node:path"
import { execSync } from "node:child_process"

export interface CharacterLoopConfig {
  char: CharacterConfig
  projectRoot: string
  tickIntervalSeconds: number
  imageName: string
}

/**
 * Full lifecycle for a single character:
 * 1. Ensure container exists and is running
 * 2. Login to game API
 * 3. Optionally dream (compress diary)
 * 4. Run the monitor tick loop (brain + subagents)
 */
export const characterLoop = (config: CharacterLoopConfig) =>
  Effect.gen(function* () {
    const docker = yield* Docker
    const gameApi = yield* GameApi
    const charFs = yield* CharacterFs
    const log = yield* CharacterLog

    const containerName = `roci-${config.char.name}`

    yield* logToConsole(config.char.name, "orchestrator", "Starting character loop...")

    // 1. Ensure container exists
    const existing = yield* docker.status(containerName)

    let containerId: string

    if (existing && existing.status === "running") {
      containerId = existing.id
      yield* logToConsole(config.char.name, "orchestrator", `Container ${containerName} already running`)
    } else if (existing && existing.status === "paused") {
      yield* docker.resume(containerName)
      containerId = existing.id
      yield* logToConsole(config.char.name, "orchestrator", `Container ${containerName} resumed`)
    } else {
      // Remove old container if exists
      if (existing) {
        yield* docker.remove(containerName)
      }

      // Create new container
      containerId = yield* docker.create({
        name: containerName,
        image: config.imageName,
        mounts: [
          {
            host: config.char.dir,
            container: "/work/me",
          },
          {
            host: path.resolve(config.projectRoot, "shared-resources/workspace"),
            container: "/work/workspace",
          },
          {
            host: path.resolve(config.projectRoot, "docs"),
            container: "/work/docs",
          },
          {
            host: path.resolve(config.projectRoot, "in-game-CLAUDE.md"),
            container: "/work/CLAUDE.md",
            readonly: true,
          },
          {
            host: path.resolve(config.projectRoot, ".claude"),
            container: "/work/.claude",
            readonly: true,
          },
          {
            host: path.resolve(config.projectRoot, ".devcontainer"),
            container: "/opt/devcontainer",
            readonly: true,
          },
          {
            host: path.resolve(config.projectRoot, "shared-resources/sm-cli"),
            container: "/work/workspace/bin",
          },
          {
            host: path.resolve(config.projectRoot, "harness"),
            container: "/opt/harness",
            readonly: true,
          },
        ],
        env: {},
        cmd: ["bash", "-c", "bash /opt/devcontainer/init-firewall.sh; sleep infinity"],
        capAdd: ["NET_ADMIN", "NET_RAW"],
      })

      // Start the container
      yield* Effect.try({
        try: () => {
          execSync(`docker start ${containerId}`, { stdio: "pipe" })
        },
        catch: (e) => new DockerError("Failed to start container", e),
      })

      yield* logToConsole(config.char.name, "orchestrator", `Container ${containerName} created and started`)
    }

    // 2. Login to game API
    const creds = yield* charFs.readCredentials(config.char)
    yield* gameApi.login(creds)
    yield* logToConsole(config.char.name, "orchestrator", "Logged in to game API")

    // 3. Dream (compress diary if needed)
    const diary = yield* charFs.readDiary(config.char)
    const diaryLines = diary.split("\n").length
    if (diaryLines > 200) {
      yield* logToConsole(config.char.name, "orchestrator", `Diary is ${diaryLines} lines — dreaming...`)
      yield* dream.execute({ char: config.char }).pipe(
        Effect.catchAll((e) =>
          logToConsole(config.char.name, "orchestrator", `Dream failed: ${e}`),
        ),
      )
    }

    // 4. Run the monitor tick loop
    yield* logToConsole(config.char.name, "orchestrator", "Starting monitor tick loop...")

    yield* log.action(config.char, {
      timestamp: new Date().toISOString(),
      source: "orchestrator",
      character: config.char.name,
      type: "loop_start",
      containerId,
    })

    yield* tickLoop({
      char: config.char,
      containerId,
      tickIntervalSeconds: config.tickIntervalSeconds,
      projectRoot: config.projectRoot,
    })
  })
