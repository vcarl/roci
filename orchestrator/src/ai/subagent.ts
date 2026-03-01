import { Effect, Ref } from "effect"
import { Claude, ClaudeError } from "../services/Claude.js"
import { CharacterLog } from "../logging/log-writer.js"
import { demuxStream } from "../logging/log-demux.js"
import { logStderr, logStreamEvent } from "../logging/console-renderer.js"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { PlanStep } from "./types.js"
import type { GameState, Situation } from "../../../harness/src/types.js"

export interface SubagentInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  systemPrompt: string  // in-game-CLAUDE.md content, passed via --system-prompt
  containerEnv?: Record<string, string>  // env vars passed at docker exec time
  step: PlanStep
  state: GameState
  situation: Situation
  personality: string  // character background snippet
  values: string       // character values snippet
  tickIntervalSec: number   // seconds per tick from server
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

    market_sell: `Sell cargo at the current station. Use \`sm market sell [item_id] [quantity] [price]\` to create sell orders. Check market prices first with \`sm market\` and \`sm listings [item_id]\` to see what players are paying. Sell strategically — price competitively against existing orders.`,

    dock: `Dock at the nearest station. Use \`sm dock\` if at a dockable POI. If not at a dockable POI, travel to one first.`,

    undock: `Undock from the current station. Use \`sm undock\` to leave the station.`,

    refuel: `Refuel your ship. Use \`sm refuel\` while docked. Ensure you have enough credits.`,

    repair: `Repair your ship. Use \`sm repair\` while docked. Ensure you have enough credits.`,

    combat: `You are in combat. Assess the threat. Use \`sm attack [target]\` to fight or \`sm flee\` to escape. Check \`sm status\` to monitor hull and shields. Prioritize survival.`,

    chat: `Read recent chat and respond appropriately. Use \`sm chat history\` to read messages, \`sm chat send [channel] [message]\` to respond. Stay in character.`,

    explore: `Explore the current area. Check \`sm status\` for your situation, \`sm system\` for POIs, \`sm map\` for connected systems. Make observations and decide what to do next.`,
  }

  const taskInstruction = taskPrompts[step.task] ?? taskPrompts.explore
  const tickIntervalSec = input.tickIntervalSec
  const budgetSeconds = Math.round(step.timeoutTicks * tickIntervalSec)

  return `# Your Mission

${taskInstruction}

## Specific Goal
${step.goal}

## Success Condition
${step.successCondition}

## Time Budget
You have ${step.timeoutTicks} game ticks (~${budgetSeconds}s) to complete this task.
Work efficiently — execute commands, check results, and move on. Do not deliberate excessively.
If you are running low on time, wrap up with a COMPLETION REPORT of what you accomplished.

## Current State
${briefing}

## Who You Are
${personality.slice(0, 800)}

## Your Values (brief)
${values.slice(0, 500)}

## Available Commands
The \`sm\` CLI is already installed on your PATH — just run it directly. Do NOT try to install, build, or locate it. Run \`sm --help\` for the full list of commands. Key commands:
- \`sm status\` — check your current state
- \`sm mine\` — mine resources at current POI
- \`sm market sell [item_id] [qty] [price]\` — create a sell order
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

    // Accumulate text blocks for the completion report
    const textRef = yield* Ref.make<string[]>([])

    // Scoped block keeps the process alive through stream consumption + waitForExit
    const { exitCode, stderr } = yield* Effect.scoped(
      Effect.gen(function* () {
        const { stream, waitForExit } = yield* claude.execInContainer({
          containerId: input.containerId,
          playerName: input.playerName,
          prompt,
          model: input.step.model,
          systemPrompt: input.systemPrompt,
          outputFormat: "stream-json",
          env: input.containerEnv,
        })

        // Demux the stream into log files, accumulating text
        yield* demuxStream(input.char, stream, "subagent", textRef)

        // Wait for process exit and capture stderr
        return yield* waitForExit
      }),
    )

    if (stderr.trim()) {
      yield* logStderr(input.char.name, stderr)
    }

    if (exitCode !== 0) {
      yield* log.action(input.char, {
        timestamp: new Date().toISOString(),
        source: "orchestrator",
        character: input.char.name,
        type: "subagent_error",
        task: input.step.task,
        exitCode,
        stderr: stderr.trim().slice(0, 1000),
      })
      return yield* Effect.fail(
        new ClaudeError(
          `Subagent exited with code ${exitCode}: ${stderr.trim().slice(0, 500)}`,
        ),
      )
    }

    const collectedText = yield* Ref.get(textRef)

    if (collectedText.length === 0) {
      yield* logStreamEvent(input.char.name, "warn", "Subagent produced no text output")
    }

    yield* log.action(input.char, {
      timestamp: new Date().toISOString(),
      source: "orchestrator",
      character: input.char.name,
      type: "subagent_complete",
      task: input.step.task,
    })

    return collectedText.join("\n")
  })
