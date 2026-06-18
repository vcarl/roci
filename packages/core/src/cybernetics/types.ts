import type { AnyModel } from "../core/limbic/hypothalamus/runtime.js"
import type { CharacterConfig } from "../services/CharacterFs.js"

/** A single scoped unit of work handed to a cybernetic (Claude Code) worker. */
export interface DelegationConfig {
  containerId: string
  playerName: string
  char: CharacterConfig
  /** The scoped task instructions (becomes the worker's stdin prompt). */
  task: string
  /** Identity/capability context for the worker (becomes --system-prompt). */
  systemPrompt: string
  /** Model the worker runs on (e.g. "sonnet"). */
  model: AnyModel
  /** Wall-clock budget before the worker is interrupted. */
  timeoutMs: number
  addDirs?: string[]
  env?: Record<string, string>
  /** If set, restrict the worker's tools via --allowedTools. */
  allowedTools?: string[]
}

/**
 * Outcome of a delegation. `failed` is produced when the underlying claude
 * invocation errors (e.g. auth) — captured, not thrown, so the conscious tier
 * can evaluate it like any other result.
 */
export interface DelegationResult {
  status: "completed" | "timed_out" | "failed"
  /** The worker's final text output, or the error message when failed. */
  output: string
  durationMs: number
}
