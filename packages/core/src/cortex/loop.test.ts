import { describe, it, expect } from "vitest"
import { Effect, Layer, Queue, Ref } from "effect"
import { CommandExecutor } from "@effect/platform"
import { runCortex } from "./loop.js"
import { ModelClient } from "../model/client.js"
import type { ModelHandle } from "../model/handles.js"
import { CyberneticsTest, Cybernetics } from "../cybernetics/delegate.js"
import type { DelegationResult } from "../cybernetics/types.js"
import { EventProcessorTag } from "../core/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "../core/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "../core/limbic/amygdala/interrupt.js"
import { StateRendererTag } from "../core/state-renderer.js"
import { PromptBuilderTag } from "../core/prompt-builder.js"
import { CharacterFs } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"

// ModelClient that branches on which skill template produced the prompt.
//
// NOTE: the real skill templates share marker words (decide.md embeds both the
// "Headline" label and a "disposition" field; evaluate.md contains "judgment"
// AND "disposition" AND "decision"). A naive `includes("disposition")`-first
// check would misclassify the decide prompt as an observe prompt and the plan
// would never fire. We instead classify by the unique COMBINATION of markers
// each rendered prompt carries:
//   observe   → has "disposition", lacks "decision"
//   evaluate  → has "judgment",    lacks "headline"
//   orient    → has "headline",    lacks "judgment"
//   decide    → everything else (carries all of the above)
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
            text: '{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
            raw: {},
          }
        // decide
        return {
          text: '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do the thing","tier":"smart","successCondition":"thing done","timeoutTicks":1}]}',
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

// CharacterFs + CharacterLog no-op stubs matching their real interfaces.
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
    characterExists: () => Effect.succeed(true),
  }),
)
const fakeLog = Layer.succeed(CharacterLog, CharacterLog.of({ emit: () => Effect.void }))
const fakeIo = Layer.mergeAll(fakeFs, fakeLog)

// Stubs for services required by the forked cybernetics.delegate type signature.
// CyberneticsTest never calls runTurn so these are never invoked at runtime.
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
const fakeRuntimeDeps = Layer.mergeAll(StubCommandExecutor, StubOAuthToken)

describe("runCortex", () => {
  it("escalates, delegates one step, evaluates, and completes", async () => {
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      let delegated = false
      const cyb = CyberneticsTest((c) => {
        delegated = true
        return { status: "completed", output: `did ${c.task.slice(0, 10)}`, durationMs: 10 }
      })
      const result = yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1, // keep the test fast
      }).pipe(Effect.provide(Layer.mergeAll(scriptedClient, cyb, fakeDomain, fakeIo, fakeRuntimeDeps)))
      return { result, delegated }
    })
    const { result, delegated } = await Effect.runPromise(program)
    expect(delegated).toBe(true)
    expect(result._tag).toBe("Completed")
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
          Layer.mergeAll(
            scriptedClient,
            CyberneticsTest(() => ({ status: "completed", output: "", durationMs: 1 })),
            criticalDomain,
            fakeIo,
            fakeRuntimeDeps,
          ),
        ),
      )
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Interrupted")
    if (result._tag === "Interrupted") expect(result.criticals[0].message).toContain("hull")
  }, 20_000)

  it("interrupts an in-flight delegation fiber when a critical fires", async () => {
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      // Tracks whether the blocking delegation was interrupted vs. ran to completion.
      const interrupted = yield* Ref.make(false)
      const completed = yield* Ref.make(false)
      // The critical only fires from tick 2 onward, so the loop forks the
      // delegation on tick 1, and the fiber is still in flight (it blocks forever)
      // when the interrupt is detected on tick 2.
      const tickRef = yield* Ref.make(0)
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
              const t = Effect.runSync(Ref.updateAndGet(tickRef, (n) => n + 1))
              return t >= 2 ? [{ priority: "critical", message: "hull critical" }] : []
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
      // Blocking delegation: never completes, and records interruption.
      const blockingCyb = Layer.succeed(
        Cybernetics,
        Cybernetics.of({
          delegate: () =>
            Effect.never.pipe(
              Effect.onInterrupt(() => Ref.set(interrupted, true)),
              Effect.zipRight(Ref.set(completed, true)),
            ) as Effect.Effect<DelegationResult, never, never>,
        }),
      )
      const result = yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(scriptedClient, blockingCyb, interruptingDomain, fakeIo, fakeRuntimeDeps)))
      return {
        result,
        wasInterrupted: yield* Ref.get(interrupted),
        didComplete: yield* Ref.get(completed),
      }
    })
    const { result, wasInterrupted, didComplete } = await Effect.runPromise(program)
    expect(result._tag).toBe("Interrupted")
    if (result._tag === "Interrupted") {
      expect(result.criticals.length).toBeGreaterThan(0)
      expect(result.criticals[0].message).toContain("hull")
    }
    // The in-flight fiber was actually interrupted, never ran to completion.
    expect(wasInterrupted).toBe(true)
    expect(didComplete).toBe(false)
  }, 20_000)

  it("forks and completes every step of a multi-step plan", async () => {
    // decide → 2-step plan; first evaluate → next_step, second → terminate.
    const evalCountRef = { n: 0 }
    const multiStepClient = Layer.succeed(
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
              // First step advances, second step terminates the plan.
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
                text: '{"headline":"act now","sections":[],"whatChanged":"x","emotionalState":"😰","metrics":{}}',
                raw: {},
              }
            // decide → two steps.
            return {
              text: '{"decision":"plan","reasoning":"go","steps":[{"task":"step-one","goal":"first","tier":"smart","successCondition":"done","timeoutTicks":1},{"task":"step-two","goal":"second","tier":"smart","successCondition":"done","timeoutTicks":1}]}',
              raw: {},
            }
          }),
      }),
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      let delegations = 0
      const cyb = CyberneticsTest((c) => {
        delegations++
        return { status: "completed", output: `did ${c.task.slice(0, 10)}`, durationMs: 10 }
      })
      const result = yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(multiStepClient, cyb, fakeDomain, fakeIo, fakeRuntimeDeps)))
      return { result, delegations }
    })
    const { result, delegations } = await Effect.runPromise(program)
    // Both steps were delegated, and the plan completed.
    expect(delegations).toBe(2)
    expect(result._tag).toBe("Completed")
  }, 20_000)
})
