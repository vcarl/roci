// Re-export core types and utilities

export { scaffoldCharacter } from "./core/character-scaffold.js";
export type {
	ContainerMount,
	DomainBundle,
	DomainConfig,
	DomainProcedure,
	InitContext,
	ProcedureMessage,
} from "./core/domain-bundle.js";
export type {
	DomainEvent,
	DomainSituation,
	DomainState,
} from "./core/domain-types.js";

export type {
	ConnectionState,
	Phase,
	PhaseContext,
	PhaseRegistry,
	PhaseResult,
} from "./core/phase.js";
export { PhaseRegistryTag } from "./core/phase.js";

export { runPhases } from "./core/phase-runner.js";
export type {
	ChannelEventContext,
	PlanPromptContext,
	PromptBuilder,
	SubagentPromptContext,
	TaskPromptContext,
} from "./core/prompt-builder.js";
export { PromptBuilderTag } from "./core/prompt-builder.js";
export type { Skill, SkillRegistry } from "./core/skill.js";
export { SkillRegistryTag } from "./core/skill.js";

export type { StateRenderer } from "./core/state-renderer.js";
export { StateRendererTag } from "./core/state-renderer.js";

export {
	loadTemplate,
	loadTemplateWithMeta,
	parseFrontmatter,
	renderTemplate,
	stripFrontmatter,
} from "./core/template.js";
export type {
	Alert,
	BrainMode,
	ExitReason,
	Plan,
	PlanStep,
	StateMachineResult,
	StepCompletionResult,
	StepTiming,
} from "./core/types.js";

// Skills — operating loop prompt templates
export { loadSkillSync } from "./skills/index.js"
export type { LoadedSkill } from "./skills/index.js"
export type {
	Disposition,
	ObserveResult,
	OrientResult,
	WaitState,
	DecideResult,
	Judgment,
	EvaluateTransition,
	EvaluateResult,
} from "./skills/index.js"
export { getCadenceGuidance } from "./skills/index.js"
export type { Cadence } from "./skills/index.js"
