import { describe, it, expect, afterEach, beforeEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { DEFAULT_CORTEX_MODELS } from "../../../model/handles.js"
import { runConsciousDecide, runConsciousEvaluate, runDiaryTurn } from "./tiers-conscious.js"
import type { ActivationRunnerConfig } from "#brain/stem/tier-config.js"
import type { OrientResult } from "../../../skills/types.js"
import { fixedClient, recordingService, silentLog } from "../../../testing/model-test-layers.js"
import { setEpisodeTick, resetEpisodeContext } from "../../../logging/episodes.js"
import { buildAxisSpecs } from "../../../core/salience.js"

const config: ActivationRunnerConfig = {
  char: { name: "ada", root: "/work/players/ada" },
  cadence: "real-time",
  models: DEFAULT_CORTEX_MODELS,
}

/** The base config with episode logging ENABLED, rooted under `r` (players/ada/logs).
 *  Replaces the former module-level setEpisodeLogRoot(root): the persistence root now
 *  flows explicitly through char.logsDir. */
const configWithLogs = (r: string): ActivationRunnerConfig => ({
  ...config,
  char: { ...config.char, root: path.join(r, "players", "ada") },
})

// The decide path consumes the orient result's `sections` via `.map`. Even if
// a malformed OrientResult slips through (e.g. constructed directly), the
// decide builder must not throw on a non-array `sections`.
describe("runConsciousDecide — does not crash on malformed orient", () => {
  const decideWith = (orient: OrientResult) =>
    Effect.runPromise(
      Effect.provide(
        runConsciousDecide(config, orient, "no plan", "skills"),
        Layer.mergeAll(
          fixedClient('{"decision":"continue","reasoning":"steady"}'),
          recordingService([]),
          silentLog,
        ),
      ),
    )

  const base = {
    headline: "h",
    whatChanged: "w",
    emotionalState: "😐",
    confidence: "low" as const,
    metrics: {},
  }

  it("does not throw when sections is undefined", async () => {
    const out = await decideWith({ ...base, sections: undefined as never })
    expect(out.decision).toBe("continue")
  })

  it("does not throw when sections is a non-array", async () => {
    const out = await decideWith({ ...base, sections: "docked" as never })
    expect(out.decision).toBe("continue")
  })
})

// Regression: a small conscious model can emit `{"transition":"replan"}` — a
// bare ENUM STRING where the schema wants `{transition:"replan",...}`. The merge
// keeps the string, so downstream `evalResult.transition.transition` is
// undefined and every transition branch falls through (silently wrong: the loop
// neither replans nor terminates nor waits — it falls into the next_step else).
// runConsciousEvaluate must normalize `transition` so it is ALWAYS a valid
// `{transition: <enum>}` object before it reaches the loop.
describe("runConsciousEvaluate — transition normalization", () => {
  const evalInput = {
    task: "t",
    goal: "g",
    successCondition: "c",
    ticksBudgeted: 4,
    ticksConsumed: 2,
    executionReport: "did stuff",
    stateDiff: "diff",
    conditionCheck: "checked",
    emotionalState: "😐",
    remainingSteps: "None.",
  }

  const evalWith = (raw: string) =>
    Effect.runPromise(
      Effect.provide(
        runConsciousEvaluate(config, evalInput),
        Layer.mergeAll(fixedClient(raw), recordingService([]), silentLog),
      ),
    )

  it("coerces a bare-string transition (\"replan\") to a valid object", async () => {
    const out = await evalWith(
      '{"judgment":"failed","reasoning":"r","transition":"replan"}',
    )
    expect(out.transition).toEqual({ transition: "replan" })
    // Downstream `t.transition` reads must see the enum, not undefined.
    expect(out.transition.transition).toBe("replan")
  })

  it("coerces a bare-string \"next_step\" transition to a valid object", async () => {
    const out = await evalWith(
      '{"judgment":"succeeded","reasoning":"r","transition":"next_step"}',
    )
    expect(out.transition.transition).toBe("next_step")
  })

  it("defaults to next_step when transition is missing entirely", async () => {
    const out = await evalWith('{"judgment":"succeeded","reasoning":"r"}')
    expect(out.transition.transition).toBe("next_step")
  })

  it("defaults to next_step when transition is an unrecoverable shape (number)", async () => {
    const out = await evalWith(
      '{"judgment":"failed","reasoning":"r","transition":7}',
    )
    expect(out.transition.transition).toBe("next_step")
  })

  it("preserves a proper object transition (replan with reason)", async () => {
    const out = await evalWith(
      '{"judgment":"failed","reasoning":"r","transition":{"transition":"replan","reason":"stuck"}}',
    )
    expect(out.transition).toEqual({ transition: "replan", reason: "stuck" })
  })

  it("preserves a proper object transition (terminate with summary)", async () => {
    const out = await evalWith(
      '{"judgment":"succeeded","reasoning":"r","transition":{"transition":"terminate","summary":"done"}}',
    )
    expect(out.transition.transition).toBe("terminate")
  })

  it("falls back to a valid transition object on a total parse miss", async () => {
    const out = await evalWith("the model rambled, no json")
    expect(out.transition.transition).toBe("next_step")
  })
})

describe("transition episodes — OODA tier calls", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-tiers-conscious-"))
    resetEpisodeContext("ada")
    setEpisodeTick("ada", 7)
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const transitionFile = () => path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
  const readTransitions = () =>
    fs.readFileSync(transitionFile(), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))

  const orientFixture: OrientResult = {
    headline: "h", sections: [], whatChanged: "w", emotionalState: "😐", confidence: "low", metrics: {},
  }

  // Split from the original mixed "decide, evaluate, and diary each append
  // their phase; observe never does" case (cortex/tiers.test.ts) — the
  // observe/hindbrain negative control now lives in the sibling
  // tiers-limbic.test.ts (limbic layer). This half preserves the positive
  // assertion: decide, evaluate, and diary each append their phase.
  it("decide, evaluate, and diary each append their phase", async () => {
    const layersFor = (text: string) => Layer.mergeAll(fixedClient(text), recordingService([]), silentLog)

    await Effect.runPromise(
      Effect.provide(runConsciousDecide(configWithLogs(root), orientFixture, "No active plan.", "actions"),
        layersFor('{"decision":"continue","reasoning":"r"}')),
    )
    await Effect.runPromise(
      Effect.provide(
        runConsciousEvaluate(configWithLogs(root), {
          task: "t", goal: "g", successCondition: "s", ticksBudgeted: 2, ticksConsumed: 1,
          executionReport: "r", stateDiff: "", conditionCheck: "c", emotionalState: "😐", remainingSteps: "None.",
        }),
        layersFor('{"judgment":"succeeded","reasoning":"done","transition":{"transition":"next_step"}}'),
      ),
    )
    await Effect.runPromise(
      Effect.provide(
        runDiaryTurn(configWithLogs(root), {
          charName: "ada", task: "t", goal: "g", judgment: "succeeded",
          reasoning: "r", executionReport: "e", emotionalState: "😐",
        }),
        layersFor("Dear diary, it went fine."),
      ),
    )

    const phases = readTransitions().map((r) => r.phase)
    expect(phases).toEqual(["decide", "evaluate", "diary"])
    const diary = readTransitions()[2]
    expect(diary.output).toBe("Dear diary, it went fine.")
  })
})

