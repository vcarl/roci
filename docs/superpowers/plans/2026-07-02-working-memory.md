# Working Memory (`wm`) Implementation Plan (Stage 2 of agent cognition extensions)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-character working-memory store — `players/<name>/me/wm.json` plus a compact human-readable `WM.md` next to it — mutated by an in-container `wm` bun CLI and by the harness (decide seeds plan steps as todos, evaluate marks them done, replan discards orphans), injected into every conscious LLM request via the OpenCode `instructions` mechanism, rendered into the orient/decide prompts, and with every mutation recorded in `episodes-transition.jsonl` (spec §2, `docs/superpowers/specs/2026-07-02-agent-cognition-extensions-design.md:38-69`). Tasks 1-3 first land three small deferred Stage-1 (episode log) fixes.

**Architecture:** Three new modules under `packages/core/src/conscious/` mirroring the long-term-memory trio: `wm-core.ts` (dependency-free pure types + state machine + `WM.md` render — every function self-contained so the generated CLI embeds them **verbatim** via `Function.prototype.toString`, the same no-drift rationale as `memory-cli.ts:53-63`'s generate-time interpolation of the unit-tested SQL builders), `wm-store.ts` (host-side never-failing Effect surface: atomic write-via-rename IO on `char.dir`, plan seeding, pending-delta drain, prompt render — this module's read surface is what the Stage-4 retrospect consumes), and `wm-cli.ts` (the generated `/usr/local/bin/wm` bun script, provisioned **eagerly** at container startup in `apps/roci/src/orchestrator.ts` alongside `memory`). Injection rides a new per-character project-local `players/<name>/opencode.json` whose `instructions` array points at `me/WM.md` (verified against OpenCode v1.17.13: instruction files are re-read from disk on **every** LLM request — spec:15, spec:56). Harness lifecycle hooks live at the cortex loop's existing seams: plan assignment (`loop.ts:407-425`), the evaluate step-end block (`loop.ts:561-596`), `resetPlanState` (`loop.ts:203-213`), and the orient/decide prompt builders (`tiers.ts:204-292`). Agent-side (CLI) mutations are journaled in `wm.json`'s `pendingDeltas` and drained by the harness onto the step-end record's existing `wmDeltas` field (`episodes.ts:68`, written as `null` since Stage 1); harness mutations outside a step window are recorded as a new small `type:"wm"` transition record.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Effect 3.x, vitest 3.x, pnpm + nx monorepo (`@roci/core` at `packages/core`, app `apps/roci`). No new dependencies.

## Global Constraints

- **Atomic write-via-rename on BOTH sides** (spec §2 Store, spec:42): every `wm.json`/`WM.md` write — host (`wm-store.ts`) and container (the generated CLI) — goes write-tmp-then-rename, so a reader never sees a torn file. Concurrent host/container mutations resolve to one side's complete state, never corruption (spec:69).
- **NO `wm list`** (spec:52): the CLI has exactly three verbs — `wm todo "<text>" [--parent <id>]`, `wm done <id>`, `wm discard <id>`. Visibility comes from automatic injection, not from the agent remembering to look. A test asserts the generated script dispatches no `list` verb.
- **Discard retains** (spec:50): `discarded` todos are kept in `wm.json` (not done, not in progress), **excluded from active renders** (`WM.md`, the prompt block — a discarded node hides its whole subtree), and **visible to retrospectives** (Stage 4 reads `wm.json` via `readWm`, which returns discarded entries).
- **Eager provisioning — no lazy provisioning in the cortex loop** (spec:46; spec:18 hard rule; the memory-CLI incident documented at `apps/roci/src/orchestrator.ts:159-165` and `conscious-thought.ts:102-107` — a lazily provisioned binary `exit 127`'d during the startup-phase reflection and lost diary entries to the dream cull): the `wm` CLI is installed at container startup in `apps/roci/src/orchestrator.ts` right after the `memory` CLI (`orchestrator.ts:159-176`), before any phase runs. Per-character files (`wm.json`, `WM.md`, `opencode.json`) are seeded in `provisionImpl` (`conscious-thought.ts:81-112`), which runs once before the first tick — provisioning, not an in-loop load.
- **wm writes must never disturb the tick loop** — the same never-fail discipline as episodes (`episodes.ts:8-11`): every `wm-store.ts` writer/reader is `Effect<..., never, never>`, swallow-and-log (`console.error`), degrading to an empty result. The plan/step control flow never depends on a wm write having succeeded.
- **Plain JSON on the shared mount, never sqlite** (spec §2 Store, spec:42; spec:30): the harness writes host-side and per-character sqlite is container-only (sqlite-vec bus-errors host-side on macOS). `wm.json` lives at `players/<name>/me/wm.json` (`char.dir` per `CharacterFs.ts:18-21`), `WM.md` next to it.
- **All wm mutations are recorded in `episodes-transition.jsonl`** (spec:65): agent (CLI) mutations journal into `wm.json.pendingDeltas` and are drained onto the step-end record's `wmDeltas`; harness mutations ride step-end `wmDeltas` too, or a `type:"wm"` record when no step is in flight. `StepBoundaryEpisode`'s shape is unchanged (`wmDeltas: unknown[] | null` was reserved by Stage 1 exactly for this — `episodes.ts:51-69`).
- **Prompt-cache churn is accepted** (spec:56): the changing `WM.md` invalidates the provider prompt cache on every mutation; the conscious model is local MLX, so this is a deliberate, documented trade.
- **SpaceMolt only** (spec:5): the GitHub domain is stale and out of scope; every hook is a domain-agnostic core seam.
- **Verification:** run from the worktree root `/Users/vcarl/workspace/roci/.claude/worktrees/skills` (`node_modules` is installed). Tests: `pnpm vitest run <relative-test-path>`. Typecheck: `pnpm nx run-many -t typecheck --skip-nx-cache` — **always pass `--skip-nx-cache`** (nx caches typecheck and will replay a stale green result).
- Conventional-commit messages; end every commit body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Commit with `--no-verify`.

## File Structure

**New files:**
- `packages/core/src/conscious/wm-core.ts` — types (`WmTodo`, `WmDelta`, `WmFile`, `WmMutation`), pure state machine (`applyWmMutation`), tolerant parser (`parseWmFile`), `WM.md` render (`renderWmMarkdown`). Every function self-contained for verbatim CLI embedding.
- `packages/core/src/conscious/wm-core.test.ts`
- `packages/core/src/conscious/wm-store.ts` — host-side Effect surface: `readWm`, `ensureWmFiles`, `mutateWm`, `seedWmPlan`, `drainWmDeltas`, `renderOpenTodoTree`, path helpers.
- `packages/core/src/conscious/wm-store.test.ts`
- `packages/core/src/conscious/wm-cli.ts` — `buildWmCliScript` (generated bun script) + `provisionWmCli` + `WM_CLI_PATH` + `WM_USAGE`.
- `packages/core/src/conscious/wm-cli.test.ts`

**Modified files:**
- `packages/core/src/cortex/loop.ts` — Task 1: `resetPlanState` (`:203-213`) becomes Effect-returning and emits the abandoned step's step-end; Task 8: plan-todo seeding at both plan-assignment sites (`:407-425`), done/orphan/drain at the step-end block (`:561-596`), orphan discard in `resetPlanState`; Task 9: wm prompt block threading at both forebrain call sites (`:374-381`, `:497-504`) and the decide call (`:392`).
- `packages/core/src/cortex/loop.test.ts` — new tests per task.
- `packages/core/src/logging/episodes.ts` — Task 2: `finishEpisodeCycle` per-file isolation + orphan `.tmp` cleanup (`:186-214`); Task 8: `WmTransitionEpisode` union member (`:77`).
- `packages/core/src/logging/episodes.test.ts`
- `packages/core/src/core/limbic/hypothalamus/transport.test.ts` — Task 3: `status:"error"` emission test (test-only).
- `packages/core/src/conscious/opencode-config.ts` — Task 7: `buildCharacterOpencodeConfigJson` + `writeCharacterOpencodeConfig`.
- `packages/core/src/conscious/opencode-config.test.ts`
- `packages/core/src/conscious/conscious-thought.ts` — Task 7: `provisionImpl` writes the project config + seeds wm files (`:81-112`).
- `packages/core/src/conscious/conscious-thought.test.ts`
- `packages/core/src/cortex/state.ts` — Task 7: `formatStepTask` documents the wm verbs (`:296-304`).
- `packages/core/src/cortex/state.test.ts`
- `packages/core/src/cortex/tiers.ts` — Task 9: `workingMemory` prompt variable on `runForebrain` (`:204-258`) and `runConsciousDecide` (`:261-292`).
- `packages/core/src/cortex/tiers.test.ts`
- `packages/core/src/skills/orient.md` (`:35-39`), `packages/core/src/skills/decide.md` (`:35-41`) — Task 9: `{{workingMemory}}` sections.
- `apps/roci/src/orchestrator.ts` — Task 6: eager `provisionWmCli` after the memory block (`:159-176`).

**Design decisions resolved up front (spec-vs-code reconciliation):**
1. **How CLI mutations reach the episode stream.** The CLI runs in-container; the episode writers run host-side with a module-level root. Rather than have two writers append to the same JSONL from both sides of the mount, the CLI journals each mutation into `wm.json.pendingDeltas` (part of the same atomic rename it already does) and the harness **drains** the journal at step boundaries onto the step-end record's `wmDeltas` — the exact field Stage 1 reserved (`episodes.ts:53-54, :68`, "Stage 2/3 fill them"). Harness mutations that happen *outside* an in-flight step (decide-time seeding; discards when no step is open) get a new small `type:"wm"` transition record. This is schema-consistent: `wmDeltas: unknown[] | null` is unchanged, and `TransitionEpisode` gains one additive union member that readers discriminate on `type` (rotation's `lineType` already tolerates any type — `episodes.ts:156-163`).
2. **No-drift between host logic and the generated CLI.** `memory-cli.ts:47-51` establishes the house pattern: interpolate the unit-tested TS artifacts at GENERATE time so the container script can't drift. For wm the artifacts are functions, not SQL strings, so `buildWmCliScript` embeds `parseWmFile`/`applyWmMutation`/`renderWmMarkdown` via `Function.prototype.toString()` — verified in this repo's toolchain (vitest transform and `tsc`/`tsx` both erase types and preserve declaration names). `wm-core.ts` carries a header contract: self-contained function declarations only.
3. **Where the `instructions` entry lives.** The global config (`opencode-config.ts:29`, `/home/node/.config/opencode/opencode.jsonc`) is per-container and shared by all characters, so the entry goes in a per-character project-local `players/<name>/opencode.json`. The conscious session's cwd is `/work/players/<name>` (`process-runner.ts:23` — `docker exec -w /work/players/${config.playerName}`), so the relative path `me/WM.md` resolves to the character's own file.
4. **Where the verb docs live.** Spec:64 binds `formatStepTask` ("documents the wm verbs to the agent"), and per-step repetition suits the small local model. The docs go there and **only** there (not also in the agent markdown), so there is a single doc site to keep current; `WM.md` itself stays pure data.
5. **Headline-todo closure semantics.** Spec:60-63 says evaluate marks the step todo done and a replan discards orphans, but is silent on the plan-headline todo when a plan *finishes*. Resolution: the headline todo is marked **done** when every seeded step todo is done (plan completed, or dropped after its last step succeeded), **discarded** otherwise — so retrospectives can tell completed plans from abandoned ones.

---

## Task 1: Stage-1 fix — step-end for a step abandoned by `resetPlanState`

An in-session `reorient`/`interrupt` rung calls `resetPlanState()` (`loop.ts:472`) while a step can be mid-flight: its `step-start` was emitted (`loop.ts:682-693`) but evaluate never ran, so the episode substrate shows an unclosed step. Emit a `step-end` with `transition:"replan"` and **no verdict** (nothing was evaluated), guarded on the episode context's `stepId` so a normal evaluate step-end (which clears the stepId at `loop.ts:673` right after emitting) can never be double-emitted.

**Files:**
- Modify: `packages/core/src/cortex/loop.ts:203-213` (`resetPlanState` → Effect-returning), `:472` (call site gains `yield*`)
- Test: `packages/core/src/cortex/loop.test.ts` (inside `describe("runCortex — limbic drives …")`, after the reorient test at `:1672-1711`)

**Interfaces:**
- Consumes: `appendTransitionEpisode`, `episodeContext`, `setEpisodeStep` (already imported at `loop.ts:62-68`); `planSteps` (`:48`).
- Produces: `resetPlanState: () => Effect.Effect<void>` — the loop-local closure; Task 8 extends this same body with orphan discard + delta drain. No signature change anywhere else; the emission is emit-only (episode writers are swallow-and-log, `Effect<void, never, never>`).

- [ ] **Step 1: Write the failing test**

In `packages/core/src/cortex/loop.test.ts`, append inside `describe("runCortex — limbic drives (per-event triage + escalation ladder)", ...)` (after the reorient test ending at line 1711). It reuses that test's exact scenario (`limbicClient`, `domainWith`, weight-5 reorient event) plus the episode-root idiom already used at `:1423`:

