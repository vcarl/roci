import { Layer } from "effect"
import type { InterruptRule, InterruptRegistry } from "../../core/interrupt.js"
import { InterruptRegistryTag } from "../../core/interrupt.js"
import type { Alert } from "../../core/types.js"
import { SituationType as SituationTypeEnum } from "../../../../harness/src/types.js"
import type { GameState, Situation } from "../../../../harness/src/types.js"

const priorityOrder: Record<Alert["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const interruptRules: ReadonlyArray<InterruptRule<GameState, Situation>> = [
  // ── Critical ───────────────────────────────────────────
  {
    name: "in_combat",
    priority: "critical",
    condition: (_s, sit) => sit.type === SituationTypeEnum.InCombat,
    message: () => "You are in combat! Focus on fighting or flee.",
    suggestedAction: "attack",
    suppressWhenTaskIs: "combat",
  },
  {
    name: "hull_critical",
    priority: "critical",
    condition: (s, _sit) => {
      const pct = s.ship.max_hull > 0 ? s.ship.hull / s.ship.max_hull : 1
      return pct < 0.2
    },
    message: (s) => {
      const pct = s.ship.max_hull > 0 ? Math.round((s.ship.hull / s.ship.max_hull) * 100) : 100
      return `Hull critically damaged (${pct}%). Repair immediately or retreat.`
    },
    suggestedAction: "dock",
  },

  // ── High ───────────────────────────────────────────────
  {
    name: "fuel_low_undocked",
    priority: "high",
    condition: (s, sit) => sit.flags.lowFuel && sit.type !== SituationTypeEnum.Docked,
    message: (s) => {
      const pct = s.ship.max_fuel > 0 ? Math.round((s.ship.fuel / s.ship.max_fuel) * 100) : 100
      return `Fuel low (${pct}%). Find a station to refuel before you're stranded.`
    },
    suggestedAction: "find_route",
  },
  {
    name: "hull_low_undocked",
    priority: "high",
    condition: (s, sit) => {
      const pct = s.ship.max_hull > 0 ? s.ship.hull / s.ship.max_hull : 1
      return sit.flags.lowHull && sit.type !== SituationTypeEnum.Docked && pct >= 0.2
    },
    message: (s) => {
      const pct = s.ship.max_hull > 0 ? Math.round((s.ship.hull / s.ship.max_hull) * 100) : 100
      return `Hull damaged (${pct}%). Consider docking for repairs.`
    },
    suggestedAction: "dock",
  },

  // ── Medium ─────────────────────────────────────────────
  {
    name: "cargo_full",
    priority: "medium",
    condition: (_s, sit) => sit.flags.cargoFull,
    message: () => "Cargo hold is full. Sell or deposit items before mining more.",
    suggestedAction: "dock",
  },
  {
    name: "pending_trades",
    priority: "medium",
    condition: (_s, sit) => sit.flags.hasPendingTrades,
    message: () => "You have pending trade offers to review.",
    suggestedAction: "get_trades",
  },
  {
    name: "completable_mission",
    priority: "medium",
    condition: (_s, sit) => sit.flags.hasCompletableMission,
    message: () => "A mission is ready to complete!",
    suggestedAction: "complete_mission",
  },

  // ── Low ────────────────────────────────────────────────
  {
    name: "cargo_nearly_full",
    priority: "low",
    condition: (_s, sit) => sit.flags.cargoNearlyFull && !sit.flags.cargoFull,
    message: (s) => {
      const pct = Math.round((s.ship.cargo_used / s.ship.cargo_capacity) * 100)
      return `Cargo nearly full (${pct}%). Plan to offload soon.`
    },
  },
  {
    name: "unread_chat",
    priority: "low",
    condition: (_s, sit) => sit.flags.hasUnreadChat,
    message: () => "New chat messages received.",
    suggestedAction: "get_chat_history",
  },
  {
    name: "fuel_low_docked",
    priority: "low",
    condition: (_s, sit) => sit.flags.lowFuel && sit.type === SituationTypeEnum.Docked,
    message: (s) => {
      const pct = s.ship.max_fuel > 0 ? Math.round((s.ship.fuel / s.ship.max_fuel) * 100) : 100
      return `Fuel low (${pct}%). Refuel before undocking.`
    },
    suggestedAction: "refuel",
  },
]

const spaceMoltInterruptRegistry: InterruptRegistry<GameState, Situation> = {
  rules: interruptRules,

  evaluate(state: GameState, situation: Situation, currentTask?: string): Alert[] {
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

  criticals(state: GameState, situation: Situation, currentTask?: string): Alert[] {
    return this.evaluate(state, situation, currentTask).filter((a) => a.priority === "critical")
  },

  softAlerts(state: GameState, situation: Situation, currentTask?: string): Alert[] {
    return this.evaluate(state, situation, currentTask).filter((a) => a.priority !== "critical")
  },
}

/** Layer providing the SpaceMolt interrupt registry. */
export const SpaceMoltInterruptRegistryLive = Layer.succeed(InterruptRegistryTag, spaceMoltInterruptRegistry)
