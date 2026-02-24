import { Effect } from "effect"
import type { GameState, Situation } from "../../../harness/src/types.js"
import type { Plan } from "../ai/types.js"
import type { StepCompletionResult } from "../monitor/plan-tracker.js"

function timestamp(): string {
  const now = new Date()
  return now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

/** Simple multi-character console renderer. Prefixes each line with timestamp and character name. */
export const logToConsole = (
  character: string,
  source: string,
  message: string,
) =>
  Effect.sync(() => {
    const ts = timestamp()
    const prefix = `${ts} [${character}:${source}]`
    for (const line of message.split("\n")) {
      console.log(`${prefix} ${line}`)
    }
  })

/** Compact one-liner showing key state values each tick. */
export const logStateBar = (
  character: string,
  state: GameState,
  situation: Situation,
) =>
  Effect.sync(() => {
    const ts = timestamp()
    const loc = `${state.poi?.name ?? state.player.current_poi} (${state.system?.name ?? state.player.current_system})`
    const fuel = `fuel:${Math.round((state.ship.fuel / state.ship.max_fuel) * 100)}%`
    const hull = `hull:${Math.round((state.ship.hull / state.ship.max_hull) * 100)}%`
    const cargo = `cargo:${Math.round((state.ship.cargo_used / state.ship.cargo_capacity) * 100)}%`
    const cr = `cr:${state.player.credits}`
    const status = state.player.docked_at_base ? "DOCKED" : state.inCombat ? "COMBAT" : state.travelProgress ? "TRANSIT" : "SPACE"

    console.log(`${ts} [${character}:state] ${loc} | ${fuel} ${hull} ${cargo} ${cr} ${status}`)
  })

/** Step header when spawning a subagent. */
export const logPlanTransition = (
  character: string,
  plan: Plan,
  stepIndex: number,
) =>
  Effect.sync(() => {
    const ts = timestamp()
    const step = plan.steps[stepIndex]
    const prefix = `${ts} [${character}:plan]`
    console.log(`${prefix} --- Step ${stepIndex + 1}/${plan.steps.length} ---`)
    console.log(`${prefix} [${step.task}] ${step.goal}`)
    console.log(`${prefix} Success when: ${step.successCondition}`)
  })

/** Step completion summary. */
export const logStepResult = (
  character: string,
  stepIndex: number,
  result: StepCompletionResult,
) =>
  Effect.sync(() => {
    const ts = timestamp()
    const tag = result.complete ? "OK" : "INCOMPLETE"
    console.log(`${ts} [${character}:done] [${tag}] Step ${stepIndex + 1}: ${result.reason}`)
  })
