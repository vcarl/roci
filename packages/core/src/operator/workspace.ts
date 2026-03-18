/**
 * Workspace utility functions for the fleet shared library.
 *
 * Machine-state files are written by the harness on tick intervals.
 * Agents read these files on-demand via claude -p filesystem access.
 *
 * workspace/ lives at shared-resources/workspace/ relative to project root.
 */

import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from "node:fs"
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

export interface CultGoals {
  updatedAt: string
  lockbox: {
    credits: number
    creditsTarget: number
    steelPlate: number
    steelPlateTarget: number
    circuitBoard: number
    circuitBoardTarget: number
  }
  gathering: { current: number; target: number }
  factionStorage: Record<string, number>
}

export interface FactionChatCache {
  updatedAt: string
  messages: Array<{ from: string; message: string; timestamp: string }>
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

/**
 * Write cult-goals.json from faction storage data.
 * Called every 10 ticks by the state machine.
 */
export function writeWorkspaceGoals(
  projectRoot: string,
  factionStorage: Record<string, number>,
): void {
  const filePath = join(workspacePath(projectRoot), "cult-goals.json")
  let existing: CultGoals
  try {
    existing = JSON.parse(readFileSync(filePath, "utf-8")) as CultGoals
  } catch {
    existing = {
      updatedAt: new Date().toISOString(),
      lockbox: {
        credits: 0, creditsTarget: 200000,
        steelPlate: 0, steelPlateTarget: 200,
        circuitBoard: 0, circuitBoardTarget: 50,
      },
      gathering: { current: 0, target: 20 },
      factionStorage: {},
    }
  }

  existing.updatedAt = new Date().toISOString()
  existing.factionStorage = factionStorage
  existing.lockbox.steelPlate = factionStorage["steel_plate"] ?? existing.lockbox.steelPlate
  existing.lockbox.circuitBoard = factionStorage["circuit_board"] ?? existing.lockbox.circuitBoard

  try {
    writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8")
  } catch {
    // silent
  }
}

/**
 * Write faction-chat-cache.json from recent faction chat messages.
 * Called every 5 ticks by the state machine.
 */
export function writeFactionChatCache(
  projectRoot: string,
  messages: Array<{ from: string; message: string; timestamp: string }>,
): void {
  const filePath = join(workspacePath(projectRoot), "faction-chat-cache.json")
  const cache: FactionChatCache = {
    updatedAt: new Date().toISOString(),
    messages: messages.slice(-20),
  }

  try {
    writeFileSync(filePath, JSON.stringify(cache, null, 2), "utf-8")
  } catch {
    // silent
  }
}

/**
 * Generate INDEX.md from the current workspace file tree.
 * Called on startup and when files are added/removed.
 */
export function generateWorkspaceIndex(projectRoot: string): void {
  const ws = workspacePath(projectRoot)
  if (!existsSync(ws)) return

  const now = new Date().toISOString()
  const lines: string[] = [
    "# Fleet Workspace Index",
    `Last updated: ${now}`,
    "",
    "## Machine State (updated by harness)",
    "- team-status.json — live snapshot of all agents (location, credits, fuel, cargo, activity)",
    "- cult-goals.json — lockbox progress, Gathering count, faction storage",
    "- faction-chat-cache.json — last 20 faction chat messages",
    "",
    "## CULT Operations",
    "- task-board.md — fleet-wide task queue, open/in-progress/done",
    "- resource-intel.md — deposit states, depletion patterns, routing suggestions",
    "",
  ]

  // Hobbies
  const hobbiesDir = join(ws, "hobbies")
  if (existsSync(hobbiesDir)) {
    lines.push("## Agent Hobby Docs (published intel — maintained by each agent's Social Brain)")
    const hobbyFiles = readdirSync(hobbiesDir).filter((f) => f.endsWith(".md")).sort()
    for (const f of hobbyFiles) {
      const name = f.replace(".md", "")
      lines.push(`- hobbies/${f} — ${name}'s published intel`)
    }
    lines.push("")
  }

  // Lore
  const loreDir = join(ws, "lore")
  if (existsSync(loreDir)) {
    lines.push("## Lore (read-only)")
    const loreFiles = readdirSync(loreDir).filter((f) => f.endsWith(".md")).sort()
    for (const f of loreFiles) {
      lines.push(`- lore/${f}`)
    }
    lines.push("")
  }

  // Doctrine
  const doctrineDir = join(ws, "doctrine")
  if (existsSync(doctrineDir)) {
    lines.push("## Doctrine (read-only)")
    const doctrineFiles = readdirSync(doctrineDir).filter((f) => f.endsWith(".md")).sort()
    for (const f of doctrineFiles) {
      lines.push(`- doctrine/${f}`)
    }
    lines.push("")
  }

  try {
    writeFileSync(join(ws, "INDEX.md"), lines.join("\n"), "utf-8")
  } catch {
    // silent
  }
}

/**
 * Seed workspace on startup. Creates directories and copies lore/doctrine
 * files if not already present. Never overwrites existing files.
 */
export function seedWorkspace(projectRoot: string, overlordDir: string): void {
  const ws = workspacePath(projectRoot)

  // Ensure directories
  for (const dir of ["hobbies", "lore", "doctrine"]) {
    mkdirSync(join(ws, dir), { recursive: true })
  }

  // Ensure machine state stubs
  const stubs: Record<string, string> = {
    "team-status.json": JSON.stringify({ updatedAt: null, agents: [] }, null, 2),
    "cult-goals.json": JSON.stringify({
      updatedAt: null,
      lockbox: { credits: 0, creditsTarget: 200000, steelPlate: 0, steelPlateTarget: 200, circuitBoard: 0, circuitBoardTarget: 50 },
      gathering: { current: 0, target: 20 },
      factionStorage: {},
    }, null, 2),
    "faction-chat-cache.json": JSON.stringify({ updatedAt: null, messages: [] }, null, 2),
    "task-board.md": "# Task Board\n\n## Open\n\n## In Progress\n\n## Done\n",
    "resource-intel.md": "# Resource Intel\n\nFleet-maintained resource intelligence.\n\n## Deposit States\n\n## Depletion Patterns\n\n## Routing Suggestions\n",
  }

  for (const [name, content] of Object.entries(stubs)) {
    const target = join(ws, name)
    if (!existsSync(target)) {
      try { writeFileSync(target, content, "utf-8") } catch { /* silent */ }
    }
  }

  // Copy lore files (never overwrite)
  const loreCopies: Array<[string, string]> = [
    [join(overlordDir, "memory", "game_lore", "MISSIONS.md"), join(ws, "lore", "MISSIONS.md")],
    [join(overlordDir, "memory", "game_lore", "STATIONS.md"), join(ws, "lore", "STATIONS.md")],
    [join(overlordDir, "memory", "game_lore", "INDEX.md"), join(ws, "lore", "ARG_STATUS.md")],
    [join(overlordDir, "GAME_MECHANICS.md"), join(ws, "lore", "GAME_MECHANICS.md")],
  ]

  for (const [src, dest] of loreCopies) {
    if (!existsSync(dest) && existsSync(src)) {
      try { copyFileSync(src, dest) } catch { /* silent */ }
    }
  }

  // Copy doctrine files (never overwrite)
  const doctrineCopies: Array<[string, string]> = [
    [join(overlordDir, "memory", "vault", "doctrine", "THESIGNAL.md"), join(ws, "doctrine", "signal-faith.md")],
    [join(overlordDir, "memory", "vault", "doctrine", "CULT_IDENTITY.md"), join(ws, "doctrine", "cult-values.md")],
    [join(overlordDir, "memory", "vault", "doctrine", "NEONECHO_SOUL.md"), join(ws, "doctrine", "neonecho-voice.md")],
    [join(overlordDir, "memory", "vault", "doctrine", "SAVOLENT_SOUL.md"), join(ws, "doctrine", "savolent-voice.md")],
    [join(overlordDir, "memory", "vault", "doctrine", "ZEALOT_SOUL.md"), join(ws, "doctrine", "zealot-voice.md")],
  ]

  for (const [src, dest] of doctrineCopies) {
    if (!existsSync(dest) && existsSync(src)) {
      try { copyFileSync(src, dest) } catch { /* silent */ }
    }
  }

  // Generate index after seeding
  generateWorkspaceIndex(projectRoot)
}

/**
 * Read social-state.json for an agent.
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
