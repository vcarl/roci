/**
 * Overlord Monitor — fleet commander.
 *
 * Polls all agent status.json files every 5 minutes.
 * Detects stuck agents and drops edict nudges.
 * Responds to HELP_REQUESTED signals with Opus.
 * Writes wind-down when usage threshold is hit (via fetch-usage.py — CULT-only).
 *
 * Usage:
 *   node dist/overmind/overlord.js [--players-dir <path>] [--interval <seconds>] [--no-usage-check]
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { execSync } from "node:child_process"
import { readWindDown, writeWindDown } from "@signal/core/operator/wind-down-file.js"
import { writeEdict } from "@signal/core/operator/edict-inbox.js"
import type { AgentStatusSnapshot } from "@signal/core/server/status-reporter.js"

// ─── Config ────────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const STUCK_THRESHOLD = 3 // same (phase, stepIndex) for N consecutive polls → nudge

// Parse CLI args
const args = process.argv.slice(2)

function getArg(flag: string, def: string): string {
  const idx = args.indexOf(flag)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1]! : def
}

const playersDir = path.resolve(getArg("--players-dir", path.resolve(process.cwd(), "players")))
const pollIntervalMs = parseInt(getArg("--interval", "300"), 10) * 1000
const noUsageCheck = args.includes("--no-usage-check")

// ─── State ─────────────────────────────────────────────────────────────────

type PollState = {
  stuckCount: number
  lastPhase: string
  lastStepIndex: number
  nudgeSentAt?: number
}

const pollState = new Map<string, PollState>()
let pollCount = 0

// ─── Status reader ──────────────────────────────────────────────────────────

function readAllStatus(): Map<string, AgentStatusSnapshot> {
  const result = new Map<string, AgentStatusSnapshot>()

  if (!fs.existsSync(playersDir)) return result

  const entries = fs.readdirSync(playersDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const statusPath = path.join(playersDir, entry.name, "status.json")
    if (!fs.existsSync(statusPath)) continue
    try {
      const raw = fs.readFileSync(statusPath, "utf-8")
      const snapshot = JSON.parse(raw) as AgentStatusSnapshot
      result.set(entry.name, snapshot)
    } catch {
      // corrupt status file — skip
    }
  }

  return result
}

// ─── Help request reader ────────────────────────────────────────────────────

type HelpRequest = {
  agentName: string
  message: string
  context?: string
  requestedAt: string
}

function drainHelpRequests(): HelpRequest[] {
  const requests: HelpRequest[] = []

  if (!fs.existsSync(playersDir)) return requests

  const entries = fs.readdirSync(playersDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const helpPath = path.join(playersDir, entry.name, "help_request.json")
    if (!fs.existsSync(helpPath)) continue
    try {
      const raw = fs.readFileSync(helpPath, "utf-8")
      const req = JSON.parse(raw) as HelpRequest
      requests.push({ ...req, agentName: entry.name })
      fs.unlinkSync(helpPath) // consume once
    } catch {
      // malformed — remove it
      try { fs.unlinkSync(helpPath) } catch { /* ignore */ }
    }
  }

  return requests
}

// ─── Usage check (CULT-only) ─────────────────────────────────────────────────

type UsageResult = {
  session: number
  weekly: number
  session_end_time?: string
}

function checkUsage(fetchUsagePath: string): UsageResult | null {
  if (!fs.existsSync(fetchUsagePath)) return null
  try {
    const out = execSync(`python3 "${fetchUsagePath}"`, { encoding: "utf-8", timeout: 30_000 })
    return JSON.parse(out) as UsageResult
  } catch {
    return null
  }
}

// ─── Stuck detection + nudge ────────────────────────────────────────────────

function processStuck(name: string, snapshot: AgentStatusSnapshot): void {
  const prev = pollState.get(name)
  const samePhase = prev && prev.lastPhase === snapshot.phase && prev.lastStepIndex === snapshot.stepIndex
  const stuckCount = samePhase ? (prev?.stuckCount ?? 0) + 1 : 1

  pollState.set(name, {
    stuckCount,
    lastPhase: snapshot.phase,
    lastStepIndex: snapshot.stepIndex,
    nudgeSentAt: samePhase ? prev?.nudgeSentAt : undefined,
  })

  if (stuckCount >= STUCK_THRESHOLD) {
    const lastNudge = pollState.get(name)?.nudgeSentAt ?? 0
    const nudgeCooldownMs = DEFAULT_POLL_INTERVAL_MS * STUCK_THRESHOLD * 2 // 30 min cooldown
    if (Date.now() - lastNudge > nudgeCooldownMs) {
      console.log(`[Overlord] ${name} appears stuck (phase=${snapshot.phase}, step=${snapshot.stepIndex}, count=${stuckCount}) — sending nudge edict`)
      const playerDir = path.join(playersDir, name)
      writeEdict(playerDir, {
        priority: "low",
        content: `You appear to be stuck on [${snapshot.currentGoal ?? "unknown goal"}] in phase ${snapshot.phase} for ${stuckCount * Math.round(pollIntervalMs / 60000)} minutes. Assess your current situation and either continue or abandon and replan.`,
        issuedAt: new Date().toISOString(),
        source: "overlord",
      })
      const state = pollState.get(name)!
      state.nudgeSentAt = Date.now()
    }
  }
}

