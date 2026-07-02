import { describe, it, expect } from "vitest"
import { Effect, Layer, Queue, Fiber, Option } from "effect"
import { CommandExecutor } from "@effect/platform"
import { runCortex } from "./loop.js"
import { ModelClient } from "../model/client.js"
import { ModelError } from "../model/errors.js"
import type { ModelHandle } from "../model/handles.js"
import { ConsciousThought, ConsciousThoughtTest } from "../conscious/conscious-thought.js"
import { Docker } from "../services/Docker.js"
import type { TurnResult } from "../core/limbic/hypothalamus/types.js"
import { EventProcessorTag } from "../core/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../core/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../core/limbic/amygdala/interrupt.js"
import { StateRendererTag } from "../core/state-renderer.js"
import { PromptBuilderTag } from "../core/prompt-builder.js"
import { CharacterFs, CharacterFsError } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { MemoryGateway } from "../conscious/memory-gateway.js"
import { STEP_DONE_MARKER } from "./state.js"
import { ModelService } from "../services/ModelService.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setEpisodeLogRoot, resetEpisodeContext } from "../logging/episodes.js"

// No-op ModelService: withTier is transparent (passes the effect through unchanged).
const noopModelService = Layer.succeed(
  ModelService,
  ModelService.of({
    withTier: (_tier) => (effect) => effect as never,
  }),
)

// ModelClient that branches on which skill template produced the prompt.
// Classify by unique COMBINATION of markers (see original test comment for rationale).
const scriptedClient = Layer.succeed(
  ModelClient,
  ModelClient.of({
    complete: (_h: ModelHandle, messages) =>
      Effect.sync(() => {
        const p = messages.map((m) => m.content).join(" ").toLowerCase()
        // Diary turn carries the "judgment" label — branch on its unique
        // "plain prose" phrase FIRST so it isn't mistaken for an evaluate call.
        if (p.includes("plain prose")) return { text: "Fixture diary text.", raw: {} }
        const hasDisposition = p.includes("disposition")
        const hasDecision = p.includes("decision")
        const hasHeadline = p.includes("headline")
        const hasJudgment = p.includes("judgment")
        if (hasDisposition && !hasDecision)
          return {
            text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}',
            raw: {},
          }
        if (hasJudgment && !hasHeadline)
          return {
            text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}',
            raw: {},
          }
        if (hasHeadline && !hasJudgment)
          return {
            text: '{"headline":"act now","sections":[{"id":"s1","heading":"Action","body":"Get moving."}],"whatChanged":"things changed","emotionalState":"😰","metrics":{}}',
            raw: {},
          }
        // decide
        return {
          text: '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do the thing","tier":"smart","successCondition":"thing done","timeoutTicks":2}]}',
          raw: {},
        }
      }),
  }),
)

// Scripted client where first evaluate → next_step, second → terminate (multi-step test).
const makeMultiStepClient = (evalCountRef: { n: number }) =>
  Layer.succeed(
    ModelClient,
    ModelClient.of({
      complete: (_h: ModelHandle, messages) =>
        Effect.sync(() => {
          const p = messages.map((m) => m.content).join(" ").toLowerCase()
          // Diary turn carries the "judgment" label too — branch on its unique
          // "plain prose" phrase FIRST so it isn't counted as an evaluate call.
          if (p.includes("plain prose")) return { text: "Fixture diary text.", raw: {} }
          const hasDisposition = p.includes("disposition")
          const hasDecision = p.includes("decision")
          const hasHeadline = p.includes("headline")
          const hasJudgment = p.includes("judgment")
          if (hasDisposition && !hasDecision)
            return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
          if (hasJudgment && !hasHeadline) {
            evalCountRef.n++
            const transition =
              evalCountRef.n === 1
                ? '{"transition":"next_step"}'
                : '{"transition":"terminate","summary":"all done"}'
            return {
              text: `{"judgment":"succeeded","reasoning":"done","transition":${transition}}`,
              raw: {},
            }
          }
          if (hasHeadline && !hasJudgment)
            return {
              text: '{"headline":"act now","sections":[{"id":"s1","heading":"Detail","body":"Do it."}],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
              raw: {},
            }
          // decide → two steps, timeoutTicks: 4 so budget doesn't fire first
          return {
            text: '{"decision":"plan","reasoning":"go","steps":[{"task":"step-one","goal":"first","tier":"smart","successCondition":"done","timeoutTicks":4},{"task":"step-two","goal":"second","tier":"smart","successCondition":"done","timeoutTicks":4}]}',
            raw: {},
          }
        }),
    }),
  )

// Default domain: events are STATE-CHANGING (processEvent returns a stateUpdate),
// so they pass the loop's !stateUpdate fast-path and reach the (scripted)
// hindbrain. An identity stateUpdate is enough to mark the event non-inert.
const fakeDomain = Layer.mergeAll(
  Layer.succeed(
    EventProcessorTag,
    EventProcessorTag.of({ processEvent: () => ({ stateUpdate: (s: unknown) => s }) }),
  ),
  Layer.succeed(
    SituationClassifierTag,
    SituationClassifierTag.of({
      summarize: () => ({ situation: {} as never, headline: "h", sections: [], metrics: {} }),
    }),
  ),
  Layer.succeed(
    InterruptRegistryTag,
    InterruptRegistryTag.of({
      rules: [],
      evaluate: () => [],
      criticals: () => [],
      softAlerts: () => [],
    }),
  ),
  Layer.succeed(
    StateRendererTag,
    StateRendererTag.of({
      richSnapshot: () => ({}),
      stateDiff: () => "",
      formatStateBar: () => "",
    }),
  ),
  Layer.succeed(
    PromptBuilderTag,
    PromptBuilderTag.of({ systemPrompt: () => "you are an agent" }),
  ),
)

const fakeFs = Layer.succeed(
  CharacterFs,
  CharacterFs.of({
    readDiary: () => Effect.succeed(""),
    writeDiary: () => Effect.void,
    readSecrets: () => Effect.succeed(""),
    writeSecrets: () => Effect.void,
    readCredentials: () => Effect.succeed({ username: "", password: "" }),
    readBackground: () => Effect.succeed(""),
    readValues: () => Effect.succeed(""),
    readPalette: () => Effect.succeed(""),
    readDrives: () => Effect.succeed(""),
    characterExists: () => Effect.succeed(true),
  }),
)
const fakeLog = Layer.succeed(CharacterLog, CharacterLog.of({ emit: () => Effect.void }))
const fakeIo = Layer.mergeAll(fakeFs, fakeLog)

