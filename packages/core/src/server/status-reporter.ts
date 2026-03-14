/**
 * StatusReporter
 * Writes per-agent status snapshots to players/{name}/status.json
 * after each phase transition and plan update.
 *
 * One file per agent — safe for parallel runners.
 * Overlord (T2.2) and the status HTTP server (status-server.ts) read these files.
 */

import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export type AgentStatusSnapshot = {
  /** Character name (lowercase, matches players/ dir) */
  name: string
  /** Domain type (e.g. "spacemolt", "github") */
  domain: string
  /** Current phase from the lifecycle */
  phase: string
  /** Current brain mode ("select" | "mine" | "haul" | etc.) */
  mode: string
  /** Current plan reasoning (null if no plan) */
  plan: string | null
  /** Current step goal (null if no plan or all steps done) */
  currentGoal: string | null
  /** Current step index */
  stepIndex: number
  /** Derived situation type (e.g. "docked", "in_space") */
  situation: string
  /** Key metrics for Overlord health checks */
  metrics: Record<string, number | boolean | string>
  /** Total turns processed in this session */
  turnCount: number
  /** ISO timestamp of last update */
  lastUpdated: string
  /** Recent soft alerts (non-critical interrupts) */
  recentAlerts: string[]
}

/**
 * Write the agent snapshot to players/{name}/status.json.
 * Silently swallows write errors — status is observability, not critical.
 */
export function reportStatus(
  playersDir: string,
  name: string,
  snapshot: AgentStatusSnapshot,
): void {
  try {
    const dir = join(playersDir, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "status.json"), JSON.stringify(snapshot, null, 2), "utf-8")
  } catch (err) {
    console.warn(`[status-reporter/${name}] failed to write status.json:`, (err as Error).message)
  }
}
