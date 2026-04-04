import type { AgentRuntime, AnyModel } from "./runtime.js"
import type { CharacterConfig } from "../../../services/CharacterFs.js"

/** Configuration for a single brain or body turn. */
export interface TurnConfig {
  containerId: string
  playerName: string
  systemPrompt: string
  prompt: string
  model: AnyModel
  timeoutMs: number
  env?: Record<string, string>
  /** Container --add-dir paths for claude subagent. */
  addDirs?: string[]
  /** Character config for log routing. */
  char: CharacterConfig
  /** Label for console output (e.g. "brain", "body"). */
  role: "brain" | "body"
  /** If set, restrict available tools via --allowedTools. */
  allowedTools?: string[]
  /** If set, block these tools via --disallowedTools. */
  disallowedTools?: string[]
  /** If set, cap spend for this turn via --max-budget-usd. */
  maxBudgetUsd?: number
  /** If true, run the agent with no tools available. */
  noTools?: boolean
  /** Override which runtime binary to use; defaults to auto-detected from model. */
  runtime?: AgentRuntime
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
  brainModel: AnyModel
  bodyModel: AnyModel
  brainTimeoutMs: number
  bodyTimeoutMs: number
  env?: Record<string, string>
  /** Container --add-dir paths for claude subagent. */
  addDirs?: string[]
  /** Character config for log routing. */
  char: CharacterConfig
  /** Called before each cycle to generate the brain's input prompt (state summary, etc.) */
  buildBrainPrompt: () => string
  /** If set, restrict the brain's available tools via --allowedTools. */
  brainAllowedTools?: string[]
  /** If set, block these tools from the brain via --disallowedTools. */
  brainDisallowedTools?: string[]
}

/** Result of a full brain/body cycle. */
export interface CycleResult {
  brainResult: TurnResult
  bodyResult: TurnResult
  brainSummary?: string
  bodySummary?: string
}
