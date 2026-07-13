import { Context } from "effect"
import type { DomainState, DomainSituation } from "../../../core/domain-types.js"
import type { Alert } from "../../../core/types.js"

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
 * A per-rule evaluation record for one tick — the audit trail of what the
 * amygdala saw and did. Emitted only for rules whose condition MATCHED (a
 * matched-but-not-acted-on rule is the interesting, previously-invisible case).
 */
export interface InterruptEvaluation {
  /** The rule that matched. */
  readonly ruleName: string
  readonly priority: Alert["priority"]
  /**
   * What happened to the match:
   * - `fired`: a critical rule that cuts the line and drives replanning.
   * - `suppressed-by-task:<task>`: skipped because the current step's task matches `suppressWhenTaskIs`.
   * - `below-threshold`: matched but non-critical, so it does not drive replanning (soft alert).
   */
  readonly outcome: string
  /** Where the match routes: critical → the conscious tier; everything else → `none`. */
  readonly tier: "conscious" | "none"
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
  /**
   * Diagnostic: one record per rule whose condition MATCHED this tick, capturing
   * its outcome (fired / suppressed / below-threshold) and destination tier.
   * Returns `[]` when no rule matched, so callers can log only on active ticks.
   */
  explain(state: DomainState, situation: DomainSituation, currentTask?: string): InterruptEvaluation[]
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

    explain(state, situation, currentTask?) {
      const records: InterruptEvaluation[] = []
      for (const rule of rules) {
        if (!rule.condition(state, situation)) continue
        const suppressed = currentTask !== undefined && rule.suppressWhenTaskIs === currentTask
        const outcome = suppressed
          ? `suppressed-by-task:${currentTask}`
          : rule.priority === "critical"
            ? "fired"
            : "below-threshold"
        records.push({
          ruleName: rule.name,
          priority: rule.priority,
          outcome,
          tier: !suppressed && rule.priority === "critical" ? "conscious" : "none",
        })
      }
      return records
    },
  }
}

/**
 * Effect service tag for the interrupt registry.
 */
export class InterruptRegistryTag extends Context.Tag("InterruptRegistry")<InterruptRegistryTag, InterruptRegistry>() {}
