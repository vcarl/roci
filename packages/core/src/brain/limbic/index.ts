// ── THALAMUS ── Sensory relay: event processing, classification, context accumulation
export type { EventProcessor, EventResult, EventCategory, DomainContext } from "./thalamus/index.js"
export { EventProcessorTag } from "./thalamus/index.js"
export type { SituationClassifier, SituationSummary } from "./thalamus/index.js"
export { SituationClassifierTag } from "./thalamus/index.js"

// ── AMYGDALA ── Threat detection: interrupt evaluation and alerting
export type { InterruptRule, InterruptRegistry } from "./amygdala/index.js"
export { InterruptRegistryTag, createInterruptRegistry } from "./amygdala/index.js"
export type { Alert } from "../../core/types.js"

// ── AUTONOMIC ── Homeostatic regulation: tempo, cadence, drives
export type { TempoConfig, TempoBase, StateMachineTempo, PlannedActionTempo } from "./autonomic/tempo.js"

// ── HIPPOCAMPUS ── Memory: unified per-cycle consolidate + cull dream
export type { DreamType, DreamInput, DreamOutput } from "./hippocampus/index.js"
export { dream, DIARY_TARGET_LINES, REFLECTION_TURN_TIMEOUT_MS, CULL_TURN_TIMEOUT_MS, REFLECTION_CONTEXT_MAX } from "./hippocampus/index.js"
