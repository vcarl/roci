import type { GameState } from "./types.js"

/** Extract a compact snapshot of key state values for logging. */
export function snapshot(state: GameState): Record<string, unknown> {
  // Use player fields (current_poi/current_system) as the authoritative location
  // source: observation_update now folds poi_id/system_id into the player every
  // tick, and periodic get_state refreshes keep player scalars + poi/system names
  // fresh. The poi/system objects still lag between refreshes, so we fall back to
  // the player's id when the cached object's id no longer matches.
  const poiLabel = state.player.current_poi
    ? (state.poi?.name && state.poi.id === state.player.current_poi ? state.poi.name : state.player.current_poi)
    : "unknown"
  const systemLabel = state.player.current_system
    ? (state.system?.name && state.system.id === state.player.current_system ? state.system.name : state.player.current_system)
    : "unknown"
  return {
    cargo: `${state.ship.cargo_used}/${state.ship.cargo_capacity}`,
    fuel: `${state.ship.fuel}/${state.ship.max_fuel}`,
    hull: `${state.ship.hull}/${state.ship.max_hull}`,
    credits: state.player.credits,
    location: `${poiLabel} in ${systemLabel}`,
    docked: state.player.docked_at_base != null,
    inCombat: state.inCombat,
  }
}

/** Richer snapshot that includes cargo item breakdown and tick, for diff tracking. */
export function richSnapshot(state: GameState): Record<string, unknown> {
  return {
    ...snapshot(state),
    cargoItems: state.ship.cargo.map(c => ({ id: c.item_id, qty: c.quantity })),
    tick: state.tick,
  }
}

/** Produce a human-readable diff of two rich snapshots, showing only changed fields. */
export function stateDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): string {
  if (!before) return "(no before-state captured)"

  const lines: string[] = []

  // Compare scalar fields
  const scalarKeys = ["cargo", "fuel", "hull", "credits", "location", "docked", "inCombat"] as const
  for (const key of scalarKeys) {
    const b = before[key]
    const a = after[key]
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      if (key === "credits" && typeof b === "number" && typeof a === "number") {
        const delta = a - b
        lines.push(`${key}: ${b} -> ${a} (${delta >= 0 ? "+" : ""}${delta})`)
      } else {
        lines.push(`${key}: ${String(b)} -> ${String(a)}`)
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
        lines.push(`cargo ${id}: ${bQty} -> ${aQty} (${delta >= 0 ? "+" : ""}${delta})`)
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : "(no changes detected)"
}
