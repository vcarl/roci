import type { Behavior, BehaviorDigest } from "./behavior.js"

interface DigestState extends BehaviorDigest {
  _terminalRank: number
}

// Only `session_end` is a terminal behavior; ranked so a stray double would not
// downgrade the cause. (Crash terminal causes — PROCESS_DIED — are the QA
// monitor's fold-fallback concern, not the accumulator's.)
const TERMINAL_RANK: Partial<Record<Behavior["type"], number>> = {
  session_end: 1,
}

const accumulators = new Map<string, DigestState>()
const ended = new Set<string>()
let shutdownSignal: string | undefined

export function emptyBehaviorDigest(): BehaviorDigest {
  return {
    counts: {},
    sequence: [],
    timings: { firstForebrainMs: null, firstPlanMs: null },
    startTs: null,
    terminalCause: null,
  }
}

function stateFor(character: string): DigestState {
  let s = accumulators.get(character)
  if (!s) {
    s = { ...emptyBehaviorDigest(), _terminalRank: 0 }
    accumulators.set(character, s)
  }
  return s
}

/** Fold one behavior into the character's running digest. Never throws. */
export function recordBehavior(character: string, behavior: Behavior, ts: string): void {
  const s = stateFor(character)
  s.counts[behavior.type] = (s.counts[behavior.type] ?? 0) + 1
  s.sequence.push(behavior.type)

  if (s.startTs === null && behavior.type === "session_start") s.startTs = ts
  const rawSinceStart = s.startTs ? Date.parse(ts) - Date.parse(s.startTs) : null
  const sinceStart = rawSinceStart === null || Number.isNaN(rawSinceStart) ? null : rawSinceStart

  if (s.timings.firstForebrainMs === null && behavior.type === "tier_call" && behavior.tier === "forebrain") {
    s.timings.firstForebrainMs = sinceStart
  }
  if (s.timings.firstPlanMs === null && behavior.type === "decision" && behavior.disposition === "plan") {
    s.timings.firstPlanMs = sinceStart
  }

  const incomingRank = TERMINAL_RANK[behavior.type] ?? 0
  if (incomingRank > s._terminalRank) {
    s._terminalRank = incomingRank
    if (behavior.type === "session_end") {
      s.terminalCause = behavior.signal
        ? `session ended (${behavior.reason}: ${behavior.signal})`
        : `session ended (${behavior.reason})`
    }
  }
}

/** Defensive copy of the character's current digest. Never throws. */
export function snapshotDigest(character: string): BehaviorDigest {
  const s = stateFor(character)
  return {
    counts: { ...s.counts },
    sequence: [...s.sequence],
    timings: { ...s.timings },
    startTs: s.startTs,
    terminalCause: s.terminalCause,
  }
}

/** Test/lifecycle reset for a character's accumulator + end-guard. */
export function resetBehaviorDigest(character: string): void {
  accumulators.delete(character)
  ended.delete(character)
}

/** Returns true exactly once per character — the session_end idempotency guard. */
export function tryMarkEnded(character: string): boolean {
  if (ended.has(character)) return false
  ended.add(character)
  return true
}

/** Capture the OS signal name from a (synchronous) signal handler. */
export function recordShutdownSignal(signal: string): void {
  shutdownSignal = signal
}

/** Read-and-clear the captured shutdown signal name. */
export function consumeShutdownSignal(): string | undefined {
  const s = shutdownSignal
  shutdownSignal = undefined
  return s
}
