import type { FeedRecord, TransitionType } from "./types.js"

export interface RunDigest {
  env: { character: string; domain: string; tickIntervalMs: number; gitSha: string }
  counts: Record<string, number>
  sequence: TransitionType[]
  timings: { firstForebrainMs: number | null; firstPlanMs: number | null }
  startTs: string | null
  terminalCause: string | null
}

const TERMINAL_RANK: Partial<Record<string, number>> = {
  FATAL_ERROR: 3,
  PROCESS_DIED: 2,
  SESSION_END: 1,
}

const TERMINAL_CAUSE: Partial<Record<string, (r: FeedRecord) => string>> = {
  FATAL_ERROR: (r) => r.summary,
  PROCESS_DIED: (r) => r.summary,
  SESSION_END: () => "session ended",
}

// Internal shape extends RunDigest with a rank tracker so the fold stays pure.
interface RunDigestInternal extends RunDigest {
  _terminalRank: number
}

export function emptyDigest(env: RunDigest["env"]): RunDigest {
  const d: RunDigestInternal = {
    env,
    counts: {},
    sequence: [],
    timings: { firstForebrainMs: null, firstPlanMs: null },
    startTs: null,
    terminalCause: null,
    _terminalRank: 0,
  }
  return d
}

export function foldDigest(d: RunDigest, r: FeedRecord): RunDigest {
  const counts = { ...d.counts, [r.type]: (d.counts[r.type] ?? 0) + 1 }
  const sequence =
    r.kind === "transition" ? [...d.sequence, r.type as TransitionType] : d.sequence
  const startTs = d.startTs ?? (r.type === "SESSION_START" ? r.ts : null)
  const sinceStart = startTs ? Date.parse(r.ts) - Date.parse(startTs) : null
  const timings = { ...d.timings }
  if (timings.firstForebrainMs === null && r.type === "FOREBRAIN") {
    timings.firstForebrainMs = sinceStart
  }
  if (timings.firstPlanMs === null && r.type === "DECISION" && r.summary.includes("plan")) {
    timings.firstPlanMs = sinceStart
  }

  const currentRank = (d as RunDigestInternal)._terminalRank ?? 0
  const incomingRank = TERMINAL_RANK[r.type] ?? 0
  const terminalCause =
    incomingRank > currentRank
      ? (TERMINAL_CAUSE[r.type]?.(r) ?? d.terminalCause)
      : d.terminalCause
  const nextRank = incomingRank > currentRank ? incomingRank : currentRank

  const next: RunDigestInternal = {
    ...d,
    counts,
    sequence,
    timings,
    startTs,
    terminalCause,
    _terminalRank: nextRank,
  }
  return next
}
