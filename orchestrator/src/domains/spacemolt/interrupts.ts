import { Layer } from "effect"
import type { InterruptRule, InterruptRegistry } from "../../core/interrupt.js"
import { InterruptRegistryTag } from "../../core/interrupt.js"
import type { Alert } from "../../core/types.js"
import { SituationType as SituationTypeEnum } from "./types.js"
import type { GameState, Situation } from "./types.js"

const priorityOrder: Record<Alert["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const interruptRules: ReadonlyArray<InterruptRule> = [
  // ── Critical ───────────────────────────────────────────
  {
    name: "in_combat",
    priority: "critical",
    condition: (_s, sit) => (sit as Situation).type === SituationTypeEnum.InCombat,
    message: () => "You are in combat! Focus on fighting or flee.",
    suggestedAction: "attack",
    suppressWhenTaskIs: "combat",
  },
  {
    name: "hull_critical",
    priority: "critical",
    condition: (s) => {
      const gs = s as GameState
      const pct = gs.ship.max_hull > 0 ? gs.ship.hull / gs.ship.max_hull : 1
      return pct < 0.2
    },
    message: (s) => {
      const gs = s as GameState
      const pct = gs.ship.max_hull > 0 ? Math.round((gs.ship.hull / gs.ship.max_hull) * 100) : 100
      return `Hull critically damaged (${pct}%). Repair immediately or retreat.`
    },
    suggestedAction: "dock",
  },

  // ── High ───────────────────────────────────────────────
  {
    name: "fuel_low_undocked",
    priority: "high",
    condition: (s, sit) => {
      const gSit = sit as Situation
      return gSit.flags.lowFuel && gSit.type !== SituationTypeEnum.Docked
    },
    message: (s) => {
      const gs = s as GameState
      const pct = gs.ship.max_fuel > 0 ? Math.round((gs.ship.fuel / gs.ship.max_fuel) * 100) : 100
      return `Fuel low (${pct}%). Find a station to refuel before you're stranded.`
    },
    suggestedAction: "find_route",
  },
  {
    name: "hull_low_undocked",
    priority: "high",
    condition: (s, sit) => {
      const gs = s as GameState
      const gSit = sit as Situation
      const pct = gs.ship.max_hull > 0 ? gs.ship.hull / gs.ship.max_hull : 1
      return gSit.flags.lowHull && gSit.type !== SituationTypeEnum.Docked && pct >= 0.2
    },
    message: (s) => {
      const gs = s as GameState
      const pct = gs.ship.max_hull > 0 ? Math.round((gs.ship.hull / gs.ship.max_hull) * 100) : 100
      return `Hull damaged (${pct}%). Consider docking for repairs.`
    },
    suggestedAction: "dock",
  },

  // ── Medium ─────────────────────────────────────────────
  {
    name: "cargo_full",
    priority: "medium",
    condition: (_s, sit) => (sit as Situation).flags.cargoFull,
    message: () => "Cargo hold is full. Sell or deposit items before mining more.",
    suggestedAction: "dock",
  },
  {
    name: "pending_trades",
    priority: "medium",
    condition: (_s, sit) => (sit as Situation).flags.hasPendingTrades,
    message: () => "You have pending trade offers to review.",
    suggestedAction: "get_trades",
  },
  {
    name: "completable_mission",
    priority: "medium",
    condition: (_s, sit) => (sit as Situation).flags.hasCompletableMission,
    message: () => "A mission is ready to complete!",
    suggestedAction: "complete_mission",
  },

  // ── Low ────────────────────────────────────────────────
  {
    name: "cargo_nearly_full",
    priority: "low",
    condition: (_s, sit) => {
      const gSit = sit as Situation
      return gSit.flags.cargoNearlyFull && !gSit.flags.cargoFull
    },
    message: (s) => {
      const gs = s as GameState
      const pct = Math.round((gs.ship.cargo_used / gs.ship.cargo_capacity) * 100)
      return `Cargo nearly full (${pct}%). Plan to offload soon.`
    },
  },
  {
    name: "unread_chat",
    priority: "low",
    condition: (_s, sit) => (sit as Situation).flags.hasUnreadChat,
    message: () => "New chat messages received.",
    suggestedAction: "get_chat_history",
  },
  {
    name: "fuel_low_docked",
    priority: "low",
    condition: (_s, sit) => {
      const gSit = sit as Situation
      return gSit.flags.lowFuel && gSit.type === SituationTypeEnum.Docked
    },
    message: (s) => {
      const gs = s as GameState
      const pct = gs.ship.max_fuel > 0 ? Math.round((gs.ship.fuel / gs.ship.max_fuel) * 100) : 100
      return `Fuel low (${pct}%). Refuel before undocking.`
    },
    suggestedAction: "refuel",
  },
]

const spaceMoltInterruptRegistry: InterruptRegistry = {
  rules: interruptRules,

  evaluate(state, situation, currentTask?) {
    const alerts: Alert[] = []
    for (const rule of interruptRules) {
      if (currentTask && rule.suppressWhenTaskIs === currentTask) continue
      if (rule.condition(state, situation)) {
        alerts.push({
          priority: rule.priority,
          message: rule.message(state, situation),
          suggestedAction: rule.suggestedAction,
          ruleName: rule.name,
        })
      }
    }
    return alerts.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
  },

  criticals(state, situation, currentTask?) {
    return this.evaluate(state, situation, currentTask).filter((a) => a.priority === "critical")
  },

  softAlerts(state, situation, currentTask?) {
    return this.evaluate(state, situation, currentTask).filter((a) => a.priority !== "critical")
  },
}

/** Layer providing the SpaceMolt interrupt registry. */
export const SpaceMoltInterruptRegistryLive = Layer.succeed(InterruptRegistryTag, spaceMoltInterruptRegistry)