// Stubs for services declared in ConsciousThought's requirement channels.
const StubCommandExecutor = Layer.succeed(
  CommandExecutor.CommandExecutor,
  { start: () => { throw new Error("stub CommandExecutor: not implemented") } } as unknown as CommandExecutor.CommandExecutor,
)
const StubOAuthToken = Layer.succeed(
  OAuthToken,
  OAuthToken.of({
    getToken: Effect.succeed({ token: "stub", version: 0 }),
    validateInContainer: () => Effect.succeed(true),
  }),
)
const StubDocker = Layer.succeed(
  Docker,
  Docker.of({ exec: () => Effect.succeed("") } as unknown as typeof Docker.Service),
)
const fakeMemory = Layer.succeed(
  MemoryGateway,
  MemoryGateway.of({ remember: () => Effect.void, recall: () => Effect.succeed("") }),
)
const fakeRuntimeDeps = Layer.mergeAll(StubCommandExecutor, StubOAuthToken, StubDocker, fakeMemory)

/** Canonical canned TurnResult for a step that completes successfully. */
const successTurnResult = (task: string): TurnResult => ({
  output: `did ${task.slice(0, 10)} ${STEP_DONE_MARKER}`,
  timedOut: false,
  durationMs: 10,
})

describe("runCortex (conscious-session executor)", () => {
  it("turn 1 opens a session and the loop completes when evaluate returns terminate", async () => {
    let turnCallCount = 0
    const ctLayer = ConsciousThoughtTest((config, resume) => {
      turnCallCount++
      // First call: no resume (turn 1 opens session)
      if (!resume) {
        return { result: successTurnResult(config.prompt), sessionId: "ses_001" }
      }
      return { result: successTurnResult(config.prompt), sessionId: "ses_001" }
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      const result = yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(scriptedClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
      return { result, turnCallCount }
    })
    const { result, turnCallCount: count } = await Effect.runPromise(program)
    // Turn 1 must have been called (opens session)
    expect(count).toBeGreaterThanOrEqual(1)
    expect(result._tag).toBe("Completed")
  }, 20_000)

  it("done-marker in turn output triggers early evaluate before tick-budget", async () => {
    // The step has timeoutTicks: 10, but turn 1 returns STEP_DONE_MARKER → evaluate fires immediately.
    let evaluateCallCount = 0
    // Intercept evaluate by counting how many times the model is called with "judgment"
    const countingEvalClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            // The dedicated diary turn's prompt also carries the "judgment" label;
            // branch on its unique "plain prose" phrase FIRST so it isn't miscounted
            // as an evaluate call below.
            if (p.includes("plain prose")) return { text: "Fixture diary text.", raw: {} }
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline) {
              evaluateCallCount++
              return {
                text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}',
                raw: {},
              }
            }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            return {
              text: `{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":10}]}`,
              raw: {},
            }
          }),
      }),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `task done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_done",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      const result = yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(countingEvalClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
      return result
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // evaluate was called exactly once (early, on done-marker)
    expect(evaluateCallCount).toBe(1)
  }, 20_000)

  it("tick-budget expiry triggers salvage evaluate when no done-marker", async () => {
    // Step timeoutTicks: 1 — after 1 tick the budget fires even without STEP_DONE_MARKER.
    const budgetClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            // Diary turn carries the "judgment" label — branch on its unique
            // "plain prose" phrase FIRST so it isn't mistaken for an evaluate call.
            if (p.includes("plain prose")) return { text: "Fixture diary text.", raw: {} }
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"salvage","transition":{"transition":"terminate","summary":"salvaged"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            return {
              text: `{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":1}]}`,
              raw: {},
            }
          }),
      }),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      // No STEP_DONE_MARKER in output
      result: { output: "making progress...", timedOut: false, durationMs: 5 },
      sessionId: "ses_budget",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(budgetClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
  }, 20_000)

  it("non-discard hindbrain during session stores a pendingDirective for the next steer turn", async () => {
    // We verify this by checking that ConsciousThoughtTest's onSteer receives the directive
    // (onSteer is called on resume turns, which only happen when a directive was pending).
    const capturedDirectives: string[] = []
    // The step has a large timeoutTicks (30) so the tick-budget backstop cannot salvage-complete
    // the step before the mid-session event lands. Turn 1 returns no done-marker; a mid-session
    // event (forked offerer below) triggers in-session hindbrain (non-discard) → forebrain →
    // directive stored. Once the cadence window opens (tick - lastSteerTick >= 3) the steer turn
    // fires (turn 2 returns the done-marker → step completes → evaluate → terminate).
    const steerClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            // Diary turn carries the "judgment" label — branch on its unique
            // "plain prose" phrase FIRST so it isn't mistaken for an evaluate call.
            if (p.includes("plain prose")) return { text: "Fixture diary text.", raw: {} }
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"focus on login","sections":[{"id":"s1","heading":"Priority","body":"Fix the login bug."}],"whatChanged":"login broken","emotionalState":"😟","metrics":{}}',
                raw: {},
              }
            return {
              text: `{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}`,
              raw: {},
            }
          }),
      }),
    )
    let turnCount = 0
    const ctLayer = ConsciousThoughtTest(
      (config, resume) => {
        turnCount++
        if (turnCount >= 2) {
          // Second+ turn: emit done marker to end the step
          return {
            result: { output: `steered ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
            sessionId: "ses_steer",
          }
        }
        return { result: { output: "working...", timedOut: false, durationMs: 5 }, sessionId: "ses_steer" }
      },
      (directive) => capturedDirectives.push(directive),
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" }) // tick 1: forms the plan, opens turn 1
      // Deliver a mid-session event AFTER turn 1 has opened the session, so the hindbrain
      // triages it in-session (currentPlan !== null) → forebrain → directive. The step only
      // completes via a steer turn carrying a directive (turn 2 returns the done-marker), so
      // the loop deterministically stays in-session until steering occurs — wall-clock affects
      // only the tick count, not the ordering.
      yield* Effect.forkDaemon(
        Effect.sleep("8 millis").pipe(
          Effect.andThen(Queue.offer(events, { type: "mid-session-update" })),
        ),
      )
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(steerClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // At least one steer directive was captured (hard assertion — must not be vacuous).
    expect(capturedDirectives.length).toBeGreaterThanOrEqual(1)
    // The directive text is laundered (model-generated headline/body, not raw event text)
    const allDirectives = capturedDirectives.join(" ")
    expect(allDirectives).toContain("focus on login")
  }, 20_000)

  it("cadence throttle: steer turn carries the latest coalesced directive", async () => {
    // The steer turn receives the latest forebrain directive as its prompt; verified via onSteer.
    // Setup: a large timeoutTicks (30) so the budget can't pre-empt; the plan-forming orient
    // produces "first orient" (idle), and the mid-session orient produces "second orient (newest)",
    // which is the directive carried by the steer turn. (Pure newest-wins overwrite of
    // pendingDirective is a deterministic assignment, covered by the overwrite semantics.)
    const capturedDirectives: string[] = []
    let orientCallCount = 0
    const coalesceClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            // Diary turn carries the "judgment" label — branch on its unique
            // "plain prose" phrase FIRST so it isn't mistaken for an evaluate call.
            if (p.includes("plain prose")) return { text: "Fixture diary text.", raw: {} }
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment) {
              orientCallCount++
              const headline = orientCallCount === 1 ? "first orient" : "second orient (newest)"
              return {
                text: `{"headline":"${headline}","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}`,
                raw: {},
              }
            }
            return {
              text: `{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}`,
              raw: {},
            }
          }),
      }),
    )
    let turnCount = 0
    const ctLayer = ConsciousThoughtTest(
      (_config, _resume) => {
        turnCount++
        if (turnCount >= 2) {
          return {
            result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
            sessionId: "ses_coalesce",
          }
        }
        return { result: { output: "working", timedOut: false, durationMs: 5 }, sessionId: "ses_coalesce" }
      },
      (d) => capturedDirectives.push(d),
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "event-a" }) // tick 1: forms the plan (orient #1 = "first orient")
      // Mid-session event → in-session forebrain (orient #2 = "second orient (newest)") → directive.
      yield* Effect.forkDaemon(
        Effect.sleep("8 millis").pipe(
          Effect.andThen(Queue.offer(events, { type: "event-b" })),
        ),
      )
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(coalesceClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // A throttled steer turn fired carrying the laundered, latest forebrain directive (hard assertion).
    // (Pure newest-wins/overwrite coalescing of pendingDirective is covered deterministically by the
    // overwrite semantics; this loop-level test verifies a steer turn fires with the latest directive.)
    expect(capturedDirectives.length).toBeGreaterThanOrEqual(1)
    expect(capturedDirectives[capturedDirectives.length - 1]).toContain("second orient (newest)")
  }, 20_000)

  it("runs a dedicated diary turn after evaluate and appends the reflection to the diary", async () => {
    // After a step completes and evaluate runs, a dedicated diary model turn must fire
    // and its prose must be appended via charFs.writeDiary. The diary skill prompt is the
    // only one containing the phrase "plain prose" — branch on it (ordered FIRST so the
    // "judgment" label it also carries doesn't fall through to the evaluate branch).
    const diaryWrites: string[] = []
    const capturingFs = Layer.succeed(
      CharacterFs,
      CharacterFs.of({
        readDiary: () => Effect.succeed(""),
        writeDiary: (_char, content) =>
          Effect.sync(() => {
            diaryWrites.push(content)
          }),
        readSecrets: () => Effect.succeed(""),
        writeSecrets: () => Effect.void,
        readCredentials: () => Effect.succeed({ username: "", password: "" }),
        readBackground: () => Effect.succeed(""),
        readValues: () => Effect.succeed(""),
        readPalette: () => Effect.succeed(""),
        readDrives: () => Effect.succeed(""),
        characterExists: () => Effect.succeed(true),
      }),
    )
    const diaryIo = Layer.mergeAll(capturingFs, fakeLog)
    const diaryClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            // Diary discriminator FIRST — its prompt also contains the "judgment" label.
            if (p.includes("plain prose")) return { text: "Fixture diary text.", raw: {} }
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            return {
              text: `{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":10}]}`,
              raw: {},
            }
          }),
      }),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `task done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_diary",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(diaryClient, ctLayer, fakeDomain, diaryIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // The dedicated diary turn ran and appended its prose.
    expect(diaryWrites.length).toBeGreaterThanOrEqual(1)
    expect(diaryWrites.join("\n")).toContain("Fixture diary text.")
  }, 20_000)

  it("a decide=plan with no actionable steps is dropped LOUDLY (warn) and never goes active", async () => {
    // Issue 4: a parseable `{"decision":"plan","steps":[]}` must NOT enter the
    // active state (no conscious turn forked) AND must emit a warn-level log so the
    // silent drop is diagnosable. A follow-up event re-escalates → second decide
    // returns terminate so the loop completes deterministically.
    const warnMessages: string[] = []
    const recordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_char, event) =>
          Effect.sync(() => {
            if (event.kind === "system" && event.level === "warn") warnMessages.push(event.message)
          }),
      }),
    )
    let decideCount = 0
    const emptyPlanClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            if (p.includes("plain prose")) return { text: "Fixture diary text.", raw: {} }
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return { text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"x"}}', raw: {} }
            if (hasHeadline && !hasJudgment)
              return { text: '{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}', raw: {} }
            // decide: first call → empty-steps plan (must be dropped); second → terminate.
            decideCount++
            if (decideCount === 1)
              return { text: '{"decision":"plan","reasoning":"go","steps":[]}', raw: {} }
            return { text: '{"decision":"terminate","reasoning":"stop"}', raw: {} }
          }),
      }),
    )
    let turnCount = 0
    const ctLayer = ConsciousThoughtTest((_config, _resume) => {
      turnCount++
      return { result: { output: "should never run", timedOut: false, durationMs: 1 }, sessionId: "ses_none" }
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "event-a" }) // tick 1: orient → decide=plan(empty) → dropped
      yield* Effect.forkDaemon(
        Effect.sleep("8 millis").pipe(Effect.andThen(Queue.offer(events, { type: "event-b" }))),
      )
      const result = yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(emptyPlanClient, ctLayer, fakeDomain, Layer.mergeAll(fakeFs, recordingLog), fakeRuntimeDeps, noopModelService)))
      return { result, turnCount }
    })
    const { result, turnCount: tc } = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // The empty plan never went active — no conscious turn was forked.
    expect(tc).toBe(0)
    // The drop was loud: a warn-level log fired mentioning the dropped plan.
    expect(warnMessages.some((m) => m.toLowerCase().includes("no actionable steps"))).toBe(true)
  }, 20_000)

  it("a failing diary turn is logged LOUDLY (kind:error) and degrades without stalling the loop", async () => {
    // Issue 1: runDiaryTurn failing (model error) must NOT be swallowed silently.
    // A structured kind:"error" event fires and the entry degrades to "" — the
    // loop still completes (the dropped reflection is visible, not invisible).
    const errorMessages: string[] = []
    const recordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_char, event) =>
          Effect.sync(() => {
            if (event.kind === "error") errorMessages.push(event.message)
          }),
      }),
    )
    const diaryFailClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) => {
          const p = messages.map((m) => m.content).join(" ").toLowerCase()
          // The diary turn (unique "plain prose" phrase) FAILS.
          if (p.includes("plain prose"))
            return Effect.fail(new ModelError({ tier: "forebrain", model: "m", baseUrl: "u", reason: "diary boom" }))
          return Effect.sync(() => {
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return { text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"x"}}', raw: {} }
            if (hasHeadline && !hasJudgment)
              return { text: '{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}', raw: {} }
            return { text: '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":10}]}', raw: {} }
          })
        },
      }),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `task done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_diaryfail",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(diaryFailClient, ctLayer, fakeDomain, Layer.mergeAll(fakeFs, recordingLog), fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    expect(errorMessages.some((m) => m.toLowerCase().includes("diary turn failed"))).toBe(true)
  }, 20_000)

  it("swallowed identity reads (background/values/diary) now fail LOUDLY (kind:error)", async () => {
    // Issue 1 folded scope: a failing identity/memory read must log a structured
    // error before degrading to "" — the forebrain's loss of grounding must be
    // diagnosable, not invisible. The loop still completes.
    const errorMessages: string[] = []
    const recordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_char, event) =>
          Effect.sync(() => {
            if (event.kind === "error") errorMessages.push(event.message)
          }),
      }),
    )
    const failingFs = Layer.succeed(
      CharacterFs,
      CharacterFs.of({
        readDiary: () => Effect.fail(new CharacterFsError("diary read boom")),
        writeDiary: () => Effect.void,
        readSecrets: () => Effect.succeed(""),
        writeSecrets: () => Effect.void,
        readCredentials: () => Effect.succeed({ username: "", password: "" }),
        readBackground: () => Effect.fail(new CharacterFsError("background read boom")),
        readValues: () => Effect.fail(new CharacterFsError("values read boom")),
        readPalette: () => Effect.succeed(""),
        readDrives: () => Effect.succeed(""),
        characterExists: () => Effect.succeed(true),
      }),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `task done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_idfail",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(scriptedClient, ctLayer, fakeDomain, Layer.mergeAll(failingFs, recordingLog), fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    const joined = errorMessages.join(" ").toLowerCase()
    expect(joined).toContain("background")
    expect(joined).toContain("values")
    expect(joined).toContain("diary")
  }, 20_000)

  it("a throwing event processor fails LOUDLY (kind:error) without stopping the tick", async () => {
    // The event-drain error path must emit a structured kind:"error" event (not an
    // info-classified system line) and keep going — the tick still triages and the
    // loop completes.
    const errorMessages: string[] = []
    const recordingLog = Layer.succeed(
      CharacterLog,
      CharacterLog.of({
        emit: (_char, event) =>
          Effect.sync(() => {
            if (event.kind === "error") errorMessages.push(event.message)
          }),
      }),
    )
    const throwingDomain = Layer.mergeAll(
      Layer.succeed(
        EventProcessorTag,
        EventProcessorTag.of({ processEvent: () => { throw new Error("boom event") } }),
      ),
      Layer.succeed(
        SituationClassifierTag,
        SituationClassifierTag.of({
          summarize: () => ({ situation: {} as never, headline: "h", sections: [], metrics: {} }),
        }),
      ),
      Layer.succeed(
        InterruptRegistryTag,
        InterruptRegistryTag.of({ rules: [], evaluate: () => [], softAlerts: () => [], criticals: () => [] }),
      ),
      Layer.succeed(
        StateRendererTag,
        StateRendererTag.of({ richSnapshot: () => ({}), stateDiff: () => "", formatStateBar: () => "" }),
      ),
      Layer.succeed(PromptBuilderTag, PromptBuilderTag.of({ systemPrompt: () => "x" })),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_evt",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(scriptedClient, ctLayer, throwingDomain, Layer.mergeAll(fakeFs, recordingLog), fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    expect(errorMessages.some((m) => m.toLowerCase().includes("event error"))).toBe(true)
  }, 20_000)

  it("returns Interrupted when a critical interrupt fires", async () => {
    const criticalDomain = Layer.mergeAll(
      Layer.succeed(EventProcessorTag, EventProcessorTag.of({ processEvent: () => ({}) })),
      Layer.succeed(
        SituationClassifierTag,
        SituationClassifierTag.of({
          summarize: () => ({ situation: {} as never, headline: "h", sections: [], metrics: {} }),
        }),
      ),
      Layer.succeed(
        InterruptRegistryTag,
        InterruptRegistryTag.of({
          rules: [],
          evaluate: () => [],
          softAlerts: () => [],
          criticals: () => [{ priority: "critical", message: "hull critical" }],
        }),
      ),
      Layer.succeed(
        StateRendererTag,
        StateRendererTag.of({
          richSnapshot: () => ({}),
          stateDiff: () => "",
          formatStateBar: () => "",
        }),
      ),
      Layer.succeed(PromptBuilderTag, PromptBuilderTag.of({ systemPrompt: () => "x" })),
    )
    const ctLayer = ConsciousThoughtTest(() => ({
      result: { output: "working", timedOut: false, durationMs: 1 },
      sessionId: "ses_x",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        tickIntervalMs: 1,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(scriptedClient, ctLayer, criticalDomain, fakeIo, fakeRuntimeDeps, noopModelService),
        ),
      )
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Interrupted")
    if (result._tag === "Interrupted") expect(result.criticals[0].message).toContain("hull")
  }, 20_000)

  it("criticals interrupt an in-flight conscious fiber", async () => {
    const interrupted = { value: false }
    const tickRef = { n: 0 }
    const interruptingDomain = Layer.mergeAll(
      Layer.succeed(EventProcessorTag, EventProcessorTag.of({ processEvent: () => ({}) })),
      Layer.succeed(
        SituationClassifierTag,
        SituationClassifierTag.of({
          summarize: () => ({ situation: {} as never, headline: "h", sections: [], metrics: {} }),
        }),
      ),
      Layer.succeed(
        InterruptRegistryTag,
        InterruptRegistryTag.of({
          rules: [],
          evaluate: () => [],
          softAlerts: () => [],
          criticals: () => {
            tickRef.n++
            return tickRef.n >= 2 ? [{ priority: "critical", message: "hull critical" }] : []
          },
        }),
      ),
      Layer.succeed(
        StateRendererTag,
        StateRendererTag.of({
          richSnapshot: () => ({}),
          stateDiff: () => "",
          formatStateBar: () => "",
        }),
      ),
      Layer.succeed(PromptBuilderTag, PromptBuilderTag.of({ systemPrompt: () => "x" })),
    )
    // Blocking conscious turn: never completes, records interruption.
    const blockingCt = Layer.succeed(
      ConsciousThought,
      ConsciousThought.of({
        provision: () => Effect.void as Effect.Effect<void, never, Docker>,
        turn: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => { interrupted.value = true })),
          ) as Effect.Effect<{ result: TurnResult; sessionId: string }, never, never>,
      }),
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(scriptedClient, blockingCt, interruptingDomain, fakeIo, fakeRuntimeDeps, noopModelService),
        ),
      )
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Interrupted")
    if (result._tag === "Interrupted") {
      expect(result.criticals.length).toBeGreaterThan(0)
      expect(result.criticals[0].message).toContain("hull")
    }
    expect(interrupted.value).toBe(true)
  }, 20_000)

  it("multi-step plan advances next_step across sessions", async () => {
    const evalCountRef = { n: 0 }
    const multiStepClient = makeMultiStepClient(evalCountRef)
    let sessionCount = 0
    const ctLayer = ConsciousThoughtTest((config, resume) => {
      // Each step's first turn opens a new session.
      if (!resume) sessionCount++
      return {
        result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
        sessionId: `ses_step${sessionCount}`,
      }
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      const result = yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(multiStepClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
      return { result, sessionCount }
    })
    const { result, sessionCount: sc } = await Effect.runPromise(program)
    // Two steps → two sessions opened
    expect(sc).toBe(2)
    expect(result._tag).toBe("Completed")
  }, 20_000)

  it("a discover decision becomes a one-step 'discover' plan that executes", async () => {
    const capturedPrompts: string[] = []
    const discoverClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"learned","transition":{"transition":"terminate","summary":"done"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"cold start — unknown world","sections":[],"whatChanged":"x","emotionalState":"😰","confidence":"low","metrics":{}}',
                raw: {},
              }
            // decide → discover
            return {
              text: '{"decision":"discover","reasoning":"flying blind","discover":{"questions":["what can my CLI do?","where are the docs?"],"tier":"fast","timeoutTicks":2}}',
              raw: {},
            }
          }),
      }),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => {
      capturedPrompts.push(_config.prompt)
      return {
        result: { output: `probed ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
        sessionId: "ses_discover",
      }
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "boot" })
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(discoverClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // The executed step was the synthetic discover step (formatStepTask emits "# Task: discover").
    expect(capturedPrompts.some((p) => p.includes("# Task: discover"))).toBe(true)
  }, 20_000)

  it("malformed discover decision (missing discover object) degrades gracefully without crashing", async () => {
    // Regression guard: a model can emit `{"decision":"discover","reasoning":"x"}` with no
    // `discover` key. Without the loop-branch guard, discoverToPlan crashes with
    // TypeError: Cannot read properties of undefined (reading 'questions').
    // With the guard the loop falls through (no plan set this tick) and continues;
    // a follow-up decide (triggered by a second event) returns terminate → Completed.
    let decideCallCount = 0
    const malformedDiscoverClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"done"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"cold start","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            // decide: first call is malformed discover (no discover payload), second is terminate
            decideCallCount++
            if (decideCallCount === 1)
              return { text: '{"decision":"discover","reasoning":"x"}', raw: {} }
            return { text: '{"decision":"terminate","reasoning":"done","summary":"all done"}', raw: {} }
          }),
      }),
    )
    const capturedPrompts: string[] = []
    const ctLayer = ConsciousThoughtTest((_config, _resume) => {
      capturedPrompts.push(_config.prompt)
      return {
        result: { output: `probed ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
        sessionId: "ses_malformed",
      }
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "boot" })
      // Second event triggers a second orient → decide (returns terminate).
      yield* Effect.forkDaemon(
        Effect.sleep("8 millis").pipe(
          Effect.andThen(Queue.offer(events, { type: "retry" })),
        ),
      )
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(malformedDiscoverClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    // Must NOT crash — degrades gracefully, loop continues past the malformed decision.
    expect(result._tag).toBe("Completed")
    // No discover step was executed (no plan was set from the malformed discover).
    expect(capturedPrompts.some((p) => p.includes("# Task: discover"))).toBe(false)
  }, 20_000)

  it("directive text is laundered (model-generated forebrain output, not raw event text)", async () => {
    // Verify that what onSteer receives is the formatted forebrain orient,
    // not the raw event string ("{ type: 'combat' }").
    const capturedDirectives: string[] = []
    let turnCount = 0
    const launderClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            // Diary turn carries the "judgment" label — branch on its unique
            // "plain prose" phrase FIRST so it isn't mistaken for an evaluate call.
            if (p.includes("plain prose")) return { text: "Fixture diary text.", raw: {} }
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                // Laundered headline — not raw event JSON
                text: '{"headline":"LAUNDERED_HEADLINE","sections":[{"id":"s1","heading":"Details","body":"LAUNDERED_BODY"}],"whatChanged":"LAUNDERED_CHANGED","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            return {
              text: `{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}`,
              raw: {},
            }
          }),
      }),
    )
    const ctLayer = ConsciousThoughtTest(
      (_config, _resume) => {
        turnCount++
        if (turnCount >= 2) {
          return {
            result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
            sessionId: "ses_launder",
          }
        }
        return { result: { output: "working", timedOut: false, durationMs: 5 }, sessionId: "ses_launder" }
      },
      (d) => capturedDirectives.push(d),
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "plan-seed-event" }) // tick 1: forms the plan
      // The mid-session event carries a recognizable raw type string; the resulting steer
      // directive must contain ONLY the laundered forebrain text, never this raw string.
      yield* Effect.forkDaemon(
        Effect.sleep("8 millis").pipe(
          Effect.andThen(Queue.offer(events, { type: "raw-event-should-not-appear" })),
        ),
      )
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(launderClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    await Effect.runPromise(program)
    // Hard assertion — a directive must have been captured, and it must be laundered.
    expect(capturedDirectives.length).toBeGreaterThanOrEqual(1)
    for (const d of capturedDirectives) {
      expect(d).not.toContain("raw-event-should-not-appear")
      expect(d).toContain("LAUNDERED_HEADLINE")
    }
  }, 20_000)

  it("a plan assigned after a long idle forks its conscious turn (not instant salvage-evaluate)", async () => {
    // Repro for the stale-stepStartTick salvage bug. Tick 1 decides `wait` → no plan
    // is formed and the loop idles with stepStartTick frozen at its init value (0).
    // Several ticks later an escalating event forms a REAL plan whose step has a small
    // timeoutTicks. With the stale stepStartTick the loop computes a huge ticksConsumed
    // and (in the buggy version) salvage-evaluates the step on the SAME tick it is
    // assigned — its conscious turn never forks. The fix gates budget-elapsed on an
    // open session, so a never-started step forks turn 1 instead.
    let decideCount = 0
    let turnCallCount = 0
    const client = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              // Either a salvage evaluate (buggy path) or a real evaluate (fixed path) →
              // terminate, so both versions reach Completed and the assertion is on turns.
              return {
                text: '{"judgment":"failed","reasoning":"salvage","transition":{"transition":"terminate","summary":"done"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"go","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            // decide: first call waits (idle, no plan); second call forms a real plan.
            decideCount++
            if (decideCount === 1)
              return {
                text: '{"decision":"wait","reasoning":"hold","wait":{"waitingFor":"signal","resolutionSignal":"sig","disposition":"hold"}}',
                raw: {},
              }
            return {
              text: '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":2}]}',
              raw: {},
            }
          }),
      }),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => {
      turnCallCount++
      return {
        result: { output: `did it ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
        sessionId: "ses_idle_plan",
      }
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "boot" }) // tick 1 → escalate → decide #1 = wait
      // After the loop has idled several ticks (stepStartTick still 0), deliver an
      // escalating event so decide #2 forms a fresh plan.
      yield* Effect.forkDaemon(
        Effect.sleep("12 millis").pipe(Effect.andThen(Queue.offer(events, { type: "wakeup" }))),
      )
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // The freshly-assigned step's conscious turn MUST have forked at least once.
    // Buggy: 0 (instant salvage-evaluate on the assignment tick); fixed: >= 1.
    expect(turnCallCount).toBeGreaterThanOrEqual(1)
  }, 20_000)

  it("self-drives a re-orient after a replan transition even with no inbound events", async () => {
    // Repro for the idle-stall-after-replan bug. A plan runs, evaluate returns `replan`,
    // currentPlan is nulled and the loop drops to idle. With NO further world events the
    // only orient trigger (shouldForceOrient) can never fire, so the buggy loop idles
    // forever. The fix sets forceOrientNext on replan, forcing exactly one re-orient on
    // the next tick → a second decide runs → terminate → Completed.
    let decideCount = 0
    const client = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              // evaluate → replan (drops to idle; without self-drive the loop stalls).
              return {
                text: '{"judgment":"failed","reasoning":"redo","transition":{"transition":"replan"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"go","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            // decide: #1 forms a plan; #2 (the self-driven re-orient) terminates.
            decideCount++
            if (decideCount === 1)
              return {
                text: '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}',
                raw: {},
              }
            return { text: '{"decision":"terminate","reasoning":"done","summary":"all done"}', raw: {} }
          }),
      }),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_replan",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" }) // the ONLY event ever queued
      // Fork + bounded wait so the buggy version fails fast (decideCount stays 1)
      // rather than hanging until the test timeout.
      const fiber = yield* Effect.fork(
        runCortex({
          char: { name: "ada", dir: "/work/players/ada/me" },
          containerId: "c1",
          events,
          initialState: {},
          cadence: "real-time",
          orientInterval: 1,
          tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService))),
      )
      yield* Effect.sleep("150 millis")
      const exit = yield* Fiber.poll(fiber)
      yield* Fiber.interrupt(fiber)
      return { count: decideCount, completed: Option.isSome(exit) }
    })
    const { count, completed } = await Effect.runPromise(program)
    // Self-drive: a SECOND decide ran after the replan despite no new events.
    expect(count).toBeGreaterThanOrEqual(2)
    expect(completed).toBe(true)
  }, 20_000)

  it("a wait transition does NOT force a re-orient (deliberate idling)", async () => {
    // Guard for the replan self-drive: a `wait` transition is deliberate idling and must
    // NOT set forceOrientNext. After the wait the loop idles indefinitely (no new events),
    // so only the initial plan's decide ever runs — decideCount stays 1.
    let decideCount = 0
    const client = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision)
              return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
            if (hasJudgment && !hasHeadline)
              // evaluate → wait (deliberate idle; must NOT self-drive a re-orient).
              return {
                text: '{"judgment":"succeeded","reasoning":"hold","transition":{"transition":"wait","wait":{"waitingFor":"x","resolutionSignal":"y","disposition":"hold"}}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: '{"headline":"go","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            // decide: always a plan — if a spurious re-orient fired, decideCount would climb.
            decideCount++
            return {
              text: '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}',
              raw: {},
            }
          }),
      }),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_wait",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" }) // the ONLY event ever queued
      const fiber = yield* Effect.fork(
        runCortex({
          char: { name: "ada", dir: "/work/players/ada/me" },
          containerId: "c1",
          events,
          initialState: {},
          cadence: "real-time",
          orientInterval: 1,
          tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService))),
      )
      yield* Effect.sleep("150 millis")
      yield* Fiber.interrupt(fiber)
      return decideCount
    })
    const count = await Effect.runPromise(program)
    // Only the initial plan's decide ran; the wait transition did not self-drive an orient.
    expect(count).toBe(1)
  }, 20_000)

  it("emits step-start and step-end transition episodes (verdict, null skill/wm fields)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-loop-"))
    setEpisodeLogRoot(root)
    resetEpisodeContext("ada")
    try {
      const ctLayer = ConsciousThoughtTest((config) => ({
        result: successTurnResult(config.prompt),
        sessionId: "ses_ep",
      }))
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" })
        return yield* runCortex({
          char: { name: "ada", dir: "/work/players/ada/me" },
          containerId: "c1",
          events,
          initialState: {},
          cadence: "real-time",
          orientInterval: 1,
          tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(scriptedClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
      })
      const result = await Effect.runPromise(program)
      expect(result._tag).toBe("Completed")

      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const records = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      const start = records.find((r) => r.type === "step-start")
      const end = records.find((r) => r.type === "step-end")
      expect(start).toMatchObject({ task: "act", goal: "do the thing", skill: null, wmDeltas: null })
      expect(typeof start.tick).toBe("number")
      expect(start.stepId).toMatch(/^s\d+-0$/)
      expect(end).toMatchObject({
        stepId: start.stepId,
        task: "act",
        verdict: "succeeded",
        transition: "terminate",
        skill: null,
        wmDeltas: null,
      })
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})

