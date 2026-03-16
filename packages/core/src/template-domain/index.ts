/**
 * Public API for the template domain.
 *
 * Re-export only what consumers need. Avoid wildcard exports (`export *`)
 * — they make it hard to track what's public and can cause name collisions.
 *
 * Typical consumers:
 *   - The CLI's domain registry (needs `templateDomainConfig`)
 *   - Tests (may need individual layers and types)
 */

// ── Bundle and config ────────────────────────────────────────
export { templateDomainBundle, templateDomainConfig } from "./bundle.js";

// ── Individual service layers ────────────────────────────────
// Exported for testing and for domains that want to compose
// individual services rather than the full bundle.
export { TemplateEventProcessorLive } from "./event-processor.js";
export { TemplateInterruptRegistryLive } from "./interrupt-rules.js";
export { TemplatePromptBuilderLive } from "./prompt-builder.js";
export { TemplateSituationClassifierLive } from "./situation-classifier.js";
export { TemplateSkillRegistryLive } from "./skills.js";
export { TemplateStateRendererLive } from "./state-renderer.js";

// ── Types ────────────────────────────────────────────────────
// Export domain types for consumers that need to work with
// the template domain's state directly.
export type {
	TemplateEvent,
	TemplateSituation,
	TemplateSituationFlags,
	TemplateSituationType,
	TemplateState,
	TodoItem,
} from "./types.js";