```ts
  it("reorient closes the abandoned in-flight step with a replan step-end (no verdict, no double-emit)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-abandon-"))
    setEpisodeLogRoot(root)
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
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
```

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/cortex/loop.test.ts -t "reorient closes the abandoned"
```

Expected failure: `expected [] to have a length of 1` — the run produces a `step-start` but zero `step-end` records (the abandoned step is never closed).

- [ ] **Step 3: Implement**

In `packages/core/src/cortex/loop.ts`, replace the `resetPlanState` closure (lines 203-213, keeping the existing doc comment above it) with:

```ts
    const resetPlanState = () =>
      Effect.gen(function* () {
        // Deferred Stage-1 fix: a reorient/interrupt can abandon a step whose
        // step-start was emitted but whose evaluate (and step-end) never ran,
        // leaving an unclosed step in the episode substrate. Close it here with
        // transition:"replan" and NO verdict — nothing was evaluated. Guard on
        // the episode context's stepId: the normal evaluate path clears it
        // immediately after emitting its own step-end (per-step reset below),
        // so a non-null stepId means exactly "in-flight, not yet closed" — a
        // double emission is impossible.
        const ctx = episodeContext(config.char.name)
        const step = planSteps(cortex.currentPlan)[cortex.currentStepIndex]
        if (ctx.stepId !== null && step) {
          yield* appendTransitionEpisode(config.char.name, {
            type: "step-end",
            ts: new Date().toISOString(),
            tick,
            stepId: ctx.stepId,
            task: step.task,
            goal: step.goal,
            transition: "replan",
            skill: null,
            wmDeltas: null,
          })
        }
        cortex.currentPlan = null
        cortex.lastOrientTick = 0
        sessionId = null
        stepReport = ""
        stepDoneSignaled = false
        pendingDirective = null
        lastSteerTick = 0
        bypassSteerCadence = false
        setEpisodeStep(config.char.name, null)
      })
```

At the single call site (line 472), change:

```ts
          resetPlanState()
```

to:

```ts
          yield* resetPlanState()
```

- [ ] **Step 4: Run the full loop suite, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/cortex/loop.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/cortex/loop.ts packages/core/src/cortex/loop.test.ts
git commit --no-verify -m "fix(episodes): close abandoned in-flight steps with a replan step-end

resetPlanState (reorient/interrupt rungs) now emits the abandoned step's
step-end — transition:\"replan\", no verdict — guarded on the episode context
stepId so the normal evaluate step-end can never double-emit.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Stage-1 fix — per-file isolation + orphan `.tmp` cleanup in `finishEpisodeCycle`

`finishEpisodeCycle` (`episodes.ts:186-214`) wraps BOTH streams' append+rotate in one `Effect.tryPromise`: a failure on `episodes-tool.jsonl` skips `episodes-transition.jsonl` entirely, and a rename failure strands a `.tmp` file forever.

**Files:**
- Modify: `packages/core/src/logging/episodes.ts:186-214`
- Test: `packages/core/src/logging/episodes.test.ts`

**Interfaces:**
- Consumes/produces: `finishEpisodeCycle: (character: string) => Effect.Effect<void>` — **signature unchanged**; behavior only.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/logging/episodes.test.ts` (the file already has `root`, `logsPath`, `readLines`, `toolRecord` helpers and imports `finishEpisodeCycle`):

```ts
describe("finishEpisodeCycle — per-file isolation (deferred Stage-1 fix)", () => {
  it("still writes the transition boundary when the tool stream is unwritable", async () => {
    // Make the tool stream path a DIRECTORY: appendFile → EISDIR for that stream only.
    fs.mkdirSync(logsPath(TOOL_EPISODE_FILE), { recursive: true })
    await expect(Effect.runPromise(finishEpisodeCycle("ada"))).resolves.toBeUndefined()
    const transitions = readLines(TRANSITION_EPISODE_FILE).map((l) => JSON.parse(l))
    expect(transitions.some((r) => r.type === "cycle-boundary")).toBe(true)
  })

  it("removes a stale orphaned .tmp left by a previously failed rotation", async () => {
    await Effect.runPromise(appendToolEpisode("ada", toolRecord()))
    fs.writeFileSync(`${logsPath(TOOL_EPISODE_FILE)}.tmp`, "orphan from a crashed rotation")
    await Effect.runPromise(finishEpisodeCycle("ada"))
    expect(fs.existsSync(`${logsPath(TOOL_EPISODE_FILE)}.tmp`)).toBe(false)
    // The real stream is untouched by the orphan: its record + boundary parse fine.
    const records = readLines(TOOL_EPISODE_FILE).map((l) => JSON.parse(l))
    expect(records.some((r) => r.tool === "bash")).toBe(true)
    expect(records.some((r) => r.type === "cycle-boundary")).toBe(true)
  })
})
```

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/logging/episodes.test.ts
```

Expected: the isolation test fails with `ENOENT … episodes-transition.jsonl` (the tool stream's EISDIR aborted the whole cycle before the transition stream was touched), and the orphan test fails on `expect(fs.existsSync(...)).toBe(false)`.

- [ ] **Step 3: Implement**

In `packages/core/src/logging/episodes.ts`, replace the whole `finishEpisodeCycle` (lines 186-214, keeping the doc comment but extending it) with:

```ts
/**
 * Close the current reflection cycle: append a cycle-boundary marker to both
 * episode streams, then rotate each to the last EPISODE_RETAIN_CYCLES cycles
 * (write-to-tmp + rename, so a concurrent reader never sees a torn file).
 * Swallow-and-log: a rotation failure must never disturb reflection.
 *
 * Per-file isolation (deferred Stage-1 fix): each stream gets its own
 * try/catch so one stream's I/O failure cannot skip the other's boundary or
 * rotation. Stale `.tmp` files from a previously crashed rotation are removed
 * up front, and a failed rotation cleans up its own `.tmp`.
 */
export const finishEpisodeCycle = (character: string): Effect.Effect<void> => {
  const root = episodeRoot
  if (root === null) return Effect.void
  return Effect.promise(async () => {
    const boundary: CycleBoundaryEpisode = { type: "cycle-boundary", ts: new Date().toISOString() }
    const line = `${JSON.stringify(boundary)}\n`
    const dir = logsDir(root, character)
    try {
      await fsp.mkdir(dir, { recursive: true })
    } catch (e) {
      console.error(`[episodes] cycle rotation failed for ${character}: ${e}`)
      return
    }
    for (const file of [TOOL_EPISODE_FILE, TRANSITION_EPISODE_FILE]) {
      const filePath = path.join(dir, file)
      const tmp = `${filePath}.tmp`
      try {
        await fsp.rm(tmp, { force: true }) // stale orphan from a crashed rotation
        await fsp.appendFile(filePath, line, "utf8")
        const text = await fsp.readFile(filePath, "utf8")
        const lines = text.split("\n").filter((l) => l.trim().length > 0)
        const kept = retainLastCycles(lines, EPISODE_RETAIN_CYCLES)
        if (kept.length < lines.length) {
          await fsp.writeFile(tmp, kept.map((l) => `${l}\n`).join(""), "utf8")
          await fsp.rename(tmp, filePath)
        }
      } catch (e) {
        console.error(`[episodes] cycle rotation failed for ${character} (${file}): ${e}`)
        await fsp.rm(tmp, { force: true }).catch(() => {})
      }
    }
  })
}
```

(`Effect.promise` is safe here: the async body catches everything itself, so it never rejects — same `Effect<void, never, never>` discipline as before.)

- [ ] **Step 4: Run it, expect pass; typecheck + commit**

All pre-existing `finishEpisodeCycle` tests (rotation, "never fails when logs path is unwritable" — the `players`-as-file case now hits the mkdir guard) must still pass.

```
pnpm vitest run packages/core/src/logging/episodes.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/logging/episodes.ts packages/core/src/logging/episodes.test.ts
git commit --no-verify -m "fix(episodes): isolate per-stream failures in cycle rotation, clean orphaned .tmp

