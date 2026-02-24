import { Effect, Fiber } from "effect"
import { characterLoop, type CharacterLoopConfig } from "./character-loop.js"
import { logToConsole } from "../logging/console-renderer.js"

/**
 * Multi-character orchestrator. Spawns a Fiber per character,
 * manages their lifecycles, and waits for all to complete (or be interrupted).
 */
export const runOrchestrator = (configs: CharacterLoopConfig[]) =>
  Effect.gen(function* () {
    yield* logToConsole("orchestrator", "main", `Starting ${configs.length} character(s)...`)

    // Fork each character loop as a fiber
    const fibers = yield* Effect.forEach(configs, (config) =>
      characterLoop(config).pipe(
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
