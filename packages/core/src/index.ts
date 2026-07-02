// Re-export core types and utilities
export type { UnifiedEvent } from "./logging/events.js"
export type { Behavior, BehaviorDigest } from "./logging/behavior.js"

export { scaffoldCharacter, autoAcceptReview } from "./core/character-scaffold.js";
export type { ReviewFn, ReviewDecision } from "./core/character-scaffold.js";
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
export type { PromptBuilder } from "./core/prompt-builder.js";
export { PromptBuilderTag } from "./core/prompt-builder.js";

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

export * from "./model/handles.js"
export * from "./model/errors.js"
export * from "./model/client.js"


// Cortex — local-model escalation ladder
export { runCortex } from "./cortex/loop.js"
export type { CortexLoopConfig, CortexResult } from "./cortex/loop.js"
export { freshCortexState, appraise, appraiseTick, emptyEscalation, DEFAULT_APPRAISAL_THRESHOLDS } from "./cortex/state.js"
export type { CortexState, HindbrainEscalation, EscalationRung, AppraisalThresholds } from "./cortex/state.js"
// Limbic drives — innate motivators carried in the character template (Subteam A)
export { TEMPLATE_DRIVES, CORE_DRIVE_NAMES, drivesFile, renderDriveLines, parseDriveNames } from "./core/drives.js"
export type { DomainDrive } from "./core/drives.js"
export { runHindbrain, runForebrain, runConsciousDecide, runConsciousEvaluate } from "./cortex/tiers.js"
export type { CortexRunnerConfig } from "./cortex/tiers.js"

// Conscious tier — local-model OpenCode executor session
export { ConsciousThought, ConsciousThoughtLive, ConsciousThoughtTest } from "./conscious/conscious-thought.js"
export type { ConsciousTurnConfig, ProvisionOpts } from "./conscious/conscious-thought.js"

// ModelService — tier lifecycle management
export { ModelService, ModelServiceLive, ModelBackendTag, makeModelService } from "./services/ModelService.js"
export { makeMlxBackend, buildMlxArgs, buildProbeRequest } from "./services/mlx-backend.js"
// Synchronous orphan-reaper backstop for resident mlx servers (the tsx double-fork
// shutdown race). The signal handlers in apps/roci/src/main.ts call reapResidentServers.
export {
  reapResidentServers,
  registerResidentServer,
  unregisterResidentServer,
} from "./services/mlx-backend.js"
export { MODEL_TIER_SPECS, resolveTierSpec } from "./services/model-tier-spec.js"
export type { TierSpec, TierLifecycle } from "./services/model-tier-spec.js"
export { SpawnError, ReadinessError, ModelCrashed } from "./services/model-backend.js"
export type { ModelBackend, RunningServer } from "./services/model-backend.js"
