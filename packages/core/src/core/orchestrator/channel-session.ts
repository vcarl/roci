import { Effect, Queue, Option, Fiber } from "effect"
import type { CharacterConfig } from "../../services/CharacterFs.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { CommandExecutor } from "@effect/platform"
import { EventProcessorTag } from "../limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../limbic/amygdala/interrupt.js"
import { PromptBuilderTag } from "../prompt-builder.js"
import { StateRendererTag } from "../state-renderer.js"
import { runSession } from "../limbic/hypothalamus/session-runner.js"
import type { SessionHandle } from "../limbic/hypothalamus/session-runner.js"
import { OAuthToken } from "../../services/OAuthToken.js"
import { CharacterLog } from "../../logging/log-writer.js"
import { logToConsole } from "../../logging/console-renderer.js"
import type { ModelConfig } from "../model-config.js"
import type { Alert } from "../types.js"

// ── Types ────────────────────────────────────────────────────

export interface ChannelSessionConfig {
  char: CharacterConfig
  containerId: string
  containerEnv?: Record<string, string>
  addDirs?: string[]
  events: Queue.Queue<unknown>
  initialState: unknown
  sessionModel?: string
  sessionTimeoutMs?: number
  channelPort?: number
  models: ModelConfig
}

export type ChannelSessionResult =
  | { readonly _tag: "Completed"; readonly finalState: unknown }
  | { readonly _tag: "Interrupted"; readonly finalState: unknown; readonly criticals: Alert[] }

// ── Default constants ────────────────────────────────────────

const DEFAULT_SESSION_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour
const TICK_INTERVAL_MS = 30_000 // 30 seconds
const POST_SPAWN_DELAY_MS = 2_000 // 2 seconds after spawning before pushing task

// ── runChannelSession ────────────────────────────────────────

export const runChannelSession = (config: ChannelSessionConfig) =>
  Effect.gen(function* () {
    const eventProcessor = yield* EventProcessorTag
    const classifier = yield* SituationClassifierTag
    const interruptRegistry = yield* InterruptRegistryTag
    const promptBuilder = yield* PromptBuilderTag
    const renderer = yield* StateRendererTag
    const charFs = yield* CharacterFs

    let currentState = config.initialState
    let prevSnapshot = renderer.richSnapshot(currentState)
    let sessionHandle: SessionHandle | null = null
    let tickNumber = 0

    const sessionTimeoutMs = config.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS
    const sessionModel = config.sessionModel ?? "sonnet"

    // Determine system prompt
    const systemPrompt = promptBuilder.systemPrompt("select", "")

    while (true) {
      tickNumber++

      // ── 1. Drain event queue (non-blocking) ──────────────────

      let drained = false
      while (!drained) {
        const maybeEvent = yield* Queue.poll(config.events)
        if (Option.isNone(maybeEvent)) {
          drained = true
        } else {
          const event = maybeEvent.value
          yield* Effect.try(() => {
            const result = eventProcessor.processEvent(event, currentState)
            if (result.stateUpdate) {
              currentState = result.stateUpdate(currentState)
            }
            if (result.log) {
              result.log()
            }
          }).pipe(
            Effect.catchAll((e) =>
              logToConsole(config.char.name, "error", `Event processing error: ${e}`),
            ),
          )
        }
      }

      // ── 2. Classify situation ────────────────────────────────

      const summary = classifier.summarize(currentState)

      // ── 3. Evaluate interrupts ───────────────────────────────

      const allAlerts = interruptRegistry.evaluate(currentState, summary.situation)
      const criticals = allAlerts.filter((a) => a.priority === "critical")

      // ── 4. If criticals: interrupt session and return ────────

      if (criticals.length > 0) {
        yield* logToConsole(
          config.char.name,
          "orchestrator",
          `Critical interrupt: ${criticals.map((a) => a.message).join("; ")} — stopping session`,
        )
        if (sessionHandle !== null) {
          yield* sessionHandle.interrupt
        }
        return {
          _tag: "Interrupted" as const,
          finalState: currentState,
          criticals,
        }
      }

      // ── 5. Check if session has completed ───────────────────

      if (sessionHandle !== null) {
        // Poll session completion without blocking: race join against zero timeout.
        // Effect.timeoutOption wraps result in Option: Some(value) = completed, None = timed out.
        const isComplete = yield* sessionHandle.join.pipe(
          Effect.timeoutOption("0 millis"),
          Effect.map(Option.isSome),
        )

        if (isComplete) {
          yield* logToConsole(
            config.char.name,
            "orchestrator",
            `Session completed naturally — tick ${tickNumber}`,
          )
          return {
            _tag: "Completed" as const,
            finalState: currentState,
          }
        }
      }

      // ── 6. If session running: push state update ─────────────

      if (sessionHandle !== null) {
        const currentSnapshot = renderer.richSnapshot(currentState)
        const stateDiff = renderer.stateDiff(prevSnapshot, currentSnapshot)
        const softAlerts = allAlerts.filter((a) => a.priority !== "critical")

        const channelEventContent =
          promptBuilder.channelEvent?.({
            summary,
            stateDiff: stateDiff || undefined,
            softAlerts: softAlerts.length > 0 ? softAlerts : undefined,
            tickNumber,
          }) ?? JSON.stringify({ summary: summary.headline, stateDiff, tickNumber })

        yield* sessionHandle.pushEvent(channelEventContent, { type: "tick" }).pipe(
          Effect.catchAll((e) =>
            logToConsole(config.char.name, "error", `pushEvent (tick) failed: ${e}`),
          ),
        )

        prevSnapshot = currentSnapshot
      }

      // ── 7. If no session: start one ──────────────────────────

      if (sessionHandle === null) {
        yield* logToConsole(
          config.char.name,
          "orchestrator",
          `Starting channel session (model=${sessionModel})`,
        )

        // Read identity
        const background = yield* charFs.readBackground(config.char).pipe(
          Effect.catchAll(() => Effect.succeed("")),
        )
        const values = yield* charFs.readValues(config.char).pipe(
          Effect.catchAll(() => Effect.succeed("")),
        )
        const diary = yield* charFs.readDiary(config.char).pipe(
          Effect.catchAll(() => Effect.succeed("")),
        )

        // Build task prompt content
        const taskContent =
          promptBuilder.taskPrompt?.({
            state: currentState,
            summary,
            diary,
            background,
            values,
          }) ?? "Begin working."

        // Spawn session
        const handle = yield* runSession({
          containerId: config.containerId,
          playerName: config.char.name,
          systemPrompt,
          model: sessionModel,
          sessionTimeoutMs,
          env: config.containerEnv,
          addDirs: config.addDirs,
          char: config.char,
          channelPort: config.channelPort,
        })

        sessionHandle = handle

        // Wait 2 seconds then push the task as first channel event
        yield* Effect.sleep(`${POST_SPAWN_DELAY_MS} millis`)
        yield* sessionHandle.pushEvent(taskContent, { type: "task" }).pipe(
          Effect.catchAll((e) =>
            logToConsole(config.char.name, "error", `pushEvent (task) failed: ${e}`),
          ),
        )

        yield* logToConsole(
          config.char.name,
          "orchestrator",
          `Session started — task event pushed`,
        )
      }

      // ── 8. Sleep tick interval ───────────────────────────────

      yield* Effect.sleep(`${TICK_INTERVAL_MS} millis`)
    }
  })
