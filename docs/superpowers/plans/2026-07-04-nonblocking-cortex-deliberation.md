# Non-blocking Cortex Deliberation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — dispatch each Task below to a fresh implementer subagent, one at a time, in order. Each Task is a self-contained TDD unit ending in a green test run and a commit.

**Goal:** Fork the idle-path deliberation (`orient → recall → decide`) off the cortex loop fiber so the fast/limbic reflexes (event drain, amygdala criticals, hindbrain triage) stay live during a slow conscious turn, mirroring the existing `consciousFiber` fork/poll/join pattern.

**Architecture:** A new loop-local `deliberationFiber` (mutually exclusive with `consciousFiber`) holds an off-fiber computation over a fork-time snapshot. The fiber does pure model computation and never mutates loop state; ALL loop-state mutation happens on the loop fiber at fork (snapshot) and at land (apply). The existing escalation ladder governs the in-flight deliberation and reconciles the landed plan, and fork-time episode attribution keeps forked tier records correctly stamped.

**Tech Stack:** Effect-TS (fibers: `Effect.fork` / `Fiber.poll` / `Fiber.join` / `Fiber.interrupt`), vitest.

## Global Constraints

Encode these verbatim from the spec; they hold across every Task:

- **No wall-clock timeout** on the deliberation. The pathology is root-caused upstream (resource/prompt structure), not capped. Do not add any `Effect.timeout` to the deliberation fork.
- **The fiber does pure model computation over a fork-time snapshot. The loop fiber owns ALL mutation.** The deliberation fiber never writes `cortex.*`, `state`, episode context, wm, or skills. It returns a value; the loop fiber applies it at the hand-back point (preserving today's atomic seed section, just relocated).
- **Never-fail degrade.** Deliberation fiber failure/interrupt → no plan seeded, placeholder state retained, re-orient next tick. Matches the existing degrade-never-crash posture (`parseOr` decide fallback, dream/retrospect).
- **Mirror the `consciousFiber` pattern.** Fork (`loop.ts:902/926`), poll (`:408`), join (`:410`), interrupt (`:394/636`). `deliberationFiber` and `consciousFiber` are mutually exclusive by construction (a deliberation produces the plan; the body turn runs only once `currentPlan !== null`).
- **TDD:** write the failing test first, watch it fail, implement, watch it pass, commit. One commit per Task.
- **All work** on branch `feat/wm` in the worktree `/Users/vcarl/workspace/roci/.claude/worktrees/skills`. Tests run `npx vitest run --root packages/core <file>`. A pre-commit hook runs a typecheck, so **every commit must typecheck** (test + impl land in the same commit — never commit a RED state).
- **Regression seal (every Task):** the full `src/cortex/loop.test.ts` suite (the 39-test limbic-drives suite + the executor suite) and `src/cortex/tiers.test.ts` must stay green. Each Task's final step runs both files.

---

### Task 1: Fork-time episode attribution capture

`emitTier` stamps a tier record with `ctx.tick`/`ctx.stepId` read **at completion** (`tiers.ts:134-136`) plus the live epoch (`:135`). A deliberation forked at tick N and completing at tick N+k would mis-stamp its `orient`/`decide` records with N+k's tick (the loop advances `setEpisodeTick` every tick, `loop.ts:342`). Thread an explicit, captured attribution through the two forked tier runners so their records carry the fork-time attribution. Chosen mechanism: **explicit param threading** (not a scoped global override) — it is fiber-safe against the concurrently-mutating module-level context and is directly unit-testable. The in-session (non-forked) path passes nothing and keeps reading the live context unchanged.

**Files:**
- Modify `packages/core/src/logging/episodes.ts` — add `EpisodeAttribution` interface + `captureEpisodeAttribution` near the context accessors (after `currentEpisodeEpoch`, ~line 302).
- Modify `packages/core/src/cortex/tiers.ts` — add optional `attribution` param to `emitTier` (~127), `runForebrain` (~211), `runConsciousDecide` (~278).
- Test: `packages/core/src/cortex/tiers.test.ts` (extend the existing `describe("transition episodes — OODA tier calls")` block, ~466).

**Interfaces:**
- Produces `interface EpisodeAttribution { tick: number | null; stepId: string | null; epoch: string | null }` and `captureEpisodeAttribution(character: string): EpisodeAttribution` (episodes.ts).
- Produces amended signatures Task 2 consumes:
  - `runForebrain(config, accumulatedEvents, domainState, identity, emotionalWeight, recalledMemories?, workingMemory?, orientKind?, attribution?: EpisodeAttribution)`
  - `runConsciousDecide(config, orient, currentPlanState, availableActions, recalledMemories?, workingMemory?, skillIndex?, attribution?: EpisodeAttribution)`

Steps:

- [ ] **Write the failing test.** In `tiers.test.ts`, add to the imports on line 24: `setEpisodeStep` and `captureEpisodeAttribution`:
  ```ts
  import { setEpisodeLogRoot, setEpisodeTick, setEpisodeStep, resetEpisodeContext, beginEpisodeEpoch, captureEpisodeAttribution } from "../logging/episodes.js"
  ```
  Then inside `describe("transition episodes — OODA tier calls", ...)` add:
  ```ts
  it("stamps a forked deliberation's tier record with the CAPTURED attribution, not the live context", async () => {
    const epoch = beginEpisodeEpoch("ada") // clears + issues the run epoch
    setEpisodeTick("ada", 5)
    setEpisodeStep("ada", null)
    const captured = captureEpisodeAttribution("ada") // { tick: 5, stepId: null, epoch }
    // The fast loop advances the live module-level context while the fork is in flight:
    setEpisodeTick("ada", 9)
    await Effect.runPromise(
      Effect.provide(
        runForebrain(
          config, ["evt"], "{}", { background: "", values: "", diary: "", synthesis: "" },
          "😐", "", "", "plan", captured,
        ),
        Layer.mergeAll(
          fixedClient('{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","confidence":"low","metrics":{}}'),
          recordingService([]), silentLog,
        ),
      ),
    )
    const [rec] = readTransitions()
    // Without the fix, emitTier reads the live tick (9); the capture must win.
    expect(rec).toMatchObject({ type: "tier", phase: "orient", tick: 5, epoch })
  })
  ```
- [ ] **Run it — expect FAIL.** `npx vitest run --root packages/core src/cortex/tiers.test.ts` → the new test fails with `tick: 9` (live context), asserted `tick: 5`. (Runs despite the 9th arg being unknown to the current signature — vitest transpiles without typechecking.)
- [ ] **Implement `episodes.ts`.** After `currentEpisodeEpoch` (~302) add:
  ```ts
  /** A fork-time snapshot of the episode attribution, so a deliberation forked at
   *  tick N stamps its tier records with N's attribution even if it completes at N+k. */
  export interface EpisodeAttribution {
    tick: number | null
    stepId: string | null
    epoch: string | null
  }

  /** Capture the current (tick/stepId/epoch) attribution at fork time. */
  export function captureEpisodeAttribution(character: string): EpisodeAttribution {
    const ctx = episodeContext(character)
    return { tick: ctx.tick, stepId: ctx.stepId, epoch: currentEpisodeEpoch(character) }
  }
  ```
- [ ] **Implement `tiers.ts`.** Import the type: change line 24 to also import `type EpisodeAttribution`. Amend `emitTier` (127) to take a trailing `attribution?: EpisodeAttribution` and prefer it:
  ```ts
  const emitTier = (
    character: string,
    phase: "orient" | "decide" | "evaluate" | "diary",
    prompt: string,
    output: unknown,
    orientKind?: "plan" | "steer",
    attribution?: EpisodeAttribution,
  ): Effect.Effect<void> => {
    const ctx = attribution ?? episodeContext(character)
    const epoch = attribution ? attribution.epoch : currentEpisodeEpoch(character)
    return appendTransitionEpisode(character, {
      type: "tier",
      ts: new Date().toISOString(),
      tick: ctx.tick,
      stepId: ctx.stepId,
      phase,
      ...(phase === "orient" && orientKind ? { orientKind } : {}),
      ...(epoch !== null ? { epoch } : {}),
      prompt,
      output,
    })
  }
  ```
  Add a trailing `attribution?: EpisodeAttribution` param to `runForebrain` (after `orientKind` at ~225) and pass it through: `Effect.tap((result) => emitTier(config.char.name, "orient", prompt, result, orientKind, attribution))` (273). Add a trailing `attribution?: EpisodeAttribution` param to `runConsciousDecide` (after `skillIndex` at ~285) and pass it: `Effect.tap((result) => emitTier(config.char.name, "decide", prompt, result, undefined, attribution))` (313).
- [ ] **Run it — expect PASS.** `npx vitest run --root packages/core src/cortex/tiers.test.ts` → all green (existing attribution tests at 487/508/525/539 still pass — they pass no `attribution`, so the live-context branch is unchanged).
- [ ] **Regression seal.** `npx vitest run --root packages/core src/cortex/loop.test.ts` → green (loop untouched).
- [ ] **Commit.**
  ```
  git add packages/core/src/logging/episodes.ts packages/core/src/cortex/tiers.ts packages/core/src/cortex/tiers.test.ts
  git commit -m "feat(cortex): capture fork-time episode attribution for tier records"
  ```

---

### Task 2: `deliberationFiber` state + fork/poll/join + apply-on-loop seed

Replace the inline idle deliberation (`loop.ts:478-613`) with a forked one. The whole `identity read → orient → recall → decide` chain moves into a `runDeliberation` closure that runs on the fork; the atomic seed (`currentPlan`/`wornSkill`/wm/episode) moves to the loop-fiber land point. This Task applies **unconditionally** on land (no staleness gate yet — Task 3) and drains `accumulatedEvents` to `[]` (parity with today — Task 4 refines to slice). The amygdala critical path also gains a `deliberationFiber` interrupt.

**Files:**
- Modify `packages/core/src/cortex/loop.ts`:
  - loop-local `let`s (~189-221): add `deliberationFiber`, `deliberationSnapshotCount`, `deliberationSettledThisTick`, the `DeliberationContext`/`DeliberationResult` types, and the `runDeliberation` closure.
  - amygdala critical (~394): interrupt `deliberationFiber` alongside `consciousFiber`.
  - after hindbrain triage (~460, before `willEvaluate` at 468): insert the deliberation poll/land block.
  - forebrain idle path (478-613): replace the inline body with the fork.
  - import: add `captureEpisodeAttribution` and `type EpisodeAttribution` to the `../logging/episodes.js` import (66-68); `OrientResult`/`DecideResult` types from `../skills/types.js`.
- Test: `packages/core/src/cortex/loop.test.ts` (extend the limbic-drives `describe` at ~1889, reusing `domainWith`, `limbicClient`, `DISCARD`).

**Interfaces:**
- Consumes `runForebrain(..., "plan", attribution)`, `runConsciousDecide(..., attribution)`, `captureEpisodeAttribution` (Task 1).
- Produces (loop-internal, consumed by Tasks 3-5):
  - `let deliberationFiber: Fiber.RuntimeFiber<DeliberationResult, never> | null`
  - `let deliberationSnapshotCount: number`
  - `let deliberationSettledThisTick: boolean`
  - `interface DeliberationResult { orient: OrientResult; decide: DecideResult }`
  - `interface DeliberationContext { summaryJson: string; accumulatedEvents: string[]; emotionalWeight: string; attribution: EpisodeAttribution }`
  - `const runDeliberation: (snap: DeliberationContext) => Effect.Effect<DeliberationResult, never, R>` (R inferred from the loop's service context).

Steps:

- [ ] **Write the failing tests.** In the limbic-drives `describe` (after the reorient test at ~2083), add two tests:
  ```ts
  it("reflexes stay live: a slow (blocking) deliberation does not freeze hindbrain triage / amygdala checks (Unit: fork)", async () => {
    let observeCount = 0
    const criticalsRef = { n: 0 }
    // decide (the else branch) BLOCKS the fork forever; orient + observe complete normally.
    const blockingDecideClient = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) => {
          const p = messages.map((m) => m.content).join(" ").toLowerCase()
          if (p.includes("plain prose")) return Effect.succeed({ text: "d", raw: {} })
          const hasDisposition = p.includes("disposition")
          const hasDecision = p.includes("decision")
          const hasHeadline = p.includes("headline")
          const hasJudgment = p.includes("judgment")
          if (hasDisposition && !hasDecision) {
            observeCount++
            return Effect.succeed({ text: DISCARD, raw: {} })
          }
          if (hasHeadline && !hasJudgment)
            return Effect.succeed({ text: '{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","metrics":{}}', raw: {} })
          if (hasJudgment && !hasHeadline)
            return Effect.succeed({ text: '{"judgment":"succeeded","reasoning":"x","transition":{"transition":"terminate","summary":"x"}}', raw: {} })
          // decide → never resolves: the deliberation fork is suspended here.
          return Effect.never as never
        },
      }),
    )
    // Fire a critical on the 3rd criticals() call → the loop must reach it, proving it kept ticking.
    const domain = domainWith([], () => {
      criticalsRef.n++
      return criticalsRef.n >= 3 ? [{ priority: "critical" as const, message: "hull critical" }] : []
    })
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" }) // tick 1 escalates → forks the (blocking) deliberation
      // A mid-deliberation state-changing event must still be triaged (proves liveness).
      yield* Effect.forkDaemon(Effect.sleep("4 millis").pipe(Effect.andThen(Queue.offer(events, { type: "later" }))))
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(blockingDecideClient, ctLayer, domain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    // The loop kept ticking through the blocked deliberation and reached the critical.
    expect(result._tag).toBe("Interrupted")
    // At least the tick-1 observe plus the mid-deliberation observe ran (reflexes alive).
    expect(observeCount).toBeGreaterThanOrEqual(2)
  }, 20_000)

  it("mutual exclusion: never forks a second deliberation while one is in flight", async () => {
    let orientCount = 0
    const client = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) => {
          const p = messages.map((m) => m.content).join(" ").toLowerCase()
          if (p.includes("plain prose")) return Effect.succeed({ text: "d", raw: {} })
          const hasDisposition = p.includes("disposition")
          const hasDecision = p.includes("decision")
          const hasHeadline = p.includes("headline")
          const hasJudgment = p.includes("judgment")
          if (hasDisposition && !hasDecision) return Effect.succeed({ text: DISCARD, raw: {} })
          if (hasHeadline && !hasJudgment) {
            orientCount++
            return Effect.succeed({ text: '{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","metrics":{}}', raw: {} })
          }
          if (hasJudgment && !hasHeadline)
            return Effect.succeed({ text: '{"judgment":"succeeded","reasoning":"x","transition":{"transition":"terminate","summary":"x"}}', raw: {} })
          return Effect.never as never // decide blocks → deliberation stays in flight
        },
      }),
    )
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" })
      const fiber = yield* Effect.fork(
        runCortex({
          char: { name: "ada", dir: "/work/players/ada/me" },
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
  ```
- [ ] **Run it — expect FAIL.** `npx vitest run --root packages/core src/cortex/loop.test.ts` → both new tests fail: today the inline `yield* runConsciousDecide(...)` blocks the whole loop on `Effect.never`, so no further ticks run (`observeCount` stays 1; `result` never reaches the critical; `orientCount` stays 1 but the loop hangs → interrupt yields a hung state / wrong tag).
- [ ] **Implement — new loop state + types + closure.** In the loop-local block (after `bypassSteerCadence` at 221) add:
  ```ts
  // Deliberation fork (spec: non-blocking idle path). Mirrors consciousFiber and is
  // mutually exclusive with it (a deliberation produces the plan; the body turn runs
  // only once currentPlan !== null). Non-null ⇒ a deliberation is in flight.
  let deliberationFiber: Fiber.RuntimeFiber<DeliberationResult, never> | null = null
  // # of accumulatedEvents fed to the in-flight orient (the snapshot prefix to drain on apply).
  let deliberationSnapshotCount = 0
  // Guards against forking a fresh deliberation on the same tick one just landed/discarded.
  let deliberationSettledThisTick = false
  ```
  Add module-level (or above `runCortex`, alongside the other interfaces) the two shapes:
  ```ts
  interface DeliberationContext {
    summaryJson: string
    accumulatedEvents: string[]
    emotionalWeight: string
    attribution: EpisodeAttribution
  }
  interface DeliberationResult {
    orient: OrientResult
    decide: DecideResult
  }
  ```
  Define `runDeliberation` as a closure inside `runCortex` (after the other closures such as `resetPlanState`, before the provision at ~306), lifting the fork-safe body from the current inline path (486-533) and passing `snap.attribution` into both tier runners; catchAll makes it never-fail:
  ```ts
  const runDeliberation = (snap: DeliberationContext) =>
    Effect.gen(function* () {
      const identity = yield* readIdentityContext({
        char: config.char,
        containerId: config.containerId,
        accumulatedEvents: snap.accumulatedEvents,
        emotionalWeight: snap.emotionalWeight,
      })
      const skillMetas = yield* charFs
        .listSkills(config.char)
        .pipe(Effect.catchAll(() => Effect.succeed([] as SkillMeta[])))
      const skillIndex = renderSkillIndex(skillMetas)
      const orient = yield* runForebrain(
        runnerConfig, snap.accumulatedEvents, snap.summaryJson, identity, snap.emotionalWeight,
        identity.recalledMemories, identity.workingMemory, "plan", snap.attribution,
      )
      yield* logBehavior(config.char.name, "cortex", "forebrain", { type: "orient", headline: orient.headline })
      for (const w of orientMemories(orient)) yield* memory.remember(config.containerId, config.char, w)
      const decideRecall = yield* memory.recall(
        config.containerId, config.char, decideQuery(orient), { k: 5, label: "Relevant memories" },
      )
      const decide = yield* runConsciousDecide(
        runnerConfig, orient, "No active plan.", AVAILABLE_ACTIONS, decideRecall, identity.workingMemory, skillIndex, snap.attribution,
      )
      for (const w of decideMemories(decide)) yield* memory.remember(config.containerId, config.char, w)
      yield* (decide.decision === "plan" || decide.decision === "wait" || decide.decision === "terminate"
        ? logBehavior(config.char.name, "cortex", "conscious", { type: "decision", disposition: decide.decision })
        : logBehavior(config.char.name, "cortex", "conscious", { type: "note", label: `decision:${decide.decision}` }))
      return { orient, decide } satisfies DeliberationResult
    }).pipe(
      // Never-fail: a model error inside the fork degrades to a no-plan result (Task 5
      // adds the re-orient follow-up). The apply branch treats "continue" as no plan.
      Effect.catchAll((e) =>
        logError(config.char.name, "cortex", `deliberation failed; no plan seeded: ${e}`).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.as({
            orient: { headline: "deliberation failed", sections: [], whatChanged: "", emotionalState: snap.emotionalWeight, confidence: "low", metrics: {} },
            decide: { decision: "continue", reasoning: "deliberation failed" },
          } as DeliberationResult),
        ),
      ),
    )
  ```
  Add imports: extend the `../logging/episodes.js` import block (66-68) with `captureEpisodeAttribution` and `type EpisodeAttribution`; add `import type { OrientResult, DecideResult } from "../skills/types.js"` (or extend the existing skills/types import if present).
- [ ] **Implement — amygdala targets the deliberation fiber.** In the critical block, after `if (consciousFiber) yield* Fiber.interrupt(consciousFiber)` (394):
  ```ts
  if (deliberationFiber) {
    yield* Fiber.interrupt(deliberationFiber)
    deliberationFiber = null
  }
  ```
- [ ] **Implement — poll/land block.** Immediately after the triage escalate-finalize line `if (!escalate && shouldForceOrient(cortex, tick, orientInterval)) escalate = true` (460), insert:
  ```ts
  // Poll the in-flight deliberation. On completion, apply on the LOOP fiber — the
  // relocated atomic seed (Task 3 gates this on staleness; Task 4 refines the drain).
  deliberationSettledThisTick = false
  if (deliberationFiber !== null) {
    const done = yield* Fiber.poll(deliberationFiber).pipe(Effect.map(Option.isSome))
    if (done) {
      const outcome: DeliberationResult = yield* Fiber.join(deliberationFiber)
      deliberationFiber = null
      deliberationSettledThisTick = true
      const maybeCompleted = yield* applyDeliberation(outcome) // returns CortexResult on terminate, else null
      if (maybeCompleted) return maybeCompleted
    }
  }
  ```
  Define `applyDeliberation` as a closure (near `runDeliberation`) that is the relocated seed block (loop.ts 531-612) rebound to the outcome, returning the loop's `Completed` result on terminate (so the caller can `return` it) and `null` otherwise. It rebinds `orient`→`outcome.orient`, `decide`→`outcome.decide`, defines `resolveWornSkill` over `outcome.decide`, and ends the section with:
  ```ts
  cortex.accumulatedEvents = [] // Task 4 → slice(deliberationSnapshotCount)
  cortex.lastOrientTick = tick
  deliberationSnapshotCount = 0
  ```
  (Signature: `const applyDeliberation = (outcome: DeliberationResult): Effect.Effect<CortexResult | null, ...> => Effect.gen(...)`. Keep the terminate/wait/discover/plan/empty-plan branches byte-for-byte from 560-612; `terminate` and the `wait.disposition === "terminate"` case `return { _tag: "Completed" as const, finalState: state }`, all other branches `return null` at the end.)
- [ ] **Implement — replace the inline idle path with the fork.** Replace the entire body of `if (cortex.currentPlan === null) { ... }` (478-613) with:
  ```ts
  if (cortex.currentPlan === null) {
    // 5a. Idle path: fork a deliberation (non-blocking). Mutually exclusive with an
    // in-flight deliberation (guard) and with a body turn (currentPlan !== null → else).
    if (deliberationFiber === null && !deliberationSettledThisTick && escalate) {
      const snapshot: DeliberationContext = {
        summaryJson: JSON.stringify(summary, null, 2),
        accumulatedEvents: [...cortex.accumulatedEvents],
        emotionalWeight: cortex.emotionalWeight,
        attribution: captureEpisodeAttribution(config.char.name),
      }
      deliberationSnapshotCount = snapshot.accumulatedEvents.length
      deliberationFiber = yield* Effect.fork(runDeliberation(snapshot))
    }
  } else {
    // 5b. In-session path (unchanged) — the existing graded ladder, lines 615-692.
    ...
  }
  ```
  Leave the `else` (5b in-session) block exactly as-is (615-692).
- [ ] **Run it — expect PASS.** `npx vitest run --root packages/core src/cortex/loop.test.ts` → the two new tests pass, and the whole suite is green (the idle-path tests now form their plan via a fork that lands within a tick or two under `tickIntervalMs:1` with a non-blocking client — observable behavior preserved).
- [ ] **Regression seal.** `npx vitest run --root packages/core src/cortex/tiers.test.ts` → green.
- [ ] **Commit.**
  ```
  git add packages/core/src/cortex/loop.ts packages/core/src/cortex/loop.test.ts
  git commit -m "feat(cortex): fork idle deliberation off the loop fiber, seed on land"
  ```

---

### Task 3: Escalation-ladder governance of the in-flight deliberation

While a deliberation is in flight, the existing ladder governs it: a `reorient`/`interrupt` rung (world moved materially → the fork-time snapshot is stale) interrupts the fiber and re-orients next tick; `steer`/`accumulate`/`none` let it cook (events retained). This unifies the in-flight interrupt and the landed-plan reconciliation into one `stale` predicate — whether the fiber is still running (interrupt) or landed this same tick (join-and-discard), a stale snapshot is discarded and the loop re-orients.

**Files:**
- Modify `packages/core/src/cortex/loop.ts` — wrap the Task 2 poll/land block (after triage, ~461) with the `stale` guard.
- Test: `packages/core/src/cortex/loop.test.ts` (limbic-drives `describe`).

**Interfaces:**
- Consumes `deliberationFiber`, `deliberationSnapshotCount`, `deliberationSettledThisTick`, `applyDeliberation` (Task 2), `esc: HindbrainEscalation` (loop-local, `state.ts`), `forceOrientNext` (loop-local).
- Produces no new symbols; changes the poll/land block's control flow (Task 4 consumes the `else if (done)` apply arm).

Steps:

- [ ] **Write the failing tests.** In the limbic-drives `describe`, add:
  ```ts
  it("ladder governs the in-flight deliberation: a reorient-rung event interrupts the fiber and re-orients (Unit: fork ladder)", async () => {
    const interrupted = { value: false }
    let decideCount = 0
    const client = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) => {
          const p = messages.map((m) => m.content).join(" ").toLowerCase()
          if (p.includes("plain prose")) return Effect.succeed({ text: "d", raw: {} })
          const hasDisposition = p.includes("disposition")
          const hasDecision = p.includes("decision")
          const hasHeadline = p.includes("headline")
          const hasJudgment = p.includes("judgment")
          if (hasDisposition && !hasDecision)
            return Effect.succeed({
              text: p.includes("termination-60s")
                ? '{"disposition":"escalate","emotionalWeight":"😱","drive":"agency","weight":5,"interrupt":false,"reason":"account termination in 60s"}'
                : DISCARD,
              raw: {},
            })
          if (hasHeadline && !hasJudgment)
            return Effect.succeed({ text: '{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","metrics":{}}', raw: {} })
          if (hasJudgment && !hasHeadline)
            return Effect.succeed({ text: '{"judgment":"succeeded","reasoning":"x","transition":{"transition":"terminate","summary":"x"}}', raw: {} })
          // decide: #1 blocks (deliberation in flight); #2 (post-reorient) terminates.
          decideCount++
          if (decideCount === 1)
            return Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => { interrupted.value = true })),
            ) as never
          return Effect.succeed({ text: '{"decision":"terminate","reasoning":"reoriented"}', raw: {} })
        },
      }),
    )
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" }) // tick 1 → fork deliberation (decide #1 blocks)
      yield* Effect.forkDaemon(Effect.sleep("8 millis").pipe(Effect.andThen(Queue.offer(events, { type: "termination-60s" }))))
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
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
    const client = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) => {
          const p = messages.map((m) => m.content).join(" ").toLowerCase()
          if (p.includes("plain prose")) return Effect.succeed({ text: "d", raw: {} })
          const hasDisposition = p.includes("disposition")
          const hasDecision = p.includes("decision")
          const hasHeadline = p.includes("headline")
          const hasJudgment = p.includes("judgment")
          if (hasDisposition && !hasDecision) return Effect.succeed({ text: DISCARD, raw: {} })
          if (hasHeadline && !hasJudgment)
            return Effect.succeed({ text: '{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","metrics":{}}', raw: {} })
          if (hasJudgment && !hasHeadline)
            return Effect.succeed({ text: '{"judgment":"succeeded","reasoning":"x","transition":{"transition":"terminate","summary":"x"}}', raw: {} })
          return Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => { interrupted.value = true })),
          ) as never // decide blocks → deliberation in flight when the critical fires
        },
      }),
    )
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const domain = domainWith([], () => {
      criticalsRef.n++
      return criticalsRef.n >= 3 ? [{ priority: "critical" as const, message: "hull critical" }] : []
    })
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" })
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domain, fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Interrupted")
    expect(interrupted.value).toBe(true)
  }, 20_000)
  ```
- [ ] **Run it — expect FAIL.** `npx vitest run --root packages/core src/cortex/loop.test.ts` → the reorient test fails (Task 2 has no `stale` gate: the deliberation is never interrupted, decide #1 blocks forever, `interrupted.value` stays false and the loop hangs to timeout). The critical test likely already passes (Task 2 added the amygdala `deliberationFiber` interrupt) — keep it as a regression lock.
- [ ] **Implement — the `stale` guard.** Replace the Task 2 poll/land block with:
  ```ts
  deliberationSettledThisTick = false
  if (deliberationFiber !== null) {
    // The ladder answers "stale snapshot": a reorient/interrupt-rung event means the
    // world moved materially, so the fork-time snapshot is stale. Discard whether the
    // fiber is still cooking (interrupt) or landed this tick (join to drain) and re-orient.
    const stale = esc.rung === "reorient" || esc.rung === "interrupt"
    if (stale) {
      const done = yield* Fiber.poll(deliberationFiber).pipe(Effect.map(Option.isSome))
      if (done) yield* Fiber.join(deliberationFiber)
      else yield* Fiber.interrupt(deliberationFiber)
      deliberationFiber = null
      deliberationSnapshotCount = 0
      deliberationSettledThisTick = true
      forceOrientNext = true
      yield* logToConsole(
        config.char.name, "cortex",
        `deliberation superseded (${esc.rung}): ${esc.dominant?.reason ?? "world moved"}`,
      ).pipe(Effect.catchAll(() => Effect.void))
    } else {
      const done = yield* Fiber.poll(deliberationFiber).pipe(Effect.map(Option.isSome))
      if (done) {
        const outcome: DeliberationResult = yield* Fiber.join(deliberationFiber)
        deliberationFiber = null
        deliberationSettledThisTick = true
        const maybeCompleted = yield* applyDeliberation(outcome)
        if (maybeCompleted) return maybeCompleted
      }
    }
  }
  ```
  (`esc.rung === "reorient" || esc.rung === "interrupt"` mirrors the in-session test at loop.ts:619 exactly — no new export from `state.ts`.)
- [ ] **Run it — expect PASS.** `npx vitest run --root packages/core src/cortex/loop.test.ts` → both new tests pass and the suite is green.
- [ ] **Regression seal.** `npx vitest run --root packages/core src/cortex/tiers.test.ts` → green.
- [ ] **Commit.**
  ```
  git add packages/core/src/cortex/loop.ts packages/core/src/cortex/loop.test.ts
  git commit -m "feat(cortex): ladder governs and supersedes the in-flight deliberation"
  ```

---

### Task 4: Landed-plan reconciliation — drain snapshot, retain new events

Refine the apply arm so it **drains only the snapshot events** (the prefix fed to the forked orient) and **retains events accumulated during the deliberation** — so a fresh land applies cleanly while newly-arrived context survives to feed the next orient. This is the reconciliation the spec calls out ("apply the plan; drain the deliberation's snapshot events"; "the newly-accumulated events are retained").

**Files:**
- Modify `packages/core/src/cortex/loop.ts` — in `applyDeliberation`, change the drain from `= []` to `slice(deliberationSnapshotCount)`.
- Test: `packages/core/src/cortex/loop.test.ts` (limbic-drives `describe`).

**Interfaces:**
- Consumes `deliberationSnapshotCount`, `cortex.accumulatedEvents`.
- Produces no new symbols.

Steps:

- [ ] **Write the failing test.** This asserts the two reconciliation outcomes plus retention. The retention arm captures the second (in-session steer) orient's rendered prompt and asserts the snapshot event was drained while the mid-deliberation event survived:
  ```ts
  it("landed reconciliation: applies a fresh plan and drains ONLY the snapshot events (retains mid-deliberation events)", async () => {
    const orientPrompts: string[] = []
    // decide #1 blocks until a mid-deliberation event lands, then completes with a plan.
    let decideCount = 0
    const client = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) => {
          const raw = messages.map((m) => m.content).join(" ")
          const p = raw.toLowerCase()
          if (p.includes("plain prose")) return Effect.succeed({ text: "d", raw: {} })
          const hasDisposition = p.includes("disposition")
          const hasDecision = p.includes("decision")
          const hasHeadline = p.includes("headline")
          const hasJudgment = p.includes("judgment")
          if (hasDisposition && !hasDecision)
            // Mid-deliberation event is a plain accumulate (weight 2, non-discard) — retained, not stale.
            return Effect.succeed({
              text: p.includes("MID_EVENT")
                ? '{"disposition":"accumulate","emotionalWeight":"😐","drive":null,"weight":2,"interrupt":false,"reason":"minor"}'
                : DISCARD,
              raw: {},
            })
          if (hasHeadline && !hasJudgment) {
            orientPrompts.push(raw)
            return Effect.succeed({ text: '{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","metrics":{}}', raw: {} })
          }
          if (hasJudgment && !hasHeadline)
            return Effect.succeed({ text: '{"judgment":"succeeded","reasoning":"x","transition":{"transition":"terminate","summary":"x"}}', raw: {} })
          decideCount++
          // decide #1 lands a real one-step plan (fresh — no reorient occurred).
          if (decideCount === 1)
            return Effect.succeed({ text: '{"decision":"plan","reasoning":"go","steps":[{"task":"act","goal":"do","tier":"smart","successCondition":"done","timeoutTicks":30}]}', raw: {} })
          return Effect.succeed({ text: '{"decision":"terminate","reasoning":"done"}', raw: {} })
        },
      }),
    )
    let turnCount = 0
    const ctLayer = ConsciousThoughtTest(
      (_c, _r) => {
        turnCount++
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
      // A mid-deliberation event that arrives while the plan-forming deliberation is in flight.
      yield* Effect.forkDaemon(Effect.sleep("3 millis").pipe(Effect.andThen(Queue.offer(events, { type: "MID_EVENT" }))))
      return yield* runCortex({
        char: { name: "ada", dir: "/work/players/ada/me" },
        containerId: "c1", events, initialState: {}, cadence: "real-time", orientInterval: 1, tickIntervalMs: 1,
      }).pipe(Effect.provide(Layer.mergeAll(client, ctLayer, domainWith([]), fakeIo, fakeRuntimeDeps, noopModelService)))
    })
    const result = await Effect.runPromise(program)
    expect(result._tag).toBe("Completed")
    // The fresh plan applied and its step ran (a body turn, then a steer turn, fired).
    expect(turnCount).toBeGreaterThanOrEqual(1)
    // Reconciliation drained the SNAPSHOT event but retained MID_EVENT: the post-apply
    // in-session steer orient carries MID_EVENT and no longer carries the drained SEED_EVENT.
    const steerOrient = orientPrompts.find((p) => p.includes("MID_EVENT"))
    expect(steerOrient).toBeDefined()
    expect(steerOrient!).not.toContain("SEED_EVENT")
  }, 20_000)
  ```
- [ ] **Run it — expect FAIL.** `npx vitest run --root packages/core src/cortex/loop.test.ts` → fails: with Task 2/3's `cortex.accumulatedEvents = []`, the snapshot event AND the mid event are both cleared on apply, so no post-apply orient carries `MID_EVENT` → `steerOrient` is `undefined`.
- [ ] **Implement — slice the snapshot prefix.** In `applyDeliberation`, change the drain line to:
  ```ts
  // Drain ONLY the events fed to this deliberation's orient; retain any that
  // accumulated DURING the deliberation so they feed the next orient (spec: reconciliation).
  cortex.accumulatedEvents = cortex.accumulatedEvents.slice(deliberationSnapshotCount)
  cortex.lastOrientTick = tick
  deliberationSnapshotCount = 0
  ```
  (The snapshot is always a prefix: the idle fork path only ever `push`es to `cortex.accumulatedEvents`, never reassigns it, while a deliberation is in flight — the reassign-to-`[]` sites are the in-session drains, gated behind `currentPlan !== null`, which cannot run while `currentPlan === null` during a deliberation.)
- [ ] **Run it — expect PASS.** `npx vitest run --root packages/core src/cortex/loop.test.ts` → green (the fresh-apply and stale-discard outcomes from Tasks 2/3 remain covered; this locks the drain/retain semantics).
- [ ] **Regression seal.** `npx vitest run --root packages/core src/cortex/tiers.test.ts` → green.
- [ ] **Commit.**
  ```
  git add packages/core/src/cortex/loop.ts packages/core/src/cortex/loop.test.ts
  git commit -m "feat(cortex): reconcile landed plan — drain snapshot, retain new events"
  ```

---

### Task 5: Never-fail degrade + inline-path cleanup

Seal the error-handling posture the fork enables and remove the now-obsolete inline-path scaffolding. Before this change, the inline `yield* runConsciousDecide(...)` propagated a model error and **crashed** `runCortex`. The fork's catchAll (Task 2) already prevents the crash; this Task makes the degrade *productive* — a failed deliberation lands as no-plan and self-drives a re-orient (so a quiet world does not stall), and it removes the obsolete inline comments.

**Files:**
- Modify `packages/core/src/cortex/loop.ts` — in the poll/land apply arm, set `forceOrientNext` when a landed deliberation seeded no actionable plan; delete the obsolete inline-path comment block (the `// 5a. Idle path: orient → decide → plan (unchanged from pre-4b).` framing at old 479 and any stale references to the inline flow).
- Test: `packages/core/src/cortex/loop.test.ts` (limbic-drives `describe`).

**Interfaces:**
- Consumes `applyDeliberation` return, `cortex.currentPlan`, `forceOrientNext`.
- Produces no new symbols.

Steps:

- [ ] **Write the failing test.**
  ```ts
  it("never-fail degrade: a deliberation whose decide model errors seeds no plan and re-orients (no crash, no stall)", async () => {
    let decideCount = 0
    const client = Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) => {
          const p = messages.map((m) => m.content).join(" ").toLowerCase()
          if (p.includes("plain prose")) return Effect.succeed({ text: "d", raw: {} })
          const hasDisposition = p.includes("disposition")
          const hasDecision = p.includes("decision")
          const hasHeadline = p.includes("headline")
          const hasJudgment = p.includes("judgment")
          if (hasDisposition && !hasDecision) return Effect.succeed({ text: DISCARD, raw: {} })
          if (hasHeadline && !hasJudgment)
            return Effect.succeed({ text: '{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","metrics":{}}', raw: {} })
          if (hasJudgment && !hasHeadline)
            return Effect.succeed({ text: '{"judgment":"succeeded","reasoning":"x","transition":{"transition":"terminate","summary":"x"}}', raw: {} })
          // decide: #1 FAILS (model error) → fork degrades to no-plan; #2 (the self-driven
          // re-orient, no new events) terminates → proves the quiet world did not stall.
          decideCount++
          if (decideCount === 1)
            return Effect.fail(new ModelError({ tier: "conscious", model: "m", baseUrl: "u", reason: "decide boom" }))
          return Effect.succeed({ text: '{"decision":"terminate","reasoning":"done"}', raw: {} })
        },
      }),
    )
    const ctLayer = ConsciousThoughtTest((_c, _r) => ({ result: { output: "x", timedOut: false, durationMs: 1 }, sessionId: "s" }))
    const program = Effect.gen(function* () {
      const events = yield* Queue.unbounded<unknown>()
      yield* Queue.offer(events, { type: "seed" }) // the ONLY event ever queued
      const fiber = yield* Effect.fork(
        runCortex({
          char: { name: "ada", dir: "/work/players/ada/me" },
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
  ```
  (`ModelError` and `Option` are already imported in `loop.test.ts` at lines 6 and 2.)
- [ ] **Run it — expect FAIL.** `npx vitest run --root packages/core src/cortex/loop.test.ts` → fails: the deliberation degrades to a `continue` result that seeds no plan, but nothing re-drives a quiet world, so `decideCount` stays 1 and the loop idles (never Completed).
- [ ] **Implement — re-orient on a no-actionable-plan land.** In the poll/land apply arm (Task 3's `else` branch), after `applyDeliberation` returns without completing, self-drive a re-orient when no plan was seeded:
  ```ts
  const maybeCompleted = yield* applyDeliberation(outcome)
  if (maybeCompleted) return maybeCompleted
  // Never-fail degrade / no-op decide (continue/failed/malformed) seeded no plan —
  // self-drive a re-orient next tick so a quiet world does not stall.
  if (cortex.currentPlan === null) forceOrientNext = true
  ```
- [ ] **Implement — cleanup.** Remove the now-obsolete inline-path comment framing so the code reflects the fork model: delete the stale `// 5a. Idle path: orient → decide → plan (unchanged from pre-4b).`-style comment lines that referenced the deleted inline flow, and confirm (via `Grep` for `runForebrain`/`runConsciousDecide` in `loop.ts`) that the ONLY call site of each is now inside `runDeliberation` (the in-session steer path still calls `runForebrain` directly — that is expected and untouched).
- [ ] **Run it — expect PASS.** `npx vitest run --root packages/core src/cortex/loop.test.ts` → green.
- [ ] **Regression seal (full).** `npx vitest run --root packages/core src/cortex/loop.test.ts src/cortex/tiers.test.ts src/cortex/state.test.ts` → all green; confirm the pre-commit typecheck passes on commit.
- [ ] **Commit.**
  ```
  git add packages/core/src/cortex/loop.ts packages/core/src/cortex/loop.test.ts
  git commit -m "feat(cortex): degrade a failed deliberation to a re-orient; drop dead inline path"
  ```

---

## Data flow (end state)

1. **Tick start** — `tick++`, `setEpisodeTick` (`loop.ts:339-342`).
2. **Drain** events → `state` (349-380), unchanged.
3. **Classify + amygdala critical** (382-404) — a critical now interrupts `consciousFiber` **and** `deliberationFiber`, then exits `Interrupted`.
4. **Poll `consciousFiber`** (407-422), unchanged.
5. **Hindbrain triage** (424-460) → `esc: HindbrainEscalation`.
6. **Deliberation handling** (new, after 460, before `willEvaluate`) — if `deliberationFiber !== null`: `stale = esc.rung ∈ {reorient, interrupt}` → interrupt-if-running / join-if-landed, discard, `forceOrientNext`; else poll → on land `applyDeliberation` (seed `currentPlan`/`wornSkill`/wm/episode from the outcome, drain the snapshot prefix, retain new events), and re-orient if no plan was seeded.
7. **Forebrain dispatch** (478+) — `currentPlan === null` → fork a new deliberation (snapshot `summary`/`accumulatedEvents`/`emotionalWeight`/attribution; `Effect.fork(runDeliberation)`) guarded by `deliberationFiber === null && !deliberationSettledThisTick && escalate`; else the unchanged in-session ladder (5b).
8. **Step execution** (694+) and **sleep** (946), unchanged.

Inside the fork, `runDeliberation` reads identity/skills, runs `orient → recall → decide` with the captured attribution (so tier records stamp the fork-time tick/stepId/epoch), and returns `{ orient, decide }`; all `cortex.*`/wm/skill/episode-context mutation happens only at the loop-fiber land point.

## Critical details

- **No timeout** anywhere on the deliberation — enforced by the plan never adding `Effect.timeout` to `runDeliberation` or the fork.
- **Never-fail:** `runDeliberation`'s `Effect.catchAll` (Task 2) makes the fiber `<DeliberationResult, never>`; a decide/orient