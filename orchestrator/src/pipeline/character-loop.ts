import { Effect } from "effect"
import { GameApi } from "../services/GameApi.js"
import { CharacterFs, type CharacterConfig } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import { tickLoop } from "../monitor/tick-loop.js"
import { dream } from "../ai/dream.js"
import { logToConsole } from "../logging/console-renderer.js"

export interface CharacterLoopConfig {
  char: CharacterConfig
  projectRoot: string
  tickIntervalSeconds: number
  imageName: string
  /** Shared container ID — set by orchestrator before forking character fibers */
  containerId?: string
  /** Env vars passed at docker exec time (e.g. CLAUDE_CODE_OAUTH_TOKEN) */
  containerEnv?: Record<string, string>
}

/**
 * Full lifecycle for a single character (shared container is already running):
 * 1. Login to game API
 * 2. Optionally dream (compress diary)
 * 3. Run the monitor tick loop (brain + subagents)
 */
export const characterLoop = (config: CharacterLoopConfig & { containerId: string }) =>
  Effect.gen(function* () {
    const gameApi = yield* GameApi
    const charFs = yield* CharacterFs
    const log = yield* CharacterLog

    const { containerId } = config

    yield* logToConsole(config.char.name, "orchestrator", "Starting character loop...")

    // 1. Login to game API
    const creds = yield* charFs.readCredentials(config.char)
    yield* gameApi.login(creds)
    yield* logToConsole(config.char.name, "orchestrator", "Logged in to game API")

    // 2. Dream (compress diary if needed)
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

    // 3. Run the monitor tick loop
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
      playerName: config.char.name,
      tickIntervalSeconds: config.tickIntervalSeconds,
      projectRoot: config.projectRoot,
      containerEnv: config.containerEnv,
    })
  })
