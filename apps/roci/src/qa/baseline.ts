// apps/roci/src/qa/baseline.ts
import type { RunDigest } from "./digest.js"

export interface Drift {
  field: string
  baseline: number
  run: number
  note: string
}

export interface DriftReport {
  drifts: Drift[]
  ok: boolean
}

export function compareBaseline(
  run: RunDigest,
  baseline: RunDigest,
  countTolerance = 0,
): DriftReport {
  const drifts: Drift[] = []
  const types = new Set([...Object.keys(baseline.counts), ...Object.keys(run.counts)])
  for (const t of [...types].sort()) {
    const b = baseline.counts[t] ?? 0
    const r = run.counts[t] ?? 0
    if (Math.abs(b - r) > countTolerance) {
      const note = b === 0 ? "new event class" : r === 0 ? "missing vs baseline" : "count delta"
      drifts.push({ field: `count.${t}`, baseline: b, run: r, note })
    }
  }
  return { drifts, ok: drifts.length === 0 }
}
