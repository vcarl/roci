/**
 * Officer Deep Context — CULT-specific
 *
 * For officer brain turns (NeonEcho, Zealot, Savolent), inject additional
 * CULT doctrine context beyond what's in background.md:
 *   - GLOBAL_DIRECTIVE.md — current operator-level strategic directive
 *   - ROSTER.md — fleet overview and agent status
 *   - Faction doctrine summary (distilled from CULT_IDENTITY.md)
 *
 * This is CULT-only and should never go upstream. Officers need faction-level
 * awareness that congregation members don't need for their focused grind tasks.
 *
 * Usage (in prompt-builder or state-machine):
 *   const ctx = await loadDeepContext(playersDir, agentName)
 *   if (ctx) { brainPrompt += ctx }
 */

import * as path from "node:path"
import * as fs from "node:fs"

export interface DeepContextResult {
  globalDirective: string | null
  roster: string | null
  /** Formatted string ready to inject into brain prompt */
  formatted: string
}

const OFFICER_NAMES = new Set(["neonecho", "zealot", "savolent", "blackjack"])

export function isOfficer(agentName: string): boolean {
  return OFFICER_NAMES.has(agentName.toLowerCase())
}

/**
 * Load CULT deep context for officer agents.
 * Returns null if agent is not an officer or context files don't exist.
 *
 * @param overlordDir - Path to the overlord/ directory (host-side, not container)
 * @param agentName - Agent name (e.g., "neonecho", "zealot")
 */
export function loadDeepContext(overlordDir: string, agentName: string): DeepContextResult | null {
  if (!isOfficer(agentName)) return null

  const globalDirectivePath = path.join(overlordDir, "GLOBAL_DIRECTIVE.md")
  const rosterPath = path.join(overlordDir, "memory", "ROSTER.md")

  let globalDirective: string | null = null
  let roster: string | null = null

  try {
    globalDirective = fs.readFileSync(globalDirectivePath, "utf-8")
  } catch {
    // Not required — some deployments may not have it
  }

  try {
    const rosterFull = fs.readFileSync(rosterPath, "utf-8")
    // Trim to first 3000 chars to avoid token waste
    roster = rosterFull.slice(0, 3000)
  } catch {
    // Not required
  }

  if (!globalDirective && !roster) return null

  const sections: string[] = ["## CULT Command Context (Officer Only)"]

  if (globalDirective) {
    sections.push("### Global Directive\n" + globalDirective.trim())
  }

  if (roster) {
    sections.push("### Fleet Roster\n" + roster.trim())
  }

  return {
    globalDirective,
    roster,
    formatted: sections.join("\n\n"),
  }
}

/**
 * Inject deep context into a brain prompt string.
 * Inserts after the first paragraph (after the briefing section).
 */
export function injectDeepContext(brainPrompt: string, deepContext: DeepContextResult): string {
  return brainPrompt + "\n\n" + deepContext.formatted
}
