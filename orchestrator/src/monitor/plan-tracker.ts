import type { GameState, Situation } from "../../../harness/src/types.js"
import type { PlanStep } from "../ai/types.js"

export interface StepCompletionResult {
  complete: boolean
  reason: string
  matchedCondition: string | null
  relevantState: Record<string, unknown>
}

/** Extract a compact snapshot of key state values for logging. */
export function buildStateSnapshot(state: GameState): Record<string, unknown> {
  return {
    cargo: `${state.ship.cargo_used}/${state.ship.cargo_capacity}`,
    fuel: `${state.ship.fuel}/${state.ship.max_fuel}`,
    hull: `${state.ship.hull}/${state.ship.max_hull}`,
    credits: state.player.credits,
    location: `${state.poi?.name ?? state.player.current_poi} in ${state.system?.name ?? state.player.current_system}`,
    docked: state.player.docked_at_base !== null,
    inCombat: state.inCombat,
    traveling: state.travelProgress !== null,
  }
}

/** Richer snapshot that includes cargo item breakdown and tick, for diff tracking. */
export function buildRichSnapshot(state: GameState): Record<string, unknown> {
  return {
    ...buildStateSnapshot(state),
    cargoItems: state.ship.cargo.map(c => ({ id: c.item_id, qty: c.quantity })),
    tick: state.tick,
  }
}

