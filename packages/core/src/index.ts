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
	EvaluatePromptContext,
	InterruptPromptContext,
	PlannedActionBrainPromptContext,
	PlanPromptContext,
	PromptBuilder,
	SubagentPromptContext,
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

export { parseHarnessState, applyHarnessState, parseSocialReport } from "./core/orchestrator/harness-state.js";
export type { HarnessStateTag } from "./core/orchestrator/harness-state.js";
export type { SocialBrainConfig, SocialBrainState } from "./core/orchestrator/social-brain.js";
export { shouldRunSocial, runSocialTurn } from "./core/orchestrator/social-brain.js";
export type { SocialState, TeamStatus, TeamAgent } from "./operator/workspace.js";
export { readSocialState, writeSocialState, updateTeamStatus } from "./operator/workspace.js";