// ── Subteam A — limbic drives: per-event triage, fast-path, graded ladder ──────
describe("runCortex — limbic drives (per-event triage + escalation ladder)", () => {
  // Build a domain whose processEvent marks an event inert (no stateUpdate) when
  // its `type` is in `inertTypes`, state-changing otherwise. Optional criticals.
  const domainWith = (
    inertTypes: string[],
    criticals: () => { priority: "critical"; message: string }[] = () => [],
  ) =>
    Layer.mergeAll(
      Layer.succeed(
        EventProcessorTag,
        EventProcessorTag.of({
          processEvent: ((e: unknown) => {
            const t = (e as { type?: string }).type ?? ""
            return inertTypes.includes(t) ? {} : { stateUpdate: (s: unknown) => s }
          }) as never,
        }),
      ),
      Layer.succeed(
        SituationClassifierTag,
        SituationClassifierTag.of({
          summarize: () => ({ situation: {} as never, headline: "h", sections: [], metrics: {} }),
        }),
      ),
      Layer.succeed(
        InterruptRegistryTag,
        InterruptRegistryTag.of({ rules: [], evaluate: () => [], softAlerts: () => [], criticals }),
      ),
      Layer.succeed(
        StateRendererTag,
        StateRendererTag.of({ richSnapshot: () => ({}), stateDiff: () => "", formatStateBar: () => "" }),
      ),
      Layer.succeed(PromptBuilderTag, PromptBuilderTag.of({ systemPrompt: () => "x" })),
    )

  // A ModelClient with injectable per-event observe output + decide output, and
  // hooks to count observe/decide calls. Branches by skill marker like scriptedClient.
  const limbicClient = (opts: {
    observe: (promptLower: string) => string
    decide: () => string
    onObserve?: () => void
    onDecide?: () => void
    headline?: string
  }) =>
    Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) =>
          Effect.sync(() => {
            const p = messages.map((m) => m.content).join(" ").toLowerCase()
            if (p.includes("plain prose")) return { text: "Fixture diary text.", raw: {} }
            const hasDisposition = p.includes("disposition")
            const hasDecision = p.includes("decision")
            const hasHeadline = p.includes("headline")
            const hasJudgment = p.includes("judgment")
            if (hasDisposition && !hasDecision) {
              opts.onObserve?.()
              return { text: opts.observe(p), raw: {} }
            }
            if (hasJudgment && !hasHeadline)
              return {
                text: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"x"}}',
                raw: {},
              }
            if (hasHeadline && !hasJudgment)
              return {
                text: `{"headline":"${opts.headline ?? "act now"}","sections":[{"id":"s1","heading":"H","body":"B"}],"whatChanged":"x","emotionalState":"😰","metrics":{}}`,
                raw: {},
              }
            opts.onDecide?.()
            return { text: opts.decide(), raw: {} }
          }),
      }),
    )

  const DISCARD = '{"disposition":"discard","emotionalWeight":"😐","drive":null,"weight":0,"interrupt":false,"reason":"noise"}'

  it("fast-path: inert (no stateUpdate) events make ZERO model calls; only state-changing events are appraised (Unit 5/6)", async () => {
    let observeCount = 0
    const client = limbicClient({
      observe: () => DISCARD,
      decide: () => '{"decision":"terminate","reasoning":"stop"}',
      onObserve: () => observeCount++,
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      // 2 state-changing + 1 inert, all in tick 1.
      yield* Queue.offer(events, { type: "change-a" })
      yield* Queue.offer(events, { type: "change-b" })
      yield* Queue.offer(events, { type: "noise" })
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domainWith(["noise"]), fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // Exactly the 2 state-changing events reached the 2B; the inert one was fast-pathed.
    expect(observeCount).toBe(2)
  }, 20_000)

  it("hard-interrupt rung: a physical-attack event with interrupt:true kills the in-flight conscious fiber and reorients (Unit 7/9)", async () => {
    const interrupted = { value: false }
    let decideCount = 0
    const client = limbicClient({
      observe: (p) =>
        p.includes("attack-now")
          ? '{"disposition":"escalate","emotionalWeight":"😱","drive":"safety","weight":5,"interrupt":true,"reason":"under fire right now"}'
          : DISCARD,
      decide: () => {
        decideCount++
        return decideCount === 1
          ? '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":50}]}'
          : '{"decision":"terminate","reasoning":"post-interrupt stop"}'
      },
    })
    const blockingCt = Layer.succeed(
      ConsciousThought,
      ConsciousThought.of({
        provision: () => Effect.void as Effect.Effect<void, never, Docker>,
        turn: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => { interrupted.value = true })),
          ) as Effect.Effect<{ result: TurnResult; sessionId: string }, never, never>,
      }),
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "plan-seed" }) // tick 1 → plan → turn 1 (blocks)
      yield* Effect.forkDaemon(
        Effect.sleep("8 millis").pipe(Effect.andThen(Queue.offer(events, { type: "attack-now" }))),
      )
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, blockingCt, domainWith([]), fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // The in-flight conscious turn was hard-interrupted by the hindbrain interrupt rung.
    expect(interrupted.value).toBe(true)
    // …and it reorients (a fresh decide cycle ran after the interrupt).
    expect(decideCount).toBeGreaterThanOrEqual(2)
  }, 20_000)

  it("reorient rung: an abstract drop-everything emergency (weight 5, interrupt:false) drops the plan and reorients via the GRADED layer, NOT a hard interrupt (Unit 9)", async () => {
    let decideCount = 0
    const client = limbicClient({
      observe: (p) =>
        p.includes("termination-60s")
          ? // Abstract emergency: high weight but interrupt:false — the 2B-owned graded layer.
            '{"disposition":"escalate","emotionalWeight":"😱","drive":"agency","weight":5,"interrupt":false,"reason":"account termination in 60s"}'
          : DISCARD,
      decide: () => {
        decideCount++
        return decideCount === 1
          ? '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":50}]}'
          : '{"decision":"terminate","reasoning":"reoriented"}'
      },
    })
    // Non-blocking turn: turn 1 completes with no done-marker, leaving the plan
    // active and idle — so the reorient is observable as a fresh decide cycle.
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "working...", timedOut: false, durationMs: 1 }, sessionId: "ses_re" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "plan-seed" }) // tick 1 → plan
      yield* Effect.forkDaemon(
        Effect.sleep("8 millis").pipe(Effect.andThen(Queue.offer(events, { type: "termination-60s" }))),
      )
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domainWith([]), fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // The reorient dropped the active plan → a second decide (replan) ran.
    // (It was NOT routed through the amygdala/critical-exit, and NOT a hard interrupt.)
    expect(decideCount).toBeGreaterThanOrEqual(2)
  }, 20_000)

  it("steer rung: a weight-4 in-session event (no escalate disposition) drives a priority steer directive (Unit 7)", async () => {
    const capturedDirectives: string[] = []
    let turnCount = 0
    const client = limbicClient({
      headline: "PRIORITY_STEER_HEADLINE",
      observe: (p) =>
        p.includes("steer-evt")
          ? // weight 4 ≥ STEER, disposition accumulate (NOT escalate) — weight alone steers.
            '{"disposition":"accumulate","emotionalWeight":"😟","drive":"sustenance","weight":4,"interrupt":false,"reason":"resource pressure"}'
          : DISCARD,
      decide: () =>
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":50}]}',
    })
    const ctLayer = ConsciousThoughtTest(
      (_c, _r) => {
        turnCount++
        if (turnCount >= 2)
          return { result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 1 }, sessionId: "ses_steer" }
        return { result: { output: "working", timedOut: false, durationMs: 1 }, sessionId: "ses_steer" }
      },
      (d) => capturedDirectives.push(d),
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "plan-seed" }) // tick 1 → plan, opens turn 1
      yield* Effect.forkDaemon(
        Effect.sleep("8 millis").pipe(Effect.andThen(Queue.offer(events, { type: "steer-evt" }))),
      )
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domainWith([]), fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // A steer directive fired in-session, driven purely by the weight-4 salience.
    expect(capturedDirectives.length).toBeGreaterThanOrEqual(1)
    expect(capturedDirectives.join(" ")).toContain("PRIORITY_STEER_HEADLINE")
  }, 20_000)

  // Nit 1: the in-session steer gate is rung-aware, not just nonDiscard. An event
  // with weight ≥ STEER but disposition:"discard" computes esc.rung === "steer"
  // (escalate:true) yet is NOT pushed to accumulatedEvents (so nonDiscard is
  // false). Under the old `nonDiscard`-only gate the in-session path did nothing —
  // an asymmetry with the seam the loop advertises. It must now steer on it.
  // Deterministic delivery: turn 1 enqueues the mid-session event (drained the
  // NEXT tick); a tick-gated critical bounds the run.
  it("Nit 1: a steer-rung event with disposition 'discard' (nonDiscard false) still drives the in-session steer", async () => {
    const captured: string[] = []
    const tickRef = { n: 0 }
    const STEER_DISCARD =
      '{"disposition":"discard","emotionalWeight":"😟","drive":"sustenance","weight":4,"interrupt":false,"reason":"high-salience but technically discardable"}'
    const client = limbicClient({
      headline: "STEER_FROM_DISCARD",
      observe: (p) => (p.includes("steer-evt") ? STEER_DISCARD : DISCARD),
      decide: () =>
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":50}]}',
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      const ctLayer = ConsciousThoughtTest(
        (_c, resume) => {
          // turn 1 (no resume) enqueues the mid-session steer event for the next tick.
          if (!resume) Queue.unsafeOffer(events, { type: "steer-evt" })
          return { result: { output: "working", timedOut: false, durationMs: 1 }, sessionId: "ses_n1" }
        },
        (d) => captured.push(d),
      )
      yield* Queue.offer(events, { type: "plan-seed" })
      // Bound the loop: exit via a critical once the steer has had its chance.
      const domain = domainWith([], () => {
        tickRef.n++
        return tickRef.n >= 4 ? [{ priority: "critical" as const, message: "bound" }] : []
      })
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    await Effect.runPromise(program)
    // Under the old nonDiscard-only gate this is empty (the steer never fired).
    expect(captured.length).toBeGreaterThanOrEqual(1)
    expect(captured.join(" ")).toContain("STEER_FROM_DISCARD")
  }, 20_000)

  // Nit 2: ISOLATE bypassSteerCadence. Two steer-rung events are delivered one per
  // tick (turn-offers-next-event, deterministic). The first steer fires at tick 2
  // and sets lastSteerTick=2; the second arrives at tick 3 — INSIDE the throttle
  // window (3 - 2 = 1 < DEFAULT_STEER_CADENCE_TICKS=3). A tick-gated critical exits
  // at tick 4. WITH bypass both steers fire (2 directives); WITHOUT bypass the
  // first steer is itself throttled to tick 3, so only one fires before the bound —
  // the assertion of ≥2 fails. This pins the throttle short-circuit, not just
  // "a weight-4 steers".
  it("Nit 2: bypassSteerCadence fires a steer-rung event within DEFAULT_STEER_CADENCE_TICKS of the prior steer", async () => {
    const captured: string[] = []
    const tickRef = { n: 0 }
    const STEER =
      '{"disposition":"accumulate","emotionalWeight":"😟","drive":"sustenance","weight":4,"interrupt":false,"reason":"salient"}'
    const client = limbicClient({
      headline: "BYPASS_STEER",
      observe: (p) => (p.includes("steer-evt") ? STEER : DISCARD),
      decide: () =>
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":50}]}',
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      let resumeCount = 0
      const ctLayer = ConsciousThoughtTest(
        (_c, resume) => {
          // turn 1 enqueues steer-evt #1; the FIRST steer turn enqueues steer-evt #2.
          if (!resume) Queue.unsafeOffer(events, { type: "steer-evt" })
          else {
            resumeCount++
            if (resumeCount === 1) Queue.unsafeOffer(events, { type: "steer-evt" })
          }
          return { result: { output: "working", timedOut: false, durationMs: 1 }, sessionId: "ses_n2" }
        },
        (d) => captured.push(d),
      )
      yield* Queue.offer(events, { type: "plan-seed" })
      const domain = domainWith([], () => {
        tickRef.n++
        return tickRef.n >= 4 ? [{ priority: "critical" as const, message: "bound" }] : []
      })
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    await Effect.runPromise(program)
    // Both steers fired within the 4-tick bound: the second short-circuited the
    // throttle. Without the bypass, only one fires before the critical exits.
    expect(captured.length).toBeGreaterThanOrEqual(2)
  }, 20_000)
})
