/**
 * Status HTTP server.
 * Serves agent status snapshots from players/{name}/status.json over HTTP.
 *
 * Routes:
 *   GET /           — health check
 *   GET /status     — all agent snapshots as a JSON object keyed by name
 *   GET /status/:name — single agent snapshot
 *
 * Usage (run separately from the orchestrator):
 *   node packages/core/src/server/status-server.js [--players-dir /path/to/players] [--port 7456]
 *
 * Or import and call startStatusServer() programmatically.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DEFAULT_PORT = 7456

function readAll(playersDir: string): Record<string, unknown> {
  if (!existsSync(playersDir)) return {}
  const result: Record<string, unknown> = {}
  for (const entry of readdirSync(playersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const statusFile = join(playersDir, entry.name, "status.json")
    if (!existsSync(statusFile)) continue
    try {
      result[entry.name] = JSON.parse(readFileSync(statusFile, "utf-8"))
    } catch {
      result[entry.name] = null
    }
  }
  return result
}

function readOne(playersDir: string, name: string): unknown | null {
  const fp = join(playersDir, name, "status.json")
  if (!existsSync(fp)) return null
  try {
    return JSON.parse(readFileSync(fp, "utf-8"))
  } catch {
    return null
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  })
  res.end(json)
}

export function startStatusServer(options: {
  playersDir: string
  port?: number
}): { close: () => void } {
  const { playersDir, port = DEFAULT_PORT } = options

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)
    const pathname = url.pathname

    if (pathname === "/") {
      respond(res, 200, { ok: true, port })
      return
    }

    if (pathname === "/status") {
      respond(res, 200, readAll(playersDir))
      return
    }

    const m = pathname.match(/^\/status\/([a-z0-9_-]+)$/)
    if (m) {
      const snap = readOne(playersDir, m[1]!)
      if (!snap) {
        respond(res, 404, null)
        return
      }
      respond(res, 200, snap)
      return
    }

    respond(res, 404, { error: "not found" })
  })

  server.listen(port, () => {
    console.log(`[status-server] running on http://localhost:${port}`)
    console.log(`  GET /status       — all agents`)
    console.log(`  GET /status/:name — single agent`)
  })

  return {
    close: () => server.close(),
  }
}

// --- Standalone entry point ---
if (process.argv[1] && process.argv[1].endsWith("status-server.js")) {
  const args = process.argv.slice(2)
  let playersDir = join(process.cwd(), "players")
  let port = DEFAULT_PORT

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--players-dir") playersDir = args[++i]!
    if (args[i] === "--port") port = parseInt(args[++i]!, 10)
  }

  startStatusServer({ playersDir, port })
}