describe("working-memory prompt variable (spec §2)", () => {
  const layers = (text: string) => Layer.mergeAll(fixedClient(text), recordingService([]), silentLog)
  const wmOrientFixture: OrientResult = {
    headline: "h",
    sections: [],
    whatChanged: "w",
    emotionalState: "😐",
    confidence: "low",
    metrics: {},
  }

  it("decide renders the open-todo tree into the prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-tiers-conscious-"))
    resetEpisodeContext("ada")
    try {
      await Effect.runPromise(
        Effect.provide(
          runConsciousDecide(configWithLogs(root), wmOrientFixture, "No active plan.", "actions", "", "- t2 WM_DECIDE_MARKER"),
          layers('{"decision":"continue","reasoning":"r"}'),
        ),
      )
      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const [rec] = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      expect(rec.prompt).toContain("- t2 WM_DECIDE_MARKER")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("decide skill selection (spec §3)", () => {
  const layers = (text: string) => Layer.mergeAll(fixedClient(text), recordingService([]), silentLog)
  const orientFixture: OrientResult = {
    headline: "h", sections: [], whatChanged: "w", emotionalState: "😐", confidence: "low", metrics: {},
  }

  it("renders the skill index into the decide prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-idx-"))
    resetEpisodeContext("ada")
    try {
      await Effect.runPromise(
        Effect.provide(
          runConsciousDecide(configWithLogs(root), orientFixture, "No active plan.", "actions", "", "", "- learning — SKILL_INDEX_MARKER"),
          layers('{"decision":"continue","reasoning":"r"}'),
        ),
      )
      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const [rec] = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      expect(rec.prompt).toContain("SKILL_INDEX_MARKER")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps a valid skill on the parsed result and drops junk", async () => {
    const good = await Effect.runPromise(
      Effect.provide(
        runConsciousDecide(config, orientFixture, "No active plan.", "actions"),
        layers('{"decision":"plan","reasoning":"r","steps":[],"skill":" securing-fuel "}'),
      ),
    )
    expect((good as { skill?: string }).skill).toBe("securing-fuel")

    const junk = await Effect.runPromise(
      Effect.provide(
        runConsciousDecide(config, orientFixture, "No active plan.", "actions"),
        layers('{"decision":"continue","reasoning":"r","skill":42}'),
      ),
    )
    expect("skill" in junk).toBe(false)
  })
})

