/**
 * Episode log substrate (agent-cognition Stage 1, spec §1).
 *
 * Two append-only JSONL streams per character under players/<name>/logs/:
 *   - episodes-tool.jsonl        high cadence, low fidelity (one record per OpenCode tool call)
 *   - episodes-transition.jsonl  low cadence, full fidelity (OODA tier calls + step boundaries)
 *
 * Episode writes are logging, not control flow: every writer is
 * Effect<void, never, never> — failures are swallowed after a console.error and
 * can never disturb the tick loop. Writers are a no-op until setEpisodeLogRoot
 * is called (apps/roci/src/cli.ts does this once at startup with PROJECT_ROOT).
 *
 * Module-level per-character context (tick/stepId) mirrors behavior-digest.ts:
 * the cortex loop stamps it; the transport and tier emitters read it.
 */
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import type { Judgment } from "../skills/types.js"

export const ARGS_SUMMARY_MAX = 200
/** Rotation: retain the last N reflection cycles (spec §1 "Rotation"). */
export const EPISODE_RETAIN_CYCLES = 5
export const TOOL_EPISODE_FILE = "episodes-tool.jsonl"
export const TRANSITION_EPISODE_FILE = "episodes-transition.jsonl"

/** One record per OpenCode tool call. Full tool responses are never stored. */
export interface ToolEpisode {
  ts: string
  tick: number | null
  stepId: string | null
  tool: string
  /** JSON of the tool input, truncated to ARGS_SUMMARY_MAX chars. */
  argsSummary: string
  /** Terminal tool state, e.g. "completed" | "error". */
  status: string
  durationMs: number | null
}

/** One record per OODA tier call: full rendered prompt + parsed output. */
export interface TierTransitionEpisode {
  type: "tier"
  ts: string
  tick: number | null
  stepId: string | null
  phase: "orient" | "decide" | "evaluate" | "diary"
  prompt: string
  output: unknown
}

/**
 * Step boundary records. `skill` (worn skill, spec §3) and `wmDeltas`
 * (working-memory deltas, spec §2) exist NOW for schema stability; Stage 1
 * always writes them as null — Stages 2/3 populate them.
 */
export interface StepBoundaryEpisode {
  type: "step-start" | "step-end"
  ts: string
  tick: number
  stepId: string
  task: string
  goal: string
  /** step-end only: the evaluate verdict. */
  verdict?: Judgment
  /** step-end only: the evaluate transition. */
  transition?: "next_step" | "replan" | "wait" | "terminate"
  skill: string | null
  wmDeltas: unknown[] | null
}

/** Marks the end of one reflection cycle in both streams (rotation unit). */
export interface CycleBoundaryEpisode {
  type: "cycle-boundary"
  ts: string
}

export type TransitionEpisode = TierTransitionEpisode | StepBoundaryEpisode | CycleBoundaryEpisode

// ── Root config ──────────────────────────────────────────────
let episodeRoot: string | null = null

/** Enable episode writes rooted at `root` (the harness project root); null disables. */
export function setEpisodeLogRoot(root: string | null): void {
  episodeRoot = root
}

function logsDir(root: string, character: string): string {
  return path.resolve(root, "players", character, "logs")
}

// ── Per-character tick/step context ──────────────────────────
export interface EpisodeContext {
  tick: number | null
  stepId: string | null
}

const contexts = new Map<string, EpisodeContext>()

export function episodeContext(character: string): EpisodeContext {
  return contexts.get(character) ?? { tick: null, stepId: null }
}

export function setEpisodeTick(character: string, tick: number): void {
  contexts.set(character, { ...episodeContext(character), tick })
}

export function setEpisodeStep(character: string, stepId: string | null): void {
  contexts.set(character, { ...episodeContext(character), stepId })
}

/** Test/lifecycle reset. */
export function resetEpisodeContext(character: string): void {
  contexts.delete(character)
}

// ── Record helpers ───────────────────────────────────────────
/** Compact-JSON a tool input, truncated to ARGS_SUMMARY_MAX chars. Never throws. */
export function summarizeArgs(input: unknown): string {
  let s: string
  try {
    s = JSON.stringify(input) ?? String(input)
  } catch {
    s = "[unserializable args]"
  }
  return s.length <= ARGS_SUMMARY_MAX ? s : `${s.slice(0, ARGS_SUMMARY_MAX)}…`
}

// ── Append writers (swallow-and-log; never fail) ─────────────
const append = (character: string, file: string, record: unknown): Effect.Effect<void> => {
  const root = episodeRoot
  if (root === null) return Effect.void
  return Effect.tryPromise({
    try: async () => {
      const line = `${JSON.stringify(record)}\n`
      const dir = logsDir(root, character)
      await fsp.mkdir(dir, { recursive: true })
      await fsp.appendFile(path.join(dir, file), line, "utf8")
    },
    catch: (e) => e,
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => console.error(`[episodes] append to ${file} failed for ${character}: ${e}`)),
    ),
  )
}

export const appendToolEpisode = (character: string, record: ToolEpisode): Effect.Effect<void> =>
  append(character, TOOL_EPISODE_FILE, record)

export const appendTransitionEpisode = (
  character: string,
  record: TransitionEpisode,
): Effect.Effect<void> => append(character, TRANSITION_EPISODE_FILE, record)
