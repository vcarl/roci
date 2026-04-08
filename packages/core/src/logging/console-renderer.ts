import { Effect } from "effect"
import type { Plan } from "../core/types.js"
import type { StepCompletionResult } from "../core/types.js"

// ── Per-player ANSI colors ───────────────────────────────

const RESET = "\x1b[0m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"

/** Stable color palette — each player gets a distinct hue. */
const PLAYER_COLORS: string[] = [
  "\x1b[36m",  // cyan
  "\x1b[33m",  // yellow
  "\x1b[35m",  // magenta
  "\x1b[32m",  // green
  "\x1b[34m",  // blue
  "\x1b[91m",  // bright red
]

const colorCache = new Map<string, string>()
let nextColorIdx = 0

function colorFor(character: string): string {
  let c = colorCache.get(character)
  if (!c) {
    c = PLAYER_COLORS[nextColorIdx % PLAYER_COLORS.length]
    nextColorIdx++
    colorCache.set(character, c)
  }
  return c
}

/** Colorized character tag: "[name:source]" — also usable from sync code. */
export function tag(character: string, source: string): string {
  const c = colorFor(character)
  return `${c}[${character}:${source}]${RESET}`
}

/** Colorized character name for narrative lines. */
function name(character: string): string {
  const c = colorFor(character)
  return `${c}${BOLD}${character}${RESET}`
}

// ── System messages (monitor, brain, errors) ──────────────

/** System/orchestrator message with bracket prefix. */
export const logToConsole = (
  character: string,
  source: string,
  message: string,
) =>
  Effect.sync(() => {
    const prefix = tag(character, source)
    for (const line of message.split("\n")) {
      console.log(`${prefix} ${line}`)
    }
  })

// ── Storytelling output (character voice) ─────────────────

/** Step transition header when spawning a subagent. */
export const logPlanTransition = (
  character: string,
  plan: Plan,
  stepIndex: number,
) =>
  Effect.sync(() => {
    const step = plan.steps[stepIndex]
    const c = colorFor(character)
    console.log(`${c}>> subagent start${RESET} — Step ${stepIndex + 1}/${plan.steps.length}: [${step.task}] ${step.goal} (${step.tier})`)
  })

/** Step completion result. */
export const logStepResult = (
  character: string,
  stepIndex: number,
  result: StepCompletionResult,
) =>
  Effect.sync(() => {
    const c = colorFor(character)
    const marker = result.complete ? `${c}OK${RESET}` : `\x1b[31mFAILED${RESET}`
    console.log(`${c}<< subagent done${RESET} — [${marker}] Step ${stepIndex + 1}: ${result.reason}`)
  })

// ── Type-tagged stream event output (used by log-demux) ──

/** Log a type-tagged stream event to console. */
export const logStreamEvent = (
  character: string,
  source: string,
  message: string,
) =>
  Effect.sync(() => {
    const prefix = tag(character, source)
    for (const line of message.split("\n")) {
      console.log(`${prefix} ${line}`)
    }
  })

/** Log stderr lines — suppressed from stdout. */
export const logStderr = (_character: string, _stderr: string) => Effect.void

// ── Character narrative lines (used by log-demux) ────────

/** Character thought — the LLM's voice IS the character. Full text shown. */
export const logCharThought = (character: string, text: string, indent = "") =>
  Effect.sync(() => {
    const lines = text.split("\n").filter((l) => l.trim().length > 0)
    if (lines.length > 0) {
      const prefix = `${indent}${name(character)}:`
      for (const line of lines) {
        console.log(`${prefix} ${line.trim()}`)
      }
    }
  })

/** Extended thinking block from the LLM. */
export const logThinking = (character: string, text: string, indent = "") =>
  Effect.sync(() => {
    const lines = text.split("\n").filter((l) => l.trim().length > 0)
    if (lines.length > 0) {
      const prefix = `${indent}${tag(character, "thinking")}`
      for (const line of lines) {
        console.log(`${prefix} ${DIM}${line.trim()}${RESET}`)
      }
    }
  })

/** Character action — suppressed from stdout. */
export const logCharAction = (_character: string, _command: string) => Effect.void

/** Tool result — first 10 + last 5 lines, with truncation indicator. */
export const logCharResult = (character: string, text: string, indent = "") =>
  Effect.sync(() => {
    const lines = text.split("\n").filter((l) => l.trim().length > 0)
    if (lines.length === 0) return

    const MAX_HEAD = 5
    const MAX_TAIL = 3
    const c = colorFor(character)
    const prefix = `${indent}${c}  >${RESET}`

    if (lines.length <= MAX_HEAD + MAX_TAIL) {
      for (const line of lines) {
        console.log(`${prefix} ${line}`)
      }
    } else {
      for (const line of lines.slice(0, MAX_HEAD)) {
        console.log(`${prefix} ${line}`)
      }
      console.log(`${prefix} ${DIM}... (${lines.length - MAX_HEAD - MAX_TAIL} lines omitted)${RESET}`)
      for (const line of lines.slice(-MAX_TAIL)) {
        console.log(`${prefix} ${line}`)
      }
    }
  })

/** Simple tick notification. */
export const logTickReceived = (character: string, tick: number) =>
  Effect.sync(() => {
    console.log(`${tag(character, "tick")} ${tick}`)
  })

/** Format an unknown error into a readable string. */
export function formatError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "object" && e !== null && "message" in e) return String((e as Record<string, unknown>).message)
  return String(e)
}
