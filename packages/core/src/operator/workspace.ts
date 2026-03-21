/**
 * Workspace utility functions for fleet state and social presence.
 *
 * Machine-state files are written by the harness on tick intervals.
 * Agents read these files on-demand via claude -p filesystem access.
 *
 * workspace/ lives at shared-resources/workspace/ relative to project root.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

// ── Types ────────────────────────────────────────────────────

export interface TeamAgent {
  name: string
  location: string
  docked: boolean
  station: string | null
  credits: number
  fuel: number
  cargo: { used: number; capacity: number }
  currentActivity: string
  lastUpdated: string
}

export interface TeamStatus {
  updatedAt: string
  agents: TeamAgent[]
}

export interface SocialState {
  lastForumPost: string | null
  lastFactionChat: string | null
  lastDM: Record<string, string>
  pendingReplies: string[]
  openDMThreads: Array<{
    player: string
    isTeammate: boolean
    lastMessage: string
    ourTurn: boolean
  }>
  recentTeamActivity: string
}

// ── Paths ────────────────────────────────────────────────────

function workspacePath(projectRoot: string): string {
  return join(projectRoot, "shared-resources", "workspace")
}

// ── Team Status ──────────────────────────────────────────────

/**
 * Merge one agent's status into team-status.json.
 * Reads the existing file, updates the agent entry, writes back.
 */
export function updateTeamStatus(
  projectRoot: string,
  agentName: string,
  data: Omit<TeamAgent, "name">,
): void {
  const filePath = join(workspacePath(projectRoot), "team-status.json")
  let existing: TeamStatus
  try {
    existing = JSON.parse(readFileSync(filePath, "utf-8")) as TeamStatus
  } catch {
    existing = { updatedAt: new Date().toISOString(), agents: [] }
  }

  const now = new Date().toISOString()
  const agent: TeamAgent = { name: agentName, ...data, lastUpdated: now }

  const idx = existing.agents.findIndex((a) => a.name === agentName)
  if (idx >= 0) {
    existing.agents[idx] = agent
  } else {
    existing.agents.push(agent)
  }
  existing.updatedAt = now

  try {
    writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8")
  } catch {
    // workspace write is observability — never crash
  }
}

// ── Social State ─────────────────────────────────────────────

/**
 * Read social-state.json for an agent.
 * Returns defaults if the file doesn't exist.
 */
export function readSocialState(playerDir: string): SocialState {
  const filePath = join(playerDir, "social-state.json")
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as SocialState
  } catch {
    return {
      lastForumPost: null,
      lastFactionChat: null,
      lastDM: {},
      pendingReplies: [],
      openDMThreads: [],
      recentTeamActivity: "",
    }
  }
}

/**
 * Write social-state.json for an agent.
 */
export function writeSocialState(playerDir: string, state: SocialState): void {
  const filePath = join(playerDir, "social-state.json")
  try {
    writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8")
  } catch {
    // silent
  }
}

/**
 * Check whether the workspace directory exists for a project root.
 */
export function workspaceExists(projectRoot: string): boolean {
  return existsSync(workspacePath(projectRoot))
}
