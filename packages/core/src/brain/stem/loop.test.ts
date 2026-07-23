import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { Effect, Layer, Queue, Fiber, Option, Deferred } from "effect"
import { CommandExecutor } from "@effect/platform"
import { runActivation, DEFAULT_STEER_CADENCE_TICKS } from "./loop.js"
import { ModelClient, type CompletionResult } from "../../model/client.js"
import { ModelError } from "../../model/errors.js"
import type { ModelHandle } from "../../model/handles.js"
import { ConsciousThought, ConsciousThoughtTest } from "#brain/cortex/conscious/conscious-thought.js"
import { Docker } from "../../services/Docker.js"
import type { TurnResult } from "#brain/stem/transport/types.js"
import { EventProcessorTag } from "#brain/limbic/thalamus/event-processor.js"
import { SituationClassifierTag } from "#brain/limbic/thalamus/situation-classifier.js"
import { InterruptRegistryTag } from "#brain/limbic/amygdala/interrupt.js"
import { StateRendererTag } from "../../core/state-renderer.js"
import { PromptBuilderTag } from "../../core/prompt-builder.js"
import { CharacterFs, CharacterFsError } from "../../services/CharacterFs.js"
import { meDir } from "../../services/character-paths.js"
import { CharacterLog } from "../../logging/log-writer.js"
import { OAuthToken } from "../../services/OAuthToken.js"
import { MemoryGateway } from "#brain/limbic/hippocampus/memory/memory-gateway.js"
import { STEP_DONE_MARKER } from "./state.js"
import { ModelService } from "../../services/ModelService.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { resetEpisodeContext, setEpisodeStep, setEpisodeTick } from "../../logging/episodes.js"
import { parseWmFile } from "@roci/player-tools/wm-core"
import { parseSkillFile, serializeSkillFile, slugify } from "../../services/skills-core.js"

// Silence two classes of hermetic best-effort noise from the fixtures below that
// pass an opaque, non-existent player root ("/work/players/ada", so meDir/logsDir
// resolve under /work) as a bare identity (see the fakeFs note ~L168):
//   1. the non-DI'd wm-store's seedWmPlan tries `mkdir -p /work`, fails ENOENT at
//      the filesystem root, swallows it, and logs `[wm] plan seed failed`.
//   2. episode logging is ALWAYS ON now (logs are not optional): every writer
//      resolves logsDir(char) = /work/players/ada/logs and its append/rotate
//      mkdir fails on the host, swallowed after an `[episodes] …` console.error.
// Both failures are by-design (they write nothing) and no test here asserts on wm
// state or episode files against a /work root — the real wm-lifecycle and episode
// tests use their own tmpdir roots. This drops ONLY that /work console spam; the
// loud EACCES line from the read-only "POPULATED character" test (~L2838), which
// that test's own comment documents as expected, is deliberately left intact.
let wmWorkNoiseSpy: ReturnType<typeof vi.spyOn>
beforeAll(() => {
  const real = console.error.bind(console)
  wmWorkNoiseSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (
      typeof args[0] === "string" &&
      args[0].startsWith("[wm] plan seed failed") &&
      args[0].includes("mkdir '/work'")
    )
      return
    // Always-on episode writers targeting the opaque /work player root fail on the
    // host and log `[episodes] … failed for ada: …/work/players/ada/logs …`.
    if (
      typeof args[0] === "string" &&
      args[0].startsWith("[episodes]") &&
      args[0].includes("/work/players/")
    )
      return
    real(...args)
  })
})
afterAll(() => {
  wmWorkNoiseSpy.mockRestore()
})

// No-op ModelService: withTier is transparent (passes the effect through unchanged).
const noopModelService = Layer.succeed(
  ModelService,
  ModelService.of({
    withTier: (_tier) => (effect) => effect as never,
  }),
)

// ── Shared scripted ModelClient factory ─────────────────────────────────────
// Every test below drives the loop through the same cortex tiers, which the loop
// reaches by rendering distinct skill prompts. A fake ModelClient has only the
// prompt text to tell them apart, so ALL of them classify by the same unique
// marker COMBINATION (see the per-test comments below for the rationale): the
// diary turn owns the "plain prose" phrase; observe carries a `"disposition":`
// with no `"decision":`; evaluate carries "judgment" without "headline"; the
// forebrain orient carries "headline" without "judgment"; decide is the
// remainder. This factory is that one shared structural-marker fake —
// parameterized only by the per-branch RESPONSE. A branch value is a constant
// response string, or a `(raw, lower) => …` function for prompt-dependent /
// call-counting / failure-injecting variants, and may return either a response
// string OR a raw Effect (so a branch can fail, block on Effect.never, or gate
// on a Deferred). `raw` is the joined prompt as-is; `lower` is its lowercase.
type MockResp = string | Effect.Effect<CompletionResult, ModelError>
type Branch = MockResp | ((raw: string, lower: string) => MockResp)

const OBSERVE_ESCALATE = '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}'
const EVAL_TERMINATE =
  '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"all done"}}'
const EVAL_TERMINATE_X =
  '{"judgment":"succeeded","reasoning":"x","transition":{"transition":"terminate","summary":"x"}}'
/** Standard forebrain-orient response with an empty section list. */
const orientHeadline = (headline: string, emotional = "😰"): string =>
  `{"headline":"${headline}","sections":[],"whatChanged":"x","emotionalState":"${emotional}","metrics":{}}`

const resolveBranch = (
  branch: Branch,
  raw: string,
  lower: string,
): Effect.Effect<CompletionResult, ModelError> => {
  const r = typeof branch === "function" ? branch(raw, lower) : branch
  return typeof r === "string" ? Effect.succeed({ text: r, raw: {} }) : r
}

interface ScriptSpec {
  /** diary turn ("plain prose"); default "Fixture diary text." */
  diary?: Branch
  /** observe/appraisal; default OBSERVE_ESCALATE */
  observe?: Branch
  /** evaluate; default EVAL_TERMINATE */
  evaluate?: Branch
  /** forebrain orient; default orientHeadline(headline ?? "act now") */
  orient?: Branch
  /** convenience headline for the default orient; ignored when `orient` is set */
  headline?: string
  decide: Branch
}

const scriptClient = (spec: ScriptSpec): Layer.Layer<ModelClient> =>
  Layer.succeed(
    ModelClient,
    ModelClient.of({
      complete: (_h: ModelHandle, messages) => {
        const raw = messages.map((m) => m.content).join(" ")
        const lower = raw.toLowerCase()
        // Diary discriminator FIRST — its prompt also carries the "judgment" label.
        if (lower.includes("plain prose"))
          return resolveBranch(spec.diary ?? "Fixture diary text.", raw, lower)
        const hasDisposition = lower.includes('"disposition":"')
        const hasDecision = lower.includes('"decision":')
        const hasHeadline = lower.includes("headline")
        const hasJudgment = lower.includes("judgment")
        if (hasDisposition && !hasDecision) return resolveBranch(spec.observe ?? OBSERVE_ESCALATE, raw, lower)
        if (hasJudgment && !hasHeadline) return resolveBranch(spec.evaluate ?? EVAL_TERMINATE, raw, lower)
        if (hasHeadline && !hasJudgment)
          return resolveBranch(spec.orient ?? orientHeadline(spec.headline ?? "act now"), raw, lower)
        return resolveBranch(spec.decide, raw, lower)
      },
    }),
  )

// Fixed scripted client (populated orient section + a single-step plan).
const scriptedClient = scriptClient({
  orient:
    '{"headline":"act now","sections":[{"id":"s1","heading":"Action","body":"Get moving."}],"whatChanged":"things changed","emotionalState":"😰","metrics":{}}',
  decide:
    '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do the thing","tier":"smart","successCondition":"thing done","timeoutTicks":2}]}',
})

// Scripted client where first evaluate → next_step, second → terminate (multi-step test).
const makeMultiStepClient = (evalCountRef: { n: number }) =>
  scriptClient({
    evaluate: () => {
      evalCountRef.n++
      const transition =
        evalCountRef.n === 1 ? '{"transition":"next_step"}' : '{"transition":"terminate","summary":"all done"}'
      return `{"judgment":"succeeded","reasoning":"done","transition":${transition}}`
    },
    decide:
      '{"decision":"plan","reasoning":"go","steps":[{"task":"step-one","goal":"first","tier":"smart","successCondition":"done","timeoutTicks":4},{"task":"step-two","goal":"second","tier":"smart","successCondition":"done","timeoutTicks":4}]}',
  })

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
      explain: () => [],
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

// Default CharacterFs stub: hardcoded [] / null, no disk access. The vast
// majority of tests below pass a non-existent literal player root (e.g.
// "/work/players/ada/me") purely as an opaque identity — they don't care
// about skills at all. A REAL disk read keyed on that literal would only
// coincidentally return [] / null because the path doesn't exist on this
// host; on a host where /work happens to exist (e.g. inside this project's
// own dev container), it would silently leak real files into these
// unrelated tests. Only one test below actually exercises skill resolution
// against real files on disk — see realSkillFs.
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
    readSalience: () => Effect.succeed(""),
    characterExists: () => Effect.succeed(true),
    listSkills: () => Effect.succeed([]),
    readSkill: () => Effect.succeed(null),
    writeSkill: () => Effect.void,
    readSynthesis: () => Effect.succeed(""),
    writeSynthesis: () => Effect.void,
    deleteSkill: () => Effect.void,
  }),
)
const fakeLog = Layer.succeed(CharacterLog, CharacterLog.of({ emit: () => Effect.void }))
const fakeIo = Layer.mergeAll(fakeFs, fakeLog)

