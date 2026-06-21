import type { FeedRecord, TransitionType } from "./types.js"

export interface RunDigest {
  env: { character: string; domain: string; tickIntervalMs: number; gitSha: string }
  counts: Record<string, number>
  sequence: TransitionType[]
  timings: { firstForebrainMs: number | null; firstPlanMs: number | null }
  startTs: string | null
}

export function emptyDigest(env: RunDigest["env"]): RunDigest {
  return {
    env,
    counts: {},
    sequence: [],
    timings: { firstForebrainMs: null, firstPlanMs: null },
    startTs: null,
  }
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
  return { ...d, counts, sequence, timings, startTs }
}
