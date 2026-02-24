import { Effect, Ref, Stream } from "effect"
import { Claude, type ClaudeModel, ClaudeError } from "../services/Claude.js"
import { CharacterLog, type LogEntry } from "../logging/log-writer.js"
import { demuxStream } from "../logging/log-demux.js"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { PlanStep } from "./types.js"
import type { GameState, Situation } from "../../../harness/src/types.js"

export interface SubagentInput {
  char: CharacterConfig
  containerId: string
  step: PlanStep
  state: GameState
  situation: Situation
  personality: string  // character background snippet
  values: string       // character values snippet
}

interface SubagentResult {
  completed: boolean
  output: string
}

/** Build the subagent prompt based on the task type. */
function buildSubagentPrompt(input: SubagentInput): string {
  const { step, state, situation, personality, values } = input
  const briefing = buildStateSummary(state, situation)

  const taskPrompts: Record<string, string> = {
    mine: `Mine at your current location. Use \`sm mine\` repeatedly. Check \`sm status\` to monitor cargo. Stop when cargo is more than 90% full or when there are no more resources to mine.`,

    travel: `Navigate to the destination. Use \`sm jump [system_id]\` for inter-system jumps, then \`sm travel [poi_id]\` for intra-system travel. Wait for arrival by checking \`sm status\` periodically.`,

    sell: `Sell cargo at the current station. Use \`sm sell [item_id] [quantity]\` to sell items. Check market prices first with \`sm market\`. Sell strategically — prioritize items with good buy orders.`,

    dock: `Dock at the nearest station. Use \`sm dock\` if at a dockable POI. If not at a dockable POI, travel to one first.`,

    undock: `Undock from the current station. Use \`sm undock\` to leave the station.`,

    refuel: `Refuel your ship. Use \`sm refuel\` while docked. Ensure you have enough credits.`,

    repair: `Repair your ship. Use \`sm repair\` while docked. Ensure you have enough credits.`,

    combat: `You are in combat. Assess the threat. Use \`sm attack [target]\` to fight or \`sm flee\` to escape. Check \`sm status\` to monitor hull and shields. Prioritize survival.`,

    chat: `Read recent chat and respond appropriately. Use \`sm chat history\` to read messages, \`sm chat send [channel] [message]\` to respond. Stay in character.`,

    explore: `Explore the current area. Check \`sm status\` for your situation, \`sm system\` for POIs, \`sm map\` for connected systems. Make observations and decide what to do next.`,
  }

  const taskInstruction = taskPrompts[step.task] ?? taskPrompts.explore

  return `# Your Mission

${taskInstruction}

## Specific Goal
${step.goal}

## Success Condition
${step.successCondition}

## Current State
${briefing}

## Who You Are
${personality.slice(0, 800)}

## Your Values (brief)
${values.slice(0, 500)}

## Available Commands
Run \`sm --help\` for the full list of commands. Key commands:
- \`sm status\` — check your current state
- \`sm mine\` — mine resources at current POI
- \`sm sell [item_id] [qty]\` — sell cargo
- \`sm buy [item_id] [qty]\` — buy items
- \`sm jump [system_id]\` — jump to another system
- \`sm travel [poi_id]\` — travel to a POI in current system
- \`sm dock\` / \`sm undock\` — dock/undock at station
- \`sm refuel\` / \`sm repair\` — refuel/repair at station
- \`sm attack [target]\` / \`sm flee\` — combat actions
- \`sm chat history\` / \`sm chat send [channel] [msg]\` — social
- \`sm market\` — view market prices
- \`sm cargo\` — check cargo
- \`sm nearby\` — see nearby players

Stay focused on your specific goal. When you've achieved it or cannot make further progress, stop.

When you are finished (goal achieved or no further progress possible), write a brief
COMPLETION REPORT as your final message summarizing:
- What you accomplished
- What commands you ran and their outcomes
- Whether you believe the goal was met
- Any issues or blockers encountered`
}

function buildStateSummary(state: GameState, situation: Situation): string {
  const { player, ship } = state
  const lines = [
    `Situation: ${situation.type}`,
    `Location: ${state.poi?.name ?? player.current_poi} in ${state.system?.name ?? player.current_system}`,
    `Credits: ${player.credits}. Fuel: ${ship.fuel}/${ship.max_fuel}. Hull: ${ship.hull}/${ship.max_hull}.`,
    `Cargo: ${ship.cargo_used}/${ship.cargo_capacity}`,
  ]

  if (situation.alerts.length > 0) {
    lines.push("Alerts:")
    for (const a of situation.alerts) {
      lines.push(`  [${a.priority}] ${a.message}`)
    }
  }

  if (state.nearby.length > 0) {
    lines.push(`Nearby: ${state.nearby.map((p) => p.username).join(", ")}`)
  }

  return lines.join("\n")
}

/** Spawn a subagent in a container. Returns the accumulated subagent text output. */
export const runSubagent = (input: SubagentInput) =>
  Effect.gen(function* () {
    const claude = yield* Claude
    const log = yield* CharacterLog

    const prompt = buildSubagentPrompt(input)

    yield* log.action(input.char, {
      timestamp: new Date().toISOString(),
      source: "orchestrator",
      character: input.char.name,
      type: "subagent_spawn",
      task: input.step.task,
      goal: input.step.goal,
      model: input.step.model,
    })

    const stream = yield* claude.execInContainer({
      containerId: input.containerId,
      prompt,
      model: input.step.model,
      outputFormat: "stream-json",
    })

    // Accumulate text blocks for the completion report
    const textRef = yield* Ref.make<string[]>([])

    // Demux the stream into log files, accumulating text
    yield* demuxStream(input.char, stream, "subagent", textRef)

    const collectedText = yield* Ref.get(textRef)

    yield* log.action(input.char, {
      timestamp: new Date().toISOString(),
      source: "orchestrator",
      character: input.char.name,
      type: "subagent_complete",
      task: input.step.task,
    })

    return collectedText.join("\n")
  })