// Real disk reads (mirrors CharacterFsLive), scoped to meDir(char): used ONLY by
// the "wears a chosen skill" test, which seeds an actual skill file under a
// real tmpdir player root and asserts it gets read back and worn. Everything
// else stays on the hermetic fakeFs stub above.
const realSkillFs = Layer.succeed(
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
    readSalience: () => Effect.succeed(""),
    characterExists: () => Effect.succeed(true),
    listSkills: (char) =>
      Effect.sync(() => {
        const dir = path.join(meDir(char), "skills")
        if (!fs.existsSync(dir)) return []
        return fs
          .readdirSync(dir)
          .filter((entry) => entry.endsWith(".md"))
          .map((entry) => {
            const slug = entry.slice(0, -3)
            const doc = parseSkillFile(slug, fs.readFileSync(path.join(dir, entry), "utf8"))
            return { slug: doc.slug, name: doc.name, description: doc.description, whenToUse: doc.whenToUse }
          })
      }),
    readSkill: (char, name) =>
      Effect.sync(() => {
        const slug = slugify(name)
        const file = path.join(meDir(char), "skills", `${slug}.md`)
        if (!fs.existsSync(file)) return null
        return parseSkillFile(slug, fs.readFileSync(file, "utf8"))
      }),
    writeSkill: () => Effect.void,
    readSynthesis: () => Effect.succeed(""),
    writeSynthesis: () => Effect.void,
    deleteSkill: () => Effect.void,
  }),
)
const realSkillIo = Layer.mergeAll(realSkillFs, fakeLog)

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

