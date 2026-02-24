export interface Plan {
  steps: PlanStep[]
  reasoning: string
}

export interface PlanStep {
  task: string       // e.g. "mine", "travel", "sell", "dock", "refuel", "chat", "explore"
  goal: string       // NL goal for the subagent
  model: "haiku" | "sonnet"
  successCondition: string  // checked against game state
  timeoutTicks: number
}
