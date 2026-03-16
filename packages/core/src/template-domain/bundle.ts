/**
 * Domain bundle and config for the template todo-list domain.
 *
 * This file wires all the individual service implementations into
 * a single `DomainBundle` Layer, and exports a `DomainConfig` that
 * the CLI uses to run the domain.
 *
 * ## DomainBundle
 *
 * A `DomainBundle` is a merged Layer providing all six services the
 * core state machine needs:
 *
 *   1. EventProcessorTag
 *   2. SituationClassifierTag
 *   3. InterruptRegistryTag
 *   4. SkillRegistryTag
 *   5. PromptBuilderTag
 *   6. StateRendererTag
 *
 * Use `Layer.mergeAll(...)` to combine them. The type system ensures
 * you don't forget one — TypeScript will error if the resulting Layer
 * doesn't satisfy `DomainBundle`.
 *
 * ## DomainConfig
 *
 * A `DomainConfig` is the top-level configuration object that tells
 * the CLI everything it needs to run your domain:
 *
 *   - `bundle` — the DomainBundle Layer (optional for planned-action
 *     domains that don't use the full state machine)
 *   - `phaseRegistry` — defines the session lifecycle phases
 *   - `containerMounts` — Docker volume mounts
 *   - `imageName` — Docker image name
 *   - `initProcedure` — per-character validation
 *   - `setupCharacter` — interactive per-character setup
 *   - `initProject` — one-time project-level setup
 *   - And more — see the DomainConfig interface for all options.
 */

import { Layer } from "effect";
import type { DomainBundle, DomainConfig } from "../core/domain-bundle.js";
import { TemplateEventProcessorLive } from "./event-processor.js";
import { TemplateInterruptRegistryLive } from "./interrupt-rules.js";
import { TemplatePromptBuilderLive } from "./prompt-builder.js";
import { TemplateSituationClassifierLive } from "./situation-classifier.js";
import { TemplateSkillRegistryLive } from "./skills.js";
import { TemplateStateRendererLive } from "./state-renderer.js";

/**
 * All template domain service layers merged into a single bundle.
 *
 * Layer.mergeAll combines multiple Layers into one that provides
 * all of their services. The `DomainBundle` type alias ensures the
 * resulting layer provides exactly the six service tags the core
 * state machine requires.
 */
export const templateDomainBundle: DomainBundle = Layer.mergeAll(
	TemplateEventProcessorLive,
	TemplateSituationClassifierLive,
	TemplateInterruptRegistryLive,
	TemplateSkillRegistryLive,
	TemplatePromptBuilderLive,
	TemplateStateRendererLive,
);

/**
 * Build a DomainConfig for the template domain.
 *
 * In a real domain, this function would accept a `projectRoot`
 * parameter and construct paths relative to it. This template
 * provides a minimal config to demonstrate the shape.
 *
 * A real domain would also include:
 *   - A `phaseRegistry` with startup, run, and shutdown phases
 *   - Container mounts for character data and shared resources
 *   - An init procedure that validates character config files
 *   - A setup procedure that interactively creates config files
 *   - Docker-related settings (image name, Dockerfile path, etc.)
 *
 * See `domain-spacemolt/src/config.ts` or `domain-github/src/config.ts`
 * for complete real-world examples.
 */
export const templateDomainConfig: DomainConfig = {
	bundle: templateDomainBundle,

	// Phase registry — defines the session lifecycle.
	// A minimal registry with a single placeholder phase.
	// Real domains have startup → run → shutdown phases.
	phaseRegistry: {
		phases: [],
		getPhase: () => undefined,
		initialPhase: "startup",
	},

	// Container mounts — empty for the template.
	// Real domains mount player data, shared resources, etc.
	containerMounts: [],

	// Docker image name.
	imageName: "template-domain",

	// Identity template — hints for Claude-generated character files.
	identityTemplate: {
		backgroundHints:
			"You are a productivity-focused assistant managing a todo list. " +
			"You have opinions about task prioritization, time management, " +
			"and getting things done efficiently.",
		valuesHints:
			"Your priorities include completing high-priority items first, " +
			"keeping the backlog manageable, unblocking stuck items, and " +
			"maintaining focus on one task at a time.",
	},
};
