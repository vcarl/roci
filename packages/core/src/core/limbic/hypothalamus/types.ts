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

/** Configuration for a long-lived channel session. */
export interface SessionConfig {
  containerId: string
  playerName: string
  systemPrompt: string
  model: AnyModel
  sessionTimeoutMs: number
  env?: Record<string, string>
  addDirs?: string[]
  char: CharacterConfig
  channelPort?: number
}

/** Result when a session terminates. */
export interface SessionResult {
  reason: "completed" | "unachievable" | "crashed" | "killed"
  summary?: string
  durationMs: number
}