describe("runActivation (conscious-session executor)", () => {
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
      const result = yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    // The dedicated diary turn's prompt also carries "judgment"; the shared
    // factory's "plain prose" discriminator keeps it out of the evaluate count.
    const countingEvalClient = scriptClient({
      evaluate: () => {
        evaluateCallCount++
        return EVAL_TERMINATE
      },
      decide:
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":10}]}',
    })
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `task done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_done",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      const result = yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    const budgetClient = scriptClient({
      evaluate:
        '{"judgment":"succeeded","reasoning":"salvage","transition":{"transition":"terminate","summary":"salvaged"}}',
      decide:
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":1}]}',
    })
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      // No STEP_DONE_MARKER in output
      result: { output: "making progress...", timedOut: false, durationMs: 5 },
      sessionId: "ses_budget",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    const steerClient = scriptClient({
      orient:
        '{"headline":"focus on login","sections":[{"id":"s1","heading":"Priority","body":"Fix the login bug."}],"whatChanged":"login broken","emotionalState":"😟","metrics":{}}',
      decide:
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}',
    })
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
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    const coalesceClient = scriptClient({
      orient: () => {
        orientCallCount++
        return orientHeadline(orientCallCount === 1 ? "first orient" : "second orient (newest)")
      },
      decide:
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}',
    })
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
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
        readSalience: () => Effect.succeed(""),
        characterExists: () => Effect.succeed(true),
        listSkills: () => Effect.succeed([]),
        readSkill: () => Effect.succeed(null),
        writeSkill: () => Effect.void,
        readSynthesis: () => Effect.succeed(""),
        writeSynthesis: () => Effect.void,
        deleteSkill: () => Effect.void,
      }),
    )
    const diaryIo = Layer.mergeAll(capturingFs, fakeLog)
    const diaryClient = scriptClient({
      decide:
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":10}]}',
    })
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `task done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_diary",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    const emptyPlanClient = scriptClient({
      evaluate: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"x"}}',
      // decide: first call → empty-steps plan (must be dropped); second → terminate.
      decide: () => {
        decideCount++
        return decideCount === 1
          ? '{"decision":"plan","reasoning":"go","steps":[]}'
          : '{"decision":"terminate","reasoning":"stop"}'
      },
    })
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
      const result = yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    const diaryFailClient = scriptClient({
      // The diary turn (unique "plain prose" phrase) FAILS.
      diary: () =>
        Effect.fail(new ModelError({ tier: "forebrain", model: "m", baseUrl: "u", reason: "diary boom" })),
      evaluate: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"x"}}',
      decide:
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":10}]}',
    })
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `task done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_diaryfail",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
        readSalience: () => Effect.succeed(""),
        characterExists: () => Effect.succeed(true),
        listSkills: () => Effect.succeed([]),
        readSkill: () => Effect.succeed(null),
        writeSkill: () => Effect.void,
        readSynthesis: () => Effect.succeed(""),
        writeSynthesis: () => Effect.void,
        deleteSkill: () => Effect.void,
      }),
    )
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `task done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_idfail",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
        InterruptRegistryTag.of({ rules: [], evaluate: () => [], softAlerts: () => [], criticals: () => [], explain: () => [] }),
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
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
          explain: () => [],
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
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    // Deterministic gate (robust to the async fork-landing tick, which now seeds
    // the plan a tick or two later than the old synchronous inline path): fire the
    // critical the first tick AFTER the conscious turn has actually started, so the
    // interrupt is guaranteed to hit an IN-FLIGHT fiber regardless of scheduling jitter.
    const turnStarted = { value: false }
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
          criticals: () => (turnStarted.value ? [{ priority: "critical", message: "hull critical" }] : []),
          explain: () => [],
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
    // Blocking conscious turn: never completes, records interruption. Flags
    // turnStarted so the amygdala fires its critical exactly once a turn is in flight.
    const blockingCt = Layer.succeed(
      ConsciousThought,
      ConsciousThought.of({
        provision: () => Effect.void as Effect.Effect<void, never, Docker>,
        turn: () => {
          turnStarted.value = true
          return Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => { interrupted.value = true })),
          ) as Effect.Effect<{ result: TurnResult; sessionId: string }, never, never>
        },
      }),
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
      const result = yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    const discoverClient = scriptClient({
      evaluate:
        '{"judgment":"succeeded","reasoning":"learned","transition":{"transition":"terminate","summary":"done"}}',
      orient:
        '{"headline":"cold start — unknown world","sections":[],"whatChanged":"x","emotionalState":"😰","confidence":"low","metrics":{}}',
      decide:
        '{"decision":"discover","reasoning":"flying blind","discover":{"questions":["what can my CLI do?","where are the docs?"],"tier":"fast","timeoutTicks":2}}',
    })
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
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    const malformedDiscoverClient = scriptClient({
      evaluate:
        '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"done"}}',
      headline: "cold start",
      // decide: first call is malformed discover (no discover payload), second is terminate
      decide: () => {
        decideCallCount++
        return decideCallCount === 1
          ? '{"decision":"discover","reasoning":"x"}'
          : '{"decision":"terminate","reasoning":"done","summary":"all done"}'
      },
    })
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
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    const launderClient = scriptClient({
      // Laundered headline/body — not raw event JSON
      orient:
        '{"headline":"LAUNDERED_HEADLINE","sections":[{"id":"s1","heading":"Details","body":"LAUNDERED_BODY"}],"whatChanged":"LAUNDERED_CHANGED","emotionalState":"😰","metrics":{}}',
      decide:
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}',
    })
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
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    const client = scriptClient({
      // Either a salvage evaluate (buggy path) or a real evaluate (fixed path) →
      // terminate, so both versions reach Completed and the assertion is on turns.
      evaluate: '{"judgment":"failed","reasoning":"salvage","transition":{"transition":"terminate","summary":"done"}}',
      headline: "go",
      // decide: first call waits (idle, no plan); second call forms a real plan.
      decide: () => {
        decideCount++
        return decideCount === 1
          ? '{"decision":"wait","reasoning":"hold","wait":{"waitingFor":"signal","resolutionSignal":"sig","disposition":"hold"}}'
          : '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":2}]}'
      },
    })
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
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    const client = scriptClient({
      // evaluate → replan (drops to idle; without self-drive the loop stalls).
      evaluate: '{"judgment":"failed","reasoning":"redo","transition":{"transition":"replan"}}',
      headline: "go",
      // decide: #1 forms a plan; #2 (the self-driven re-orient) terminates.
      decide: () => {
        decideCount++
        return decideCount === 1
          ? '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}'
          : '{"decision":"terminate","reasoning":"done","summary":"all done"}'
      },
    })
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
        runActivation({
          char: { name: "ada", root: "/work/players/ada" },
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
    // The sole event is a DISCARD (non-escalating): since B2 the hindbrain reflex is
    // forked, an escalating event's appraisal would land a tick AFTER the tick-1
    // auto-escalate deliberation already forked, driving a second (legitimate) orient
    // and confounding this invariant. Making it discard isolates the invariant under
    // test — the one plan comes purely from the tick-1 auto-escalate; the wait evaluate
    // must add no further decide. (The deferred-escalation path is covered by the B2
    // "ordering contract" test.)
    let decideCount = 0
    const client = scriptClient({
      observe:
        '{"disposition":"discard","emotionalWeight":"😐","drive":null,"weight":0,"interrupt":false,"reason":"noise"}',
      // evaluate → wait (deliberate idle; must NOT self-drive a re-orient).
      evaluate:
        '{"judgment":"succeeded","reasoning":"hold","transition":{"transition":"wait","wait":{"waitingFor":"x","resolutionSignal":"y","disposition":"hold"}}}',
      headline: "go",
      // decide: always a plan — if a spurious re-orient fired, decideCount would climb.
      decide: () => {
        decideCount++
        return '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}'
      },
    })
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "ses_wait",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" }) // the ONLY event ever queued
      const fiber = yield* Effect.fork(
        runActivation({
          char: { name: "ada", root: "/work/players/ada" },
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

  it("emits step-start and step-end transition episodes (verdict, null skill field)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-loop-"))
    resetEpisodeContext("ada")
    try {
      const ctLayer = ConsciousThoughtTest((config) => ({
        result: successTurnResult(config.prompt),
        sessionId: "ses_ep",
      }))
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" })
        return yield* runActivation({
          char: { name: "ada", root: path.join(root, "players", "ada") },
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
      expect(start).toMatchObject({ task: "act", goal: "do the thing", skill: null })
      expect(typeof start.tick).toBe("number")
      // Run-epoch-prefixed stepId: c<epoch>-s<tick>-<step> (unique across runs).
      expect(start.stepId).toMatch(/^c\d+-s\d+-0$/)
      expect(end).toMatchObject({
        stepId: start.stepId,
        task: "act",
        verdict: "succeeded",
        transition: "terminate",
        skill: null,
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("resets a stale per-character episode context at runActivation entry (no stepId bleed across sessions)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-loop-stale-"))
    // Simulate the dangling context a prior runActivation invocation can leave behind
    // when it exits via the terminate/critical-interrupt paths (which return before
    // the per-step reset) — a fresh invocation must not inherit it.
    setEpisodeTick("ada", 99)
    setEpisodeStep("ada", "s99-9")
    try {
      const ctLayer = ConsciousThoughtTest((config) => ({
        result: successTurnResult(config.prompt),
        sessionId: "ses_ep_stale",
      }))
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" })
        return yield* runActivation({
          char: { name: "ada", root: path.join(root, "players", "ada") },
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
      // Earliest transition records (the orient tier call, then step-start) must
      // carry a fresh context, never the previous session's dangling stepId.
      const firstTier = records.find((r) => r.type === "tier")
      const start = records.find((r) => r.type === "step-start")
      expect(firstTier).toBeDefined()
      // Idle/plan path orient carries the plan discriminator (loop wiring).
      expect(firstTier).toMatchObject({ phase: "orient", orientKind: "plan" })
      // …and the run-epoch stamp (scan-invariant carrier), matching the run's stepIds.
      expect(firstTier.epoch).toMatch(/^\d+$/)
      expect(firstTier.stepId).not.toBe("s99-9")
      expect(start).toBeDefined()
      expect(start.stepId).not.toBe("s99-9")
      expect(start.stepId).toMatch(/^c\d+-s\d+-0$/)
      expect(start.stepId).toBe(`c${firstTier.epoch}-s${start.tick}-0`)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("wm lifecycle: decide seeds plan todos under a headline todo; evaluate marks done; deltas reach the episode log", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-loop-"))
    resetEpisodeContext("ada")
    const charDir = path.join(root, "players", "ada", "me")
    try {
      const ctLayer = ConsciousThoughtTest((config) => ({
        result: successTurnResult(config.prompt),
        sessionId: "ses_wm",
      }))
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" })
        return yield* runActivation({
          char: { name: "ada", root: path.join(root, "players", "ada") },
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

      // Store: headline todo (orient headline, "(assessment) "-prefixed per
      // Task 3 so a confabulated narrative can't masquerade as a plan) + one
      // child per plan step. Evaluate marks the step done, closing the
      // (single-step) plan and its headline too — pruneSettledTodos then
      // drops the fully-settled root subtree from wm.json/WM.md entirely
      // (see wm-core.ts) so completed plans don't flood WM.md context.
      const wm = parseWmFile(fs.readFileSync(path.join(charDir, "wm.json"), "utf8"))
      expect(wm.todos).toEqual([])
      // WM.md was re-rendered by the harness mutations; renderWmMarkdown's
      // empty-state string when no todos remain.
      expect(fs.readFileSync(path.join(charDir, "WM.md"), "utf8")).toContain("(no todos)")

      // Episodes: seeding recorded as a type:"wm" record; done deltas on the step-end.
      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const records = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      const wmRec = records.find((r) => r.type === "wm")
      expect(wmRec.deltas.map((d: { op: string; id: string }) => [d.op, d.id])).toEqual([
        ["add", "t1"],
        ["add", "t2"],
      ])
      const end = records.find((r) => r.type === "step-end")
      expect(end.wmDeltas.map((d: { op: string; id: string }) => [d.op, d.id])).toEqual([
        ["done", "t2"],
        ["done", "t1"],
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("threads the character's open todos into the decide prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-prompt-"))
    const charDir = path.join(root, "players", "ada", "me")
    fs.mkdirSync(charDir, { recursive: true })
    fs.writeFileSync(
      path.join(charDir, "wm.json"),
      JSON.stringify({
        version: 1,
        nextId: 2,
        // origin:"agent" — a deliberate free-standing CLI memory that survives
        // the loop-entry dead-plan sweep (a harness-origin one would be swept).
        todos: [{ id: "t1", text: "REMEMBER_THE_FUEL", parent: null, state: "open", origin: "agent", createdAt: "x", updatedAt: "x" }],
        pendingDeltas: [],
      }),
    )
    try {
      let decidePrompt = ""
      const capturingClient = scriptClient({
        diary: "Diary.",
        orient: orientHeadline("h", "😐"),
        decide: (raw) => {
          decidePrompt = raw
          return '{"decision":"terminate","reasoning":"stop"}'
        },
      })
      const ctLayer = ConsciousThoughtTest((config) => ({ result: successTurnResult(config.prompt), sessionId: "s" }))
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" })
        return yield* runActivation({
          char: { name: "ada", root: path.join(root, "players", "ada") },
          containerId: "c1",
          events,
          initialState: {},
          cadence: "real-time",
          orientInterval: 1,
          tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(capturingClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
      })
      await Effect.runPromise(program)
      expect(decidePrompt).toContain("- t1 REMEMBER_THE_FUEL")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("renders a non-blank skill index in the decide prompt when no skills exist yet", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-empty-index-"))
    const charDir = path.join(root, "players", "ada", "me")
    fs.mkdirSync(charDir, { recursive: true })
    try {
      let decidePrompt = ""
      const capturingClient = scriptClient({
        diary: "Diary.",
        orient: orientHeadline("h", "😐"),
        decide: (raw) => {
          decidePrompt = raw
          return '{"decision":"terminate","reasoning":"stop"}'
        },
      })
      const ctLayer = ConsciousThoughtTest((config) => ({ result: successTurnResult(config.prompt), sessionId: "s" }))
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" })
        return yield* runActivation({
          char: { name: "ada", root: path.join(root, "players", "ada") },
          containerId: "c1",
          events,
          initialState: {},
          cadence: "real-time",
          orientInterval: 1,
          tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(capturingClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
      })
      await Effect.runPromise(program)
      // An empty skill index must never render as a bare header — the small
      // decide model never sees an empty "## Your Skills" section.
      expect(decidePrompt).not.toMatch(/Your Skills\s*\n\s*\n\s*##/)
      expect(decidePrompt.toLowerCase()).toContain("no skills yet")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("wears a chosen skill: injects its body into the step task and records the name on step boundaries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-worn-"))
    resetEpisodeContext("ada")
    const charDir = path.join(root, "players", "ada", "me")
    fs.mkdirSync(path.join(charDir, "skills"), { recursive: true })
    fs.writeFileSync(
      path.join(charDir, "skills", "securing-fuel.md"),
      serializeSkillFile({ slug: "securing-fuel", name: "securing-fuel", description: "d", whenToUse: "w", body: "WORN_SKILL_BODY_MARKER" }),
    )
    try {
      let stepPrompt = ""
      const ctLayer = ConsciousThoughtTest((config) => {
        stepPrompt = config.prompt
        return { result: successTurnResult(config.prompt), sessionId: "s" }
      })
      const capturingClient = scriptClient({
        diary: "Diary.",
        orient: orientHeadline("act now", "😐"),
        evaluate: '{"judgment":"succeeded","reasoning":"ok","transition":{"transition":"terminate","summary":"done"}}',
        // decide: plan one step, wearing securing-fuel.
        decide:
          '{"decision":"plan","reasoning":"go","skill":"securing-fuel","steps":[{"task":"act","goal":"do the thing","tier":"smart","successCondition":"done","timeoutTicks":50}]}',
      })
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" })
        return yield* runActivation({
          char: { name: "ada", root: path.join(root, "players", "ada") },
          containerId: "c1",
          events,
          initialState: {},
          cadence: "real-time",
          orientInterval: 1,
          tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(capturingClient, ctLayer, fakeDomain, realSkillIo, fakeRuntimeDeps, noopModelService)))
      })
      const result = await Effect.runPromise(program)
      expect(result._tag).toBe("Completed")
      // The worn skill's body reached the worker's step task.
      expect(stepPrompt).toContain("## Skill in use")
      expect(stepPrompt).toContain("WORN_SKILL_BODY_MARKER")
      // The worn skill's NAME is stamped on both step boundary records.
      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const records = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      expect(records.find((r) => r.type === "step-start").skill).toBe("securing-fuel")
      expect(records.find((r) => r.type === "step-end").skill).toBe("securing-fuel")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("degrades to a plain step task when the chosen skill does not exist (never fails the step)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-missing-"))
    resetEpisodeContext("ada")
    const charDir = path.join(root, "players", "ada", "me")
    try {
      let stepPrompt = ""
      const ctLayer = ConsciousThoughtTest((config) => {
        stepPrompt = config.prompt
        return { result: successTurnResult(config.prompt), sessionId: "s" }
      })
      const capturingClient = scriptClient({
        diary: "Diary.",
        orient: orientHeadline("h", "😐"),
        evaluate: '{"judgment":"succeeded","reasoning":"ok","transition":{"transition":"terminate","summary":"done"}}',
        decide:
          '{"decision":"plan","reasoning":"go","skill":"no-such-skill","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":50}]}',
      })
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" })
        return yield* runActivation({
          char: { name: "ada", root: path.join(root, "players", "ada") },
          containerId: "c1",
          events,
          initialState: {},
          cadence: "real-time",
          orientInterval: 1,
          tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(capturingClient, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
      })
      const result = await Effect.runPromise(program)
      expect(result._tag).toBe("Completed") // step ran fine
      expect(stepPrompt).not.toContain("## Skill in use")
      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const records = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      expect(records.find((r) => r.type === "step-start").skill).toBeNull()
      expect(records.find((r) => r.type === "step-end").skill).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})

// ── Subteam A — limbic drives: per-event triage, fast-path, graded ladder ──────
describe("runActivation — limbic drives (per-event triage + escalation ladder)", () => {
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
        InterruptRegistryTag.of({ rules: [], evaluate: () => [], softAlerts: () => [], criticals, explain: () => [] }),
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
    scriptClient({
      observe: (_raw, lower) => {
        opts.onObserve?.()
        return opts.observe(lower)
      },
      evaluate: '{"judgment":"succeeded","reasoning":"done","transition":{"transition":"terminate","summary":"x"}}',
      orient: `{"headline":"${opts.headline ?? "act now"}","sections":[{"id":"s1","heading":"H","body":"B"}],"whatChanged":"x","emotionalState":"😰","metrics":{}}`,
      decide: () => {
        opts.onDecide?.()
        return opts.decide()
      },
    })

  const DISCARD = '{"disposition":"discard","emotionalWeight":"😐","drive":null,"weight":0,"interrupt":false,"reason":"noise"}'
  // The plain "h" forebrain orient shared by the blocking/Effect-based clients below.
  const ORIENT_H = orientHeadline("h", "😐")

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
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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

  const ACCUM =
    '{"disposition":"accumulate","emotionalWeight":"😐","drive":null,"weight":2,"interrupt":false,"reason":"a greeting"}'

  // Fix 2: a chat event carries NO stateUpdate from the domain (handleChatMessage
  // returns context only), so the stateUpdate-only inert gate would fast-path
  // DISCARD it upstream of the hindbrain's chat dedup exemption — which was
  // therefore unreachable for real chat (zero chat ever reached observe). The
  // chat inert-gate exemption forces it non-inert so it reaches the 2B.
  it("fix 2: a chat event with NO stateUpdate is not fast-path-discarded — it reaches the 2B", async () => {
    let observeCount = 0
    const bound = { n: 0 }
    const client = limbicClient({
      observe: () => ACCUM,
      decide: () => '{"decision":"terminate","reasoning":"stop"}',
      onObserve: () => observeCount++,
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      // Chat is in inertTypes → domain returns NO stateUpdate for it. Under the
      // buggy gate this makes it INERT (observeCount stays 0); the fix reaches observe.
      yield* Queue.offer(events, { type: "chat", from: "ada", text: "hello" })
      const domain = domainWith(["chat"], () => (++bound.n >= 6 ? [{ priority: "critical" as const, message: "bound" }] : []))
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
        containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    await Effect.runPromise(program)
    // Under the buggy stateUpdate-only inert gate this is 0.
    expect(observeCount).toBeGreaterThanOrEqual(1)
  }, 20_000)

  // Fix 1 + Fix 2: chat is NEVER deduped-to-discard, and an EXACT repeat is
  // annotated with the exact-occurrence count `(seen 2x recently)` — the only
  // path where the annotation now fires (non-chat exact repeats are discarded
  // before observe; changed frames arrive unannotated).
  it("fix 1: an exact-repeat chat reaches the 2B BOTH times and the repeat carries '(seen 2x recently)'", async () => {
    let observeCount = 0
    const prompts: string[] = []
    const bound = { n: 0 }
    const client = limbicClient({
      observe: (p) => { prompts.push(p); return ACCUM },
      decide: () => '{"decision":"terminate","reasoning":"stop"}',
      onObserve: () => observeCount++,
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      // Two byte-identical chats → same fingerprint. A non-chat exact repeat would
      // be discarded@0; chat is exempt, so BOTH reach observe and the 2nd is annotated.
      yield* Queue.offer(events, { type: "chat", from: "ada", text: "hi" })
      yield* Queue.offer(events, { type: "chat", from: "ada", text: "hi" })
      const domain = domainWith(["chat"], () => (++bound.n >= 6 ? [{ priority: "critical" as const, message: "bound" }] : []))
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
        containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    await Effect.runPromise(program)
    // Neither chat was mechanically discarded — both reached the model.
    expect(observeCount).toBeGreaterThanOrEqual(2)
    // The exact repeat carries the exact-count suffix (N = total incl. this one).
    expect(prompts.some((p) => p.includes("(seen 2x recently)"))).toBe(true)
  }, 20_000)

  // Fix 1: a genuinely-CHANGED full_state (its nested location.system_id shifted)
  // must arrive UNANNOTATED. The old code keyed the "(seen Nx recently)" suffix on
  // the TYPE-family count, so every post-jump full_state (full_state arrives ~every
  // tick) was mislabeled "(seen 2x recently)" and the rubric-obedient 2B discarded
  // a real location change as unchanged. The suffix now keys on the EXACT
  // fingerprint count, which is 0 for a changed frame → no suffix.
  it("fix 1: a changed-location full_state (different nested system_id) reaches the 2B UNANNOTATED", async () => {
    const prompts: string[] = []
    const bound = { n: 0 }
    const client = limbicClient({
      observe: (p) => { prompts.push(p); return DISCARD },
      decide: () => '{"decision":"terminate","reasoning":"stop"}',
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    // full_state nests location under `location` (real payload shape). Two frames
    // differing only by nested system_id → DIFFERENT fingerprints → exactCount 0.
    const frameA = { type: "full_state", location: { system_id: "first_step" }, ship: { fuel: 50, max_fuel: 100 } }
    const frameB = { type: "full_state", location: { system_id: "horizon" }, ship: { fuel: 50, max_fuel: 100 } }
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, frameA)
      yield* Queue.offer(events, frameB)
      const domain = domainWith([], () => (++bound.n >= 6 ? [{ priority: "critical" as const, message: "bound" }] : []))
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
        containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    await Effect.runPromise(program)
    // Both changed frames reached observe; the CHANGED frame B is not labeled a
    // repeat. Anchor to B's exact JSON (lowercased by limbicClient) so the assertion
    // catches only a suffix attached to B, not the rubric's own "(seen Nx)" examples.
    const bJson = JSON.stringify(frameB).toLowerCase()
    expect(prompts.some((p) => p.includes(bJson))).toBe(true)
    expect(prompts.some((p) => p.includes(`${bJson} (seen`))).toBe(false)
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
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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

  it("reflexes stay live: a slow (blocking) deliberation does not freeze hindbrain triage / amygdala checks (Unit: fork)", async () => {
    let observeCount = 0
    const criticalsRef = { n: 0 }
    // decide (the else branch) BLOCKS the fork forever; orient + observe complete normally.
    const blockingDecideClient = scriptClient({
      diary: "d",
      observe: () => {
        observeCount++
        return DISCARD
      },
      evaluate: EVAL_TERMINATE_X,
      orient: ORIENT_H,
      // decide → never resolves: the deliberation fork is suspended here.
      decide: () => Effect.never,
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" }) // tick 1 escalates → forks the (blocking) deliberation
      // Deterministic mid-deliberation event (no wall-clock race). The amygdala
      // criticals() callback runs exactly once per tick (§2), so it doubles as a
      // tick clock we fully control. Offering "later" on the FIRST call (tick 1,
      // whose §2 runs before the fork is spawned in §5 that same tick) makes it
      // arrive in the queue for tick 2's drain — strictly WHILE the deliberation
      // fork is suspended on the blocked decide — so tick-2 hindbrain triage MUST
      // observe it. The critical only fires on the 4th call (tick 4), two ticks
      // later, so both observes are guaranteed to have run before the loop exits.
      const domain = domainWith([], () => {
        criticalsRef.n++
        if (criticalsRef.n === 1) Queue.unsafeOffer(events, { type: "later" })
        return criticalsRef.n >= 4 ? [{ priority: "critical" as const, message: "hull critical" }] : []
      })
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
        containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(blockingDecideClient, ctLayer, domain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    // The loop kept ticking through the blocked deliberation and reached the critical.
    expect(result._tag).toBe("Interrupted")
    // Deterministic (exact, not a race): the tick-1 seed observe PLUS the tick-2
    // mid-deliberation observe both ran before the tick-4 critical — hindbrain
    // triage stayed live the whole time the deliberation fork was blocked.
    expect(observeCount).toBe(2)
  }, 20_000)

  // ── B2: the hindbrain reflex is FORKED off the hot path (finding G) ──────────
  it("B2 finding G: a slow HINDBRAIN reflex does not freeze the loop — event drain + amygdala critical still fire while the reflex is blocked (Unit: reflex fork)", async () => {
    let observeCount = 0
    const criticalsRef = { n: 0 }
    // observe (the hindbrain reflex) BLOCKS forever; orient + decide complete so
    // the loop keeps ticking. Pre-B2 this blocked the tick inline at loop.ts:636
    // and the loop never advanced past tick 1 (→ timeout RED). Post-B2 the reflex
    // is forked, so the loop drains a 2nd event and reaches the critical.
    const blockingObserveClient = scriptClient({
      diary: "d",
      observe: () => {
        observeCount++
        return Effect.never // reflex fork suspends here — must NOT freeze the loop
      },
      evaluate: EVAL_TERMINATE_X,
      orient: ORIENT_H,
      // decide → wait: no plan, the loop idles but keeps ticking toward the critical.
      decide:
        '{"decision":"wait","reasoning":"idle","wait":{"waitingFor":"x","resolutionSignal":"y","disposition":"hold"}}',
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" }) // tick 1: submits the (blocking) reflex
      // criticals() runs once per tick (a controllable tick clock). Offer "later"
      // on tick 1 so it drains on tick 2 — a SECOND reflex is submitted while the
      // first is still blocked. The critical fires on tick 4, after both submits.
      const domain = domainWith([], () => {
        criticalsRef.n++
        if (criticalsRef.n === 1) Queue.unsafeOffer(events, { type: "later" })
        return criticalsRef.n >= 4 ? [{ priority: "critical" as const, message: "hull critical" }] : []
      })
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
        containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(blockingObserveClient, ctLayer, domain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    // The loop kept ticking through the blocked reflex and reached the critical
    // synchronously — finding G closed.
    expect(result._tag).toBe("Interrupted")
    // Both events were submitted (each invokes the observe branch once) while the
    // first reflex was still suspended: the conductor never blocked on the reflex.
    expect(observeCount).toBe(2)
  }, 20_000)

  it("B2 semantics preserved: each state-changing event's observe→remember still fires, now via the scheduler (Unit: reflex fork)", async () => {
    let observeRemembers = 0
    const countingMemory = Layer.succeed(
      MemoryGateway,
      MemoryGateway.of({
        remember: (_cid, _char, w) =>
          Effect.sync(() => {
            if ((w as { source?: string }).source === "observe") observeRemembers++
          }),
        recall: () => Effect.succeed(""),
      }),
    )
    // Non-discard observe with a reason → observeMemories yields one write per event.
    const client = limbicClient({
      observe: () => '{"disposition":"accumulate","emotionalWeight":"😐","drive":null,"weight":1,"interrupt":false,"reason":"seen it"}',
      decide: () => '{"decision":"wait","reasoning":"idle","wait":{"waitingFor":"x","resolutionSignal":"y","disposition":"hold"}}',
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "a" })
      yield* Queue.offer(events, { type: "b" })
      const fiber = yield* Effect.fork(
        runActivation({
          char: { name: "ada", root: "/work/players/ada" },
          containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1000, tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domainWith([]), fakeIo, StubCommandExecutor, StubOAuthToken, StubDocker, countingMemory, noopModelService))),
      )
      yield* Effect.sleep("80 millis") // ample ticks for both forked reflexes to land + remember
      yield* Fiber.interrupt(fiber)
      return observeRemembers
    })
    const count = await Effect.runPromise(program)
    // Exactly one observe-remember per state-changing event — the per-event
    // memory write moved INTO the scheduler but still happens once per event.
    expect(count).toBe(2)
  }, 20_000)

  it("B2 ordering contract: a reflex that lands a later tick than it was submitted still drives its escalation exactly once (queue, never drop) (Unit: reflex fork)", async () => {
    let orientCount = 0
    const criticalsRef = { n: 0 }
    // Flow: tick 1 auto-escalates (tick===1) → orient#1 + decide#1→wait (idle,
    // no plan). The seed event's reorient reflex is submitted tick 1 but GATED on
    // a Deferred opened only on tick 3. When it finally lands (a strictly later
    // tick than submission), its reorient escalation must wake exactly one more
    // orient (orient#2) → decide#2→terminate. Total orients == 2 proves the
    // late-landing escalation was consumed once and never dropped.
    const program = Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      let decideN = 0
      const client = scriptClient({
        diary: "d",
        // Gate the reflex behind the Deferred, THEN return a reorient (w5) appraisal.
        observe: () =>
          Deferred.await(gate).pipe(
            Effect.as({
              text: '{"disposition":"escalate","emotionalWeight":"😱","drive":"agency","weight":5,"interrupt":false,"reason":"big"}',
              raw: {},
            }),
          ),
        evaluate: EVAL_TERMINATE_X,
        orient: () => {
          orientCount++
          return orientHeadline("h", "😱")
        },
        // decide#1 → wait (idle, keep ticking); decide#2 (reflex-driven) → terminate.
        decide: () => {
          decideN++
          return decideN === 1
            ? '{"decision":"wait","reasoning":"idle","wait":{"waitingFor":"x","resolutionSignal":"y","disposition":"hold"}}'
            : '{"decision":"terminate","reasoning":"done"}'
        },
      })
      const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" }) // tick 1: submits the gated reflex
      // Open the gate on tick 3 (via the per-tick criticals clock). The reflex,
      // submitted tick 1, cannot land until then — strictly a later tick.
      const domain = domainWith([], () => {
        criticalsRef.n++
        if (criticalsRef.n === 3) Effect.runFork(Deferred.succeed(gate, undefined))
        return []
      })
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
        containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 100, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    // The delayed reflex's reorient escalation was consumed exactly once when it
    // landed: orient#1 (tick-1 auto) + orient#2 (reflex-driven) → terminate.
    // Never dropped despite landing a later tick than it was submitted.
    expect(result._tag).toBe("Completed")
    expect(orientCount).toBe(2)
  }, 20_000)

  it("mutual exclusion: never forks a second deliberation while one is in flight", async () => {
    let orientCount = 0
    const client = scriptClient({
      diary: "d",
      observe: DISCARD,
      evaluate: EVAL_TERMINATE_X,
      orient: () => {
        orientCount++
        return ORIENT_H
      },
      decide: () => Effect.never, // decide blocks → deliberation stays in flight
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" })
      const fiber = yield* Effect.fork(
        runActivation({
          char: { name: "ada", root: "/work/players/ada" },
          containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domainWith([]), fakeIo, fakeRuntimeDeps, noopModelService))),
      )
      yield* Effect.sleep("60 millis") // ~60 ticks; forceOrient every tick would re-fork if not mutually excluded
      yield* Fiber.interrupt(fiber)
      return orientCount
    })
    const count = await Effect.runPromise(program)
    // Exactly one deliberation ever forked despite ~60 escalating ticks.
    expect(count).toBe(1)
  }, 20_000)

  it("reorient closes the abandoned in-flight step with a replan step-end (no verdict, no double-emit)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-abandon-"))
    resetEpisodeContext("ada")
    try {
      const client = limbicClient({
        observe: (p) =>
          p.includes("termination-60s")
            ? '{"disposition":"escalate","emotionalWeight":"😱","drive":"agency","weight":5,"interrupt":false,"reason":"account termination in 60s"}'
            : DISCARD,
        decide: (() => {
          let n = 0
          return () => {
            n++
            return n === 1
              ? '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":50}]}'
              : '{"decision":"terminate","reasoning":"reoriented"}'
          }
        })(),
      })
      // Non-blocking turn with NO done-marker: the step stays in flight.
      const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "working...", timedOut: false, durationMs: 1 }, sessionId: "ses_ab" }))
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "plan-seed" })
        yield* Effect.forkDaemon(
          Effect.sleep("8 millis").pipe(Effect.andThen(Queue.offer(events, { type: "termination-60s" }))),
        )
        return yield* runActivation({
          char: { name: "ada", root: path.join(root, "players", "ada") },
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

      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const records = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      const starts = records.filter((r) => r.type === "step-start")
      const ends = records.filter((r) => r.type === "step-end")
      // Exactly one step ran, was abandoned, and was closed exactly once.
      expect(starts).toHaveLength(1)
      expect(ends).toHaveLength(1)
      expect(ends[0]).toMatchObject({ stepId: starts[0].stepId, task: "act", transition: "replan", skill: null })
      expect(ends[0].verdict).toBeUndefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("wm lifecycle: a reorient discards the dropped plan's seeded orphans, recorded on the abandoned step-end", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-orphan-"))
    resetEpisodeContext("ada")
    const charDir = path.join(root, "players", "ada", "me")
    try {
      const client = limbicClient({
        observe: (p) =>
          p.includes("termination-60s")
            ? '{"disposition":"escalate","emotionalWeight":"😱","drive":"agency","weight":5,"interrupt":false,"reason":"emergency"}'
            : DISCARD,
        decide: (() => {
          let n = 0
          return () => {
            n++
            return n === 1
              ? '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":50}]}'
              : '{"decision":"terminate","reasoning":"reoriented"}'
          }
        })(),
      })
      const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "working...", timedOut: false, durationMs: 1 }, sessionId: "ses_or" }))
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "plan-seed" })
        yield* Effect.forkDaemon(
          Effect.sleep("8 millis").pipe(Effect.andThen(Queue.offer(events, { type: "termination-60s" }))),
        )
        return yield* runActivation({
          char: { name: "ada", root: path.join(root, "players", "ada") },
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

      // The abandoned plan's seeded todos (headline t1 + step t2) are DISCARDED —
      // retained in wm.json, hidden from WM.md.
      const wm = parseWmFile(fs.readFileSync(path.join(charDir, "wm.json"), "utf8"))
      expect(wm.todos.map((t) => [t.id, t.state])).toEqual([
        ["t1", "discarded"],
        ["t2", "discarded"],
      ])
      expect(fs.readFileSync(path.join(charDir, "WM.md"), "utf8")).not.toContain("t1")

      // The discard deltas ride the abandoned step's replan step-end.
      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const records = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      const end = records.find((r) => r.type === "step-end")
      expect(end.transition).toBe("replan")
      expect(end.wmDeltas.map((d: { op: string; id: string }) => [d.op, d.id])).toEqual([
        ["discard", "t2"],
        ["discard", "t1"],
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("wm lifecycle: a critical interrupt discards the in-flight plan's seeded orphans (final review fix)", async () => {
    // Pre-fix, the amygdala critical-interrupt exit (`return { _tag:
    // "Interrupted", ... }`) skipped resetPlanState/discardPlanOrphans
    // entirely, permanently leaking the abandoned plan's seeded todos into
    // WM.md (uncapped, injected forever — the loop never runs again for this
    // session to clean them up).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-critical-"))
    resetEpisodeContext("ada")
    const charDir = path.join(root, "players", "ada", "me")
    try {
      const client = limbicClient({
        observe: () => DISCARD,
        decide: () =>
          '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":50}]}',
      })
      const ctLayer = ConsciousThoughtTest((_c, _r) => ({
        result: { output: "working...", timedOut: false, durationMs: 1 },
        sessionId: "ses_crit",
      }))
      // Tick 1 forks the idle deliberation; it lands + seeds the plan (t1 headline
      // + t2 step) — and writes wm.json — on a LATER tick's poll. Unlike the other
      // timing-coupled tests, this one's fork does real episode-log disk I/O
      // (char.logsDir set above), so its landing can span a couple of ticks — a
      // fixed +1 tick threshold would race the write. Fire the critical
      // DETERMINISTICALLY the first tick AFTER wm.json exists (i.e. the plan is truly
      // in-flight), so the interrupt always has an active plan whose orphans to discard.
      const criticalDomain = domainWith(["plan-seed"], () =>
        fs.existsSync(path.join(charDir, "wm.json"))
          ? [{ priority: "critical" as const, message: "hull critical" }]
          : [],
      )
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "plan-seed" })
        return yield* runActivation({
          char: { name: "ada", root: path.join(root, "players", "ada") },
          containerId: "c1",
          events,
          initialState: {},
          cadence: "real-time",
          orientInterval: 1,
          tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, criticalDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
      })
      const result = await Effect.runPromise(program)
      expect(result._tag).toBe("Interrupted")

      // The abandoned plan's seeded todos (headline t1 + step t2) are
      // DISCARDED — retained in wm.json, hidden from WM.md.
      const wm = parseWmFile(fs.readFileSync(path.join(charDir, "wm.json"), "utf8"))
      expect(wm.todos.map((t) => [t.id, t.state])).toEqual([
        ["t1", "discarded"],
        ["t2", "discarded"],
      ])
      expect(fs.readFileSync(path.join(charDir, "WM.md"), "utf8")).not.toContain("t1")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("wm lifecycle: loop entry sweeps a prior dead session's open plan orphans, sparing agent memory", async () => {
    // A previous session seeded plan todos (harness) then died, leaving them
    // open forever — the in-loop discardPlanOrphans only knew that session's
    // plan ids. At the NEXT session's loop entry, discardDeadPlanTodos sweeps
    // them; a free-standing agent (CLI) todo is deliberate memory and survives.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-crosssession-"))
    resetEpisodeContext("ada")
    const charDir = path.join(root, "players", "ada", "me")
    fs.mkdirSync(charDir, { recursive: true })
    fs.writeFileSync(
      path.join(charDir, "wm.json"),
      JSON.stringify({
        version: 1,
        nextId: 4,
        todos: [
          { id: "t1", text: "DEAD_PLAN_HEADLINE", parent: null, state: "open", origin: "harness", createdAt: "x", updatedAt: "x" },
          { id: "t2", text: "dead plan step", parent: "t1", state: "open", origin: "harness", createdAt: "x", updatedAt: "x" },
          { id: "t3", text: "AGENT_MEMORY_KEEP", parent: null, state: "open", origin: "agent", createdAt: "x", updatedAt: "x" },
        ],
        pendingDeltas: [],
      }),
    )
    try {
      const client = limbicClient({ observe: () => DISCARD, decide: () => '{"decision":"terminate","reasoning":"done"}' })
      const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "ses_x" }))
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "wake" })
        return yield* runActivation({
          char: { name: "ada", root: path.join(root, "players", "ada") },
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

      const wm = parseWmFile(fs.readFileSync(path.join(charDir, "wm.json"), "utf8"))
      expect(wm.todos.find((t) => t.id === "t1")?.state).toBe("discarded")
      expect(wm.todos.find((t) => t.id === "t2")?.state).toBe("discarded")
      // Agent memory untouched, still open and rendered.
      expect(wm.todos.find((t) => t.id === "t3")).toMatchObject({ state: "open", origin: "agent" })
      const md = fs.readFileSync(path.join(charDir, "WM.md"), "utf8")
      expect(md).not.toContain("DEAD_PLAN_HEADLINE")
      expect(md).toContain("AGENT_MEMORY_KEEP")

      // The sweep is recorded as a type:"wm" transition, before any step-start.
      const recFile = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const records = fs.readFileSync(recFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      const sweep = records.find((r) => r.type === "wm")
      expect(sweep.deltas.map((d: { op: string; id: string }) => [d.op, d.id])).toEqual([
        ["discard", "t1"],
        ["discard", "t2"],
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
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
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
      // >= 6, not >= 4: turn 1's callback (which enqueues the mid-session steer
      // event) itself lands on tick 2 or 3 depending on fork-scheduling jitter, and
      // since phase B2 forked the hindbrain reflex off the tick loop, a submitted
      // reflex's appraisal now lands one tick LATER than the event that triggered
      // it (observed landing as late as tick 5). The bound must clear both the
      // pre-existing turn-open jitter and the forked-reflex one-tick landing
      // latency (B2).
      const domain = domainWith([], () => {
        tickRef.n++
        return tickRef.n >= 6 ? [{ priority: "critical" as const, message: "bound" }] : []
      })
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    // Deterministic bound anchored to session-open (not an absolute tick): sinceOpen
    // counts ticks after the conscious session opens, robust to the async fork-landing
    // tick that now seeds the plan a tick or two later than the old sync path.
    const sinceOpen = { n: 0 }
    const sessionOpened = { value: false }
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
          // turn 1 enqueues steer-evt #1 and marks the session open (anchors the
          // deterministic bound below); the FIRST steer turn enqueues steer-evt #2.
          if (!resume) {
            // Distinct payloads (n:1 vs n:2) so the two steer events model two
            // GENUINELY distinct salient occurrences — the mechanical dedup (Task
            // 1) would collapse byte-identical repeats to discard@0, which is not
            // what this cadence-bypass test exercises. Both still observe as STEER
            // (the branch keys on the "steer-evt" type substring).
            Queue.unsafeOffer(events, { type: "steer-evt", n: 1 })
            sessionOpened.value = true
          } else {
            resumeCount++
            if (resumeCount === 1) Queue.unsafeOffer(events, { type: "steer-evt", n: 2 })
          }
          return { result: { output: "working", timedOut: false, durationMs: 1 }, sessionId: "ses_n2" }
        },
        (d) => captured.push(d),
      )
      yield* Queue.offer(events, { type: "plan-seed" })
      // Bound the loop a fixed number of ticks after the session opens. Anchoring
      // to session-open — not an absolute tick — preserves the identical two-steer
      // window regardless of which tick the deliberation fork lands on. Since B2
      // the hindbrain reflex is ALSO forked, so each steer-evt's appraisal lands a
      // tick later than the old sync path (the reflex-scheduler ordering contract);
      // the bound is widened to open+5 to accommodate that extra fork-landing tick
      // for BOTH steers. WITH bypass both steers still fire inside the window;
      // WITHOUT it the second waits a full DEFAULT_STEER_CADENCE_TICKS and misses.
      const domain = domainWith([], () => {
        if (sessionOpened.value) sinceOpen.n++
        return sinceOpen.n >= 5 ? [{ priority: "critical" as const, message: "bound" }] : []
      })
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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

  it("ladder governs the in-flight deliberation: a reorient-rung event interrupts the fiber and re-orients (Unit: fork ladder)", async () => {
    const interrupted = { value: false }
    let decideCount = 0
    const client = scriptClient({
      diary: "d",
      observe: (_raw, lower) =>
        lower.includes("termination-60s")
          ? '{"disposition":"escalate","emotionalWeight":"😱","drive":"agency","weight":5,"interrupt":false,"reason":"account termination in 60s"}'
          : DISCARD,
      evaluate: EVAL_TERMINATE_X,
      orient: ORIENT_H,
      // decide: #1 blocks (deliberation in flight); #2 (post-reorient) terminates.
      decide: () => {
        decideCount++
        return decideCount === 1
          ? Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted.value = true })))
          : '{"decision":"terminate","reasoning":"reoriented"}'
      },
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" }) // tick 1 → fork deliberation (decide #1 blocks)
      yield* Effect.forkDaemon(Effect.sleep("8 millis").pipe(Effect.andThen(Queue.offer(events, { type: "termination-60s" }))))
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
        containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domainWith([]), fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // The reorient-rung event interrupted the in-flight deliberation…
    expect(interrupted.value).toBe(true)
    // …and re-oriented: a second decide cycle ran after the interrupt.
    expect(decideCount).toBeGreaterThanOrEqual(2)
  }, 20_000)

  it("an amygdala critical during a deliberation interrupts the fiber and exits Interrupted (Unit: fork critical)", async () => {
    const interrupted = { value: false }
    const criticalsRef = { n: 0 }
    const client = scriptClient({
      diary: "d",
      observe: DISCARD,
      evaluate: EVAL_TERMINATE_X,
      orient: ORIENT_H,
      // decide blocks → deliberation in flight when the critical fires
      decide: () =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted.value = true }))),
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const domain = domainWith([], () => {
      criticalsRef.n++
      return criticalsRef.n >= 3 ? [{ priority: "critical" as const, message: "hull critical" }] : []
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" })
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
        containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Interrupted")
    expect(interrupted.value).toBe(true)
  }, 20_000)

  it("landed reconciliation: applies a fresh plan and drains ONLY the snapshot events (retains mid-deliberation events)", async () => {
    const orientPrompts: string[] = []
    // decide #1 blocks until a mid-deliberation event lands, then completes with a plan.
    let decideCount = 0
    const client = scriptClient({
      diary: "d",
      // Both the seed event (pre-fork) and the mid-deliberation event (in-flight)
      // are plain accumulates (weight 2, non-discard) — SEED_EVENT so it actually
      // joins `accumulatedEvents` and rides the fork-time snapshot (making the
      // slice-drain assertion below non-vacuous); MID_EVENT so it's retained, not
      // stale, per the ladder. Checked against `raw` — these markers are uppercase.
      observe: (raw) =>
        raw.includes("MID_EVENT") || raw.includes("SEED_EVENT")
          ? '{"disposition":"accumulate","emotionalWeight":"😐","drive":null,"weight":2,"interrupt":false,"reason":"minor"}'
          : DISCARD,
      evaluate: EVAL_TERMINATE_X,
      orient: (raw) => {
        orientPrompts.push(raw)
        return ORIENT_H
      },
      // Since B2 the hindbrain reflex is forked, so SEED_EVENT's appraisal lands a
      // tick AFTER it is submitted — it cannot ride the tick-1 auto-escalate
      // deliberation's (empty) snapshot. So decide #1 (tick-1, empty snapshot)
      // lands a `wait`; SEED_EVENT then accumulates, and a later `forceOrient` fork
      // (decide #2) carries it into the plan-forming orient — exactly the snapshot
      // the slice-drain must drain.
      decide: () => {
        decideCount++
        if (decideCount === 1)
          return '{"decision":"wait","reasoning":"idle","wait":{"waitingFor":"x","resolutionSignal":"y","disposition":"hold"}}'
        if (decideCount === 2)
          return '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}'
        return '{"decision":"terminate","reasoning":"done"}'
      },
    })
    let turnCount = 0
    // Flips once the FIRST body turn is forked — which can only happen once
    // `currentPlan` is non-null, i.e. strictly after the tick-1 deliberation
    // has already landed and applied. A shared, plain (non-Effect) signal so
    // the domain's per-tick `criticals()` hook (below) can react to it.
    const turnStarted = { value: false }
    const ctLayer = ConsciousThoughtTest(
      (_c, _r) => {
        turnCount++
        turnStarted.value = true
        // Turn 2 (a steer turn) carries the in-session directive; end the step there.
        return turnCount >= 2
          ? { result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 1 }, sessionId: "s" }
          : { result: { output: "working", timedOut: false, durationMs: 1 }, sessionId: "s" }
      },
      undefined,
    )
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "SEED_EVENT" }) // snapshot event (drained on apply)
      // Deterministic mid-deliberation event (no wall-clock race). A wall-clock
      // sleep here would race the deliberation's own duration (which varies with
      // however many real Effect steps — identity reads, memory recall, model
      // calls — it takes to resolve): too short and MID_EVENT lands in the same
      // fork-time snapshot as SEED_EVENT (making the drop assertion vacuous in
      // the other direction); too long and it can land AFTER the plan lands but
      // with no further hindbrain triage ever surfacing it in an orient (the
      // assertion below would see `undefined`). Anchoring on `turnStarted`
      // instead of a tick/time count is exact: a body turn cannot start before
      // `currentPlan` is set, so gating the offer on it guarantees MID_EVENT is
      // queued strictly after the snapshot was taken AND after the plan has
      // already landed — so its own hindbrain triage tick is guaranteed to see
      // `currentPlan !== null` and fire the in-session steer orient.
      let midOffered = false
      const domain = domainWith([], () => {
        if (turnStarted.value && !midOffered) {
          midOffered = true
          Queue.unsafeOffer(events, { type: "MID_EVENT" })
        }
        return []
      })
      // orientInterval:3 (not 1) so the post-idle `forceOrient` waits a few ticks
      // after the empty tick-1 deliberation — giving SEED_EVENT's forked reflex
      // time to land + accumulate before decide #2's fork captures its snapshot.
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
        containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 3, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // The fresh plan applied and its step ran (a body turn, then a steer turn, fired).
    expect(turnCount).toBeGreaterThanOrEqual(1)
    // Prerequisite check: SEED_EVENT genuinely ACCUMULATED before the deliberation
    // forked — it rode the fork-time snapshot into the plan-forming orient. Without
    // this, the drop assertion below would be vacuous (an implementation that never
    // drains anything would pass trivially, since there'd be nothing to drain).
    const seedOrient = orientPrompts.find((p) => p.includes("SEED_EVENT"))
    expect(seedOrient).toBeDefined()
    // Reconciliation drained the SNAPSHOT event but retained MID_EVENT: the post-apply
    // in-session steer orient carries MID_EVENT and no longer carries the drained SEED_EVENT.
    const steerOrient = orientPrompts.find((p) => p.includes("MID_EVENT"))
    expect(steerOrient).toBeDefined()
    expect(steerOrient!).not.toContain("SEED_EVENT")
  }, 20_000)

  it("never-fail degrade: a deliberation whose decide model errors seeds no plan and re-orients (no crash, no stall)", async () => {
    let decideCount = 0
    const client = scriptClient({
      diary: "d",
      observe: DISCARD,
      evaluate: EVAL_TERMINATE_X,
      orient: ORIENT_H,
      // decide: #1 FAILS (model error) → fork degrades to no-plan; #2 (the self-driven
      // re-orient, no new events) terminates → proves the quiet world did not stall.
      decide: () => {
        decideCount++
        return decideCount === 1
          ? Effect.fail(new ModelError({ tier: "conscious", model: "m", baseUrl: "u", reason: "decide boom" }))
          : '{"decision":"terminate","reasoning":"done"}'
      },
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" }) // the ONLY event ever queued
      const fiber = yield* Effect.fork(
        runActivation({
          char: { name: "ada", root: "/work/players/ada" },
          containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domainWith([]), fakeIo, fakeRuntimeDeps, noopModelService))),
      )
      yield* Effect.sleep("150 millis")
      const exit = yield* Fiber.poll(fiber)
      yield* Fiber.interrupt(fiber)
      return { count: decideCount, completed: Option.isSome(exit) }
    })
    const { count, completed } = await Effect.runPromise(program)
    // The failed deliberation did not crash the loop; it re-oriented (a 2nd decide ran) and completed.
    expect(count).toBeGreaterThanOrEqual(2)
    expect(completed).toBe(true)
  }, 20_000)

  it("wait/hold land does NOT force a re-orient: a deliberate hold is not a busy re-deliberation loop", async () => {
    // Sibling of the degrade test above. A deliberation that DECIDES wait/hold leaves
    // currentPlan null (like a degrade) but is a DELIBERATE idle — it must NOT re-orient,
    // or the hold turns into a per-tick orient→decide busy-loop. The degrade guard must
    // fire ONLY on a genuinely-degraded no-plan land, never on a wait.
    let decideCount = 0
    const client = scriptClient({
      diary: "d",
      observe: DISCARD,
      evaluate: EVAL_TERMINATE_X,
      orient: ORIENT_H,
      // decide: waits/holds (deliberate idle). If the guard wrongly forces a re-orient,
      // the next tick re-forks and decide runs AGAIN — decideCount climbs past 1 (the bug).
      decide: () => {
        decideCount++
        return '{"decision":"wait","reasoning":"holding","wait":{"waitingFor":"signal","resolutionSignal":"sig","disposition":"hold"}}'
      },
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" }) // the ONLY event ever queued
      const fiber = yield* Effect.fork(
        runActivation({
          char: { name: "ada", root: "/work/players/ada" },
          containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domainWith([]), fakeIo, fakeRuntimeDeps, noopModelService))),
      )
      yield* Effect.sleep("150 millis")
      yield* Fiber.interrupt(fiber)
      return decideCount
    })
    const count = await Effect.runPromise(program)
    // The hold is respected: decide ran exactly once — the quiet world did not re-deliberate.
    expect(count).toBe(1)
  }, 20_000)
})

describe("identity/context assembly (single seam, honest empty blocks)", () => {
  // Extract the "## Agent Identity" block (background/values/diary/synthesis) —
  // the section fed by readIdentityContext.
  const identityBlock = (prompt: string): string => {
    const start = prompt.indexOf("## Agent Identity")
    const end = prompt.indexOf("## Emotional Weight from Observations")
    return prompt.slice(start, end)
  }

  it("idle-path orient prompt renders empty identity blocks as placeholders, never bare headers", async () => {
    let orientPrompt = ""
    const client = scriptClient({
      orient: (raw) => {
        orientPrompt = raw
        return orientHeadline("act now")
      },
      decide:
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":1}]}',
    })
    const ctLayer = ConsciousThoughtTest((_config, _resume) => ({
      result: { output: `done ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 },
      sessionId: "s",
    }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" })
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
        containerId: "c1",
        events,
        initialState: {},
        cadence: "real-time",
        orientInterval: 1,
        tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    await Effect.runPromise(program)
    expect(orientPrompt).not.toBe("")
    // The synthesis memory-index header must never stand alone over a blank line.
    expect(orientPrompt).not.toMatch(/Memory Index \(synthesis\)\s*\n\s*\n\s*##/)
    // Every empty identity block reads as an explicit placeholder, not a bare header.
    expect(orientPrompt).toContain("(no memory index yet)")
    expect(orientPrompt).toContain("(no background recorded yet)")
    expect(orientPrompt).toContain("(no values recorded yet)")
    expect(orientPrompt).toContain("(no diary entries yet)")
    // The recall block is self-guarding (formatRecall returns "" when empty and
    // owns its own header inside the block) — an empty recall must NOT inject a
    // stray floating placeholder line at the top of the prompt, nor a bare
    // "## You recall" header.
    expect(orientPrompt).not.toContain("(no relevant memories recalled)")
    expect(orientPrompt).not.toContain("## You recall")
  }, 20_000)

  it("idle and steer paths render an identical identity block for the same state", async () => {
    const orientPrompts: string[] = []
    const client = scriptClient({
      orient: (raw) => {
        orientPrompts.push(raw)
        return orientHeadline("focus")
      },
      // decide: large budget so the step stays in-session until a steer turn lands.
      decide:
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}',
    })
    let turnCount = 0
    const ctLayer = ConsciousThoughtTest((_config, _resume) => {
      turnCount++
      if (turnCount >= 2)
        return { result: { output: `steered ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 }, sessionId: "s" }
      return { result: { output: "working...", timedOut: false, durationMs: 5 }, sessionId: "s" }
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "combat" }) // tick 1: idle orient → plan → turn 1
      yield* Effect.forkDaemon(
        Effect.sleep("8 millis").pipe(Effect.andThen(Queue.offer(events, { type: "mid-session-update" }))),
      )
      return yield* runActivation({
        char: { name: "ada", root: "/work/players/ada" },
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
    // Both an idle orient (plan formation) and a steer orient (mid-session) fired.
    expect(orientPrompts.length).toBeGreaterThanOrEqual(2)
    const blocks = orientPrompts.map(identityBlock)
    // The identity block is byte-identical across every path for the same state.
    for (const b of blocks) expect(b).toBe(blocks[0])
    // And it is the honest placeholder form (not a bare header), on both paths.
    expect(blocks[0]).toContain("(no memory index yet)")
  }, 20_000)

  it("idle and steer paths render identical identity, recall, and wm-tree content for a POPULATED character", async () => {
    // The byte-identity claim actually rests on the populated case: non-empty
    // background/values/diary/synthesis, recall hits present, and an open
    // agent-authored wm todo. The char dir is made read-only after seeding
    // wm.json so seedWmPlan's persist fails (best-effort, logged) and the wm
    // state is genuinely THE SAME for both the idle-orient and steer-orient
    // reads — otherwise plan-seeded todos would legitimately differ between them.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-populated-"))
    const charDir = path.join(root, "players", "ada", "me")
    fs.mkdirSync(charDir, { recursive: true })
    fs.writeFileSync(
      path.join(charDir, "wm.json"),
      JSON.stringify({
        version: 1,
        nextId: 2,
        todos: [
          {
            id: "t1",
            text: "WM_AGENT_TODO_MARKER",
            parent: null,
            state: "open",
            origin: "agent", // survives the loop-entry dead-plan sweep
            createdAt: "2026-07-03T00:00:00.000Z",
            updatedAt: "2026-07-03T00:00:00.000Z",
          },
        ],
        pendingDeltas: [],
      }),
    )
    fs.chmodSync(charDir, 0o555)
    const populatedFs = Layer.succeed(
      CharacterFs,
      CharacterFs.of({
        readDiary: () => Effect.succeed("DIARY_MARKER day one"),
        writeDiary: () => Effect.void,
        readSecrets: () => Effect.succeed(""),
        writeSecrets: () => Effect.void,
        readCredentials: () => Effect.succeed({ username: "", password: "" }),
        readBackground: () => Effect.succeed("BACKGROUND_MARKER born on Ceres"),
        readValues: () => Effect.succeed("VALUES_MARKER honesty"),
        readPalette: () => Effect.succeed(""),
        readDrives: () => Effect.succeed(""),
        readSalience: () => Effect.succeed(""),
        characterExists: () => Effect.succeed(true),
        listSkills: () => Effect.succeed([]),
        readSkill: () => Effect.succeed(null),
        writeSkill: () => Effect.void,
        readSynthesis: () => Effect.succeed("SYNTHESIS_MARKER I am cautious"),
        writeSynthesis: () => Effect.void,
        deleteSkill: () => Effect.void,
      }),
    )
    // Recall returns a fixed self-contained block for the orient-cadence label.
    const populatedMemory = Layer.succeed(
      MemoryGateway,
      MemoryGateway.of({
        remember: () => Effect.void,
        recall: (_c, _ch, _q, opts) =>
          Effect.succeed(opts.label === "You recall" ? "\n\n## You recall\n- RECALL_MARKER" : ""),
      }),
    )
    const runtimeDeps = Layer.mergeAll(StubCommandExecutor, StubOAuthToken, StubDocker, populatedMemory)
    const orientPrompts: string[] = []
    const client = scriptClient({
      orient: (raw) => {
        orientPrompts.push(raw)
        return orientHeadline("focus")
      },
      // decide: large budget so the step stays in-session until a steer turn lands.
      decide:
        '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}',
    })
    let turnCount = 0
    const ctLayer = ConsciousThoughtTest((_config, _resume) => {
      turnCount++
      if (turnCount >= 2)
        return { result: { output: `steered ${STEP_DONE_MARKER}`, timedOut: false, durationMs: 5 }, sessionId: "s" }
      return { result: { output: "working...", timedOut: false, durationMs: 5 }, sessionId: "s" }
    })
    try {
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" }) // tick 1: idle orient → plan → turn 1
        yield* Effect.forkDaemon(
          Effect.sleep("8 millis").pipe(Effect.andThen(Queue.offer(events, { type: "mid-session-update" }))),
        )
        return yield* runActivation({
          char: { name: "ada", root: path.join(root, "players", "ada") },
          containerId: "c1",
          events,
          initialState: {},
          cadence: "real-time",
          orientInterval: 1,
          tickIntervalMs: 1,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(client, ctLayer, fakeDomain, Layer.mergeAll(populatedFs, fakeLog), runtimeDeps, noopModelService),
          ),
        )
      })
      const result = await Effect.runPromise(program)
      expect(result._tag).toBe("Completed")
      // Both an idle orient (plan formation) and a steer orient (mid-session) fired.
      expect(orientPrompts.length).toBeGreaterThanOrEqual(2)
      // The identity block (background/values/diary/synthesis) is byte-identical
      // across the idle and steer paths, carrying the REAL content.
      const blocks = orientPrompts.map(identityBlock)
      for (const b of blocks) expect(b).toBe(blocks[0])
      expect(blocks[0]).toContain("BACKGROUND_MARKER born on Ceres")
      expect(blocks[0]).toContain("VALUES_MARKER honesty")
      expect(blocks[0]).toContain("DIARY_MARKER day one")
      expect(blocks[0]).toContain("SYNTHESIS_MARKER I am cautious")
      // The wm-tree block (Working Memory → Instructions) is byte-identical too,
      // and renders the live open todo (no "(no open todos)" placeholder).
      const wmBlock = (prompt: string): string =>
        prompt.slice(prompt.indexOf("## Working Memory (open todos)"), prompt.indexOf("## Instructions"))
      const wmBlocks = orientPrompts.map(wmBlock)
      for (const w of wmBlocks) expect(w).toBe(wmBlocks[0])
      expect(wmBlocks[0]).toContain("WM_AGENT_TODO_MARKER")
      expect(wmBlocks[0]).not.toContain("(no open todos)")
      // The recall block renders its hits (own header, passed through raw) on BOTH paths.
      for (const prompt of orientPrompts) {
        expect(prompt).toContain("## You recall\n- RECALL_MARKER")
      }
    } finally {
      fs.chmodSync(charDir, 0o755)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})

// ── Phase 0 characterization — contracts the runActivation decomposition must preserve ──
// These pin the observable behaviors the B/A/rename phases could silently break.
// They deliberately do NOT duplicate contracts already pinned elsewhere in this file;
// see .superpowers/sdd/phase-0-baseline.md for the test↔contract map. New here only
// where no existing test pins the contract (tick-cadence source) or where a phase will
// relocate a named exported knob (DEFAULT_STEER_CADENCE_TICKS).
describe("runActivation — Phase 0 characterization (decomposition-invariant contracts)", () => {
  it("tick cadence source: the inter-tick sleep is sourced from config.tickIntervalMs, defaulting to the 30s DEFAULT_TICK_MS when the caller passes none", async () => {
    // Load-bearing for Phase B1: today the domains capture the connection's
    // tickIntervalSec but pass NO tickIntervalMs, so the live loop silently paces on
    // the 30s DEFAULT_TICK_MS. B1 will start threading the real cadence in. This test
    // pins the CURRENT source-of-truth so a later phase can't accidentally change which
    // knob governs pacing. Observed via wall clock: a scenario needing several ticks
    // completes near-instantly at tickIntervalMs:1, but cannot make multi-tick progress
    // within 250ms when the 30s default governs (250ms << 30_000ms — a 120x margin).
    const ctLayer = () =>
      ConsciousThoughtTest((config) => ({ result: successTurnResult(config.prompt), sessionId: "ses_cadence" }))

    // (a) Configured fast cadence → the multi-tick scenario completes.
    const fast = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" })
        return yield* runActivation({
          char: { name: "ada", root: "/work/players/ada" },
          containerId: "c1",
          events,
          initialState: {},
          cadence: "real-time",
          orientInterval: 1,
          tickIntervalMs: 1,
        }).pipe(Effect.provide(Layer.mergeAll(scriptedClient, ctLayer(), fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService)))
      }),
    )
    expect(fast._tag).toBe("Completed")

    // (b) Default cadence (no tickIntervalMs) → after 250ms the loop is still on its
    // first DEFAULT_TICK_MS (30s) sleep, so the same scenario has NOT completed.
    const stillRunningOnDefault = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" })
        const fiber = yield* Effect.fork(
          runActivation({
            char: { name: "ada", root: "/work/players/ada" },
            containerId: "c1",
            events,
            initialState: {},
            cadence: "real-time",
            orientInterval: 1,
            // NO tickIntervalMs → DEFAULT_TICK_MS (30_000ms) governs pacing.
          }).pipe(Effect.provide(Layer.mergeAll(scriptedClient, ctLayer(), fakeDomain, fakeIo, fakeRuntimeDeps, noopModelService))),
        )
        yield* Effect.sleep("250 millis")
        const exit = yield* Fiber.poll(fiber)
        yield* Fiber.interrupt(fiber)
        return Option.isNone(exit)
      }),
    )
    expect(stillRunningOnDefault).toBe(true)
  }, 20_000)

  it("steer throttle knob: DEFAULT_STEER_CADENCE_TICKS pins the in-session steer cadence window (exported from the loop)", () => {
    // §7 contract: a coalesced directive is pushed to the open session at most once
    // every DEFAULT_STEER_CADENCE_TICKS ticks, unless a priority (steer-rung) event
    // sets bypassSteerCadence. Functional behavior is covered by "cadence throttle:
    // steer turn carries the latest coalesced directive" (coalescing/newest-wins) and
    // "Nit 2: bypassSteerCadence fires ... within DEFAULT_STEER_CADENCE_TICKS". This
    // guards the constant's VALUE and its export location so the rename/relocation
    // phases keep the named knob stable rather than silently re-tuning the window.
    expect(DEFAULT_STEER_CADENCE_TICKS).toBe(3)
  })
})
