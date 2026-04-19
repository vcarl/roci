/**
 * Cadence-specific guidance text injected into skill templates via {{cadenceGuidance}}.
 * Each skill's behavior shifts based on cadence — these constants describe how.
 */

export type Cadence = "real-time" | "planned-action"

const OBSERVE_GUIDANCE: Record<Cadence, string> = {
  "real-time": `In real-time mode, your threshold for escalation is LOW. The environment changes fast — a missed event can mean missed opportunities or unrecovered threats. When in doubt between accumulate and escalate, prefer escalate. Discards should be reserved for truly empty heartbeats.`,
  "planned-action": `In planned-action mode, your threshold for escalation is HIGH. Most ticks should accumulate. The environment changes slowly — patience is a virtue. Only escalate for events that genuinely invalidate current work or resolve a wait state.`,
}

const ORIENT_GUIDANCE: Record<Cadence, string> = {
  "real-time": `In real-time mode, keep summaries tight and tactical. Focus on the immediate situation — what's happening right now and what changed in the last few ticks. The decision-maker needs fast reads, not comprehensive analyses.`,
  "planned-action": `In planned-action mode, summaries can be broader and more strategic. Include context about ongoing work, recent trends, and longer-term considerations. The decision-maker has time to think.`,
}

const DECIDE_GUIDANCE: Record<Cadence, string> = {
  "real-time": `In real-time mode, bias toward short plans (1-2 steps) and fast re-decision. The situation may shift before a long plan completes. If an escalated event arrives while executing, be willing to replan. Prefer action over deliberation.`,
  "planned-action": `In planned-action mode, you can plan 3-5 steps ahead. Wait states are expected and comfortable — it's fine to say "wait for CI" or "wait for review." Let current work finish before reorienting unless something truly urgent arrives.`,
}

const EVALUATE_GUIDANCE: Record<Cadence, string> = {
  "real-time": `In real-time mode, be more willing to replan. Partial success in a fast-moving environment often means the situation has shifted. Don't stubbornly continue a plan that's no longer relevant.`,
  "planned-action": `In planned-action mode, be more patient. Partial success on step 2 of 4 usually means continue the plan. Wait states are expected — opening a PR and waiting for review is normal workflow, not a failure.`,
}

const GUIDANCE_BY_SKILL: Record<string, Record<Cadence, string>> = {
  observe: OBSERVE_GUIDANCE,
  orient: ORIENT_GUIDANCE,
  decide: DECIDE_GUIDANCE,
  evaluate: EVALUATE_GUIDANCE,
}

/**
 * Get cadence guidance text for a given skill and cadence.
 */
export function getCadenceGuidance(skillName: string, cadence: Cadence): string {
  return GUIDANCE_BY_SKILL[skillName]?.[cadence] ?? ""
}
