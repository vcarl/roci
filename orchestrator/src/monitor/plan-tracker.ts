import type { GameState, Situation } from "../../../harness/src/types.js"
import type { PlanStep } from "../ai/types.js"

/**
 * Check if a plan step's success condition is met by evaluating
 * simple conditions against the current game state.
 *
 * Success conditions are natural language strings. We pattern-match
 * common patterns and fall back to substring checks.
 */
export function isStepComplete(
  step: PlanStep,
  state: GameState,
  situation: Situation,
): boolean {
  const cond = step.successCondition.toLowerCase()

  // Cargo-related conditions
  if (cond.includes("cargo") && cond.includes("90%")) {
    return state.ship.cargo_used / state.ship.cargo_capacity > 0.9
  }
  if (cond.includes("cargo") && cond.includes("full")) {
    return state.ship.cargo_used >= state.ship.cargo_capacity
  }
  if (cond.includes("cargo") && cond.includes("empty")) {
    return state.ship.cargo_used === 0
  }

  // Docking conditions
  if (cond.includes("docked") && !cond.includes("not")) {
    return state.player.docked_at_base !== null
  }
  if (cond.includes("undocked") || (cond.includes("not") && cond.includes("docked"))) {
    return state.player.docked_at_base === null
  }

  // System/location conditions
  const systemMatch = cond.match(/current_system\s*==\s*["']?(\w+)["']?/)
  if (systemMatch) {
    return state.player.current_system === systemMatch[1]
  }
  const poiMatch = cond.match(/current_poi\s*==\s*["']?(\w+)["']?/)
  if (poiMatch) {
    return state.player.current_poi === poiMatch[1]
  }

  // Fuel conditions
  if (cond.includes("fuel") && cond.includes("full")) {
    return state.ship.fuel >= state.ship.max_fuel * 0.95
  }
  if (cond.includes("refuel")) {
    return state.ship.fuel >= state.ship.max_fuel * 0.95
  }

  // Hull conditions
  if (cond.includes("hull") && cond.includes("full")) {
    return state.ship.hull >= state.ship.max_hull * 0.95
  }
  if (cond.includes("repair")) {
    return state.ship.hull >= state.ship.max_hull * 0.95
  }

  // Combat conditions
  if (cond.includes("not") && cond.includes("combat")) {
    return !state.inCombat
  }
  if (cond.includes("combat") && cond.includes("over")) {
    return !state.inCombat
  }

  // Transit conditions
  if (cond.includes("arrived") || cond.includes("arrival")) {
    return state.travelProgress === null
  }

  // Default: if the subagent completed (ran to finish), consider it done
  return false
}
