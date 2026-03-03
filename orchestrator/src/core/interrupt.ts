import { Context } from "effect"
import type { DomainState, DomainSituation } from "./domain-types.js"
import type { Alert } from "./types.js"

/**
 * A declarative interrupt rule. When its condition fires, the state machine
 * may kill the current subagent and replan.
 */
export interface InterruptRule {
  readonly name: string
  /** Only "critical" rules trigger immediate replanning */
  readonly priority: Alert["priority"]
  /** When does this rule fire? */
  readonly condition: (state: DomainState, situation: DomainSituation) => boolean
  /** Human-readable alert message */
  readonly message: (state: DomainState, situation: DomainSituation) => string
  readonly suggestedAction?: string
  /** Prevent re-triggering if the current step's task matches this name */
  readonly suppressWhenTaskIs?: string
}

/**
 * Registry of all interrupt rules. Evaluated on each state update to
 * detect conditions that warrant replanning.
 */
export interface InterruptRegistry {
  readonly rules: ReadonlyArray<InterruptRule>
  /** Evaluate all rules, return alerts sorted by priority. If currentTask is provided, suppress rules whose suppressWhenTaskIs matches. */
  evaluate(state: DomainState, situation: DomainSituation, currentTask?: string): Alert[]
  /** Return only critical alerts (triggers for replanning). If currentTask is provided, suppress rules whose suppressWhenTaskIs matches. */
  criticals(state: DomainState, situation: DomainSituation, currentTask?: string): Alert[]
  /** Return non-critical alerts (high, medium, low). */
  softAlerts(state: DomainState, situation: DomainSituation, currentTask?: string): Alert[]
}

const priorityOrder: Record<Alert["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/**
 * Factory that builds an InterruptRegistry from a list of declarative rules.
 * Handles rule walking, suppression, sorting, and partitioning.
 */
export function createInterruptRegistry(rules: ReadonlyArray<InterruptRule>): InterruptRegistry {
  return {
    rules,

    evaluate(state, situation, currentTask?) {
      const alerts: Alert[] = []
      for (const rule of rules) {
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
}

/**
 * Effect service tag for the interrupt registry.
 */
export class InterruptRegistryTag extends Context.Tag("InterruptRegistry")<InterruptRegistryTag, InterruptRegistry>() {}
