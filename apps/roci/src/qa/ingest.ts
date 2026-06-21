import type { UnifiedEvent } from "@roci/core"
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
): { state: IngestState; records: FeedRecord[] } {
  const text = state.remainder + chunk
  const parts = text.split("\n")
  const remainder = parts.pop() ?? ""
  let reducer = state.reducer
  const records: FeedRecord[] = []
  for (const lineStr of parts) {
    if (lineStr.trim() === "") continue
    let ev: UnifiedEvent
    try {
      ev = JSON.parse(lineStr) as UnifiedEvent
    } catch {
      continue
    }
    const out = reduce(reducer, ev)
    reducer = out.state
    records.push(...out.records)
  }
  return { state: { reducer, remainder }, records }
}