// Pathways 3 and 4 (design 2026-07-31 §3): decide's and evaluate's producer (C)
// stage. Like runForebrain, runConsciousDecide/runConsciousEvaluate inline the
// render + sanitize steps with no pure seam of their own, so nothing else on
// this branch would catch a dropped `axes: renderAxisBlock(config.axes)` or a
// dropped `sanitizeSalienceVector` call. These four tests pin exactly those
// lines, mirroring tiers-limbic.test.ts's "salience axes — producer (C) stage
// (pathway 2)" for orient.
describe("salience axes — producer (C) stage (pathways 3 and 4)", () => {
  const layers = (text: string) => Layer.mergeAll(fixedClient(text), recordingService([]), silentLog)
  // Same axis fixture as tiers-limbic.test.ts / state.test.ts: one unipolar
  // drive ("voyage") and one bipolar palette axis ("burdened-exhilarated"),
  // neither of which appears anywhere else in these tests' (empty/minimal)
  // inputs — so their presence in the rendered prompt is unambiguous evidence
  // the axis block reached it.
  const axes = buildAxisSpecs(
    "- safety — your physical integrity\n- voyage — progress",
    "😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated",
  )
  const orientFixture: OrientResult = {
    headline: "h", sections: [], whatChanged: "w", emotionalState: "😐", confidence: "low", metrics: {},
  }

  describe("decide", () => {
    it("renders the axis block into the decide prompt", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "axes-decide-"))
      resetEpisodeContext("ada")
      try {
        await Effect.runPromise(
          Effect.provide(
            runConsciousDecide({ ...configWithLogs(root), axes }, orientFixture, "No active plan.", "actions"),
            layers('{"decision":"continue","reasoning":"r"}'),
          ),
        )
        const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
        const [rec] = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
        expect(rec.prompt).toContain("voyage")
        expect(rec.prompt).toContain("burdened-exhilarated")
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it("sanitizes the model's raw salience vector: unknown axis dropped, out-of-range clamped, null-valued key dropped", async () => {
      const out = await Effect.runPromise(
        Effect.provide(
          runConsciousDecide({ ...config, axes }, orientFixture, "No active plan.", "actions"),
          layers(
            '{"decision":"continue","reasoning":"r","salience":' +
              '{"safety":1.6,"curiosity":0.9,"voyage":null,"burdened-exhilarated":-0.4}}',
          ),
        ),
      )
      // safety: 1.6 clamped to 1 (unipolar). curiosity: dropped, not in the
      // derived vocabulary. voyage: null dropped entirely — a missing reading,
      // not clamped to 0. burdened-exhilarated: -0.4 kept as-is (bipolar, in range).
      expect((out as { salience?: Record<string, number> }).salience).toEqual({
        safety: 1,
        "burdened-exhilarated": -0.4,
      })
    })
  })

  describe("evaluate", () => {
    const evalInput = {
      task: "t", goal: "g", successCondition: "c", ticksBudgeted: 2, ticksConsumed: 1,
      executionReport: "did stuff", stateDiff: "diff", conditionCheck: "checked",
      emotionalState: "😐", remainingSteps: "None.",
    }

    it("renders the axis block into the evaluate prompt", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "axes-evaluate-"))
      resetEpisodeContext("ada")
      try {
        await Effect.runPromise(
          Effect.provide(
            runConsciousEvaluate({ ...configWithLogs(root), axes }, evalInput),
            layers('{"judgment":"succeeded","reasoning":"r","transition":{"transition":"next_step"}}'),
          ),
        )
        const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
        const [rec] = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
        expect(rec.prompt).toContain("voyage")
        expect(rec.prompt).toContain("burdened-exhilarated")
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it("sanitizes the model's raw salience vector: unknown axis dropped, out-of-range clamped, null-valued key dropped", async () => {
      const out = await Effect.runPromise(
        Effect.provide(
          runConsciousEvaluate({ ...config, axes }, evalInput),
          layers(
            '{"judgment":"succeeded","reasoning":"r","transition":{"transition":"next_step"},"salience":' +
              '{"safety":1.6,"curiosity":0.9,"voyage":null,"burdened-exhilarated":-0.4}}',
          ),
        ),
      )
      expect(out.salience).toEqual({ safety: 1, "burdened-exhilarated": -0.4 })
    })
  })
})
