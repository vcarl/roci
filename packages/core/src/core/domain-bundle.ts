import type { Effect, Layer } from "effect";
import type { InterruptRegistryTag } from "./limbic/amygdala/interrupt.js";
import type { EventProcessorTag } from "./limbic/thalamus/event-processor.js";
import type { SituationClassifierTag } from "./limbic/thalamus/situation-classifier.js";
import type { PhaseRegistry } from "./phase.js";
import type { PromptBuilderTag } from "./prompt-builder.js";
import type { SkillRegistryTag } from "./skill.js";
import type { StateRendererTag } from "./state-renderer.js";

/** Result message from a domain procedure. */
export interface ProcedureMessage {
	readonly level: "ok" | "warning" | "error";
	readonly text: string;
}

/**
 * A domain procedure — a named unit of work the orchestrator can invoke.
 *
 * Init is the first instance of this pattern. The steady-state event loop
 * is conceptually the second. Future procedures (triage, documentation,
 * feature development) will use the same shape with richer context.
 */
export interface DomainProcedure<Ctx, Result = ProcedureMessage[], R = never> {
	readonly name: string;
	readonly run: (ctx: Ctx) => Effect.Effect<Result, unknown, R>;
}

/** Context for init procedures. */
export interface InitContext {
	readonly projectRoot: string;
	readonly characterName: string;
	readonly characterDir: string;
}

/** Complete set of domain service layers for the core state machine. */
export type DomainBundle = Layer.Layer<
	| EventProcessorTag
	| SituationClassifierTag
	| StateRendererTag
	| InterruptRegistryTag
	| PromptBuilderTag
	| SkillRegistryTag,
	never,
	never
>;

/** Mount specification for container volumes. */
export interface ContainerMount {
	readonly host: string;
	readonly container: string;
	readonly readonly?: boolean;
}

/**
 * Complete configuration for a domain — everything needed to run
 * the orchestrator against a specific game/environment.
 */
export interface DomainConfig {
	/** Domain service layers for the state machine. Optional — planned-action-based domains don't need this. */
	readonly bundle?: DomainBundle;
	/** Phase registry defining the session lifecycle. */
	readonly phaseRegistry: PhaseRegistry;
	/** Container volume mounts for the domain. */
	readonly containerMounts: ContainerMount[];
	/** Optional setup to run after container starts (e.g. symlinks). */
	readonly containerSetup?: (containerId: string) => void;
	/** Docker image name for the domain. */
	readonly imageName: string;
	/** Domain-specific Effect service layer (e.g. GameSocket for SpaceMolt, GitHubClient for GitHub). */
	readonly serviceLayer?: Layer.Layer<never, never, never>;
	/** Path to Dockerfile, relative to project root. */
	readonly dockerfilePath?: string;
	/** Docker build context directory, relative to project root. */
	readonly dockerContext?: string;
	/** Additional domains for firewall allowlist. */
	readonly firewallExtraDomains?: string[];
	/** Container --add-dir paths for claude subagent. */
	readonly containerAddDirs?: string[];
	/** Per-character setup procedure — creates domain-specific config files interactively. */
	readonly setupCharacter?: DomainProcedure<InitContext>;
	/** Per-character init procedure — validates domain-specific setup. */
	readonly initProcedure?: DomainProcedure<InitContext>;
	/** Project-level init (create directories, etc). Runs once before per-character checks. */
	readonly initProject?: (projectRoot: string) => Effect.Effect<ProcedureMessage[]>;
	/** Instructions shown when no characters are configured yet. */
	readonly characterSetupGuide?: string[];
	/** Hints for generating character identity files (background, values). */
	readonly identityTemplate?: {
		readonly backgroundHints: string;
		readonly valuesHints: string;
	};
}
