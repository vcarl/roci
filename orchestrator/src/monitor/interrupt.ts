import type { Alert, Situation } from "../../../harness/src/types.js"

/** Extract critical alerts that warrant interrupting the current subagent. */
export function detectInterrupts(situation: Situation): Alert[] {
  return situation.alerts.filter((a) => a.priority === "critical")
}

/** Check if high-priority alerts suggest a significant change in conditions. */
export function detectHighAlerts(situation: Situation): Alert[] {
  return situation.alerts.filter(
    (a) => a.priority === "critical" || a.priority === "high",
  )
}