finishEpisodeCycle now wraps each stream in its own try/catch (one stream's
I/O failure no longer skips the other's boundary/rotation) and removes stale
.tmp files up front and on failure.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Stage-1 fix — missing test: transport emission for `status:"error"` tool states

The transport emits a tool episode for terminal states `completed` **and** `error` (`transport.ts` guard `ie.status === "completed" || ie.status === "error"`), but `transport.test.ts:256-311` only covers `completed` and `running`. Test-only task; it should pass on first run — if it fails, the emission is genuinely broken and must be fixed to match.

**Files:**
- Test: `packages/core/src/core/limbic/hypothalamus/transport.test.ts` (inside `describe("runTransport tool episodes")`, which already has `root`, `toolFile`, `toolLine(status)` helpers)

- [ ] **Step 1: Write the test**

Append inside `describe("runTransport tool episodes", ...)`:

```ts
  it('appends an episode for an ERRORED tool call (status "error")', async () => {
    const command = Command.make("bash", "-c", `printf '%s\\n' '${toolLine("error")}'`)
    await Effect.runPromise(
      Effect.provide(
        runTransport({ command, normalize: normalizeOpenCode, runtimeTag: "opencode", char, role: "body", timeoutMs: 5000 }),
        deps,
      ),
    )
    const text = fs.readFileSync(toolFile(), "utf8")
    const records = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ tool: "bash", status: "error", durationMs: 450 })
    expect(text).not.toContain("SECRET_TOOL_OUTPUT")
  })
```

- [ ] **Step 2: Run it, expect pass; commit**

```
pnpm vitest run packages/core/src/core/limbic/hypothalamus/transport.test.ts
git add packages/core/src/core/limbic/hypothalamus/transport.test.ts
git commit --no-verify -m "test(episodes): cover transport emission for errored tool states

Closes the Stage-1 review gap: status==\"error\" terminal tool states were
emitted but untested.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: wm core — types, state machine, `WM.md` render

The dependency-free heart of working memory. **Embedding contract:** every exported function in this module is embedded VERBATIM into the generated `wm` CLI via `Function.prototype.toString()` (Task 6), so each must be a self-contained function declaration — no imports, no module-level value references, no references to functions outside this file. (TS annotations are erased by the transpiler before `toString` sees them; declaration names are preserved — verified in this repo's vitest and tsc toolchains.)

**Files:**
- Create: `packages/core/src/conscious/wm-core.ts`
- Create: `packages/core/src/conscious/wm-core.test.ts`

**Interfaces:**
- Consumes: nothing (dependency-free by contract).
- Produces (Tasks 5-9 and later stages consume these exact names):
  - `export type WmState = "open" | "done" | "discarded"`
  - `export interface WmTodo { id: string; text: string; parent: string | null; state: WmState; createdAt: string; updatedAt: string }`
  - `export interface WmDelta { op: "add" | "done" | "discard"; id: string; text?: string; parent?: string | null; by: "agent" | "harness"; ts: string }`
  - `export interface WmFile { version: 1; nextId: number; todos: WmTodo[]; pendingDeltas: WmDelta[] }`
  - `export type WmMutation = { verb: "todo"; text: string; parent?: string | null } | { verb: "done"; id: string } | { verb: "discard"; id: string }`
  - `export type WmApplyResult = { ok: true; file: WmFile; delta: WmDelta } | { ok: false; error: string }`
  - `export function emptyWmFile(): WmFile`
  - `export function parseWmFile(text: string): WmFile` — tolerant; malformed input → empty file, never throws
  - `export function applyWmMutation(file: WmFile, mutation: WmMutation, by: "agent" | "harness", ts: string): WmApplyResult` — pure (no clock; `ts` injected)
  - `export function renderWmMarkdown(file: WmFile): string` — ids + tree + states, discarded subtrees excluded

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/conscious/wm-core.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import {
  emptyWmFile,
  parseWmFile,
  applyWmMutation,
  renderWmMarkdown,
  type WmFile,
} from "./wm-core.js"

const TS = "2026-07-02T00:00:00.000Z"

/** Apply a chain of mutations, asserting each succeeds. */
function applyAll(file: WmFile, muts: Parameters<typeof applyWmMutation>[1][]): WmFile {
  let f = file
  for (const m of muts) {
    const r = applyWmMutation(f, m, "harness", TS)
    if (!r.ok) throw new Error(r.error)
    f = r.file
  }
  return f
}

describe("applyWmMutation — state machine", () => {
  it("todo: assigns sequential t<N> ids, state open, and returns an add delta", () => {
    const r = applyWmMutation(emptyWmFile(), { verb: "todo", text: "buy fuel" }, "agent", TS)
    if (!r.ok) throw new Error(r.error)
    expect(r.file.todos).toEqual([
      { id: "t1", text: "buy fuel", parent: null, state: "open", createdAt: TS, updatedAt: TS },
    ])
    expect(r.file.nextId).toBe(2)
    expect(r.delta).toEqual({ op: "add", id: "t1", text: "buy fuel", parent: null, by: "agent", ts: TS })
    // Pure: the input file is untouched.
    expect(emptyWmFile().todos).toEqual([])
  })

  it("todo --parent: parents under an existing todo; rejects a missing or discarded parent", () => {
    const base = applyAll(emptyWmFile(), [{ verb: "todo", text: "plan" }])
    const child = applyWmMutation(base, { verb: "todo", text: "step", parent: "t1" }, "agent", TS)
    if (!child.ok) throw new Error(child.error)
    expect(child.file.todos[1]).toMatchObject({ id: "t2", parent: "t1", state: "open" })

    expect(applyWmMutation(base, { verb: "todo", text: "x", parent: "t99" }, "agent", TS)).toEqual({
      ok: false,
      error: "parent not found: t99",
    })
    const discarded = applyAll(base, [{ verb: "discard", id: "t1" }])
    expect(applyWmMutation(discarded, { verb: "todo", text: "x", parent: "t1" }, "agent", TS)).toEqual({
      ok: false,
      error: "parent is discarded: t1",
    })
  })

  it("rejects empty todo text", () => {
    expect(applyWmMutation(emptyWmFile(), { verb: "todo", text: "  " }, "agent", TS).ok).toBe(false)
  })

  it("open→done and open→discarded; anything else is rejected; discarded is RETAINED", () => {
    const base = applyAll(emptyWmFile(), [{ verb: "todo", text: "a" }, { verb: "todo", text: "b" }])
    const done = applyWmMutation(base, { verb: "done", id: "t1" }, "agent", TS)
    if (!done.ok) throw new Error(done.error)
    expect(done.file.todos[0].state).toBe("done")
    expect(done.delta).toEqual({ op: "done", id: "t1", by: "agent", ts: TS })

    const disc = applyWmMutation(done.file, { verb: "discard", id: "t2" }, "harness", TS)
    if (!disc.ok) throw new Error(disc.error)
    // Retained: still present in the file, just not open.
    expect(disc.file.todos[1]).toMatchObject({ id: "t2", state: "discarded" })
    expect(disc.delta).toEqual({ op: "discard", id: "t2", by: "harness", ts: TS })

    // Terminal states reject further transitions.
    expect(applyWmMutation(disc.file, { verb: "done", id: "t2" }, "agent", TS)).toEqual({
      ok: false,
      error: "todo t2 is already discarded",
    })
    expect(applyWmMutation(disc.file, { verb: "discard", id: "t1" }, "agent", TS)).toEqual({
      ok: false,
      error: "todo t1 is already done",
    })
    expect(applyWmMutation(disc.file, { verb: "done", id: "t9" }, "agent", TS)).toEqual({
      ok: false,
      error: "no such todo: t9",
    })
  })
})

describe("parseWmFile — tolerant", () => {
  it("round-trips a serialized file", () => {
    const f = applyAll(emptyWmFile(), [{ verb: "todo", text: "a" }])
    expect(parseWmFile(JSON.stringify(f))).toEqual(f)
  })

  it("degrades to the empty file on garbage, non-object, and missing fields — never throws", () => {
    expect(parseWmFile("not json")).toEqual(emptyWmFile())
    expect(parseWmFile("42")).toEqual(emptyWmFile())
    expect(parseWmFile("")).toEqual(emptyWmFile())
    // Missing nextId/pendingDeltas are reconstructed.
    const partial = parseWmFile('{"todos":[{"id":"t1","text":"a","parent":null,"state":"open","createdAt":"x","updatedAt":"x"}]}')
    expect(partial.nextId).toBe(2)
    expect(partial.pendingDeltas).toEqual([])
    expect(partial.todos).toHaveLength(1)
  })
})

describe("renderWmMarkdown", () => {
  it("renders ids, tree structure, and states; discarded subtrees are EXCLUDED", () => {
    const f = applyAll(emptyWmFile(), [
      { verb: "todo", text: "secure fuel" },            // t1
      { verb: "todo", text: "dock", parent: "t1" },     // t2
      { verb: "todo", text: "buy", parent: "t1" },      // t3
      { verb: "todo", text: "old idea" },               // t4
      { verb: "todo", text: "sub of old", parent: "t4" }, // t5
      { verb: "done", id: "t2" },
      { verb: "discard", id: "t4" },
    ])
    const md = renderWmMarkdown(f)
    expect(md).toBe(
      [
        "# Working memory",
        "",
        "- [ ] t1 secure fuel",
        "  - [x] t2 dock",
        "  - [ ] t3 buy",
        "",
      ].join("\n"),
    )
    // The discarded t4 AND its child t5 are hidden from the active render.
    expect(md).not.toContain("old")
  })

  it("renders a placeholder when there are no visible todos", () => {
    expect(renderWmMarkdown(emptyWmFile())).toBe("# Working memory\n\n(no todos)\n")
  })
})
```

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/conscious/wm-core.test.ts
```

Expected failure: `Failed to resolve import "./wm-core.js"`.

- [ ] **Step 3: Implement**

Create `packages/core/src/conscious/wm-core.ts`:

```ts
/**
 * Working-memory core (agent-cognition Stage 2, spec §2): types, the todo
 * state machine, the tolerant wm.json parser, and the WM.md render.
 *
 * EMBEDDING CONTRACT: every exported function here is embedded VERBATIM into
 * the generated in-container `wm` CLI via Function.prototype.toString()
 * (wm-cli.ts) — the same no-drift rationale as memory-cli's generate-time
 * interpolation of its unit-tested SQL builders. Each function must therefore
 * be a SELF-CONTAINED function declaration: no imports, no module-level value
 * references, no calls to anything outside this file. TS type annotations are
 * fine (the transpiler erases them before toString sees the source).
 *
 * States: open | done | discarded. Discarded = retained, not done, not in
 * progress, excluded from active renders, visible to retrospectives (spec §2).
 */

export type WmState = "open" | "done" | "discarded"

export interface WmTodo {
  id: string
  text: string
  parent: string | null
  state: WmState
  createdAt: string
  updatedAt: string
}

/** One recorded mutation. `by` distinguishes agent (CLI) from harness writes. */
export interface WmDelta {
  op: "add" | "done" | "discard"
  id: string
  /** op "add" only. */
  text?: string
  /** op "add" only. */
  parent?: string | null
  by: "agent" | "harness"
  ts: string
}

/**
 * The wm.json shape. `pendingDeltas` is the agent-mutation journal: the CLI
 * appends its delta on every mutation; the harness drains the journal into
 * episodes-transition.jsonl at step boundaries (spec §2 "All wm mutations are
 * also recorded in episodes-transition.jsonl").
 */
export interface WmFile {
  version: 1
  nextId: number
  todos: WmTodo[]
  pendingDeltas: WmDelta[]
}

export type WmMutation =
  | { verb: "todo"; text: string; parent?: string | null }
  | { verb: "done"; id: string }
  | { verb: "discard"; id: string }

export type WmApplyResult =
  | { ok: true; file: WmFile; delta: WmDelta }
  | { ok: false; error: string }

export function emptyWmFile(): WmFile {
  return { version: 1, nextId: 1, todos: [], pendingDeltas: [] }
}

/** Tolerant parser: malformed/torn/hand-edited input degrades to the empty file. */
export function parseWmFile(text: string): WmFile {
  try {
    const raw = JSON.parse(text) as { nextId?: unknown; todos?: unknown; pendingDeltas?: unknown }
    if (raw && typeof raw === "object" && Array.isArray(raw.todos)) {
      return {
        version: 1,
        nextId:
          typeof raw.nextId === "number" && raw.nextId >= 1 ? raw.nextId : raw.todos.length + 1,
        todos: raw.todos as WmTodo[],
        pendingDeltas: Array.isArray(raw.pendingDeltas) ? (raw.pendingDeltas as WmDelta[]) : [],
      }
    }
  } catch {
    // fall through — a malformed file must never wedge the CLI or the loop
  }
  return { version: 1, nextId: 1, todos: [], pendingDeltas: [] }
}

/**
 * Pure state machine. `ts` is injected (no clock) so host and CLI callers
 * stamp their own time. Transitions: open→done, open→discarded; everything
 * else is rejected with a message. Returns a NEW file (input untouched) plus
 * the delta describing the mutation; the caller decides where the delta goes
 * (CLI → pendingDeltas journal; harness → episode record directly).
 */
export function applyWmMutation(
  file: WmFile,
  mutation: WmMutation,
  by: "agent" | "harness",
  ts: string,
): WmApplyResult {
  if (mutation.verb === "todo") {
    const text = (mutation.text || "").trim()
    if (!text) return { ok: false, error: "todo text must be non-empty" }
    const parent = mutation.parent == null ? null : mutation.parent
    if (parent !== null) {
      const p = file.todos.find(function (t) { return t.id === parent })
      if (!p) return { ok: false, error: "parent not found: " + parent }
      if (p.state === "discarded") return { ok: false, error: "parent is discarded: " + parent }
    }
    const id = "t" + file.nextId
    const todo: WmTodo = { id: id, text: text, parent: parent, state: "open", createdAt: ts, updatedAt: ts }
    return {
      ok: true,
      file: {
        version: 1,
        nextId: file.nextId + 1,
        todos: file.todos.concat([todo]),
        pendingDeltas: file.pendingDeltas,
      },
      delta: { op: "add", id: id, text: text, parent: parent, by: by, ts: ts },
    }
  }
  const target = file.todos.find(function (t) { return t.id === mutation.id })
  if (!target) return { ok: false, error: "no such todo: " + mutation.id }
  if (target.state !== "open") return { ok: false, error: "todo " + mutation.id + " is already " + target.state }
  const state: WmState = mutation.verb === "done" ? "done" : "discarded"
  const todos = file.todos.map(function (t) {
    return t.id === mutation.id ? { ...t, state: state, updatedAt: ts } : t
  })
  return {
    ok: true,
    file: { version: 1, nextId: file.nextId, todos: todos, pendingDeltas: file.pendingDeltas },
    delta: { op: mutation.verb === "done" ? "done" : "discard", id: mutation.id, by: by, ts: ts },
  }
}

/**
 * Compact human-readable view: ids + tree + states. Discarded nodes hide
 * their whole subtree from the active render (retained in wm.json; visible to
 * retrospectives). Open = "[ ]", done = "[x]".
 */
export function renderWmMarkdown(file: WmFile): string {
  const byParent: Record<string, WmTodo[]> = {}
  for (const t of file.todos) {
    const key = t.parent === null ? "" : t.parent
    if (!byParent[key]) byParent[key] = []
    byParent[key].push(t)
  }
  const lines: string[] = ["# Working memory", ""]
  const before = lines.length
  const walk = function (parentKey: string, depth: number): void {
    const children = byParent[parentKey] || []
    for (const t of children) {
      if (t.state === "discarded") continue
      const box = t.state === "done" ? "[x]" : "[ ]"
      lines.push("  ".repeat(depth) + "- " + box + " " + t.id + " " + t.text)
      walk(t.id, depth + 1)
    }
  }
  walk("", 0)
  if (lines.length === before) lines.push("(no todos)")
  return lines.join("\n") + "\n"
}
```

- [ ] **Step 4: Run it, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/conscious/wm-core.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/conscious/wm-core.ts packages/core/src/conscious/wm-core.test.ts
git commit --no-verify -m "feat(wm): working-memory core — types, state machine, WM.md render

Dependency-free pure functions (spec §2): open|done|discarded states, tree
parenting, tolerant wm.json parser, discarded-excluded WM.md render. Each
function is self-contained so the generated wm CLI embeds them verbatim.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: wm host store — atomic IO, plan seeding, delta drain, prompt render

The host-side Effect surface. All writers/readers are `Effect<..., never, never>` (swallow-and-log) — wm writes must never disturb the tick loop. All writes are write-tmp-then-rename, and every mutation re-renders `WM.md` (spec:56 "On every mutation, the CLI (and the harness, when it seeds) re-renders … WM.md").

**Files:**
- Create: `packages/core/src/conscious/wm-store.ts`
- Create: `packages/core/src/conscious/wm-store.test.ts`

**Interfaces:**
- Consumes: `wm-core.js` (Task 4); `CharacterConfig` (`services/CharacterFs.ts:18-21` — `char.dir` is the absolute `players/<name>/me/` path); `PlanStep` (`core/types.ts:15-21`).
- Produces (Tasks 7-9 consume; **Stage 4's retrospect consumes the read surface** `readWm` + the `WmFile`/`WmTodo`/`WmDelta` types — discarded entries are retained and visible there; **Stage 3** shares `mutateWm`/`renderOpenTodoTree`):
  - `export const WM_JSON_FILE = "wm.json"` / `export const WM_MD_FILE = "WM.md"` / `export const WM_PROMPT_CAP = 20`
  - `export function wmJsonPath(char: CharacterConfig): string` / `export function wmMarkdownPath(char: CharacterConfig): string`
  - `export const readWm: (char: CharacterConfig) => Effect.Effect<WmFile>` — missing/corrupt → empty file
  - `export const ensureWmFiles: (char: CharacterConfig) => Effect.Effect<void>` — idempotent seed/re-render (provision seam)
  - `export const mutateWm: (char: CharacterConfig, mutations: readonly WmMutation[]) => Effect.Effect<WmDelta[]>` — applies with `by:"harness"`, skips invalid mutations (logged), persists + re-renders, returns the applied deltas
  - `export interface WmSeedResult { headlineId: string | null; stepIds: string[]; deltas: WmDelta[] }`
  - `export const seedWmPlan: (char: CharacterConfig, headline: string, steps: readonly PlanStep[]) => Effect.Effect<WmSeedResult>`
  - `export const drainWmDeltas: (char: CharacterConfig) => Effect.Effect<WmDelta[]>` — drains `pendingDeltas`, persists
  - `export function renderOpenTodoTree(file: WmFile, cap?: number): string` — open todos only, tree-rendered, capped (orient/decide prompt block)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/conscious/wm-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { emptyWmFile, parseWmFile } from "./wm-core.js"
import {
  WM_PROMPT_CAP,
  wmJsonPath,
  wmMarkdownPath,
  readWm,
  ensureWmFiles,
  mutateWm,
  seedWmPlan,
  drainWmDeltas,
  renderOpenTodoTree,
} from "./wm-store.js"

let root: string
let char: CharacterConfig
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-store-"))
  char = { name: "ada", dir: path.join(root, "players", "ada", "me") }
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)

describe("readWm / ensureWmFiles", () => {
  it("readWm returns the empty file when wm.json is missing or corrupt", async () => {
    expect(await run(readWm(char))).toEqual(emptyWmFile())
    fs.mkdirSync(char.dir, { recursive: true })
    fs.writeFileSync(wmJsonPath(char), "garbage")
    expect(await run(readWm(char))).toEqual(emptyWmFile())
  })

  it("ensureWmFiles seeds wm.json + WM.md, preserves an existing store, and never fails", async () => {
    await run(ensureWmFiles(char))
    expect(parseWmFile(fs.readFileSync(wmJsonPath(char), "utf8"))).toEqual(emptyWmFile())
    expect(fs.readFileSync(wmMarkdownPath(char), "utf8")).toContain("# Working memory")

    await run(mutateWm(char, [{ verb: "todo", text: "keep me" }]))
    await run(ensureWmFiles(char)) // idempotent — does not clobber
    expect((await run(readWm(char))).todos).toHaveLength(1)
  })
})

describe("mutateWm", () => {
  it("applies harness mutations, re-renders WM.md, and writes atomically (no .tmp left)", async () => {
    const deltas = await run(mutateWm(char, [{ verb: "todo", text: "a" }, { verb: "done", id: "t1" }]))
    expect(deltas.map((d) => d.op)).toEqual(["add", "done"])
    expect(deltas.every((d) => d.by === "harness")).toBe(true)
    const file = await run(readWm(char))
    expect(file.todos[0].state).toBe("done")
    // WM.md is re-rendered on every mutation and matches the store.
    expect(fs.readFileSync(wmMarkdownPath(char), "utf8")).toContain("- [x] t1 a")
    // Atomic write-via-rename: no temp artifacts remain.
    expect(fs.readdirSync(char.dir).filter((f) => f.includes(".tmp"))).toEqual([])
  })

  it("skips invalid mutations but applies the rest; never fails the effect", async () => {
    const deltas = await run(mutateWm(char, [{ verb: "done", id: "t99" }, { verb: "todo", text: "b" }]))
    expect(deltas).toHaveLength(1)
    expect(deltas[0].op).toBe("add")
  })

  it("never fails even when char.dir is unwritable (wm must never disturb the tick loop)", async () => {
    // Make the players/ ancestor a FILE so mkdir -p fails.
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "players"), "not a directory")
    await expect(run(mutateWm(char, [{ verb: "todo", text: "x" }]))).resolves.toEqual([])
  })
})

describe("seedWmPlan / drainWmDeltas", () => {
  it("seeds steps as todos parented under a plan-headline todo", async () => {
    const seeded = await run(
      seedWmPlan(char, "act now", [
        { task: "dock", goal: "dock at station", tier: "smart", successCondition: "docked", timeoutTicks: 2 },
        { task: "buy", goal: "buy fuel", tier: "fast", successCondition: "fuel > 50", timeoutTicks: 2 },
      ]),
    )
    expect(seeded.headlineId).toBe("t1")
    expect(seeded.stepIds).toEqual(["t2", "t3"])
    expect(seeded.deltas).toHaveLength(3)
    const file = await run(readWm(char))
    expect(file.todos[0]).toMatchObject({ id: "t1", text: "act now", parent: null })
    expect(file.todos[1]).toMatchObject({ id: "t2", text: "dock: dock at station", parent: "t1" })
    expect(file.todos[2]).toMatchObject({ id: "t3", text: "buy: buy fuel", parent: "t1" })
    // Harness seeding leaves the agent journal untouched.
    expect(file.pendingDeltas).toEqual([])
  })

  it("drainWmDeltas empties pendingDeltas and returns them exactly once", async () => {
    await run(ensureWmFiles(char))
    // Simulate an agent (CLI) mutation: journal a pending delta.
    const withPending = {
      ...(await run(readWm(char))),
      pendingDeltas: [{ op: "add" as const, id: "t9", text: "agent todo", parent: null, by: "agent" as const, ts: "x" }],
    }
    fs.writeFileSync(wmJsonPath(char), JSON.stringify(withPending))
    const drained = await run(drainWmDeltas(char))
    expect(drained).toHaveLength(1)
    expect(drained[0].by).toBe("agent")
    expect(await run(drainWmDeltas(char))).toEqual([])
  })
})

describe("renderOpenTodoTree", () => {
  it("renders only OPEN todos as a tree, capped, with discarded subtrees hidden", async () => {
    await run(mutateWm(char, [
      { verb: "todo", text: "plan" },                       // t1
      { verb: "todo", text: "done step", parent: "t1" },    // t2
      { verb: "todo", text: "open step", parent: "t1" },    // t3
      { verb: "todo", text: "dropped" },                    // t4
      { verb: "done", id: "t2" },
      { verb: "discard", id: "t4" },
    ]))
    const file = await run(readWm(char))
    const tree = renderOpenTodoTree(file)
    expect(tree).toBe("- t1 plan\n  - t3 open step")
    expect(renderOpenTodoTree(emptyWmFile())).toBe("(no open todos)")

    // Cap: 25 more open roots → 27 open lines total (t1 + t3 + 25) → the
    // capped render is exactly WM_PROMPT_CAP lines plus an overflow marker.
    const muts = Array.from({ length: 25 }, (_, i) => ({ verb: "todo" as const, text: `todo ${i}` }))
    await run(mutateWm(char, muts))
    const big = await run(readWm(char))
    const capped = renderOpenTodoTree(big, WM_PROMPT_CAP).split("\n")
    expect(capped).toHaveLength(WM_PROMPT_CAP + 1)
    expect(capped[WM_PROMPT_CAP]).toBe("(+7 more)")
  })
})
```

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/conscious/wm-store.test.ts
```

Expected failure: `Failed to resolve import "./wm-store.js"`.

- [ ] **Step 3: Implement**

Create `packages/core/src/conscious/wm-store.ts`:

```ts
/**
 * Host-side working-memory store (agent-cognition Stage 2, spec §2).
 *
 * players/<name>/me/wm.json — plain JSON on the shared mount — plus the
 * compact human-readable WM.md next to it, re-rendered on EVERY mutation
 * (WM.md is the character's opencode `instructions` file, re-read and
 * injected on every LLM request).
 *
 * Discipline (same as logging/episodes.ts): wm writes must never disturb the
 * tick loop. Every reader/writer here is Effect<..., never, never> —
 * failures are swallowed after a console.error and degrade to empty results.
 * All writes are ATOMIC (write-tmp-then-rename), so a reader never sees a
 * torn file; the in-container CLI does the same on its side.
 *
 * Read surface for later stages: Stage 4's retrospect reads wm.json via
 * `readWm` (discarded todos are retained and visible there); Stage 3 shares
 * `mutateWm` and `renderOpenTodoTree`.
 */
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { PlanStep } from "../core/types.js"
import {
  applyWmMutation,
  emptyWmFile,
  parseWmFile,
  renderWmMarkdown,
  type WmDelta,
  type WmFile,
  type WmMutation,
  type WmTodo,
} from "./wm-core.js"

export const WM_JSON_FILE = "wm.json"
export const WM_MD_FILE = "WM.md"
/** Cap on open-todo lines rendered into the orient/decide prompts (spec §2). */
export const WM_PROMPT_CAP = 20

export function wmJsonPath(char: CharacterConfig): string {
  return path.join(char.dir, WM_JSON_FILE)
}

export function wmMarkdownPath(char: CharacterConfig): string {
  return path.join(char.dir, WM_MD_FILE)
}

// ── Raw IO (private) ─────────────────────────────────────────
const writeAtomic = async (file: string, text: string): Promise<void> => {
  const tmp = `${file}.tmp.${process.pid}`
  await fsp.writeFile(tmp, text, "utf8")
  await fsp.rename(tmp, file)
}

const loadWm = async (char: CharacterConfig): Promise<WmFile> => {
  try {
    return parseWmFile(await fsp.readFile(wmJsonPath(char), "utf8"))
  } catch {
    return emptyWmFile()
  }
}

/** Persist wm.json AND the WM.md render, both atomically (spec §2 Injection). */
const persistWm = async (char: CharacterConfig, file: WmFile): Promise<void> => {
  await fsp.mkdir(char.dir, { recursive: true })
  await writeAtomic(wmJsonPath(char), JSON.stringify(file, null, 2))
  await writeAtomic(wmMarkdownPath(char), renderWmMarkdown(file))
}

// ── Public surface (never fails) ─────────────────────────────
/** Read the store; a missing or corrupt wm.json degrades to the empty file. */
export const readWm = (char: CharacterConfig): Effect.Effect<WmFile> =>
  Effect.promise(() => loadWm(char))

/**
 * Provision seam: seed wm.json/WM.md if missing, re-render WM.md if present
 * (idempotent — never clobbers existing todos). Called once from
 * provisionImpl before the first tick, so the opencode `instructions` file
 * exists from the very first request.
 */
export const ensureWmFiles = (char: CharacterConfig): Effect.Effect<void> =>
  Effect.promise(async () => {
    try {
      await persistWm(char, await loadWm(char))
    } catch (e) {
      console.error(`[wm] ensure failed for ${char.name}: ${e}`)
    }
  })

/**
 * Apply harness mutations (by:"harness"). Invalid mutations (unknown id,
 * non-open state, bad parent) are skipped with a console.error — e.g. a
 * replan discarding a todo the agent already closed. Returns the deltas that
 * actually applied; the caller records them in the episode stream.
 */
export const mutateWm = (
  char: CharacterConfig,
  mutations: readonly WmMutation[],
): Effect.Effect<WmDelta[]> =>
  Effect.promise(async () => {
    try {
      let file = await loadWm(char)
      const deltas: WmDelta[] = []
      for (const m of mutations) {
        const r = applyWmMutation(file, m, "harness", new Date().toISOString())
        if (r.ok) {
          file = r.file
          deltas.push(r.delta)
        } else {
          console.error(`[wm] harness mutation skipped for ${char.name}: ${r.error}`)
        }
      }
      if (deltas.length > 0) await persistWm(char, file)
      return deltas
    } catch (e) {
      console.error(`[wm] mutate failed for ${char.name}: ${e}`)
      return []
    }
  })

export interface WmSeedResult {
  headlineId: string | null
  stepIds: string[]
  deltas: WmDelta[]
}

/**
 * Decide-time seeding (spec §2): the plan's steps become todos parented under
 * a plan-headline todo, so intent survives replans. Returns the created ids
 * (parallel to `steps`) for the loop's done/discard bookkeeping. On failure:
 * empty result — the plan proceeds regardless.
 */
export const seedWmPlan = (
  char: CharacterConfig,
  headline: string,
  steps: readonly PlanStep[],
): Effect.Effect<WmSeedResult> =>
  Effect.promise(async () => {
    try {
      let file = await loadWm(char)
      const ts = new Date().toISOString()
      const head = applyWmMutation(file, { verb: "todo", text: headline }, "harness", ts)
      if (!head.ok) {
        console.error(`[wm] plan seed failed for ${char.name}: ${head.error}`)
        return { headlineId: null, stepIds: [], deltas: [] }
      }
      file = head.file
      const deltas: WmDelta[] = [head.delta]
      const stepIds: string[] = []
      for (const step of steps) {
        const r = applyWmMutation(
          file,
          { verb: "todo", text: `${step.task}: ${step.goal}`, parent: head.delta.id },
          "harness",
          ts,
        )
        if (r.ok) {
          file = r.file
          stepIds.push(r.delta.id)
          deltas.push(r.delta)
        } else {
          console.error(`[wm] plan step seed skipped for ${char.name}: ${r.error}`)
          stepIds.push("")
        }
      }
      await persistWm(char, file)
      return { headlineId: head.delta.id, stepIds, deltas }
    } catch (e) {
      console.error(`[wm] plan seed failed for ${char.name}: ${e}`)
      return { headlineId: null, stepIds: [], deltas: [] }
    }
  })

/**
 * Drain the agent-mutation journal (pendingDeltas, appended by the wm CLI)
 * exactly once. The loop attaches the drained deltas to the step-end record's
 * wmDeltas — how CLI mutations reach episodes-transition.jsonl (spec §2).
 */
export const drainWmDeltas = (char: CharacterConfig): Effect.Effect<WmDelta[]> =>
  Effect.promise(async () => {
    try {
      let exists = true
      try {
        await fsp.access(wmJsonPath(char))
      } catch {
        exists = false
      }
      if (!exists) return []
      const file = await loadWm(char)
      if (file.pendingDeltas.length === 0) return []
      const drained = file.pendingDeltas
      await persistWm(char, { ...file, pendingDeltas: [] })
      return drained
    } catch (e) {
      console.error(`[wm] drain failed for ${char.name}: ${e}`)
      return []
    }
  })

/**
 * The capped, tree-rendered OPEN list for the orient/decide prompt variables
 * (spec §2). Done todos are omitted (their open descendants still show, un-
 * indented past them); discarded subtrees are hidden entirely.
 */
export function renderOpenTodoTree(file: WmFile, cap: number = WM_PROMPT_CAP): string {
  const byParent = new Map<string | null, WmTodo[]>()
  for (const t of file.todos) {
    const list = byParent.get(t.parent) ?? []
    list.push(t)
    byParent.set(t.parent, list)
  }
  const lines: string[] = []
  const walk = (parent: string | null, depth: number): void => {
    for (const t of byParent.get(parent) ?? []) {
      if (t.state === "discarded") continue
      if (t.state === "open") lines.push(`${"  ".repeat(depth)}- ${t.id} ${t.text}`)
      walk(t.id, t.state === "open" ? depth + 1 : depth)
    }
  }
  walk(null, 0)
  if (lines.length === 0) return "(no open todos)"
  if (lines.length > cap) return [...lines.slice(0, cap), `(+${lines.length - cap} more)`].join("\n")
  return lines.join("\n")
}
```

- [ ] **Step 4: Run it, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/conscious/wm-store.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/conscious/wm-store.ts packages/core/src/conscious/wm-store.test.ts
git commit --no-verify -m "feat(wm): host-side wm store — atomic IO, plan seeding, delta drain

Never-failing Effect surface over players/<name>/me/wm.json (+WM.md render on
every mutation, both write-via-rename). seedWmPlan parents step todos under a
plan-headline todo; drainWmDeltas hands the CLI's journal to the episode log.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: generated `wm` CLI + eager provisioning at container startup

The bun script at `/usr/local/bin/wm` (spec:46), generated like `memory` (`memory-cli.ts:53`, installed via the `installContainerCli` idiom `install-cli.ts:14-25`), provisioned **eagerly** in `apps/roci/src/orchestrator.ts` right after the memory CLI (`orchestrator.ts:159-176`) — never lazily in the cortex loop. Verbs exactly: `todo`/`done`/`discard`; **no `list`**. Paths are relative to the in-container cwd `/work/players/<name>` (`process-runner.ts:23`), same convention as memory's `DEFAULT_DB_PATH` (`memory-cli.ts:21-22`).

**Files:**
- Create: `packages/core/src/conscious/wm-cli.ts`
- Create: `packages/core/src/conscious/wm-cli.test.ts`
- Modify: `apps/roci/src/orchestrator.ts` (import near `:12`; provisioning block after `:176`)

**Interfaces:**
- Consumes: `parseWmFile`, `applyWmMutation`, `renderWmMarkdown` (Task 4 — embedded verbatim); `installContainerCli` (`install-cli.ts:14`); `Docker`/`DockerError`.
- Produces:
  - `export const WM_CLI_PATH = "/usr/local/bin/wm"`
  - `export const WM_JSON_REL = "me/wm.json"` / `export const WM_MD_REL = "me/WM.md"`
  - `export const WM_USAGE: string`
  - `export function buildWmCliScript(): string`
  - `export function provisionWmCli(containerId: string): Effect.Effect<void, DockerError, Docker>` — error channel PROPAGATES (orchestrator logs loud and continues, mirroring `provisionMemoryCli`, `memory-cli.ts:216-227`)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/conscious/wm-cli.test.ts`. The end-to-end block executes the generated script with **node** (the script is plain JS over `node:fs`; node honors the shebang-bearing `.mjs` file and is a faithful stand-in for bun, which isn't installed on the host):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Docker } from "../services/Docker.js"
import { parseWmFile, renderWmMarkdown } from "./wm-core.js"
import { WM_CLI_PATH, buildWmCliScript, provisionWmCli } from "./wm-cli.js"

describe("buildWmCliScript", () => {
  const script = buildWmCliScript()

  it("is a bun script (absolute shebang — bun is not on PATH under bash -lc)", () => {
    expect(script.startsWith("#!/home/node/.bun/bin/bun\n")).toBe(true)
  })

  it("dispatches EXACTLY the three verbs — todo/done/discard — and NO `wm list`", () => {
    expect(script).toContain('verb === "todo"')
    expect(script).toContain('verb === "done"')
    expect(script).toContain('verb === "discard"')
    expect(script).not.toContain('"list"')
  })

  it("embeds the unit-tested core functions verbatim (no drift)", () => {
    expect(script).toContain("function parseWmFile(")
    expect(script).toContain("function applyWmMutation(")
    expect(script).toContain("function renderWmMarkdown(")
  })

  it("targets the me/-relative store paths (cwd is /work/players/<name>)", () => {
    expect(script).toContain('"me/wm.json"')
    expect(script).toContain('"me/WM.md"')
  })
})

describe("wm CLI end-to-end (script executed with node)", () => {
  let dir: string
  let scriptPath: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-cli-"))
    fs.mkdirSync(path.join(dir, "me"))
    scriptPath = path.join(dir, "wm.mjs")
    fs.writeFileSync(scriptPath, buildWmCliScript())
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const wm = (...args: string[]) =>
    execFileSync("node", [scriptPath, ...args], { cwd: dir, encoding: "utf8" }).trim()
  const store = () => parseWmFile(fs.readFileSync(path.join(dir, "me", "wm.json"), "utf8"))
  const md = () => fs.readFileSync(path.join(dir, "me", "WM.md"), "utf8")

  it("todo prints the new id, journals the delta, and renders WM.md", () => {
    expect(wm("todo", "buy fuel")).toBe("t1")
    expect(wm("todo", "at the station", "--parent", "t1")).toBe("t2")
    const f = store()
    expect(f.todos).toHaveLength(2)
    expect(f.todos[1]).toMatchObject({ id: "t2", parent: "t1", state: "open" })
    // Agent mutations are journaled for the harness to drain into episodes.
    expect(f.pendingDeltas.map((d) => d.op)).toEqual(["add", "add"])
    expect(f.pendingDeltas.every((d) => d.by === "agent")).toBe(true)
    expect(md()).toContain("- [ ] t1 buy fuel")
    expect(md()).toContain("  - [ ] t2 at the station")
  })

  it("done / discard update state; discard is hidden from WM.md but retained in wm.json", () => {
    wm("todo", "a") // t1
    wm("todo", "b") // t2
    wm("done", "t1")
    wm("discard", "t2")
    const f = store()
    expect(f.todos[0].state).toBe("done")
    expect(f.todos[1].state).toBe("discarded")
    expect(md()).toContain("- [x] t1 a")
    expect(md()).not.toContain("t2 b")
    // Render parity with the host: WM.md is exactly the host-side render.
    expect(md()).toBe(renderWmMarkdown(f))
    // Atomic writes: no temp artifacts remain.
    expect(fs.readdirSync(path.join(dir, "me")).filter((n) => n.includes(".tmp"))).toEqual([])
  })

  it("rejects bad input: unknown verb (incl. `list`) → exit 2 with usage; bad id → exit 1", () => {
    const wmFail = (...args: string[]): { status?: number; stderr?: Buffer } => {
      try {
        execFileSync("node", [scriptPath, ...args], { cwd: dir })
        throw new Error("expected the CLI to fail")
      } catch (e) {
        return e as { status?: number; stderr?: Buffer }
      }
    }
    const list = wmFail("list")
    expect(list.status).toBe(2)
    expect(String(list.stderr)).toContain("no `wm list`")
    wm("todo", "a")
    const bad = wmFail("done", "t99")
    expect(bad.status).toBe(1)
    expect(String(bad.stderr)).toContain("no such todo: t99")
  })
})

describe("provisionWmCli", () => {
  it("execs AS ROOT a command that base64-writes the script to /usr/local/bin/wm and chmods it", async () => {
    const calls: Array<{ command: string[]; opts?: { user?: string } }> = []
    const StubDocker = Layer.succeed(
      Docker,
      Docker.of({
        exec: (_id: string, command: string[], opts?: { user?: string }) => {
          calls.push({ command, opts })
          return Effect.succeed("")
        },
      } as unknown as typeof Docker.Service),
    )
    await Effect.runPromise(Effect.provide(provisionWmCli("c1"), StubDocker))
    expect(calls).toHaveLength(1)
    expect(calls[0].opts?.user).toBe("root")
    const sh = calls[0].command.join(" ")
    expect(sh).toContain(WM_CLI_PATH)
    expect(sh).toContain("chmod 0755")
  })
})
```

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/conscious/wm-cli.test.ts
```

Expected failure: `Failed to resolve import "./wm-cli.js"`.

- [ ] **Step 3: Implement**

Create `packages/core/src/conscious/wm-cli.ts`:

```ts
import { Effect } from "effect"
import { Docker, type DockerError } from "../services/Docker.js"
import { installContainerCli } from "./install-cli.js"
import { applyWmMutation, parseWmFile, renderWmMarkdown } from "./wm-core.js"

/** Where the generated CLI is installed inside the container (on PATH). */
export const WM_CLI_PATH = "/usr/local/bin/wm"
/** Store paths relative to the in-container cwd /work/players/<name> — the
 * same convention as memory's DEFAULT_DB_PATH (memory-cli.ts). */
export const WM_JSON_REL = "me/wm.json"
export const WM_MD_REL = "me/WM.md"

export const WM_USAGE = [
  "usage:",
  '  wm todo "<text>" [--parent <id>]   create a todo (prints the new id)',
  "  wm done <id>                       mark a todo done",
  "  wm discard <id>                    drop a todo without doing it (kept for later review)",
  "",
  "There is no `wm list` — your current todo tree is always visible as WM.md in your context.",
].join("\n")

/**
 * Generate the `wm` bun CLI (spec §2): a plain-JSON working-memory store with
 * three verbs and NO `list` (visibility comes from automatic injection). Every
 * mutation atomically (write-tmp-then-rename) rewrites me/wm.json AND
 * re-renders me/WM.md, which opencode re-reads and injects on every LLM
 * request via the project `instructions` config.
 *
 * Structurally mirrors memory-cli.ts: a script base64-piped to
 * /usr/local/bin/wm, provisioned idempotently AT CONTAINER STARTUP (no lazy
 * provisioning in the cortex loop). The pure core — parseWmFile /
 * applyWmMutation / renderWmMarkdown — is embedded VERBATIM at generate time
 * via Function.prototype.toString on the unit-tested wm-core functions, the
 * same no-drift rationale as memory-cli's JSON.stringify'd SQL builders: the
 * container CLI cannot diverge from the host state machine because they ARE
 * the same functions (wm-core.ts's embedding contract keeps them
 * self-contained).
 *
 * Agent mutations are journaled into wm.json's pendingDeltas; the harness
 * drains the journal onto step-end episode records (spec §2: all wm mutations
 * are recorded in episodes-transition.jsonl).
 */
export function buildWmCliScript(): string {
  const usageLit = JSON.stringify(WM_USAGE)
  const jsonRelLit = JSON.stringify(WM_JSON_REL)
  const mdRelLit = JSON.stringify(WM_MD_REL)
  return `#!/home/node/.bun/bin/bun
// Working-memory CLI (generated; do not edit — see conscious/wm-cli.ts).
// Plain JSON store at me/wm.json; every mutation atomically re-renders
// me/WM.md, which opencode injects into your context on every request.
import * as fs from "node:fs";

const WM_JSON = ${jsonRelLit};
const WM_MD = ${mdRelLit};
const USAGE = ${usageLit};

${parseWmFile.toString()}

${applyWmMutation.toString()}

${renderWmMarkdown.toString()}

function readStore() {
  try {
    return parseWmFile(fs.readFileSync(WM_JSON, "utf8"));
  } catch {
    return parseWmFile("");
  }
}

// Atomic write-via-rename on the container side (spec §2 Store).
function writeAtomic(file, text) {
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function persist(file) {
  writeAtomic(WM_JSON, JSON.stringify(file, null, 2));
  writeAtomic(WM_MD, renderWmMarkdown(file));
}

const argv = process.argv.slice(2);
const verb = argv[0];

let mutation = null;
if (verb === "todo") {
  let parent = null;
  const rest = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--parent" && i + 1 < argv.length) { parent = argv[i + 1]; i++; }
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) { console.error(USAGE); process.exit(2); }
  mutation = { verb: "todo", text: rest[0], parent: parent };
} else if (verb === "done" || verb === "discard") {
  if (argv.length !== 2) { console.error(USAGE); process.exit(2); }
  mutation = { verb: verb, id: argv[1] };
} else {
  console.error(USAGE);
  process.exit(2);
}

const result = applyWmMutation(readStore(), mutation, "agent", new Date().toISOString());
if (!result.ok) {
  console.error("wm: " + result.error);
  process.exit(1);
}
// Journal the agent mutation for the harness to drain into the episode log
// at the next step boundary (spec §2).
const next = result.file;
next.pendingDeltas = next.pendingDeltas.concat([result.delta]);
persist(next);
if (mutation.verb === "todo") console.log(result.delta.id);
`
}

/**
 * Install the generated `wm` CLI into the container (idempotent; root exec —
 * see install-cli.ts). The error channel PROPAGATES (DockerError): the caller
 * (orchestrator startup) logs it loud and continues, so a breakage shows up
 * in logs instead of only as a later "command not found" the agent hits.
 */
export function provisionWmCli(containerId: string): Effect.Effect<void, DockerError, Docker> {
  return installContainerCli(containerId, WM_CLI_PATH, buildWmCliScript())
}
```

- [ ] **Step 4: Run it, expect pass**

```
pnpm vitest run packages/core/src/conscious/wm-cli.test.ts
```

- [ ] **Step 5: Eager provisioning in the orchestrator**

In `apps/roci/src/orchestrator.ts`, add to the imports (next to line 12's `provisionMemoryCli` import):

```ts
import { provisionWmCli } from "@roci/core/conscious/wm-cli.js"
```

and immediately after the memory-CLI provisioning block (after line 176, inside the same per-container loop):

```ts
      // Provision the in-container `wm` CLI EAGERLY at startup, alongside
      // `memory` (spec §2: same no-lazy-provisioning rule — core character
      // infrastructure must exist before any phase runs). Idempotent
      // (overwrites the script); needs only a running container + root exec.
      // Failure-tolerant: log loud and continue (working memory degrades to
      // a read-only WM.md until the next start).
      yield* provisionWmCli(containerId).pipe(
        Effect.tap(() => logBehavior("orchestrator", "main", "provision", { type: "provision", component: "wm_cli", status: "ready" })),
        Effect.catchAll((e) =>
          logToConsole("orchestrator", "main", `wm CLI provisioning failed (working memory unavailable): ${e}`, "warn").pipe(
            Effect.zipRight(logBehavior("orchestrator", "main", "provision", { type: "provision", component: "wm_cli", status: "failed", detail: String(e) })),
          ),
        ),
      )
```

- [ ] **Step 6: Typecheck + commit**

```
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/conscious/wm-cli.ts packages/core/src/conscious/wm-cli.test.ts apps/roci/src/orchestrator.ts
git commit --no-verify -m "feat(wm): generated in-container wm CLI, provisioned eagerly at startup

/usr/local/bin/wm (bun script, generated like memory): todo/done/discard, NO
list. Embeds the unit-tested wm-core functions verbatim (no drift), writes
wm.json+WM.md atomically, journals agent deltas for the episode drain.
Provisioned in orchestrator startup right after the memory CLI.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: injection via opencode `instructions` + per-character provisioning + step-task verb docs

The injection mechanism (spec §2 Injection, spec:54-56): the character's opencode config gains an `instructions` entry pointing at `me/WM.md`. **Verified fact (cite in code comments): OpenCode v1.17.13 re-reads `instructions` files from disk on every LLM request** (`session/instruction.ts`, uncached, inside the per-step loop) and injects them into the system prompt as "Instructions from: \<path\>" — automatic, repeated, fresh even mid-turn (spec:15, spec:56). The global config (`opencode-config.ts:29`) is per-container/shared, so the entry lives in a per-character project-local `players/<name>/opencode.json`; the conscious session's cwd is `/work/players/<name>` (`process-runner.ts:23`), where that file resolves. `formatStepTask` (`state.ts:296-304`) documents the wm verbs to the agent (spec:64) — the single doc site (decision 4 above).

**Files:**
- Modify: `packages/core/src/conscious/opencode-config.ts` (new builder + writer after `writeCharacterAgentFile`, `:134-146`)
- Modify: `packages/core/src/conscious/conscious-thought.ts:81-112` (`provisionImpl`)
- Modify: `packages/core/src/cortex/state.ts:296-304` (`formatStepTask`)
- Test: `packages/core/src/conscious/opencode-config.test.ts`, `packages/core/src/conscious/conscious-thought.test.ts`, `packages/core/src/cortex/state.test.ts`

**Interfaces:**
- Consumes: `ensureWmFiles` (Task 5).
- Produces:
  - `export const CHARACTER_OPENCODE_CONFIG_FILE = "opencode.json"` / `export const WM_INSTRUCTIONS_PATH = "me/WM.md"` (opencode-config.ts)
  - `export function buildCharacterOpencodeConfigJson(): string`
  - `export function writeCharacterOpencodeConfig(opts: { playersDir: string; playerName: string }): void`
  - `formatStepTask(step: PlanStep, headline: string): string` — signature unchanged; body gains the wm verbs section.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/conscious/opencode-config.test.ts` (it already imports from `./opencode-config.js` — extend that import with `buildCharacterOpencodeConfigJson, writeCharacterOpencodeConfig, CHARACTER_OPENCODE_CONFIG_FILE, WM_INSTRUCTIONS_PATH`; it already has `mkdtempSync`/`tmpdir`/path imports for the `writeCharacterAgentFile` tests):

```ts
describe("buildCharacterOpencodeConfigJson (working-memory injection)", () => {
  it("points instructions at me/WM.md — re-read by opencode v1.17.13 on every LLM request", () => {
    const config = JSON.parse(buildCharacterOpencodeConfigJson())
    expect(config.instructions).toEqual([WM_INSTRUCTIONS_PATH])
    expect(WM_INSTRUCTIONS_PATH).toBe("me/WM.md")
  })
})

describe("writeCharacterOpencodeConfig", () => {
  it("writes players/<name>/opencode.json (the conscious session's cwd)", () => {
    const playersDir = mkdtempSync(nodePath.join(tmpdir(), "wm-oc-"))
    writeCharacterOpencodeConfig({ playersDir, playerName: "ada" })
    const file = nodePath.join(playersDir, "ada", CHARACTER_OPENCODE_CONFIG_FILE)
    const config = JSON.parse(readFileSync(file, "utf8"))
    expect(config.instructions).toEqual(["me/WM.md"])
  })

  it("is idempotent (safe to re-run at every provision)", () => {
    const playersDir = mkdtempSync(nodePath.join(tmpdir(), "wm-oc-"))
    writeCharacterOpencodeConfig({ playersDir, playerName: "ada" })
    writeCharacterOpencodeConfig({ playersDir, playerName: "ada" })
    const config = JSON.parse(readFileSync(nodePath.join(playersDir, "ada", "opencode.json"), "utf8"))
    expect(config.instructions).toEqual(["me/WM.md"])
  })
})
```

(Match the file's existing import names — it uses `nodePath`/`readFileSync` style in the `writeCharacterAgentFile` describes; reuse whatever is already imported there.)

Append to `packages/core/src/conscious/conscious-thought.test.ts` inside `describe("ConsciousThought.provision writes the frontier CLI", ...)` (reusing its `provisionOpts`/`StubDockerCapturing` idiom at `:188-219`, but with a char dir nested inside the temp dir so the `../..` players-dir resolution stays inside it):

```ts
  it("provisions the working-memory injection: opencode.json + seeded wm files", async () => {
    const StubDockerOk = Layer.succeed(
      Docker,
      Docker.of({ exec: () => Effect.succeed("") } as unknown as typeof Docker.Service),
    )
    const tempDir = mkdtempSync(nodePath.join(tmpdir(), "roci-wm-provision-"))
    const charDir = nodePath.join(tempDir, "players", "ada", "me")
    const program = Effect.gen(function* () {
      const ct = yield* ConsciousThought
      yield* ct.provision({ ...provisionOpts(tempDir), char: { name: "ada", dir: charDir } })
    })
    await Effect.runPromise(
      Effect.provide(program, Layer.mergeAll(ConsciousThoughtLive, StubDockerOk, StubCharacterLog)),
    )
    // Project-local opencode config: instructions → me/WM.md.
    const config = JSON.parse(
      readFileSync(nodePath.join(tempDir, "players", "ada", "opencode.json"), "utf8"),
    )
    expect(config.instructions).toEqual(["me/WM.md"])
    // The instruction file itself is seeded so it exists from the first request.
    expect(readFileSync(nodePath.join(charDir, "WM.md"), "utf8")).toContain("# Working memory")
    expect(existsSync(nodePath.join(charDir, "wm.json"))).toBe(true)
  })
```

(Add `existsSync`/`readFileSync` to the test file's `node:fs` import if missing.)

Append to `packages/core/src/cortex/state.test.ts` inside `describe("formatStepTask", ...)` (`:266`):

```ts
  it("documents the wm verbs to the agent — and does NOT invent a wm list", () => {
    const task = formatStepTask(
      { task: "act", goal: "g", tier: "smart", successCondition: "s", timeoutTicks: 2 },
      "headline",
    )
    expect(task).toContain('wm todo "<text>" [--parent <id>]')
    expect(task).toContain("wm done <id>")
    expect(task).toContain("wm discard <id>")
    expect(task).toContain("no `wm list`")
  })
```

- [ ] **Step 2: Run them, expect failure**

```
pnpm vitest run packages/core/src/conscious/opencode-config.test.ts packages/core/src/conscious/conscious-thought.test.ts packages/core/src/cortex/state.test.ts
```

Expected: import errors for the new opencode-config exports; missing files for the provision test; `expected ... to contain 'wm todo ...'` for formatStepTask.

- [ ] **Step 3: Implement**

In `packages/core/src/conscious/opencode-config.ts`, append after `writeCharacterAgentFile` (line 146):

```ts
/** Per-character project-local OpenCode config filename (in players/<name>/). */
export const CHARACTER_OPENCODE_CONFIG_FILE = "opencode.json"
/** The working-memory instructions file, relative to players/<name>/ (wm-store's WM.md). */
export const WM_INSTRUCTIONS_PATH = "me/WM.md"

/**
 * Per-character project-local OpenCode config: `instructions` points at the
 * character's WM.md (agent-cognition Stage 2, spec §2 Injection).
 *
 * Verified against OpenCode v1.17.13: files listed in `instructions` are
 * re-read from disk on EVERY LLM request (session/instruction.ts, uncached,
 * inside the per-step loop) and injected into the system prompt as
 * "Instructions from: <path>" — so a wm mutation is visible to the very next
 * request, even mid-turn, with no transcript accumulation. The relative path
 * resolves against this config's project dir: the conscious session runs with
 * cwd /work/players/<name> (process-runner.ts buildExecArgs), where this file
 * lives. Trade accepted per spec: the churning system prompt invalidates the
 * provider prompt cache — fine, the conscious model is local MLX.
 *
 * This is separate from the GLOBAL per-container config (provider/permissions,
 * GLOBAL_OPENCODE_CONFIG_PATH) because the global file is shared by every
 * character in the container; the instructions entry must be per-character.
 */
export function buildCharacterOpencodeConfigJson(): string {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      instructions: [WM_INSTRUCTIONS_PATH],
    },
    null,
    2,
  )
}

/** Write the project-local config host-side (bind-mounted players dir). Idempotent. */
export function writeCharacterOpencodeConfig(opts: { playersDir: string; playerName: string }): void {
  const dir = path.join(opts.playersDir, opts.playerName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, CHARACTER_OPENCODE_CONFIG_FILE), buildCharacterOpencodeConfigJson())
}
```

In `packages/core/src/conscious/conscious-thought.ts`: extend the `./opencode-config.js` import (line 11-16) with `writeCharacterOpencodeConfig`, add `import { ensureWmFiles } from "./wm-store.js"`, and in `provisionImpl` insert after the `writeCharacterAgentFile` `Effect.try` block (line 94) and before `provisionConsciousProvider`:

```ts
    // Working memory (spec §2 Injection): the project-local opencode.json
    // points `instructions` at me/WM.md, and the wm files are seeded so the
    // instruction file exists from the first request. Runs once before the
    // first tick — provisioning, not a lazy in-loop load (the `wm` CLI itself
    // is provisioned eagerly at container startup in orchestrator.ts).
    yield* Effect.try(() =>
      writeCharacterOpencodeConfig({
        playersDir: path.resolve(opts.char.dir, "../.."),
        playerName: opts.char.name,
      }),
    )
    yield* ensureWmFiles(opts.char)
```

In `packages/core/src/cortex/state.ts`, replace `formatStepTask` (lines 296-304) with:

```ts
/** The instructions handed to the conscious agent for one plan step. */
export function formatStepTask(step: PlanStep, headline: string): string {
  return [
    `# Task: ${step.task}`,
    `Context: ${headline}`,
    `## Goal\n${step.goal}`,
    `## Success condition\n${step.successCondition}`,
    // Working-memory verbs (spec §2: "formatStepTask documents the wm verbs
    // to the agent"). This is the single doc site — WM.md itself (injected
    // into every request via opencode instructions) stays pure data.
    [
      "## Working memory",
      "Your open todos are always visible as WM.md in your context. Keep them current with the `wm` bash command:",
      '- `wm todo "<text>" [--parent <id>]` — add a todo (prints its id)',
      "- `wm done <id>` — mark it done",
      "- `wm discard <id>` — drop it without doing it (kept for later review)",
      "There is no `wm list` — WM.md is the list.",
    ].join("\n"),
    `Do this work now. When finished, report concisely what you did and whether the success condition is met. When you have fully met the success condition, print exactly: ${STEP_DONE_MARKER}`,
  ].join("\n\n")
}
```

- [ ] **Step 4: Run everything touched, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/conscious/opencode-config.test.ts packages/core/src/conscious/conscious-thought.test.ts packages/core/src/cortex/state.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/conscious/opencode-config.ts packages/core/src/conscious/opencode-config.test.ts packages/core/src/conscious/conscious-thought.ts packages/core/src/conscious/conscious-thought.test.ts packages/core/src/cortex/state.ts packages/core/src/cortex/state.test.ts
git commit --no-verify -m "feat(wm): WM.md injection via opencode instructions + step-task verb docs

Per-character players/<name>/opencode.json points instructions at me/WM.md —
opencode v1.17.13 re-reads instruction files on every LLM request, so every
wm mutation is visible to the next request. provisionImpl writes the config
and seeds wm.json/WM.md before the first tick; formatStepTask documents the
three wm verbs (and that there is no wm list).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: harness lifecycle — seed on decide, done on evaluate, discard on replan, deltas into the episode log

The loop half of spec §2 Harness integration (spec:60-65): decide seeds plan steps as todos under a plan-headline todo; evaluate marks the step's todo done; a replan discards orphans; and **all** wm mutations land in `episodes-transition.jsonl` — agent (CLI) deltas drained from the journal onto step-end `wmDeltas`, harness deltas on the same step-end or (outside a step window) on a new `type:"wm"` record.

**Files:**
- Modify: `packages/core/src/logging/episodes.ts` (`WmTransitionEpisode`; union at `:77`)
- Modify: `packages/core/src/cortex/loop.ts` — imports; wm locals + helpers after `resetPlanState`; both plan-assignment sites (`:407-425`); the step-end block (`:583-596` area); `resetPlanState` (Task 1's version)
- Test: `packages/core/src/logging/episodes.test.ts`, `packages/core/src/cortex/loop.test.ts`

**Interfaces:**
- Consumes: `seedWmPlan`, `mutateWm`, `drainWmDeltas`, `WmDelta`, `WmMutation` (Tasks 4-5); `appendTransitionEpisode`, `episodeContext` (Stage 1).
- Produces:
  - `export interface WmTransitionEpisode { type: "wm"; ts: string; tick: number | null; stepId: string | null; deltas: unknown[] }` (episodes.ts) — additive union member of `TransitionEpisode`; `deltas` is `unknown[]` for the same reason `StepBoundaryEpisode.wmDeltas` is (the logging substrate stays import-free of `conscious/`; the concrete shape is wm-core's `WmDelta`).
  - Step-end records now carry `wmDeltas: WmDelta[]` (non-null when any mutation happened during the step) — **no type change**; Stage 1 reserved `unknown[] | null` for exactly this.

- [ ] **Step 1: Write the failing episodes test**

Append to `packages/core/src/logging/episodes.test.ts` (extend the `./episodes.js` import with `type WmTransitionEpisode` — a type-only check plus a runtime append):

```ts
describe("wm transition records (Stage 2)", () => {
  it("appendTransitionEpisode accepts a type:\"wm\" record and rotation treats it as cycle content", async () => {
    const wmRecord: WmTransitionEpisode = {
      type: "wm",
      ts: "2026-07-02T00:00:00.000Z",
      tick: 3,
      stepId: null,
      deltas: [{ op: "add", id: "t1", text: "x", parent: null, by: "harness", ts: "2026-07-02T00:00:00.000Z" }],
    }
    await Effect.runPromise(appendTransitionEpisode("ada", wmRecord))
    const [rec] = readLines(TRANSITION_EPISODE_FILE).map((l) => JSON.parse(l))
    expect(rec).toMatchObject({ type: "wm", tick: 3 })
    expect(rec.deltas).toHaveLength(1)
    // Rotation: wm records are ordinary cycle content, dropped with their cycle.
    await Effect.runPromise(finishEpisodeCycle("ada"))
    for (let c = 0; c < EPISODE_RETAIN_CYCLES; c++) await Effect.runPromise(finishEpisodeCycle("ada"))
    const remaining = readLines(TRANSITION_EPISODE_FILE).map((l) => JSON.parse(l))
    expect(remaining.every((r) => r.type === "cycle-boundary")).toBe(true)
  })
})
```

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/logging/episodes.test.ts
```

Expected: TS/vitest import failure — `episodes.js` does not export `WmTransitionEpisode` (and the object literal fails the `TransitionEpisode` union check under typecheck).

- [ ] **Step 3: Implement the episodes record**

In `packages/core/src/logging/episodes.ts`, insert after `CycleBoundaryEpisode` (line 75) and update the union (line 77):

```ts
/**
 * Working-memory mutation record (Stage 2, spec §2: "All wm mutations are also
 * recorded in episodes-transition.jsonl"). Carries harness mutations that
 * happen OUTSIDE an in-flight step window (decide-time plan seeding; orphan
 * discards with no open step). Mutations DURING a step ride the step-end
 * record's `wmDeltas` instead — drained from the CLI's pendingDeltas journal
 * plus the harness's own end-of-step mutations — so one boundary record tells
 * the whole step's wm story. `deltas` is `unknown[]` for the same reason
 * StepBoundaryEpisode.wmDeltas is: the logging substrate stays import-free of
 * conscious/ modules; the concrete shape is wm-core's WmDelta.
 */
export interface WmTransitionEpisode {
  type: "wm"
  ts: string
  tick: number | null
  stepId: string | null
  deltas: unknown[]
}

export type TransitionEpisode =
  | TierTransitionEpisode
  | StepBoundaryEpisode
  | WmTransitionEpisode
  | CycleBoundaryEpisode
```

Run `pnpm vitest run packages/core/src/logging/episodes.test.ts` — expect pass.

- [ ] **Step 4: Write the failing loop tests**

Append to `packages/core/src/cortex/loop.test.ts` inside `describe("runCortex (conscious-session executor)", ...)`. Both tests give the character a REAL tmp dir (`char.dir` under the episode root) so the wm store writes real files — the `CharacterFs` stub is irrelevant because wm-store does direct fs on `char.dir`. Add `import { parseWmFile } from "../conscious/wm-core.js"` to the test imports.

```ts
  it("wm lifecycle: decide seeds plan todos under a headline todo; evaluate marks done; deltas reach the episode log", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-loop-"))
    setEpisodeLogRoot(root)
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
        return yield* runCortex({
          char: { name: "ada", dir: charDir },
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

      // Store: headline todo (orient headline) + one child per plan step.
      const wm = parseWmFile(fs.readFileSync(path.join(charDir, "wm.json"), "utf8"))
      expect(wm.todos[0]).toMatchObject({ id: "t1", text: "act now", parent: null })
      expect(wm.todos[1]).toMatchObject({ id: "t2", text: "act: do the thing", parent: "t1" })
      // Evaluate marked the step done; the (single-step) plan closed → headline done too.
      expect(wm.todos[1].state).toBe("done")
      expect(wm.todos[0].state).toBe("done")
      // WM.md was re-rendered by the harness mutations.
      expect(fs.readFileSync(path.join(charDir, "WM.md"), "utf8")).toContain("- [x] t1 act now")

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
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
```

And inside `describe("runCortex — limbic drives …")`, extending Task 1's abandoned-step scenario:

```ts
  it("wm lifecycle: a reorient discards the dropped plan's seeded orphans, recorded on the abandoned step-end", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-orphan-"))
    setEpisodeLogRoot(root)
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
        return yield* runCortex({
          char: { name: "ada", dir: charDir },
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
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
```

- [ ] **Step 5: Run them, expect failure**

```
pnpm vitest run packages/core/src/cortex/loop.test.ts -t "wm lifecycle"
```

Expected: `ENOENT … wm.json` — the loop never seeds anything.

- [ ] **Step 6: Implement the loop hooks**

In `packages/core/src/cortex/loop.ts`:

1. Add imports (after the episodes import block ending line 68):

```ts
import { drainWmDeltas, mutateWm, seedWmPlan } from "../conscious/wm-store.js"
import type { WmDelta, WmMutation } from "../conscious/wm-core.js"
```

2. Add wm locals next to `planHeadline` (line 185):

```ts
    // Working memory (spec §2): ids of the harness-seeded plan todos — the
    // headline todo plus one child per step (parallel to the plan's steps).
    // "" marks a step whose seed was skipped (wm degraded); guarded below.
    let planHeadlineTodoId: string | null = null
    let planStepTodoIds: string[] = []
```

3. Add two helpers right BEFORE `resetPlanState`:

```ts
    // Record harness wm deltas that occur OUTSIDE an in-flight step window
    // (decide-time seeding; discards with no open step) as a type:"wm"
    // transition record (spec §2: all wm mutations are recorded).
    // appendTransitionEpisode is swallow-and-log — this never fails.
    const emitWmRecord = (deltas: readonly WmDelta[]) =>
      deltas.length === 0
        ? Effect.void
        : appendTransitionEpisode(config.char.name, {
            type: "wm",
            ts: new Date().toISOString(),
            tick,
            stepId: episodeContext(config.char.name).stepId,
            deltas: [...deltas],
          })

    // Discard the seeded todos a dropped plan leaves behind (spec §2: "a
    // replan discards orphaned todos"), headline included — the abandoned
    // plan's intent stays visible to retrospectives but leaves the active
    // render. Agent-authored todos are never touched. mutateWm skips ids the
    // agent already closed (logged, not fatal).
    const discardPlanOrphans = () =>
      Effect.gen(function* () {
        const ids = [...planStepTodoIds.filter((id) => id !== ""), ...(planHeadlineTodoId ? [planHeadlineTodoId] : [])]
        planHeadlineTodoId = null
        planStepTodoIds = []
        if (ids.length === 0) return [] as WmDelta[]
        return yield* mutateWm(config.char, ids.map((id) => ({ verb: "discard" as const, id })))
      })
```

4. Extend `resetPlanState` (Task 1's Effect version): replace the `const ctx = …` through the `if (ctx.stepId !== null && step) { … }` block with:

```ts
        const ctx = episodeContext(config.char.name)
        const step = planSteps(cortex.currentPlan)[cortex.currentStepIndex]
        // wm (spec §2): the dropped plan's seeded todos are orphans — discard
        // them, and drain any agent-journaled deltas from the abandoned step,
        // so the abandoned step-end carries the full wm story.
        const orphanDeltas = yield* discardPlanOrphans()
        const agentDeltas = yield* drainWmDeltas(config.char)
        const wmDeltas = [...agentDeltas, ...orphanDeltas]
        if (ctx.stepId !== null && step) {
          yield* appendTransitionEpisode(config.char.name, {
            type: "step-end",
            ts: new Date().toISOString(),
            tick,
            stepId: ctx.stepId,
            task: step.task,
            goal: step.goal,
            transition: "replan",
            skill: null,
            wmDeltas: wmDeltas.length > 0 ? wmDeltas : null,
          })
        } else {
          yield* emitWmRecord(wmDeltas)
        }
```

5. Seed at BOTH plan-assignment sites in 5a. After the discover branch's `planHeadline = orient.headline` (line 416) AND after the plan branch's `planHeadline = orient.headline` (line 425), add the same three lines:

```ts
            // wm (spec §2): seed the plan's steps as todos under a headline
            // todo, so intent survives replans. Seeding is best-effort — a wm
            // failure yields empty ids and the plan proceeds regardless.
            const seeded = yield* seedWmPlan(config.char, orient.headline, planSteps(cortex.currentPlan))
            planHeadlineTodoId = seeded.headlineId
            planStepTodoIds = seeded.stepIds
            yield* emitWmRecord(seeded.deltas)
```

6. Step-end block (6a). Replace the existing step-end emission (the `// Episode substrate (spec §1): step-end …` comment + `yield* appendTransitionEpisode({ … wmDeltas: null })` call, lines 583-596) with:

```ts
            // wm (spec §2): evaluate marks the step's seeded todo done; a
            // plan-dropping transition (replan/wait/terminate) discards the
            // remaining seeded todos — the headline closes done only when
            // every step todo is done, discarded otherwise; a completed plan
            // closes its headline done. Harness deltas + the drained agent
            // journal ride the step-end record's wmDeltas.
            const stepTodoId = planStepTodoIds[stepIdx] || null
            const doneDeltas = stepTodoId
              ? yield* mutateWm(config.char, [{ verb: "done", id: stepTodoId }])
              : []
            const tName = evalResult.transition.transition
            let planCloseDeltas: WmDelta[] = []
            if (tName === "replan" || tName === "wait" || tName === "terminate") {
              const remaining = planStepTodoIds.filter((id) => id !== "" && id !== stepTodoId)
              const headlineId = planHeadlineTodoId
              planHeadlineTodoId = null
              planStepTodoIds = []
              const muts: WmMutation[] = remaining.map((id) => ({ verb: "discard" as const, id }))
              if (headlineId) muts.push({ verb: remaining.length === 0 ? ("done" as const) : ("discard" as const), id: headlineId })
              planCloseDeltas = yield* mutateWm(config.char, muts)
            } else if (stepIdx + 1 >= steps.length) {
              // next_step off the end = plan complete: close the headline todo.
              const headlineId = planHeadlineTodoId
              planHeadlineTodoId = null
              planStepTodoIds = []
              planCloseDeltas = headlineId
                ? yield* mutateWm(config.char, [{ verb: "done", id: headlineId }])
                : []
            }
            const agentDeltas = yield* drainWmDeltas(config.char)
            const stepWmDeltas = [...agentDeltas, ...doneDeltas, ...planCloseDeltas]
            // Episode substrate (spec §1): step-end with the evaluate verdict.
            // skill stays null until Stage 3; wmDeltas is Stage 2's payload.
            yield* appendTransitionEpisode(config.char.name, {
              type: "step-end",
              ts: new Date().toISOString(),
              tick,
              stepId: episodeContext(config.char.name).stepId ?? `s${stepStartTick}-${stepIdx}`,
              task: step.task,
              goal: step.goal,
              verdict: evalResult.judgment,
              transition: evalResult.transition.transition,
              skill: null,
              wmDeltas: stepWmDeltas.length > 0 ? stepWmDeltas : null,
            })
```

(Note: the single-step-plan case takes the `terminate` branch here with `remaining = []` → headline `done`, matching the first loop test; the wm mutations run before the existing transition branch at line 647, which still owns control flow — wm code paths never change what the loop does next.)

- [ ] **Step 7: Relax the Stage-1 loop test, run the suites, typecheck + commit**

The pre-existing Stage-1 test (`emits step-start and step-end transition episodes (verdict, null skill/wm fields)`, `loop.test.ts:1423`) asserts `wmDeltas: null` on both boundary records. Its `char.dir = "/work/players/ada/me"` is unwritable on a dev macOS host (the wm store swallows the failure → no deltas → `null` still holds), but on a root-privileged runner the seed would succeed and fill `wmDeltas`. Make the test environment-independent: in both of its `toMatchObject` expectations, **delete the `wmDeltas: null` line** (keep `skill: null` — Stage 3 owns that field) and update the `it` title to `"emits step-start and step-end transition episodes (verdict, null skill field)"`. Task 1's abandoned-step test asserts no `wmDeltas` — no change needed there.

```
pnpm vitest run packages/core/src/cortex/loop.test.ts packages/core/src/logging/episodes.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/logging/episodes.ts packages/core/src/logging/episodes.test.ts packages/core/src/cortex/loop.ts packages/core/src/cortex/loop.test.ts
git commit --no-verify -m "feat(wm): harness plan-todo lifecycle + wm deltas in the episode log

Decide seeds plan steps under a headline todo (type:\"wm\" record); evaluate
marks the step todo done; replan/reset discards orphans (headline done only
when all steps closed); agent-journal deltas drain onto step-end wmDeltas —
every wm mutation reaches episodes-transition.jsonl (spec §2).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: open-todo visibility in the orient and decide prompts

The open list (capped, tree-rendered) becomes a prompt variable for orient and decide (spec:63). `renderTemplate` replaces unknown `{{key}}`s with `""` and ignores extra vars (`core/template.ts:52-55`), so existing callers/tests are unaffected by the new optional parameter.

**Files:**
- Modify: `packages/core/src/skills/orient.md:35-39`, `packages/core/src/skills/decide.md:35-41` (new `{{workingMemory}}` sections)
- Modify: `packages/core/src/cortex/tiers.ts` — `runForebrain` (`:204-222`), `runConsciousDecide` (`:261-285`)
- Modify: `packages/core/src/cortex/loop.ts` — both 5a call sites (`:374-381`, `:392`) and the 5b forebrain call (`:497-504`)
- Test: `packages/core/src/cortex/tiers.test.ts`, `packages/core/src/cortex/loop.test.ts`

**Interfaces:**
- Consumes: `readWm`, `renderOpenTodoTree` (Task 5).
- Produces (Stage 3 shares these exact touchpoints when it adds the skill index to decide):
  - `runForebrain(config, accumulatedEvents, domainState, identity, emotionalWeight, recalledMemories = "", workingMemory = "")`
  - `runConsciousDecide(config, orient, currentPlanState, availableActions, recalledMemories = "", workingMemory = "")`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/cortex/tiers.test.ts`, append (reusing the file's existing module-scope `config`/`fixedClient`/`recordingService`/`silentLog` helpers; note the transition-episodes block's `orientFixture` is scoped to its own describe, so define a local one here):

```ts
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

  it("orient renders the open-todo tree into the prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-tiers-"))
    setEpisodeLogRoot(root)
    resetEpisodeContext("ada")
    try {
      await Effect.runPromise(
        Effect.provide(
          runForebrain(config, ["evt"], "{}", { background: "", values: "", diary: "" }, "😐", "", "- t1 WM_ORIENT_MARKER"),
          layers('{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","confidence":"low","metrics":{}}'),
        ),
      )
      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const [rec] = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      expect(rec.prompt).toContain("Working Memory")
      expect(rec.prompt).toContain("- t1 WM_ORIENT_MARKER")
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("decide renders the open-todo tree into the prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-tiers-"))
    setEpisodeLogRoot(root)
    resetEpisodeContext("ada")
    try {
      await Effect.runPromise(
        Effect.provide(
          runConsciousDecide(config, wmOrientFixture, "No active plan.", "actions", "", "- t2 WM_DECIDE_MARKER"),
          layers('{"decision":"continue","reasoning":"r"}'),
        ),
      )
      const file = path.join(root, "players", "ada", "logs", "episodes-transition.jsonl")
      const [rec] = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      expect(rec.prompt).toContain("- t2 WM_DECIDE_MARKER")
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
```

(The tier-transition episode's `prompt` field is the cleanest window onto the rendered prompt — no new test seams needed.)

In `packages/core/src/cortex/loop.test.ts`, append inside `describe("runCortex (conscious-session executor)", ...)` — end-to-end: a pre-existing open todo written by "the agent" shows up in the decide prompt:

```ts
  it("threads the character's open todos into the decide prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-prompt-"))
    const charDir = path.join(root, "players", "ada", "me")
    fs.mkdirSync(charDir, { recursive: true })
    fs.writeFileSync(
      path.join(charDir, "wm.json"),
      JSON.stringify({
        version: 1,
        nextId: 2,
        todos: [{ id: "t1", text: "REMEMBER_THE_FUEL", parent: null, state: "open", createdAt: "x", updatedAt: "x" }],
        pendingDeltas: [],
      }),
    )
    try {
      let decidePrompt = ""
      const capturingClient = Layer.succeed(
        ModelClient,
        ModelClient.of({
          complete: (_h: ModelHandle, messages) =>
            Effect.sync(() => {
              const p = messages.map((m) => m.content).join(" ")
              const lower = p.toLowerCase()
              if (lower.includes("plain prose")) return { text: "Diary.", raw: {} }
              if (lower.includes("disposition") && !lower.includes("decision"))
                return { text: '{"disposition":"escalate","emotionalWeight":"😰","reason":"x"}', raw: {} }
              if (lower.includes("headline") && !lower.includes("judgment"))
                return { text: '{"headline":"h","sections":[],"whatChanged":"x","emotionalState":"😐","metrics":{}}', raw: {} }
              // decide
              decidePrompt = p
              return { text: '{"decision":"terminate","reasoning":"stop"}', raw: {} }
            }),
        }),
      )
      const ctLayer = ConsciousThoughtTest((config) => ({ result: successTurnResult(config.prompt), sessionId: "s" }))
      const program = Effect.gen(function* () {
        const events = yield* Queue.unbounded<unknown>()
        yield* Queue.offer(events, { type: "combat" })
        return yield* runCortex({
          char: { name: "ada", dir: charDir },
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
```

- [ ] **Step 2: Run them, expect failure**

```
pnpm vitest run packages/core/src/cortex/tiers.test.ts -t "working-memory prompt"
pnpm vitest run packages/core/src/cortex/loop.test.ts -t "threads the character"
```

Expected: TS arity is fine (extra args to a shorter signature fail typecheck but vitest's transform will fail compilation first) — concretely, `expected '' to contain 'WM_ORIENT_MARKER'` style failures / TS2554 "Expected 5-6 arguments, but got 7".

- [ ] **Step 3: Implement**

In `packages/core/src/skills/orient.md`, change (lines 35-39):

```markdown
## Emotional Weight from Observations

{{emotionalWeight}}

## Instructions
```

to:

```markdown
## Emotional Weight from Observations

{{emotionalWeight}}

## Working Memory (open todos)

{{workingMemory}}

## Instructions
```

In `packages/core/src/skills/decide.md`, change (lines 35-41):

```markdown
## Current Plan State

{{currentPlanState}}

## Available Domain Skills

{{availableSkills}}
```

to:

```markdown
## Current Plan State

{{currentPlanState}}

## Working Memory (open todos)

{{workingMemory}}

## Available Domain Skills

{{availableSkills}}
```

In `packages/core/src/cortex/tiers.ts`:

- `runForebrain` (line 204): add the trailing parameter `workingMemory = ""` after `recalledMemories = ""`, and add `workingMemory,` to the `skills.orient.render({ ... })` vars (line 212-222).
- `runConsciousDecide` (line 261): add the trailing parameter `workingMemory = ""` after `recalledMemories = ""`, and add `workingMemory,` to the `skills.decide.render({ ... })` vars (line 268-285).

In `packages/core/src/cortex/loop.ts`, add to the wm-store import: `readWm, renderOpenTodoTree`. In **5a** (before the `runForebrain` call at line 374):

```ts
          // wm (spec §2): the open list (capped, tree-rendered) is a prompt
          // variable for orient AND decide. Read once per escalation.
          const wmPromptBlock = renderOpenTodoTree(yield* readWm(config.char))
```

then pass it as the final argument to both calls: `runForebrain(..., orientRecall, wmPromptBlock)` (line 374-381) and `runConsciousDecide(runnerConfig, orient, "No active plan.", AVAILABLE_ACTIONS, decideRecall, wmPromptBlock)` (line 392). In **5b** (before the `runForebrain` call at line 497), the same `const wmPromptBlock = …` line, and pass `wmPromptBlock` as the forebrain call's final argument (line 497-504).

- [ ] **Step 4: Run the full suite, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/cortex/tiers.test.ts packages/core/src/cortex/loop.test.ts
pnpm vitest --run
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/skills/orient.md packages/core/src/skills/decide.md packages/core/src/cortex/tiers.ts packages/core/src/cortex/tiers.test.ts packages/core/src/cortex/loop.ts packages/core/src/cortex/loop.test.ts
git commit --no-verify -m "feat(wm): open-todo visibility in orient/decide prompts

The capped tree-rendered open list becomes a {{workingMemory}} variable in
the orient and decide skill templates, threaded from the loop's wm store read
(spec §2 harness integration).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Spec §2 coverage checklist

- **Store** — `players/<name>/me/wm.json`, plain JSON on the shared mount; atomic write-via-rename on both sides (spec:42): Task 5 (host `writeAtomic`), Task 6 (CLI `writeAtomic`); torn-file impossibility asserted via no-`.tmp`-artifact tests both sides.
- **CLI** — bun script at `/usr/local/bin/wm`, generated like `memory`, provisioned eagerly at container startup; verbs exactly `todo`/`done`/`discard`; **no `wm list`** (spec:44-52): Task 6 (script + `orchestrator.ts` block + negative `"list"` assertion).
- **States** `open | done | discarded`; discarded = retained, not done, not in progress, excluded from active renders, visible to retrospectives (spec:50-52): Task 4 (state machine + render exclusion), Task 5 (`renderOpenTodoTree` exclusion; `readWm` retains), Task 8 (orphan-discard loop test asserts retained-in-json/hidden-in-md).
- **Injection** — every mutation re-renders `WM.md` next to `wm.json` (CLI **and** harness); opencode `instructions` includes it; v1.17.13 per-request re-read (verified fact); prompt-cache caveat accepted (spec:54-56): Tasks 5/6 (`persistWm`/`persist` always rewrite both files), Task 7 (project config + provision seeding + cache-caveat comment).
- **Harness: decide seeds steps as todos under a plan-headline todo** (spec:60): Task 5 (`seedWmPlan`) + Task 8 (both plan-assignment sites, discover included).
- **Harness: evaluate marks the step's todo done** (spec:61): Task 8 (step-end block).
- **Harness: replan discards orphaned todos** (spec:62): Task 8 (evaluate-replan branch + `resetPlanState` reorient/interrupt path).
- **Harness: open list (capped, tree-rendered) in orient + decide prompt variables** (spec:63): Task 9.
- **Harness: `formatStepTask` documents the wm verbs** (spec:64): Task 7.
- **All wm mutations recorded in `episodes-transition.jsonl`** (spec:65): Task 8 — agent journal drained onto step-end `wmDeltas` (the field Stage 1 reserved, `episodes.ts:68`); harness seeding/out-of-step discards as `type:"wm"` records; schema-consistent (additive union member, `wmDeltas` type untouched).
- **Non-goal honored** (spec:67): no OpenCode plugin, no todowrite mirroring anywhere in this plan.
- **Testing & error handling** (spec:69): state machine, tree parenting, `WM.md` render, atomic both sides, seeding/done/orphan flows, wm-deltas-in-episodes — Tasks 4-9; never-disturb-the-tick-loop discipline tested via unwritable-dir cases (Tasks 5, 8 with `/work/...` paths).
- **Stage-1 deferred fixes:** abandoned-step step-end (Task 1), `finishEpisodeCycle` isolation + `.tmp` cleanup (Task 2), `status:"error"` transport test (Task 3).
