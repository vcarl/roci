import type { UnifiedEvent } from "@roci/core"
import type { FeedRecord, Severity } from "./types.js"
import { classifyEvent } from "./markers.js"

export interface ReducerState {
  tick: number
  started: boolean
}

export const initialState: ReducerState = { tick: 0, started: false }

const severityFor = (type: string): Severity => (type === "CRITICAL" ? "warn" : "info")

export function reduce(
  state: ReducerState,
  ev: UnifiedEvent,
): { state: ReducerState; records: FeedRecord[] } {
  const records: FeedRecord[] = []
  let { tick, started } = state

  if (!started) {
    started = true
    records.push({
      ts: ev.timestamp,
      kind: "transition",
      type: "SESSION_START",
      severity: "info",
      tick,
      summary: `session start (${ev.character})`,
    })
  }

  if (ev.kind === "system" && /^hindbrain: /.test(ev.message)) {
    tick += 1
  }

  if (ev.kind === "error") {
    records.push({
      ts: ev.timestamp,
      kind: "anomaly",
      type: "ERROR",
      severity: "error",
      tick,
      summary: `error: ${ev.message}`,
    })
    return { state: { tick, started }, records }
  }

  const marker = classifyEvent(ev)
  if (marker) {
    records.push({
      ts: ev.timestamp,
      kind: "transition",
      type: marker.type,
      severity: severityFor(marker.type),
      tick,
      summary: marker.summary,
      refs: Object.keys(marker.fields).length ? marker.fields : undefined,
    })
  }

  return { state: { tick, started }, records }
}
