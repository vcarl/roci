import type { UnifiedEvent } from "@roci/core"
import type { Marker } from "./types.js"

export function classifyEvent(ev: UnifiedEvent): Marker | null {
  if (ev.kind === "behavior") {
    const b = ev.behavior
    const note = (): Marker => ({
      type: "NOTE",
      summary: `${b.type}`,
      fields: { behaviorType: b.type },
    })
    switch (b.type) {
      case "session_start":
        return { type: "SESSION_START", summary: `session start (${b.character})`, fields: { domain: b.domain, gitSha: b.gitSha } }
      case "session_end":
        return { type: "SESSION_END", summary: `session end (${b.reason})`, fields: { reason: b.reason, ...(b.signal ? { signal: b.signal } : {}) } }
      case "appraisal":
        return b.escalated
          ? { type: "ESCALATE", summary: `hindbrain escalate (${b.disposition})`, fields: { disposition: b.disposition, ...(b.weight !== undefined ? { weight: String(b.weight) } : {}) } }
          : note()
      case "orient":
        return { type: "FOREBRAIN", summary: `forebrain: ${b.headline}`, fields: { headline: b.headline } }
      case "decision":
        return { type: "DECISION", summary: `conscious decision: ${b.disposition}`, fields: { decision: b.disposition } }
      case "step":
        return b.phase === "start"
          ? { type: "STEP_START", summary: `step start${b.task ? `: ${b.task}` : ""}`, fields: { ...(b.task ? { task: b.task } : {}), ...(b.turn !== undefined ? { turn: String(b.turn) } : {}) } }
          : b.phase === "done"
            ? { type: "STEP_DONE", summary: "step done", fields: {} }
            : { type: "STEP_SALVAGE", summary: "step salvage", fields: {} }
      case "action":
        return { type: "DELEGATION", summary: `delegation: ${b.domain}/${b.name}`, fields: { domain: b.domain, name: b.name } }
      default:
        return note()
    }
  }

  // Best-effort delegation detection: the conscious agent runs the in-container
  // `frontier` bash CLI as a tool. Sharpen this in the calibration retro.
  if (ev.kind === "tool_use") {
    const blob = JSON.stringify(ev.input ?? "")
    if (ev.tool === "frontier" || /frontier (start|poll|steer|wait)/.test(blob)) {
      return { type: "DELEGATION", summary: `delegation via ${ev.tool}`, fields: { tool: ev.tool } }
    }
    return null
  }

  if (ev.kind !== "system") return null
  const m = ev.message
  let g: RegExpMatchArray | null

  if ((g = m.match(/^hindbrain: (\S+) (.+)$/))) {
    if (g[1] === "escalate") {
      return { type: "ESCALATE", summary: `hindbrain escalate (${g[2]})`, fields: { disposition: g[1], weight: g[2] } }
    }
    return null
  }
  if ((g = m.match(/^forebrain \(in-session\): (.+)$/))) {
    return { type: "FOREBRAIN", summary: `forebrain (in-session): ${g[1]}`, fields: { headline: g[1], inSession: "true" } }
  }
  if ((g = m.match(/^forebrain: (.+)$/))) {
    return { type: "FOREBRAIN", summary: `forebrain: ${g[1]}`, fields: { headline: g[1], inSession: "false" } }
  }
  if ((g = m.match(/^conscious: (plan|wait|terminate)$/))) {
    return { type: "DECISION", summary: `conscious decision: ${g[1]}`, fields: { decision: g[1] } }
  }
  if ((g = m.match(/^conscious turn 1: (.+)$/))) {
    return { type: "STEP_START", summary: `step start: ${g[1]}`, fields: { task: g[1] } }
  }
  if ((g = m.match(/^conscious steer turn \(session (.+)\)$/))) {
    return { type: "STEER", summary: `steer turn (session ${g[1]})`, fields: { sessionId: g[1] } }
  }
  if (m === "step done-marker detected; evaluating") {
    return { type: "STEP_DONE", summary: "step done-marker detected", fields: {} }
  }
  if ((g = m.match(/^step tick-budget elapsed \((\d+)\/(\d+)\); salvage evaluate$/))) {
    return { type: "STEP_SALVAGE", summary: `step salvage (${g[1]}/${g[2]} ticks)`, fields: { consumed: g[1], budget: g[2] } }
  }
  if ((g = m.match(/^evaluate: (\S+) → (\S+)$/))) {
    return { type: "EVALUATE", summary: `evaluate: ${g[1]} → ${g[2]}`, fields: { judgment: g[1], transition: g[2] } }
  }
  if ((g = m.match(/^Critical: (.+)$/))) {
    return { type: "CRITICAL", summary: `critical: ${g[1]}`, fields: { message: g[1] } }
  }
  return null
}
