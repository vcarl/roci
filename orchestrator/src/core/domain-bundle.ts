import type { Layer } from "effect"
import type { EventProcessorTag } from "./event-source.js"
import type { SituationClassifierTag } from "./situation.js"
import type { StateRendererTag } from "./state-renderer.js"
import type { InterruptRegistryTag } from "./interrupt.js"
import type { ContextHandlerTag } from "./context-handler.js"
import type { PromptBuilderTag } from "./prompt-builder.js"
import type { SkillRegistryTag } from "./skill.js"
import type { PhaseRegistry } from "./phase.js"

/** Complete set of domain service layers for the core state machine. */
export type DomainBundle = Layer.Layer<
  EventProcessorTag | SituationClassifierTag | StateRendererTag |
  InterruptRegistryTag | ContextHandlerTag | PromptBuilderTag | SkillRegistryTag,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>

/** Mount specification for container volumes. */
export interface ContainerMount {
  readonly host: string
  readonly container: string
  readonly readonly?: boolean
}

/**
 * Complete configuration for a domain — everything needed to run
 * the orchestrator against a specific game/environment.
 */
export interface DomainConfig {
  /** Domain service layers for the state machine. */
  readonly bundle: DomainBundle
  /** Phase registry defining the session lifecycle. */
  readonly phaseRegistry: PhaseRegistry
  /** Container volume mounts for the domain. */
  readonly containerMounts: ContainerMount[]
  /** Optional setup to run after container starts (e.g. symlinks). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly containerSetup?: (containerId: string) => any
  /** Docker image name for the domain. */
  readonly imageName: string
  /** Domain-specific Effect service layer (e.g. GameSocket for SpaceMolt, GitHubClient for GitHub). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly serviceLayer?: Layer.Layer<any, any, any>
  /** Path to Dockerfile, relative to project root. */
  readonly dockerfilePath?: string
  /** Docker build context directory, relative to project root. */
  readonly dockerContext?: string
  /** Additional domains for firewall allowlist. */
  readonly firewallExtraDomains?: string[]
  /** Container --add-dir paths for claude subagent (colon-separated in ROCI_ADD_DIRS env var). */
  readonly containerAddDirs?: string[]
}
