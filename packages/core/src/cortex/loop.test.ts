import { describe, it, expect } from "vitest"
import { Effect, Layer, Queue } from "effect"
import { CommandExecutor } from "@effect/platform"
import { runCortex } from "./loop.js"
import { ModelClient } from "../model/client.js"
import type { ModelHandle } from "../model/handles.js"
import { ConsciousThought, ConsciousThoughtTest } from "../conscious/conscious-thought.js"
import { Docker } from "../services/Docker.js"
import type { TurnResult } from "../core/limbic/hypothalamus/types.js"
import { EventProcessorTag } from "../core/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../core/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../core/limbic/amygdala/interrupt.js"
import { StateRendererTag } from "../core/state-renderer.js"
import { PromptBuilderTag } from "../core/prompt-builder.js"
import { CharacterFs } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { STEP_DONE_MARKER } from "./state.js"

// ModelClient that branches on which skill template produced the prompt.
// Classify by unique COMBINATION of markers (see original test comment for rationale).
const scriptedClient = Layer.succeed(
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

const fakeDomain = Layer.mergeAll(
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
      criticals: () => [],
      softAlerts: () => [],
    }),
  ),
  Layer.succeed(
    StateRendererTag,
    StateRendererTag.of({
      snapshot: () => ({}),
      richSnapshot: () => ({}),
      stateDiff: () => "",
      logStateBar: () => {},
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
const fakeRuntimeDeps = Layer.mergeAll(StubCommandExecutor, StubOAuthToken, StubDocker)

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
      }).pipe(Effect.provide(Layer.mergeAll(scriptedClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
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
      }).pipe(Effect.provide(Layer.mergeAll(countingEvalClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
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
      }).pipe(Effect.provide(Layer.mergeAll(budgetClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
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
      }).pipe(Effect.provide(Layer.mergeAll(steerClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
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
      }).pipe(Effect.provide(Layer.mergeAll(coalesceClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // A throttled steer turn fired carrying the laundered, latest forebrain directive (hard assertion).
    // (Pure newest-wins/overwrite coalescing of pendingDirective is covered deterministically by the
    // overwrite semantics; this loop-level test verifies a steer turn fires with the latest directive.)
    expect(capturedDirectives.length).toBeGreaterThanOrEqual(1)
    expect(capturedDirectives[capturedDirectives.length - 1]).toContain("second orient (newest)")
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
          snapshot: () => ({}),
          richSnapshot: () => ({}),
          stateDiff: () => "",
          logStateBar: () => {},
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
          Layer.mergeAll(scriptedClient, ctLayer, criticalDomain, fakeIo, fakeRuntimeDeps),
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
          snapshot: () => ({}),
          richSnapshot: () => ({}),
          stateDiff: () => "",
          logStateBar: () => {},
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
          Layer.mergeAll(scriptedClient, blockingCt, interruptingDomain, fakeIo, fakeRuntimeDeps),
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
      }).pipe(Effect.provide(Layer.mergeAll(multiStepClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
      return { result, sessionCount }
    })
    const { result, sessionCount: sc } = await Effect.runPromise(program)
    // Two steps → two sessions opened
    expect(sc).toBe(2)
    expect(result._tag).toBe("Completed")
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
      }).pipe(Effect.provide(Layer.mergeAll(launderClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps)))
    })
    await Effect.runPromise(program)
    // Hard assertion — a directive must have been captured, and it must be laundered.
    expect(capturedDirectives.length).toBeGreaterThanOrEqual(1)
    for (const d of capturedDirectives) {
      expect(d).not.toContain("raw-event-should-not-appear")
      expect(d).toContain("LAUNDERED_HEADLINE")
    }
  }, 20_000)
})
