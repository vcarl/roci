import { Effect } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { PhaseRegistry } from "../core/phase.js"
import type { DomainBundle } from "../core/domain-bundle.js"
import { runPhases } from "../core/phase-runner.js"
import { logToConsole } from "../logging/console-renderer.js"

export interface CharacterLoopConfig {
  char: CharacterConfig
  tickIntervalSeconds: number
  imageName: string
  /** Shared container ID — set by orchestrator before forking character fibers */
  containerId?: string
  /** Env vars passed at docker exec time (e.g. CLAUDE_CODE_OAUTH_TOKEN) */
  containerEnv?: Record<string, string>
  /** Phase registry defining the session lifecycle. */
  phaseRegistry: PhaseRegistry
  /** Domain service layers for the state machine. Optional for hypervisor-based domains. */
  domainBundle?: DomainBundle
  /** Pause for manual approval before plan/subagent steps. */
  manualApproval?: boolean
}

/**
 * Full lifecycle for a single character (shared container is already running).
 * Delegates to the phase runner which manages connect, dream, event loop,
 * social, and reflection phases.
 */
export const characterLoop = (config: CharacterLoopConfig & { containerId: string }) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* logToConsole(config.char.name, "orchestrator", "Starting character loop...")

      yield* runPhases(
        {
          char: config.char,
          containerId: config.containerId,
          containerEnv: config.containerEnv,
          domainBundle: config.domainBundle,
          phaseData: config.manualApproval ? { manualApproval: true } : undefined,
        },
        config.phaseRegistry,
      )
    }),
  )
