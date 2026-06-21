export type TransitionType =
  | "SESSION_START"
  | "ESCALATE"
  | "FOREBRAIN"
  | "DECISION"
  | "STEER"
  | "STEP_START"
  | "STEP_DONE"
  | "STEP_SALVAGE"
  | "EVALUATE"
  | "DELEGATION"
  | "CRITICAL"
  | "SESSION_END"

export type AnomalyType = "PROCESS_DIED" | "STALL" | "ERROR" | "FATAL_ERROR"

export type Severity = "info" | "warn" | "error"

export interface FeedRecord {
  ts: string
  kind: "transition" | "anomaly"
  type: TransitionType | AnomalyType
  severity: Severity
  tick: number
  summary: string
  refs?: Record<string, string>
}

export interface Marker {
  type: TransitionType
  summary: string
  fields: Record<string, string>
}
