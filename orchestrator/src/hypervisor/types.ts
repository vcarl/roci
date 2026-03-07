import type { ClaudeModel } from "../services/Claude.js"

/** Configuration for a single brain or body turn. */
export interface TurnConfig {
  containerId: string
  playerName: string
  systemPrompt: string
  prompt: string
  model: ClaudeModel
  timeoutMs: number
  env?: Record<string, string>
}

/** Result of a completed (or timed-out) turn. */
export interface TurnResult {
  output: string
  timedOut: boolean
  durationMs: number
}

/** Configuration for a full brain/body cycle. */
export interface CycleConfig {
  containerId: string
  playerName: string
  brainSystemPrompt: string
  bodySystemPrompt: string
  brainModel: ClaudeModel
  bodyModel: ClaudeModel
  brainTimeoutMs: number
  bodyTimeoutMs: number
  env?: Record<string, string>
  /** Called before each cycle to generate the brain's input prompt (state summary, etc.) */
  buildBrainPrompt: () => string
}

/** Result of a full brain/body cycle. */
export interface CycleResult {
  brainResult: TurnResult
  bodyResult: TurnResult
  brainSummary?: string
  bodySummary?: string
}
