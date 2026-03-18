/**
 * HARNESS_STATE tag parser.
 * Agents emit this at turn end so the harness can update game state
 * without an extra API call. The tag is domain-agnostic — it uses
 * the same field names as the SpaceMolt GameState object.
 *
 * Format (single line, no spaces around colon):
 *   HARNESS_STATE:{"fuel":N,"maxFuel":N,"cargoUsed":N,"cargoCapacity":N,"credits":N,"actionPending":bool,"inCombat":bool}
 */

export type HarnessStateTag = {
  fuel?: number
  maxFuel?: number
  cargoUsed?: number
  cargoCapacity?: number
  credits?: number
  actionPending?: boolean
  inCombat?: boolean
}

/**
 * Parse a HARNESS_STATE:{...} JSON tag from Claude's output.
 * Uses the last match — Claude may emit multiple in one turn; the final one
 * reflects state after all tool calls.
 */
export function parseHarnessState(output: string): HarnessStateTag | null {
  const matches = [...output.matchAll(/HARNESS_STATE:\s*(\{[^\n]+\})/g)]
  const last = matches.at(-1)
  if (!last) return null
  try {
    return JSON.parse(last[1]!) as HarnessStateTag
  } catch {
    return null
  }
}

/**
 * Apply a parsed HARNESS_STATE tag to an opaque DomainState object.
 * Mutates in place — safe because Ref.update gives us exclusive access.
 * Uses structural field assignment compatible with SpaceMolt's GameState shape.
 */
export function applyHarnessState(state: unknown, tag: HarnessStateTag): unknown {
  if (!state || typeof state !== "object") return state
  const s = state as Record<string, unknown>

  // Ship fields
  if (tag.fuel !== undefined || tag.maxFuel !== undefined || tag.cargoUsed !== undefined || tag.cargoCapacity !== undefined) {
    const ship = ((s.ship ?? {}) as Record<string, unknown>)
    if (tag.fuel !== undefined) ship.fuel = tag.fuel
    if (tag.maxFuel !== undefined) ship.max_fuel = tag.maxFuel
    if (tag.cargoUsed !== undefined) ship.cargo_used = tag.cargoUsed
    if (tag.cargoCapacity !== undefined) ship.cargo_capacity = tag.cargoCapacity
    s.ship = ship
  }

  // Player fields
  if (tag.credits !== undefined || tag.actionPending !== undefined) {
    const player = ((s.player ?? {}) as Record<string, unknown>)
    if (tag.credits !== undefined) player.credits = tag.credits
    if (tag.actionPending !== undefined) player.action_pending = tag.actionPending
    s.player = player
  }

  // Top-level combat flag
  if (tag.inCombat !== undefined) s.inCombat = tag.inCombat

  return s
}

// ── SOCIAL_REPORT parser ────────────────────────────────────

/**
 * Parse a SOCIAL_REPORT:...\nSOCIAL_END block from Claude's output.
 * Returns the report text between the markers, or null if not found.
 */
export function parseSocialReport(output: string): string | null {
  const match = output.match(/SOCIAL_REPORT:\s*\n?([\s\S]*?)\s*SOCIAL_END/)
  if (!match) return null
  return match[1]?.trim() || null
}
