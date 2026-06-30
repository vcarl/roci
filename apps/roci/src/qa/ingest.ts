import type { UnifiedEvent, BehaviorDigest } from "@roci/core"
import type { FeedRecord } from "./types.js"
import { type ReducerState, initialState, reduce } from "./feed.js"

export interface IngestState {
  reducer: ReducerState
  remainder: string
}

export const initialIngestState: IngestState = { reducer: initialState, remainder: "" }

export function ingestChunk(
  state: IngestState,
  chunk: string,
): { state: IngestState; records: FeedRecord[]; sessionEndDigest?: BehaviorDigest } {
  const text = state.remainder + chunk
  const parts = text.split("\n")
  const remainder = parts.pop() ?? ""
  let reducer = state.reducer
  const records: FeedRecord[] = []
  let sessionEndDigest: BehaviorDigest | undefined
  for (const lineStr of parts) {
    if (lineStr.trim() === "") continue
    let ev: UnifiedEvent
    try {
      ev = JSON.parse(lineStr) as UnifiedEvent
    } catch {
      continue
    }
    if (ev.kind === "behavior" && ev.behavior.type === "session_end") {
      sessionEndDigest = ev.behavior.digest
    }
    const out = reduce(reducer, ev)
    reducer = out.state
    records.push(...out.records)
  }
  return { state: { reducer, remainder }, records, sessionEndDigest }
}
