// apps/roci/src/qa/monitor.ts
import { appendFile, open } from "node:fs/promises"
import process from "node:process"
import { type IngestState, ingestChunk, initialIngestState } from "./ingest.js"
import { renderFeedLine } from "./render.js"
import type { AnomalyType, FeedRecord, Severity } from "./types.js"

interface Args {
  events: string
  feed: string
  tickIntervalMs: number
  stallMultiple: number
  pollMs: number
  sessionPid: number | null
}

function parseArgs(raw: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = raw.indexOf(`--${name}`)
    return i >= 0 ? raw[i + 1] : undefined
  }
  const events = get("events")
  if (!events) {
    console.error(
      "usage: monitor --events <events.jsonl> [--feed <feed.jsonl>] [--tick-interval-ms N] [--stall-multiple N] [--poll-ms N] [--session-pid N]",
    )
    process.exit(2)
  }
  return {
    events,
    feed: get("feed") ?? events.replace(/events\.jsonl$/, "qa-feed.jsonl"),
    tickIntervalMs: Number(get("tick-interval-ms") ?? 30000),
    stallMultiple: Number(get("stall-multiple") ?? 2),
    pollMs: Number(get("poll-ms") ?? 1000),
    sessionPid: get("session-pid") ? Number(get("session-pid")) : null,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  let ingest: IngestState = initialIngestState
  let offset = 0
  let lastActivity = Date.now()
  let stalled = false
  let ended = false

  const write = async (r: FeedRecord): Promise<void> => {
    console.log(renderFeedLine(r))
    await appendFile(args.feed, `${JSON.stringify(r)}\n`)
  }

  const anomaly = (type: AnomalyType, severity: Severity, summary: string): FeedRecord => ({
    ts: new Date().toISOString(),
    kind: "anomaly",
    type,
    severity,
    tick: ingest.reducer.tick,
    summary,
  })

  const poll = async (): Promise<void> => {
    try {
      const fh = await open(args.events, "r")
      try {
        const { size } = await fh.stat()
        if (size > offset) {
          const buf = Buffer.alloc(size - offset)
          await fh.read(buf, 0, buf.length, offset)
          offset = size
          const out = ingestChunk(ingest, buf.toString("utf8"))
          ingest = out.state
          if (out.records.length > 0) {
            lastActivity = Date.now()
            stalled = false
            for (const r of out.records) await write(r)
          }
        }
      } finally {
        await fh.close()
      }
    } catch (e: unknown) {
      if ((e as { code?: string }).code !== "ENOENT") {
        console.error(`monitor read error: ${String(e)}`)
      }
    }
  }

  const checkStall = async (): Promise<void> => {
    if (ended || stalled) return
    const idleMs = Date.now() - lastActivity
    if (idleMs > args.stallMultiple * args.tickIntervalMs) {
      stalled = true
      await write(anomaly("STALL", "warn", `stall — no event in ${Math.round(idleMs / 1000)}s`))
    }
  }

  const checkProcess = async (): Promise<void> => {
    if (ended || args.sessionPid === null) return
    try {
      process.kill(args.sessionPid, 0) // signal 0 = liveness probe; throws if gone
    } catch {
      ended = true
      await write(anomaly("PROCESS_DIED", "error", `session process ${args.sessionPid} exited`))
    }
  }

  setInterval(() => void poll(), args.pollMs)
  setInterval(() => void checkStall(), args.pollMs)
  setInterval(() => void checkProcess(), args.pollMs)
  await poll()
}

void main()
