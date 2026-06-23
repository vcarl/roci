import type { FeedRecord } from "./types.js"

export function renderFeedLine(r: FeedRecord): string {
  const glyph = r.kind === "anomaly" ? "⚠" : "•"
  return `${glyph} [t${r.tick}] ${r.type}: ${r.summary}`
}