/** Produce a human-readable diff of two rich snapshots, showing only changed fields. */
export function buildStateDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): string {
  if (!before) return "(no before-state captured)"

  const lines: string[] = []

  // Compare scalar fields
  const scalarKeys = ["cargo", "fuel", "hull", "credits", "location", "docked", "inCombat", "traveling"] as const
  for (const key of scalarKeys) {
    const b = before[key]
    const a = after[key]
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      if (key === "credits" && typeof b === "number" && typeof a === "number") {
        const delta = a - b
        lines.push(`${key}: ${b} → ${a} (${delta >= 0 ? "+" : ""}${delta})`)
      } else {
        lines.push(`${key}: ${String(b)} → ${String(a)}`)
      }
    }
  }

  // Compare cargo items
  type CargoEntry = { id: string; qty: number }
  const beforeCargo = (before.cargoItems ?? []) as CargoEntry[]
  const afterCargo = (after.cargoItems ?? []) as CargoEntry[]
  const beforeMap = new Map(beforeCargo.map(c => [c.id, c.qty]))
  const afterMap = new Map(afterCargo.map(c => [c.id, c.qty]))

  const allIds = new Set([...beforeMap.keys(), ...afterMap.keys()])
  for (const id of allIds) {
    const bQty = beforeMap.get(id) ?? 0
    const aQty = afterMap.get(id) ?? 0
    if (bQty !== aQty) {
      if (bQty === 0) {
        lines.push(`cargo +${id}: ${aQty}`)
      } else if (aQty === 0) {
        lines.push(`cargo -${id}: was ${bQty}`)
      } else {
        const delta = aQty - bQty
        lines.push(`cargo ${id}: ${bQty} → ${aQty} (${delta >= 0 ? "+" : ""}${delta})`)
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : "(no changes detected)"
}

/**
 * Check if a plan step's success condition is met by evaluating
 * simple conditions against the current game state.
 *
 * Used for mid-run state checks only (while subagent is still running).
 * Post-completion evaluation is done by brainEvaluate.
 */
export function isStepComplete(
  step: PlanStep,
  state: GameState,
  situation: Situation,
): StepCompletionResult {
  const cond = step.successCondition.toLowerCase()
  const snapshot = buildStateSnapshot(state)

  // Cargo-related conditions
  if (cond.includes("cargo") && cond.includes("90%")) {
    const met = state.ship.cargo_used / state.ship.cargo_capacity > 0.9
    return {
      complete: met,
      reason: met
        ? `Cargo at ${Math.round((state.ship.cargo_used / state.ship.cargo_capacity) * 100)}% (>90%)`
        : `Cargo at ${Math.round((state.ship.cargo_used / state.ship.cargo_capacity) * 100)}%, need >90%`,
      matchedCondition: "cargo > 90%",
      relevantState: snapshot,
    }
  }
  if (cond.includes("cargo") && cond.includes("full")) {
    const met = state.ship.cargo_used >= state.ship.cargo_capacity
    return {
      complete: met,
      reason: met
        ? `Cargo full (${state.ship.cargo_used}/${state.ship.cargo_capacity})`
        : `Cargo not full (${state.ship.cargo_used}/${state.ship.cargo_capacity})`,
      matchedCondition: "cargo full",
      relevantState: snapshot,
    }
  }
  if (cond.includes("cargo") && cond.includes("empty")) {
    const met = state.ship.cargo_used === 0
    return {
      complete: met,
      reason: met
        ? "Cargo is empty"
        : `Cargo not empty (${state.ship.cargo_used}/${state.ship.cargo_capacity})`,
      matchedCondition: "cargo empty",
      relevantState: snapshot,
    }
  }

  // Docking conditions
  if (cond.includes("docked") && !cond.includes("not")) {
    const met = state.player.docked_at_base !== null
    return {
      complete: met,
      reason: met ? `Docked at ${state.player.docked_at_base}` : "Not docked",
      matchedCondition: "docked",
      relevantState: snapshot,
    }
  }
  if (cond.includes("undocked") || (cond.includes("not") && cond.includes("docked"))) {
    const met = state.player.docked_at_base === null
    return {
      complete: met,
      reason: met ? "Undocked" : `Still docked at ${state.player.docked_at_base}`,
      matchedCondition: "undocked",
      relevantState: snapshot,
    }
  }

  // System/location conditions
  const systemMatch = cond.match(/current_system\s*==\s*["']?(\w+)["']?/)
  if (systemMatch) {
    const met = state.player.current_system === systemMatch[1]
    return {
      complete: met,
      reason: met
        ? `In system ${systemMatch[1]}`
        : `In system ${state.player.current_system}, need ${systemMatch[1]}`,
      matchedCondition: `current_system == ${systemMatch[1]}`,
      relevantState: snapshot,
    }
  }
  const poiMatch = cond.match(/current_poi\s*==\s*["']?(\w+)["']?/)
  if (poiMatch) {
    const met = state.player.current_poi === poiMatch[1]
    return {
      complete: met,
      reason: met
        ? `At POI ${poiMatch[1]}`
        : `At POI ${state.player.current_poi}, need ${poiMatch[1]}`,
      matchedCondition: `current_poi == ${poiMatch[1]}`,
      relevantState: snapshot,
    }
  }

  // Fuel conditions
  if (cond.includes("fuel") && cond.includes("full")) {
    const met = state.ship.fuel >= state.ship.max_fuel * 0.95
    return {
      complete: met,
      reason: met
        ? `Fuel full (${state.ship.fuel}/${state.ship.max_fuel})`
        : `Fuel at ${state.ship.fuel}/${state.ship.max_fuel}`,
      matchedCondition: "fuel full",
      relevantState: snapshot,
    }
  }
  if (cond.includes("refuel")) {
    const met = state.ship.fuel >= state.ship.max_fuel * 0.95
    return {
      complete: met,
      reason: met
        ? `Refueled (${state.ship.fuel}/${state.ship.max_fuel})`
        : `Fuel at ${state.ship.fuel}/${state.ship.max_fuel}`,
      matchedCondition: "refuel",
      relevantState: snapshot,
    }
  }

  // Hull conditions
  if (cond.includes("hull") && cond.includes("full")) {
    const met = state.ship.hull >= state.ship.max_hull * 0.95
    return {
      complete: met,
      reason: met
        ? `Hull full (${state.ship.hull}/${state.ship.max_hull})`
        : `Hull at ${state.ship.hull}/${state.ship.max_hull}`,
      matchedCondition: "hull full",
      relevantState: snapshot,
    }
  }
  if (cond.includes("repair")) {
    const met = state.ship.hull >= state.ship.max_hull * 0.95
    return {
      complete: met,
      reason: met
        ? `Repaired (${state.ship.hull}/${state.ship.max_hull})`
        : `Hull at ${state.ship.hull}/${state.ship.max_hull}`,
      matchedCondition: "repair",
      relevantState: snapshot,
    }
  }

  // Combat conditions
  if (cond.includes("not") && cond.includes("combat")) {
    const met = !state.inCombat
    return {
      complete: met,
      reason: met ? "Not in combat" : "Still in combat",
      matchedCondition: "not in combat",
      relevantState: snapshot,
    }
  }
  if (cond.includes("combat") && cond.includes("over")) {
    const met = !state.inCombat
    return {
      complete: met,
      reason: met ? "Combat over" : "Still in combat",
      matchedCondition: "combat over",
      relevantState: snapshot,
    }
  }

  // Transit conditions
  if (cond.includes("arrived") || cond.includes("arrival")) {
    const met = state.travelProgress === null
    return {
      complete: met,
      reason: met ? "Arrived at destination" : "Still in transit",
      matchedCondition: "arrived",
      relevantState: snapshot,
    }
  }

  // Default: condition not recognized, subagent still running
  return {
    complete: false,
    reason: `Condition "${step.successCondition}" not recognized, subagent still running.`,
    matchedCondition: null,
    relevantState: snapshot,
  }
}
