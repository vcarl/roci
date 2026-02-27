import { Effect, Ref, Fiber, Queue } from "effect"
import { FileSystem } from "@effect/platform"
import { GameApi } from "../services/GameApi.js"
import { CharacterFs, type CharacterConfig } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import { brainPlan, brainInterrupt, brainEvaluate, type StepTiming } from "../ai/brain.js"
import { runSubagent } from "../ai/subagent.js"
import { detectInterrupts } from "./interrupt.js"
import { isStepComplete, buildStateSnapshot } from "./plan-tracker.js"
import type { Plan } from "../ai/types.js"
import type { GameState, Situation, ChatMessage, Alert } from "../../../harness/src/types.js"
import type { GameEvent, StateUpdateEvent, CombatUpdateEvent, ChatMessageEvent } from "../../../harness/src/ws-types.js"
import { logToConsole, logStateBar, logPlanTransition, logStepResult, formatError } from "../logging/console-renderer.js"
import * as path from "node:path"

export interface EventLoopConfig {
  char: CharacterConfig
  containerId: string
  playerName: string
  projectRoot: string
  containerEnv?: Record<string, string>
  events: Queue.Queue<GameEvent>
  initialState: GameState
  tickRateHz: number
}

export const eventLoop = (config: EventLoopConfig) =>
  Effect.gen(function* () {
    const api = yield* GameApi
    const charFs = yield* CharacterFs
    const log = yield* CharacterLog

    // --- State refs (same as tick-loop) ---
    const planRef = yield* Ref.make<Plan | null>(null)
    const stepRef = yield* Ref.make(0)
    const subagentFiberRef = yield* Ref.make<Fiber.RuntimeFiber<string, unknown> | null>(null)
    const tickCountRef = yield* Ref.make(0)
    const stepStartTickRef = yield* Ref.make(0)
    const subagentReportRef = yield* Ref.make("")
    const previousFailureRef = yield* Ref.make<string | null>(null)
    const stepTimingHistoryRef = yield* Ref.make<StepTiming[]>([])
    const lastProcessedTickRef = yield* Ref.make(0)
    const tickIntervalSec = 1 / config.tickRateHz

    // --- New refs for WS-driven state ---
    const gameStateRef = yield* Ref.make<GameState>(config.initialState)
    const chatContextRef = yield* Ref.make<ChatMessage[]>([])

    /**
     * Update gameStateRef from a state_update event.
     * Merges WS payload into the existing GameState.
     */
    const applyStateUpdate = (payload: StateUpdateEvent["payload"]) =>
      Ref.update(gameStateRef, (prev) => ({
        ...prev,
        player: payload.player,
        ship: payload.ship,
        nearby: payload.nearby,
        inCombat: payload.in_combat,
        tick: payload.tick,
        timestamp: Date.now(),
        travelProgress: payload.travel_progress != null
          ? {
              travel_progress: payload.travel_progress,
              travel_destination: payload.travel_destination ?? "",
              travel_type: payload.travel_type ?? "travel",
              travel_arrival_tick: payload.travel_arrival_tick ?? 0,
            }
          : null,
        // Preserve fields not in state_update (poi, system, cargo, market, etc.)
      }))

    // --- Shared logic extracted from tick-loop ---

    /** Kill the current subagent fiber if running. */
    const killSubagent = Effect.gen(function* () {
      const fiber = yield* Ref.get(subagentFiberRef)
      if (fiber) {
        yield* Fiber.interrupt(fiber).pipe(Effect.catchAll(() => Effect.void))
        yield* Ref.set(subagentFiberRef, null)
      }
    })

    /** Record step timing and log it. Returns the StepTiming entry. */
    const recordStepTiming = (task: string, goal: string, ticksBudgeted: number) =>
      Effect.gen(function* () {
        const startTick = yield* Ref.get(stepStartTickRef)
        const currentTick = yield* Ref.get(tickCountRef)
        const ticksConsumed = currentTick - startTick
        const overrun = ticksConsumed > ticksBudgeted
        const timing: StepTiming = { task, goal, ticksBudgeted, ticksConsumed, overrun }

        yield* Ref.update(stepTimingHistoryRef, (history) => [...history.slice(-9), timing])

        const budgetLabel = overrun
          ? `OVERRUN by ${ticksConsumed - ticksBudgeted}`
          : "within budget"
        yield* logToConsole(config.char.name, "monitor",
          `Step took ${ticksConsumed}/${ticksBudgeted} ticks (${budgetLabel})`)

        return timing
      })

    /** Handle critical interrupts: kill subagent, ask brain for new plan. */
    const handleInterrupt = (criticals: Alert[], state: GameState, situation: Situation, briefing: string) =>
      Effect.gen(function* () {
        yield* logToConsole(config.char.name, "monitor", `INTERRUPT: ${criticals.map((a) => a.message).join("; ")}`)

        yield* log.thought(config.char, {
          timestamp: new Date().toISOString(),
          source: "monitor",
          character: config.char.name,
          type: "interrupt",
          alerts: criticals,
          action: "killing subagent, replanning",
        })

        yield* killSubagent

        const background = yield* charFs.readBackground(config.char)
        const newPlan = yield* brainInterrupt.execute({
          state,
          situation,
          alerts: criticals,
          currentPlan: yield* Ref.get(planRef),
          briefing,
          background,
        })

        yield* log.thought(config.char, {
          timestamp: new Date().toISOString(),
          source: "brain",
          character: config.char.name,
          type: "interrupt_plan",
          plan: newPlan,
        })

        yield* logToConsole(config.char.name, "brain", `Interrupt plan: ${newPlan.reasoning}`)

        const tickCount = yield* Ref.get(tickCountRef)
        yield* Ref.set(planRef, newPlan)
        yield* Ref.set(stepRef, 0)
        yield* Ref.set(stepStartTickRef, tickCount)
      })

    /** Check if a completed subagent's step succeeded. Advance or replan. */
    const evaluateCompletedSubagent = (state: GameState) =>
      Effect.gen(function* () {
        yield* logToConsole(config.char.name, "monitor", "Subagent completed, evaluating...")

        const plan = yield* Ref.get(planRef)
        const step = yield* Ref.get(stepRef)

        if (plan && step < plan.steps.length) {
          const currentStep = plan.steps[step]
          const timing = yield* recordStepTiming(currentStep.task, currentStep.goal, currentStep.timeoutTicks)

          // Use fresh REST state for evaluation (more complete than WS state)
          const freshState = yield* api.collectState().pipe(
            Effect.catchAll(() => Effect.succeed(state)),
          )
          const report = yield* Ref.get(subagentReportRef)

          const result = yield* brainEvaluate.execute({
            step: currentStep,
            subagentReport: report,
            state: freshState,
            ticksConsumed: timing.ticksConsumed,
            ticksBudgeted: timing.ticksBudgeted,
            tickIntervalSec,
          }).pipe(
            Effect.catchAll((e) =>
              Effect.succeed({
                complete: true as const,
                reason: `Brain evaluation failed (${e}), trusting subagent completion`,
                matchedCondition: null,
                relevantState: buildStateSnapshot(freshState),
              }),
            ),
          )

          yield* logStepResult(config.char.name, step, result)

          yield* log.action(config.char, {
            timestamp: new Date().toISOString(),
            source: "monitor",
            character: config.char.name,
            type: "step_complete",
            stepIndex: step,
            task: currentStep.task,
            goal: currentStep.goal,
            successCondition: currentStep.successCondition,
            successConditionMet: result.complete,
            reason: result.reason,
            stateSnapshot: result.relevantState,
            subagentReport: report.slice(-500),
          })

          if (result.complete) {
            yield* Ref.set(stepRef, step + 1)
          } else {
            const failureContext = `Step ${step + 1} [${currentStep.task}] "${currentStep.goal}" failed: ${result.reason}\nSubagent report: ${report.slice(-300) || "(no report)"}`
            yield* logToConsole(config.char.name, "monitor", `Step ${step + 1} failed, requesting new plan...`)
            yield* Ref.set(previousFailureRef, failureContext)
            yield* Ref.set(planRef, null)
            yield* Ref.set(stepRef, 0)
          }
        }

        yield* Ref.set(subagentFiberRef, null)
        yield* Ref.set(subagentReportRef, "")
      })

    /** Check mid-run step completion and timeouts. */
    const checkMidRun = (state: GameState, situation: Situation) =>
      Effect.gen(function* () {
        const currentFiber = yield* Ref.get(subagentFiberRef)
        if (!currentFiber) return

        const plan = yield* Ref.get(planRef)
        const step = yield* Ref.get(stepRef)
        const startTick = yield* Ref.get(stepStartTickRef)
        const tickCount = yield* Ref.get(tickCountRef)

        if (plan && step < plan.steps.length) {
          const currentStep = plan.steps[step]

          const midRunResult = isStepComplete(currentStep, state, situation)
          if (midRunResult.complete) {
            yield* logToConsole(config.char.name, "monitor",
              `Step ${step + 1} condition met mid-run: ${midRunResult.reason}`)
            yield* recordStepTiming(currentStep.task, currentStep.goal, currentStep.timeoutTicks)
            yield* Fiber.interrupt(currentFiber).pipe(Effect.catchAll(() => Effect.void))
            yield* Ref.set(subagentFiberRef, null)
            yield* Ref.set(stepRef, step + 1)
          } else if (tickCount - startTick >= currentStep.timeoutTicks) {
            yield* logToConsole(config.char.name, "monitor", `Step ${step + 1} timed out — interrupting`)
            yield* recordStepTiming(currentStep.task, currentStep.goal, currentStep.timeoutTicks)
            yield* Fiber.interrupt(currentFiber).pipe(Effect.catchAll(() => Effect.void))
            yield* Ref.set(subagentFiberRef, null)
            yield* Ref.set(stepRef, step + 1)
          }
        }
      })

    /** Request a new plan from the brain if needed. */
    const maybeRequestPlan = (state: GameState, situation: Situation, briefing: string) =>
      Effect.gen(function* () {
        const plan = yield* Ref.get(planRef)
        const step = yield* Ref.get(stepRef)
        const noFiber = (yield* Ref.get(subagentFiberRef)) === null

        if (noFiber && (!plan || step >= (plan?.steps.length ?? 0))) {
          yield* logToConsole(config.char.name, "monitor", "Requesting new plan from brain...")

          const diary = yield* charFs.readDiary(config.char)
          const background = yield* charFs.readBackground(config.char)
          const values = yield* charFs.readValues(config.char)
          const previousFailure = yield* Ref.get(previousFailureRef)
          const recentChat = yield* Ref.get(chatContextRef)
          const stepTimingHistory = yield* Ref.get(stepTimingHistoryRef)

          const newPlan = yield* brainPlan.execute({
            state,
            situation,
            diary,
            briefing,
            background,
            values,
            previousFailure: previousFailure ?? undefined,
            recentChat: recentChat.length > 0 ? recentChat : undefined,
            stepTimingHistory: stepTimingHistory.length > 0 ? stepTimingHistory : undefined,
            tickIntervalSec,
          })

          yield* Ref.set(previousFailureRef, null)
          // Clear chat context after it's been consumed by the brain
          yield* Ref.set(chatContextRef, [])

          yield* log.thought(config.char, {
            timestamp: new Date().toISOString(),
            source: "brain",
            character: config.char.name,
            type: "plan",
            plan: newPlan,
            reasoning: newPlan.reasoning,
          })

          yield* logToConsole(
            config.char.name,
            "brain",
            `New plan (${newPlan.steps.length} steps): ${newPlan.reasoning}`,
          )

          const tickCount = yield* Ref.get(tickCountRef)
          yield* Ref.set(planRef, newPlan)
          yield* Ref.set(stepRef, 0)
          yield* Ref.set(stepStartTickRef, tickCount)
        }
      })

    /** Spawn a subagent for the current plan step if needed. */
    const maybeSpawnSubagent = (state: GameState, situation: Situation) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(subagentFiberRef)) !== null) return

        const currentPlan = yield* Ref.get(planRef)
        const currentStep = yield* Ref.get(stepRef)

        if (currentPlan && currentStep < currentPlan.steps.length) {
          const planStep = currentPlan.steps[currentStep]

          yield* logPlanTransition(config.char.name, currentPlan, currentStep)

          yield* logToConsole(
            config.char.name,
            "monitor",
            `Spawning subagent: [${planStep.task}] ${planStep.goal} (${planStep.model})`,
          )

          const personality = yield* charFs.readBackground(config.char)
          const values = yield* charFs.readValues(config.char)
          const fs = yield* FileSystem.FileSystem
          const systemPrompt = yield* fs.readFileString(
            path.resolve(config.projectRoot, "in-game-CLAUDE.md"),
          ).pipe(Effect.catchAll(() => Effect.succeed("")))

          const fiber = yield* runSubagent({
            char: config.char,
            containerId: config.containerId,
            playerName: config.playerName,
            systemPrompt,
            containerEnv: config.containerEnv,
            step: planStep,
            state,
            situation,
            personality,
            values,
            tickRateHz: config.tickRateHz,
          }).pipe(
            Effect.tap((report) => Ref.set(subagentReportRef, report)),
            Effect.catchAll((e) =>
              Effect.gen(function* () {
                const msg = formatError(e)
                yield* Ref.set(subagentReportRef, `[SUBAGENT ERROR] ${msg}`)
                yield* logToConsole(config.char.name, "error", msg)
                return ""
              }),
            ),
            Effect.fork,
          )

          const tickCount = yield* Ref.get(tickCountRef)
          yield* Ref.set(subagentFiberRef, fiber)
          yield* Ref.set(stepStartTickRef, tickCount)
        }
      })

    // --- Main event processing ---

    /** Process a state_update event: the core decision cycle. */
    const handleStateUpdate = (payload: StateUpdateEvent["payload"]) =>
      Effect.gen(function* () {
        yield* applyStateUpdate(payload)
        const state = yield* Ref.get(gameStateRef)
        const situation = api.classify(state)
        const briefing = api.briefing(state, situation)

        yield* logStateBar(config.char.name, state, situation)

        // Check for interrupts
        const criticals = detectInterrupts(situation)
        if (criticals.length > 0) {
          yield* handleInterrupt(criticals, state, situation, briefing)
        }

        // Check if subagent finished
        const currentFiber = yield* Ref.get(subagentFiberRef)
        if (currentFiber) {
          const poll = yield* Fiber.poll(currentFiber)
          if (poll._tag === "Some") {
            yield* evaluateCompletedSubagent(state)
          }
        }

        // Plan + spawn cycle
        yield* maybeRequestPlan(state, situation, briefing)
        yield* maybeSpawnSubagent(state, situation)
      })

    /** Process a tick event: heartbeat, timeout checks, and proactive plan/spawn. */
    const handleTick = (tick: number) =>
      Effect.gen(function* () {
        // Detect tick skips (processing took longer than tick interval)
        const lastTick = yield* Ref.get(lastProcessedTickRef)
        if (lastTick > 0 && tick - lastTick > 1) {
          yield* logToConsole(config.char.name, "monitor",
            `Skipped ${tick - lastTick - 1} ticks (processing took longer than tick interval)`)
        }
        yield* Ref.set(lastProcessedTickRef, tick)
        yield* Ref.set(tickCountRef, tick)

        const state = yield* Ref.get(gameStateRef)
        const situation = api.classify(state)
        const briefing = api.briefing(state, situation)

        // Check mid-run completion and timeouts
        yield* checkMidRun(state, situation)

        // Check if subagent finished
        const currentFiber = yield* Ref.get(subagentFiberRef)
        if (currentFiber) {
          const poll = yield* Fiber.poll(currentFiber)
          if (poll._tag === "Some") {
            yield* evaluateCompletedSubagent(state)
          }
        }

        // Proactive plan/spawn cycle — drives forward progress even without state_update
        yield* maybeRequestPlan(state, situation, briefing)
        yield* maybeSpawnSubagent(state, situation)
      })

    /** Process a combat_update event: immediate interrupt if not already handling. */
    const handleCombatUpdate = (payload: CombatUpdateEvent["payload"]) =>
      Effect.gen(function* () {
        yield* logToConsole(config.char.name, "ws:combat",
          `${payload.attacker} → ${payload.target}: ${payload.damage} dmg${payload.destroyed ? " [DESTROYED]" : ""}`)

        yield* log.action(config.char, {
          timestamp: new Date().toISOString(),
          source: "ws",
          character: config.char.name,
          type: "combat_update",
          ...payload,
        })

        // If we're not already in a combat plan, create interrupt
        const plan = yield* Ref.get(planRef)
        const currentStep = yield* Ref.get(stepRef)
        const isInCombatPlan = plan && currentStep < plan.steps.length && plan.steps[currentStep].task === "combat"

        if (!isInCombatPlan) {
          const state = yield* Ref.get(gameStateRef)
          const situation = api.classify(state)
          const briefing = api.briefing(state, situation)
          const combatAlert: Alert = {
            priority: "critical",
            message: `Combat: ${payload.attacker} attacking ${payload.target} for ${payload.damage} damage`,
            suggestedAction: "Assess threat and respond",
          }
          yield* handleInterrupt([combatAlert], state, situation, briefing)
        }
      })

    /** Process a chat_message event: log and accumulate for brain. */
    const handleChatMessage = (payload: ChatMessageEvent["payload"]) =>
      Effect.gen(function* () {
        yield* logToConsole(config.char.name, "ws:chat",
          `[${payload.channel}] ${payload.sender}: ${payload.content}`)

        yield* log.word(config.char, {
          timestamp: new Date().toISOString(),
          source: "ws",
          character: config.char.name,
          type: "chat_received",
          channel: payload.channel,
          sender: payload.sender,
          content: payload.content,
        })

        // Accumulate for next brain plan (keep last 20 messages)
        yield* Ref.update(chatContextRef, (msgs) => {
          const updated = [...msgs, {
            id: payload.id,
            sender_id: payload.sender_id,
            sender: payload.sender,
            channel: payload.channel,
            content: payload.content,
            timestamp: payload.timestamp,
          }]
          return updated.slice(-20)
        })
      })

    // --- Event loop ---

    yield* logToConsole(config.char.name, "monitor", "Starting event loop (WebSocket-driven)...")

    // Initial planning on startup — don't wait for first event
    yield* Effect.gen(function* () {
      const state = yield* Ref.get(gameStateRef)
      const situation = api.classify(state)
      const briefing = api.briefing(state, situation)
      yield* logStateBar(config.char.name, state, situation)
      yield* maybeRequestPlan(state, situation, briefing)
      yield* maybeSpawnSubagent(state, situation)
    }).pipe(
      Effect.catchAllCause((cause) => {
        const msg = cause.toString().slice(0, 500)
        return logToConsole(config.char.name, "error", `Initial planning error: ${msg}`)
      }),
    )

    yield* Effect.forever(
      Effect.gen(function* () {
        const event = yield* Queue.take(config.events)

        yield* Effect.gen(function* () {
          switch (event.type) {
            case "state_update":
              yield* handleStateUpdate(event.payload)
              break

            case "tick":
              yield* handleTick(event.payload.tick)
              break

            case "combat_update":
              yield* handleCombatUpdate(event.payload)
              break

            case "player_died":
              yield* logToConsole(config.char.name, "ws:death",
                `Killed by ${event.payload.killer_name}: ${event.payload.cause}. Respawning at ${event.payload.respawn_base}`)
              yield* killSubagent
              yield* Ref.set(planRef, null)
              yield* Ref.set(stepRef, 0)
              break

            case "chat_message":
              yield* handleChatMessage(event.payload)
              break

            case "mining_yield":
              yield* logToConsole(config.char.name, "ws:mining",
                `Yield: ${event.payload.quantity}x ${event.payload.resource_id} (${event.payload.remaining} remaining)`)
              break

            case "poi_arrival":
              yield* logToConsole(config.char.name, "ws:arrival",
                `${event.payload.username} arrived at ${event.payload.poi_name}`)
              break

            case "poi_departure":
              yield* logToConsole(config.char.name, "ws:departure",
                `${event.payload.username} departed ${event.payload.poi_name}`)
              break

            case "skill_level_up":
              yield* logToConsole(config.char.name, "ws:skill",
                `Level up! ${event.payload.skill_id} → level ${event.payload.new_level}`)
              break

            case "trade_offer_received":
              yield* logToConsole(config.char.name, "ws:trade",
                `Trade offer from ${event.payload.from_name} (trade_id: ${event.payload.trade_id})`)
              break

            case "error":
              yield* logToConsole(config.char.name, "ws:error",
                `[${event.payload.code}] ${event.payload.message}`)
              break

            case "ok":
              // Action acknowledgements — log at debug level
              yield* logToConsole(config.char.name, "ws:ok", JSON.stringify(event.payload))
              break

            case "welcome":
            case "logged_in":
              // Connection lifecycle events — already handled by GameSocket
              break

            default:
              yield* logToConsole(config.char.name, `ws:${(event as { type: string }).type}`,
                JSON.stringify((event as { payload?: unknown }).payload ?? {}))
              break
          }
        }).pipe(
          Effect.catchAll((e) => {
            const msg = formatError(e)
            return logToConsole(config.char.name, "error", `Event processing error: ${msg}`)
          }),
        )
      }),
    )
  })
