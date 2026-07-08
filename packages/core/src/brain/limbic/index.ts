// ── THALAMUS ── Sensory relay: event processing, classification, context accumulation
export type { EventProcessor, EventResult, EventCategory, DomainContext } from "#brain/limbic/thalamus/index.js"
export { EventProcessorTag } from "#brain/limbic/thalamus/index.js"
export type { SituationClassifier, SituationSummary } from "#brain/limbic/thalamus/index.js"
export { SituationClassifierTag } from "#brain/limbic/thalamus/index.js"

// ── AMYGDALA ── Threat detection: interrupt evaluation and alerting
export type { InterruptRule, InterruptRegistry } from "#brain/limbic/amygdala/index.js"
export { InterruptRegistryTag, createInterruptRegistry } from "#brain/limbic/amygdala/index.js"
export type { Alert } from "../../core/types.js"

// ── AUTONOMIC ── Homeostatic regulation: tempo, cadence, drives
export type { TempoConfig, TempoBase, StateMachineTempo, PlannedActionTempo } from "#brain/limbic/autonomic/tempo.js"

// ── HIPPOCAMPUS ── Memory: unified per-cycle consolidate + cull dream
export type { DreamType, DreamInput, DreamOutput } from "#brain/limbic/hippocampus/index.js"
export { dream, DIARY_TARGET_LINES, REFLECTION_TURN_TIMEOUT_MS, CULL_TURN_TIMEOUT_MS, REFLECTION_CONTEXT_MAX } from "#brain/limbic/hippocampus/index.js"