// ─── Help request handler (Opus escalation) ─────────────────────────────────

function handleHelpRequest(req: HelpRequest, allStatus: Map<string, AgentStatusSnapshot>): void {
  console.log(`[Overlord] HELP_REQUESTED from ${req.agentName}: ${req.message.slice(0, 200)}`)

  // Build fleet context for Opus
  const fleetSummary = [...allStatus.entries()]
    .map(([name, s]) => `${name}: phase=${s.phase} goal=${s.currentGoal ?? "none"} turn=${s.turnCount}`)
    .join("\n")

  const prompt = `You are the Overlord, fleet commander of the CULT.
An agent has sent a HELP_REQUEST:

Agent: ${req.agentName}
Message: ${req.message}
${req.context ? `Context: ${req.context}` : ""}

Fleet Status:
${fleetSummary}

Your job: provide a focused, actionable response as a high-priority edict. Be direct. One to three sentences max.
Respond with only the edict text — no preamble, no meta-commentary.`

  try {
    // Use Haiku for help response edicts (fast, cheap)
    const response = execSync(
      `claude -p ${JSON.stringify(prompt)} --model claude-haiku-4-5-20251001 --output-format text`,
      { encoding: "utf-8", timeout: 60_000 },
    ).trim()

    if (response) {
      const playerDir = path.join(playersDir, req.agentName)
      writeEdict(playerDir, {
        priority: "high",
        content: `[OVERLORD RESPONSE TO YOUR HELP REQUEST]\n${response}`,
        issuedAt: new Date().toISOString(),
        source: "overlord",
      })
      console.log(`[Overlord] Sent Haiku response to ${req.agentName}: ${response.slice(0, 100)}...`)
    }
  } catch (err) {
    console.error(`[Overlord] Help response failed: ${err}`)
  }
}

// ─── Main poll loop ──────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  pollCount++
  console.log(`[Overlord] Poll #${pollCount} — ${new Date().toISOString()}`)

  // Check if wind-down already active (don't double-write)
  const existingWindDown = readWindDown(playersDir)
  if (existingWindDown) {
    console.log(`[Overlord] Wind-down already active: ${existingWindDown.reason}`)
  }

  // 1. Usage check (CULT-only — only if fetch-usage.py exists)
  if (!noUsageCheck && !existingWindDown) {
    const fetchUsagePath = path.resolve(process.cwd(), ".claude/skills/usage-check/fetch-usage.py")
    const usage = checkUsage(fetchUsagePath)
    if (usage) {
      console.log(`[Overlord] Usage: session=${usage.session}% weekly=${usage.weekly}%`)
      if (usage.session >= 90 || usage.weekly >= 95) {
        console.log(`[Overlord] Usage threshold hit — writing wind-down signal`)
        writeWindDown(playersDir, {
          reason: `usage threshold: session=${usage.session}% weekly=${usage.weekly}%`,
          sessionEndTime: usage.session_end_time,
        })
      }
    }
  }

  // 2. Read all agent status
  const allStatus = readAllStatus()
  console.log(`[Overlord] Active agents: ${[...allStatus.keys()].join(", ") || "none"}`)

  // 3. Drain help requests (wake immediately, Opus responds)
  const helpRequests = drainHelpRequests()
  for (const req of helpRequests) {
    handleHelpRequest(req, allStatus)
  }

  // 4. Stuck detection
  for (const [name, snapshot] of allStatus) {
    processStuck(name, snapshot)
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

console.log(`[Overlord] Starting. players-dir=${playersDir} interval=${pollIntervalMs / 1000}s`)

// Run immediately, then on interval
poll().catch(console.error)
const interval = setInterval(() => poll().catch(console.error), pollIntervalMs)

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("[Overlord] Shutting down...")
  clearInterval(interval)
  process.exit(0)
})

process.on("SIGTERM", () => {
  clearInterval(interval)
  process.exit(0)
})
