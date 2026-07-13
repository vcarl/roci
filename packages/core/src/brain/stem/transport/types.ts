import type { AgentRuntime, AnyModel } from "../../../model/runtime.js"
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
  /** OpenCode agent name to run on a conscious-session first turn (`--agent`). */
  agentName?: string
}

/** Result of a completed (or timed-out) turn. */
export interface TurnResult {
  output: string
  timedOut: boolean
  durationMs: number
  /**
   * True when the transport aborted the turn because stdout stayed silent past
   * `TransportInput.silenceTimeoutMs` (a wedged/stuck request that never returns,
   * distinct from `timedOut`'s wall-clock cap). Set only when silence detection is
   * enabled; the conscious session-runner reacts to it (kill-in-container + retry).
   */
  hung?: boolean
  /** Whole ms of stdout silence at the moment a `hung` abort fired (for logging). */
  silentMs?: number
  /** First captured stream value (e.g. OpenCode sessionID), when a capture hook ran. */
  sessionId?: string
}
