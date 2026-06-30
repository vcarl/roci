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

  // Auto-inject a SESSION_START guess on the very first event — UNLESS that first
  // event is a real behavior session_start, which classifyEvent already maps to
  // SESSION_START below (avoids a double count). The structured event is the
  // source of truth; this guess only covers pre-behavior / legacy streams.
  const isBehaviorSessionStart = ev.kind === "behavior" && ev.behavior.type === "session_start"
  if (!started && !isBehaviorSessionStart) {
    started = true
    records.push({
      ts: ev.timestamp,
      kind: "transition",
      type: "SESSION_START",
      severity: "info",
      tick,
      summary: `session start (${ev.character})`,
    })
  } else if (!started) {
    started = true
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

  if (ev.kind === "system" && /^Fatal error:/.test(ev.message)) {
    const modelMatch = ev.message.match(
      /^Fatal error: Model call failed \[tier=(\w+) model=([^ \]]+)/,
    )
    if (modelMatch) {
      const [, tier, model] = modelMatch
      records.push({
        ts: ev.timestamp,
        kind: "anomaly",
        type: "FATAL_ERROR",
        severity: "error",
        tick,
        summary: `fatal: Model call failed (tier=${tier})`,
        refs: { tier, model },
      })
    } else {
      const rest = ev.message.slice("Fatal error: ".length)
      records.push({
        ts: ev.timestamp,
        kind: "anomaly",
        type: "FATAL_ERROR",
        severity: "error",
        tick,
        summary: `fatal: ${rest}`,
      })
    }
    return { state: { tick, started }, records }
  }

  if (ev.kind === "system") {
    const degradedMatch = ev.message.match(/^(hindbrain|forebrain|conscious): undefined\b/)
    if (degradedMatch) {
      const tier = degradedMatch[1]
      records.push({
        ts: ev.timestamp,
        kind: "anomaly",
        type: "DEGRADED_TIER",
        severity: "warn",
        tick,
        summary: `degraded tier: ${tier} produced no usable output`,
        refs: { tier },
      })
      return { state: { tick, started }, records }
    }
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
