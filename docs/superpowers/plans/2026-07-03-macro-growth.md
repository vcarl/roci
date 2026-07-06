# Macro growth stimulation Implementation Plan (Stage 5 of agent cognition extensions — FINAL)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan **stacks on `feat/wm`** (Stage 2 committed through `75117a9`, Stage 3 through `cba8f3e`, Stage 4 — meso retrospect — through `3bb3b76`); there is no merge to `main` between the stages. Verify you are on `feat/wm` before starting (`git -C <worktree> branch --show-current`).

**Goal:** The **macro "growth stimulation"** stage (spec §4 macro, `docs/superpowers/specs/2026-07-02-agent-cognition-extensions-design.md:112-127`) — the last extension. Every **Nth** reflection cycle (persisted counter, default N=4), a **frontier-class tool-less Claude worker** is farmed the character's accumulated skill proposals (Stage 4's `me/growth/proposals.jsonl`), the just-ended cycle's episode aggregates, the current skill index, the current `me/SYNTHESIS.md`, and a semantic sample of the `LongtermStore`. The worker returns ONE structured adjudication document — accept/reject per proposal (with the final skill contents for accepts and a reason for rejects), a freshly rewritten bounded self-model, and a first-person in-fiction diary "growth note" — and the **HARNESS applies it**: accepted skill edits go through `CharacterFs.writeSkill` (create/revise) or `CharacterFs.deleteSkill` (retire), rejected proposals are recorded with their reason to an append-only `me/growth/adjudications.jsonl` audit, the adjudicated proposals are drained from the pending queue, `me/SYNTHESIS.md` is rewritten (size-bounded, never-grows-past-bound), and the growth note is appended to `DIARY.md`. `SYNTHESIS.md` is then injected into the forebrain `orient` prompt alongside background/values/diary. The worker is **tool-less**; every guardrail lives in **code, not prompt**: macro can write skills (via `writeSkill`/`deleteSkill`) and `SYNTHESIS.md`/`DIARY.md` only — there is **no `CharacterFs` write method for VALUES.md / background.md / DRIVES.md / PALETTE.md at all**, so no macro code path can target an identity file. A macro failure (blank/timed-out/errored turn, or a container with no `memory` CLI) leaves the proposals accumulated for the next macro cycle and never disturbs promote/retrospect/consolidate/dream/mark/rotate. SpaceMolt only; the GitHub domain is stale and out of scope.

**Architecture:** The macro stage is a new module `packages/core/src/core/limbic/hippocampus/macro.ts` (`macro.execute`, sibling to `dream`/`consolidate`/`retrospect`) that gates on the counter, gathers inputs, runs ONE `role:"brain"` `noTools` turn through the frontier/reasoning model, parses the adjudication document, and applies it through `CharacterFs`. It reuses Stage 4's read surface wholesale: `readProposals`/`SkillProposal`/`aggregateEpisodes`/`renderAggregate`/`renderRawSample`/`renderSkillIndex` and `readCurrentCycleEpisodes`. `packages/core/src/conscious/growth-store.ts` grows the macro data surface: the persisted **counter** state file (`me/growth/macro-state.json`) with `MACRO_EVERY_N` (env-overridable), the append-only **adjudications** audit (`appendAdjudications` → `me/growth/adjudications.jsonl`), the **queue drain** (`removeProposals`), the tolerant **adjudication-document parser** (`parseAdjudicationDoc`), and a small **wrong-anchor hardening** of the existing `firstBalancedBracket` (carry-forward from the Stage-4 review). `packages/core/src/services/CharacterFs.ts` grows three methods — `readSynthesis`/`writeSynthesis` (the bounded self-model doc) and `deleteSkill` (the sanctioned retire path) — and `skills-core.ts`'s `validateSkillWrite` extends its newline rejection to the `description`/`when_to_use` fields (carry-forward: macro passes model-generated strings). `runForebrain` (`cortex/tiers.ts:204`) + `skills/orient.md` + both `loop.ts` orient call sites gain the `synthesis` identity field. `model-config.ts` gains a `"macro"` role. `behavior.ts`'s reflection stage union gains `"macro"`. `runReflection` (`planned-action.ts:38`) wires the macro stage **after dream and before the re-baseline mark**, wrapped in the same best-effort `Effect.catchAll(logError)` as every other stage.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Effect 3.x, `@effect/platform` `FileSystem` (via the `CharacterFs` layer already provided to `runReflection`), `@effect/platform` `CommandExecutor` + `OAuthToken` (the `runTurn` seam), vitest 3.x, pnpm + nx monorepo (`@roci/core` at `packages/core`, app `apps/roci`). No new dependencies.

## Global Constraints

- **Guardrails are code-enforced, not prompt-hoped (spec §4 Guardrails, spec:120-126):**
  - **Identity files are structurally unreachable.** Macro's only write calls are `CharacterFs.writeSkill`, `CharacterFs.deleteSkill`, `CharacterFs.writeSynthesis`, and `CharacterFs.writeDiary`. `CharacterFs` exposes **no** `writeValues`/`writeBackground`/`writeDrives`/`writePalette` method (verify: `CharacterFs.ts:31-48` write surface is `writeDiary`/`writeSecrets`/`writeSkill` + the new `writeSynthesis`/`deleteSkill`), so a macro write targeting VALUES.md/background.md/DRIVES.md/PALETTE.md cannot be expressed. This is the guardrail — not a prompt instruction.
  - **Skill caps enforced as usual.** Every accepted create/revise is applied through `writeSkill`, which runs `validateSkillWrite` (≤`MAX_SKILLS`=12 distinct skills, ≤`MAX_SKILL_BODY_CHARS`=4096 body, and — carry-forward, Task 1 — newline/`MAX_*` caps on name/description/when_to_use). A cap rejection is recorded as a **rejected** adjudication (with the cap reason) rather than crashing the stage.
  - **SYNTHESIS.md is size-bounded, mirroring dream's never-grows discipline (spec:126).** A worker synthesis over `MAX_SYNTHESIS_CHARS` (4000) is **discarded** and the prior `SYNTHESIS.md` is kept untouched (exactly dream's clamp: `dream.ts:170-178`, "cull produced N lines > input — keeping original").
  - **Proposals are evidence-bearing by construction.** Stage 4's `parseProposals` already rejects evidence-less proposals at parse (`growth-store.ts:299-300`); macro only ever reads what that gate admitted.
- **Never-fail / best-effort (spec §4 Testing, spec:127):** a macro failure "leaves proposals accumulated for the next macro cycle rather than dropping them." Every new `growth-store.ts` reader/writer is `Effect<..., never, never>` (swallow-and-log, degrade to empty). `macro.execute`'s error channel is `never`: the turn failure is caught (blank/timeout/error → adjudicate nothing, synthesize nothing, narrate nothing, return zeros); `LongtermStore.recall` is caught (container/`memory` CLI down → empty memory sample); every `CharacterFs` write is caught. The proposals queue is drained **only** for ids the worker actually adjudicated — a failed turn drains nothing, so the pending proposals survive to the next macro cycle. The `runReflection` call site adds a belt-and-suspenders `Effect.catchAll(logError)` exactly like promote/retrospect/consolidate/dream (`planned-action.ts:76-81,106-108,120-124,130-134`).
- **Counter persistence, gated cadence (spec §4 macro, spec:112 "every Nth reflection cycle", persisted counter):** the counter lives host-side in `me/growth/macro-state.json` (never-fail atomic write, same idiom as `proposals.jsonl`), bumped once per `runReflection` inside `macro.execute`; macro runs its turn only when `count % N === 0`. N defaults to `MACRO_EVERY_N = 4`, overridable via `ROCI_MACRO_EVERY_N` (parsed like `ROCI_MODEL_RESTART_RETRIES`, `ModelService.ts:33-38`; invalid/`<1` → default).
- **Tool-less frontier worker via the strong-model seam:** macro drives `runTurn({ role:"brain", noTools:true, model: resolveModel(models,"macro","reasoning") })` — the SAME `claude`-binary strong-model path dream/consolidate/retrospect use (`dream.ts:132-153`), upgraded to the reasoning tier. It does NOT drive the `frontier`/`sdk-runner` in-container async worker (design decision 1). The worker never touches the filesystem; the harness applies its document.
- **Bounded prompt (spec §1 Aggregates, spec:34):** the raw episode streams never reach the model. Macro reuses Stage 4's code-side `aggregateEpisodes`/`renderAggregate`/`renderRawSample`, renders the pending proposals compactly, and truncates the `LongtermStore` recall sample — the same "aggregates computed at read time" discipline.
- **Runs BEFORE `finishEpisodeCycle`'s rotation, AFTER dream (spec §1 Rotation, spec:32):** macro reads the current cycle's episodes (via `readCurrentCycleEpisodes`, before rotation) and appends its diary growth note AFTER dream's cull (so the note survives the compression) and BEFORE the re-baseline mark (so the note is folded into the marked diary rather than re-promoted next cycle) — design decision 2.
- **SpaceMolt only (spec:5):** `runReflection` runs for all domains, but only SpaceMolt exercises it in scope; the GitHub domain is stale.
- **Verification:** run from the worktree root `/Users/vcarl/workspace/roci/.claude/worktrees/skills` (`node_modules` installed). Tests: `pnpm vitest run <relative-test-path>`. Typecheck: `pnpm nx run-many -t typecheck --skip-nx-cache` — **always `--skip-nx-cache`** (nx caches typecheck and replays a stale green across cross-package symbol changes, e.g. the `CharacterFs` Tag surface change in Task 1).
- Conventional-commit messages; end every commit body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Commit with `--no-verify`.

## File Structure

**New files:**
- `packages/core/src/core/limbic/hippocampus/macro.ts` — `macro` (`{ name:"macro", execute }`), `MacroInput`/`MacroOutput`, `MAX_SYNTHESIS_CHARS`, `MACRO_RAW_SAMPLE_STEPS`, `MACRO_RECALL_K`, `buildMacroPrompt`, `defaultGrowthNote`, `renderPendingProposals`, `renderMemoryHits`, `synthesisRecallQuery`.
- `packages/core/src/core/limbic/hippocampus/macro.test.ts`

**Modified files:**
- `packages/core/src/services/skills-core.ts` — Task 1: `validateSkillWrite` newline rejection on `description`/`when_to_use`.
- `packages/core/src/services/skills-core.test.ts` — Task 1.
- `packages/core/src/services/CharacterFs.ts` — Task 1: `readSynthesis`/`writeSynthesis`/`deleteSkill` + `SYNTHESIS_FILE`.
- `packages/core/src/services/CharacterFs.test.ts` — Task 1.
- Every `CharacterFs.of({...})` stub — Task 1: `cortex/loop.test.ts` (×4), `core/limbic/hippocampus/consolidate.test.ts`, `retrospect.test.ts`, `dream.test.ts`, `core/orchestrator/planned-action.test.ts`.
- `packages/core/src/conscious/growth-store.ts` — Task 2: counter state, adjudications audit, `removeProposals`, `parseAdjudicationDoc`, `firstBalancedBracket` hardening.
- `packages/core/src/conscious/growth-store.test.ts` — Task 2.
- `packages/core/src/cortex/tiers.ts` — Task 3: `runForebrain` identity gains `synthesis`.
- `packages/core/src/cortex/tiers.test.ts` — Task 3.
- `packages/core/src/skills/orient.md` — Task 3: `{{synthesis}}` block.
- `packages/core/src/cortex/loop.ts` — Task 3: both orient sites read + pass `synthesis` (`:447-474`, `:628-648`).
- `packages/core/src/core/model-config.ts` — Task 4: `Role` gains `"macro"`.
- `packages/core/src/logging/behavior.ts:33` — Task 5: reflection `stage` union gains `"macro"`.
- `packages/core/src/core/orchestrator/planned-action.ts` — Task 5: macro stage after dream (`:135`→before `:142`), import.
- `packages/core/src/core/orchestrator/planned-action.test.ts` — Task 5.

**Design decisions resolved up front (with justification, grounded in the code read):**

1. **Tool-less `claude`-binary brain turn, NOT the `frontier`/`sdk-runner` worker.** Spec:114 says macro is "farmed to a frontier-class Claude worker via the harness's strong-model seam — the same infrastructure as the `frontier` tool / sdk-runner." There are two strong-model paths in the harness. (a) `runTurn` with `role:"brain"` + `noTools:true` (`process-runner.ts:101`, `dream.ts:132`) runs the `claude` binary in-container over the OAuth token with **tools disabled**, resolving whatever model string it is handed — a `"sonnet"`/`"opus"` label runs the real frontier model. dream/consolidate/retrospect all use exactly this. (b) `frontier-cli.ts` (`buildFrontierCliScript`) is a **tool-ENABLED**, steerable, detached, fifo-backed in-container async worker built for the *conscious agent* to delegate live sub-tasks mid-session (`frontier start|poll|steer|wait`). Macro needs neither tools nor steering, and the binding guardrail is precisely "macro ADJUDICATES AND APPLIES, but application goes through `CharacterFs.writeSkill` (harness code) — the worker produces a structured document and the HARNESS applies it, keeping the worker tool-less and the guardrails in code." Path (a) IS that seam; path (b) would hand the worker a filesystem and defeat the guardrail. **Decision: macro drives `runTurn({role:"brain",noTools:true})` at the reasoning tier.** "Same infrastructure" is honored in spirit: same OAuth-backed frontier `claude` worker, same never-fail blank-turn handling as dream — just the `noTools` variant at the frontier model.
2. **Placement: after dream, before the re-baseline mark.** Macro must run before `finishEpisodeCycle` (it reads the current-cycle episode aggregates, which rotation drops — `episodes.ts` / spec:32) and after dream (its diary growth note must survive dream's cull — dream compresses DIARY.md at `dream.ts:182`; a note appended before the cull could be compressed away). Placing it **before** the re-baseline mark (`planned-action.ts:142-153`) folds the growth note into the diary that the mark captures, so next cycle's promote does not re-promote the note as a "new raw entry" (`newSinceMark`). Macro is gated to every Nth cycle and wrapped best-effort, so its slow (≤`REFLECTION_TURN_TIMEOUT_MS`=8min) frontier turn cannot block the mark or rotation on the non-macro cycles, and even on a macro cycle a timeout degrades to a no-op.
3. **Counter home: host-side `me/growth/macro-state.json`, NOT the `LongtermStore` meta table.** The counter must tick every reflection and persist across sessions. `LongtermStore`'s mark table (`readMark`/`writeMark`) is **container-only** — it shells the in-container `memory` CLI via `docker exec` (`longterm-store.ts:128-149`) and fails if the container/CLI is unavailable. The counter must not depend on that (and macro's never-fail rule forbids a failure dropping the cadence). So the counter is a host-side JSON file beside `proposals.jsonl`, written with the same never-fail atomic idiom (`growth-store.ts:371-399`). N=4 default: reflection runs once per cortex break→reflect boundary; with `MAX_PROPOSALS_PER_CYCLE`=5 and `MAX_PENDING_PROPOSALS`=100 it takes ~20 cycles to saturate the queue, so N=4 keeps the pending set small (≤~20) and the synthesis ≤4 cycles stale while amortizing the expensive frontier turn + `LongtermStore` recall to once per 4 cycles. Overridable via `ROCI_MACRO_EVERY_N`.
4. **Adjudication record: TWO files, two disciplines.** Spec:116 requires "record rejected proposals with a reason" and spec:127 requires "adjudication outcomes (accepted and rejected-with-reason) must be recorded." (a) `me/growth/adjudications.jsonl` — **append-only permanent audit**, one line per outcome (`{id, ts, cycle, action, skill, decision:"accepted"|"rejected", reason}`). (b) The pending queue `proposals.jsonl` is **drained** of the adjudicated ids (`removeProposals`), because spec:110/the Stage-4 plan bind "proposals accumulate ... until the macro cycle adjudicates and **clears** them" — otherwise the same proposal re-adjudicates forever. Only ids the worker actually ruled on are drained; un-ruled proposals stay pending (never-fail: a partial turn keeps the rest).
5. **`SYNTHESIS.md` on `CharacterFs`, injected into orient alongside identity.** `SYNTHESIS.md` is a per-character identity-adjacent document re-read on escalation exactly like background/values/diary (`loop.ts:447-449`), so it belongs on the `CharacterFs` service (the identity-doc surface), not the host-side never-fail `growth-store`. Its bound is enforced in the macro stage (mirroring dream's clamp), and `readSynthesis` degrades to `""` on a missing file (like `readBackground`), so a character with no synthesis yet orients unchanged.

---

## Task 1: `CharacterFs`/`skills-core` — SYNTHESIS.md surface, `deleteSkill`, and the newline-validation carry-forward

Grow the identity-doc service with the bounded self-model read/write and the sanctioned skill-retire path, and fold in the Stage-4 carry-forward that extends `validateSkillWrite`'s newline rejection to the `description`/`when_to_use` fields (macro passes model-generated strings straight into these). Adding methods to the `CharacterFs` Tag is a cross-package surface change, so every `CharacterFs.of({...})` stub is updated in the same task.

**Files:**
- Modify: `packages/core/src/services/skills-core.ts` (`validateSkillWrite`, `:139-172`)
- Modify: `packages/core/src/services/skills-core.test.ts`
- Modify: `packages/core/src/services/CharacterFs.ts` (Tag `:31-48`; live layer `:76-176`)
- Modify: `packages/core/src/services/CharacterFs.test.ts`
- Modify: every `CharacterFs.of({...})` stub (see File Structure)

**Interfaces:**
- Produces (Task 3 consumes `readSynthesis`; Task 4 consumes `readSynthesis`/`writeSynthesis`/`deleteSkill` + the extended `validateSkillWrite`):
  - `export const SYNTHESIS_FILE = "SYNTHESIS.md"` (in `CharacterFs.ts`)
  - `readonly readSynthesis: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>` — missing file → `""`
  - `readonly writeSynthesis: (char: CharacterConfig, content: string) => Effect.Effect<void, CharacterFsError>`
  - `readonly deleteSkill: (char: CharacterConfig, name: string) => Effect.Effect<void, CharacterFsError>` — removes `me/skills/<slug>.md`; a missing file is a no-op (idempotent retire)
  - `validateSkillWrite` unchanged signature; now also rejects a newline in `fields.description` / `fields.whenToUse`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/services/skills-core.test.ts`, append to the `validateSkillWrite` describe (the file already imports it):

```ts
  it("rejects a newline in description or when_to_use (macro passes model strings)", () => {
    expect(validateSkillWrite([], "s", "body", { description: "line1\nline2" })).toEqual({
      ok: false,
      error: "skill description contains a newline",
    })
    expect(validateSkillWrite([], "s", "body", { whenToUse: "when a\nwhen b" })).toEqual({
      ok: false,
      error: "skill when_to_use contains a newline",
    })
    // a clean single-line value still passes
    expect(validateSkillWrite([], "s", "body", { description: "clean", whenToUse: "clean" })).toEqual({ ok: true })
  })
```

In `packages/core/src/services/CharacterFs.test.ts`, append (mirror the existing `writeSkill`/`readDiary` filesystem-layer tests in that file — reuse its `NodeFileSystem` provisioning + tmp-dir `char` helper; add `SYNTHESIS_FILE` to the `./CharacterFs.js` import and `fs`/`path` if not present):

```ts
describe("readSynthesis / writeSynthesis / deleteSkill (Stage 5 macro surface)", () => {
  it("readSynthesis returns '' when SYNTHESIS.md is absent, round-trips after write", async () => {
    const { char, run } = mkChar() // existing helper: tmp me/ dir + a runner providing CharacterFsLive+NodeFileSystem
    expect(await run((c) => c.readSynthesis(char))).toBe("")
    await run((c) => c.writeSynthesis(char, "I am the ship that remembers.\n"))
    expect(fs.existsSync(path.join(char.dir, SYNTHESIS_FILE))).toBe(true)
    expect(await run((c) => c.readSynthesis(char))).toBe("I am the ship that remembers.\n")
  })

  it("deleteSkill removes me/skills/<slug>.md and is a no-op when absent", async () => {
    const { char, run } = mkChar()
    await run((c) => c.writeSkill(char, { slug: "securing-fuel", name: "securing-fuel", description: "d", whenToUse: "w", body: "b" }))
    expect(fs.existsSync(path.join(char.dir, "skills", "securing-fuel.md"))).toBe(true)
    await run((c) => c.deleteSkill(char, "securing-fuel"))
    expect(fs.existsSync(path.join(char.dir, "skills", "securing-fuel.md"))).toBe(false)
    // idempotent: deleting again does not throw
    await run((c) => c.deleteSkill(char, "securing-fuel"))
    expect(await run((c) => c.listSkills(char))).toEqual([])
  })
})
```

> If `CharacterFs.test.ts` has no reusable `mkChar()`/`run` helper, add one at the top of the new describe: `const mkChar = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfs-")); const char = { name: "ada", dir: path.join(root, "me") }; const run = <A>(f: (c: CharacterFsService) => Effect.Effect<A, unknown, never>) => Effect.runPromise(Effect.gen(function*(){ const c = yield* CharacterFs; return yield* f(c) }).pipe(Effect.provide(CharacterFsLive), Effect.provide(NodeFileSystem.layer)) as Effect.Effect<A, unknown, never>); return { char, run } }` — matching the existing file's provisioning imports.

- [ ] **Step 2: Run them, expect failure**

```
pnpm vitest run packages/core/src/services/skills-core.test.ts packages/core/src/services/CharacterFs.test.ts
```

Expected: `description contains a newline` assertion fails (only `name` is checked today), and `readSynthesis`/`writeSynthesis`/`deleteSkill` are not on the Tag.

- [ ] **Step 3: Implement**

In `packages/core/src/services/skills-core.ts`, extend the `fields` block of `validateSkillWrite` (after the `name` checks, before the `description` length check, `:155`):

```ts
  if (fields?.description !== undefined && /[\r\n]/.test(fields.description)) {
    return { ok: false, error: "skill description contains a newline" }
  }
  if (fields?.whenToUse !== undefined && /[\r\n]/.test(fields.whenToUse)) {
    return { ok: false, error: "skill when_to_use contains a newline" }
  }
```

(Place both immediately after the existing `if (fields?.name !== undefined) { ... }` block and before the existing `if (fields?.description !== undefined && fields.description.length > ...)` length check. A newline-bearing description/when_to_use would smuggle an extra line into `serializeSkillFile`'s single-line `description:`/`when_to_use:` frontmatter — the same structural break the `name` newline check already guards, now closed for the two model-authored fields macro writes.)

In `packages/core/src/services/CharacterFs.ts`:

Add the file constant near the top (after the imports, before `Credentials`, `:14`):

```ts
/** The bounded self-model doc macro rewrites and orient injects (spec §4 macro). */
export const SYNTHESIS_FILE = "SYNTHESIS.md"
```

Add the three methods to the Tag interface (inside the `CharacterFs` object type, after `writeSkill`, `:46`):

```ts
    readonly readSynthesis: (char: CharacterConfig) => Effect.Effect<string, CharacterFsError>
    readonly writeSynthesis: (char: CharacterConfig, content: string) => Effect.Effect<void, CharacterFsError>
    readonly deleteSkill: (char: CharacterConfig, name: string) => Effect.Effect<void, CharacterFsError>
```

Add the three implementations to `CharacterFs.of({...})` in the live layer (after `writeSkill`, `:175`):

```ts
      // ── Self-model synthesis (spec §4 macro) ───────────────────
      // me/SYNTHESIS.md — read like an identity file (missing → ""), written
      // only by the macro cycle (bounded there). Injected into orient.
      readSynthesis: (char) =>
        readFileOr(path.join(char.dir, SYNTHESIS_FILE), ""),

      writeSynthesis: (char, content) =>
        fs.writeFileString(path.join(char.dir, SYNTHESIS_FILE), content).pipe(
          Effect.mapError((e) => new CharacterFsError("Failed to write synthesis", e)),
        ),

      // The sanctioned macro retire path: remove me/skills/<slug>.md. A missing
      // file is a no-op (idempotent) — the agent may already have deleted it
      // directly. Only ever targets a file under me/skills/ (slug-derived).
      deleteSkill: (char, name) =>
        Effect.gen(function* () {
          const file = path.join(char.dir, "skills", `${slugify(name)}.md`)
          const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
          if (!exists) return
          yield* fs.remove(file).pipe(
            Effect.mapError((e) => new CharacterFsError("Failed to delete skill", e)),
          )
        }),
```

Then update **every** `CharacterFs.of({...})` stub (the Tag now requires the three methods; TS fails otherwise) — add these three lines to each stub object (alongside its `writeSkill`):

```ts
      readSynthesis: () => Effect.succeed(""),
      writeSynthesis: () => Effect.void,
      deleteSkill: () => Effect.void,
```

Sites: `packages/core/src/cortex/loop.test.ts` (4 stubs), `packages/core/src/core/limbic/hippocampus/consolidate.test.ts`, `packages/core/src/core/limbic/hippocampus/retrospect.test.ts`, `packages/core/src/core/limbic/hippocampus/dream.test.ts`, `packages/core/src/core/orchestrator/planned-action.test.ts`. (Grep to confirm the full set: `grep -rl "CharacterFs.of(" packages/core/src`.)

- [ ] **Step 4: Run the touched suites, typecheck + commit**

```
pnpm vitest run packages/core/src/services/skills-core.test.ts packages/core/src/services/CharacterFs.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/services/skills-core.ts packages/core/src/services/skills-core.test.ts packages/core/src/services/CharacterFs.ts packages/core/src/services/CharacterFs.test.ts packages/core/src/cortex/loop.test.ts packages/core/src/core/limbic/hippocampus/consolidate.test.ts packages/core/src/core/limbic/hippocampus/retrospect.test.ts packages/core/src/core/limbic/hippocampus/dream.test.ts packages/core/src/core/orchestrator/planned-action.test.ts
git commit --no-verify -m "feat(character-fs): SYNTHESIS.md surface, deleteSkill, description/when_to_use newline caps

Grows the CharacterFs identity-doc service for Stage 5 macro: readSynthesis/
writeSynthesis (the bounded self-model doc orient will inject) and deleteSkill
(the sanctioned skill-retire path). Extends validateSkillWrite's newline
rejection from name to description/when_to_use, since macro writes
model-generated frontmatter strings. Updates every CharacterFs.of stub.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: `growth-store.ts` — macro counter, adjudications audit, queue drain, adjudication-doc parser, extractor hardening

The host-side macro data surface, sibling to Stage 4's proposal surface: the persisted counter (with the N gate constant), the append-only adjudications audit, the pending-queue drain, the tolerant adjudication-document parser, and the carry-forward wrong-anchor hardening of `firstBalancedBracket`.

**Files:**
- Modify: `packages/core/src/conscious/growth-store.ts`
- Modify: `packages/core/src/conscious/growth-store.test.ts`

**Interfaces:**
- Consumes: `CharacterConfig` (`CharacterFs.ts:26`); the existing `firstBalancedBracket`/`ProposalAction`/`SkillProposal`/`proposalsJsonlPath`/`loadProposals` idiom already in the file.
- Produces (Task 4 consumes all of these):
  - `export const MACRO_EVERY_N = 4` / `export function macroEveryN(): number` (env `ROCI_MACRO_EVERY_N`)
  - `export const MACRO_STATE_FILE = "macro-state.json"` / `export function macroStatePath(char): string`
  - `export const readMacroCount: (char: CharacterConfig) => Effect.Effect<number>` — missing/garbled → 0
  - `export const bumpMacroCount: (char: CharacterConfig) => Effect.Effect<number>` — atomic +1, returns the new count; never-fails (on write failure returns the pre-bump count so the same cadence retries, never crashes)
  - `export interface Adjudication { id: string; ts: string; cycle: number; action: ProposalAction; skill: string; decision: "accepted" | "rejected"; reason: string }`
  - `export const ADJUDICATIONS_JSONL_FILE = "adjudications.jsonl"` / `export function adjudicationsJsonlPath(char): string`
  - `export const appendAdjudications: (char, rows: readonly Adjudication[]) => Effect.Effect<number>` — append-only, never-fails
  - `export const removeProposals: (char, ids: readonly string[]) => Effect.Effect<number>` — atomic rewrite dropping `ids`; returns the count removed; never-fails
  - `export interface AdjudicationDecision { id: string; decision: "accept" | "reject"; reason: string; skill?: { name: string; description: string; whenToUse: string; body: string } }`
  - `export interface AdjudicationDoc { decisions: AdjudicationDecision[]; synthesis: string | null; diaryNote: string | null }`
  - `export function parseAdjudicationDoc(text: string): AdjudicationDoc` — tolerant; never throws

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/conscious/growth-store.test.ts` (extend the `./growth-store.js` import with the new symbols; `fs`/`os`/`path`/`CharacterConfig` are already imported):

```ts
import {
  MACRO_EVERY_N,
  macroEveryN,
  readMacroCount,
  bumpMacroCount,
  appendAdjudications,
  adjudicationsJsonlPath,
  removeProposals,
  parseAdjudicationDoc,
  type Adjudication,
} from "./growth-store.js"

describe("macro counter — persisted, atomic, never-fail", () => {
  let root: string
  let char: CharacterConfig
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "macro-"))
    char = { name: "ada", dir: path.join(root, "players", "ada", "me") }
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("MACRO_EVERY_N default is 4; macroEveryN honors ROCI_MACRO_EVERY_N and floors invalid at the default", () => {
    expect(MACRO_EVERY_N).toBe(4)
    const prev = process.env.ROCI_MACRO_EVERY_N
    try {
      process.env.ROCI_MACRO_EVERY_N = "2"
      expect(macroEveryN()).toBe(2)
      process.env.ROCI_MACRO_EVERY_N = "0"
      expect(macroEveryN()).toBe(MACRO_EVERY_N) // <1 → default
      process.env.ROCI_MACRO_EVERY_N = "nonsense"
      expect(macroEveryN()).toBe(MACRO_EVERY_N)
    } finally {
      if (prev === undefined) delete process.env.ROCI_MACRO_EVERY_N
      else process.env.ROCI_MACRO_EVERY_N = prev
    }
  })

  it("missing state → 0; bump persists and increments across reads", async () => {
    expect(await Effect.runPromise(readMacroCount(char))).toBe(0)
    expect(await Effect.runPromise(bumpMacroCount(char))).toBe(1)
    expect(await Effect.runPromise(bumpMacroCount(char))).toBe(2)
    expect(await Effect.runPromise(readMacroCount(char))).toBe(2)
  })

  it("bump never throws when the growth dir is unwritable", async () => {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "players"), "not a directory")
    await expect(Effect.runPromise(bumpMacroCount(char))).resolves.toBe(0)
  })
})

describe("appendAdjudications / removeProposals", () => {
  let root: string
  let char: CharacterConfig
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "adj-"))
    char = { name: "ada", dir: path.join(root, "players", "ada", "me") }
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const adj = (id: string, decision: "accepted" | "rejected"): Adjudication => ({
    id, ts: "t", cycle: 4, action: "revise", skill: "securing-fuel", decision, reason: "r",
  })

  it("appends adjudications as append-only jsonl and never throws", async () => {
    expect(await Effect.runPromise(appendAdjudications(char, [adj("a", "accepted"), adj("b", "rejected")]))).toBe(2)
    expect(await Effect.runPromise(appendAdjudications(char, [adj("c", "rejected")]))).toBe(1)
    const lines = fs.readFileSync(adjudicationsJsonlPath(char), "utf8").trim().split("\n")
    expect(lines).toHaveLength(3) // append-only: all three retained
    expect(JSON.parse(lines[2]).id).toBe("c")
  })

  it("removeProposals drains only the named ids from the pending queue", async () => {
    await Effect.runPromise(appendProposals(char, [
      { id: "id-0", ts: "t", action: "create", skill: "s0", summary: "s0", evidence: "e", status: "pending" },
      { id: "id-1", ts: "t", action: "create", skill: "s1", summary: "s1", evidence: "e", status: "pending" },
      { id: "id-2", ts: "t", action: "create", skill: "s2", summary: "s2", evidence: "e", status: "pending" },
    ]))
    const removed = await Effect.runPromise(removeProposals(char, ["id-0", "id-2", "unknown"]))
    expect(removed).toBe(2)
    expect((await Effect.runPromise(readProposals(char))).map((p) => p.id)).toEqual(["id-1"])
  })
})

describe("parseAdjudicationDoc — tolerant", () => {
  it("extracts decisions (with skill contents), synthesis, and diaryNote", () => {
    const doc = parseAdjudicationDoc(JSON.stringify({
      adjudications: [
        { id: "revise:securing-fuel:top up earlier", decision: "accept", reason: "clear win",
          skill: { name: "securing-fuel", description: "d", when_to_use: "w", body: "new body" } },
        { id: "create:x:junk", decision: "reject", reason: "no signal" },
      ],
      synthesis: "I am the ship that tops up early.",
      diaryNote: "Something reached into me while I rested.",
    }))
    expect(doc.decisions).toHaveLength(2)
    expect(doc.decisions[0]).toMatchObject({ decision: "accept", reason: "clear win" })
    expect(doc.decisions[0].skill).toMatchObject({ name: "securing-fuel", whenToUse: "w", body: "new body" })
    expect(doc.decisions[1]).toMatchObject({ decision: "reject", reason: "no signal", skill: undefined })
    expect(doc.synthesis).toContain("tops up early")
    expect(doc.diaryNote).toContain("reached into me")
  })

  it("tolerates a ```json fence and prose framing; missing fields → empty/null", () => {
    const doc = parseAdjudicationDoc("Here is my judgment:\n```json\n" + JSON.stringify({ adjudications: [] }) + "\n```")
    expect(doc.decisions).toEqual([])
    expect(doc.synthesis).toBeNull()
    expect(doc.diaryNote).toBeNull()
  })

  it("returns an empty doc on garbage (never throws)", () => {
    expect(parseAdjudicationDoc("not json")).toEqual({ decisions: [], synthesis: null, diaryNote: null })
  })
})

describe("firstBalancedBracket / extractProposalsArray — wrong-anchor hardening (Stage-4 review probes)", () => {
  const now = "2026-07-03T00:00:00.000Z"
  it("probe-5: prose containing an earlier bare '[' does not swallow the real proposals object", () => {
    const text =
      "Options I weighed [fuel, nav, comms] before deciding. My proposals:\n" +
      JSON.stringify({ proposals: [{ action: "revise", skill: "securing-fuel", summary: "top up earlier", evidence: "s1 failed" }] })
    const out = parseProposals(text, now)
    expect(out.map((p) => p.skill)).toEqual(["securing-fuel"])
  })
  it("probe-6: a non-JSON '{' block before the real object is skipped, recovering the later valid object", () => {
    const text =
      "note {this is prose, not json} then the real one: " +
      JSON.stringify({ proposals: [{ action: "create", skill: "docking-drill", summary: "practice docking", evidence: "s3 failed" }] })
    const out = parseProposals(text, now)
    expect(out.map((p) => p.skill)).toEqual(["docking-drill"])
  })
})
```

- [ ] **Step 2: Run them, expect failure**

```
pnpm vitest run packages/core/src/conscious/growth-store.test.ts
```

Expected: the new symbols are unresolved, and probe-5/6 fail against the current first-open-bracket anchor.

- [ ] **Step 3: Implement**

In `packages/core/src/conscious/growth-store.ts`:

Add the imports the counter needs (top, with the existing `fsp`/`path` imports already present — no new import lines needed; `crypto.randomUUID` is already used).

Replace the current `firstBalancedBracket` (`:188-226`) body with the hardened version — same string-aware scan, but when an object `{` and an array `[` both appear, **prefer the object**, and on a parse-failure of the first candidate, **retry from the next opening bracket**:

```ts
/**
 * Find a balanced top-level bracketed value in `text`, string-aware (ignores
 * brackets/quotes inside double-quoted strings, including escaped quotes).
 * Returns an array of every balanced candidate from `startAt` onward, in order,
 * with a stable PREFERENCE: an object `{...}` sorts before an array `[...]` that
 * opens at a later index is NOT reordered — order is positional, but the caller
 * tries objects first (see extractProposalsArray). Replicated self-contained
 * from cortex/parse.ts (see module header) to avoid a conscious/ -> cortex/ edge.
 *
 * Stage-4 review hardening (probe-5/6): the old single-candidate scan anchored on
 * the FIRST opening bracket, so prose like "options [a, b] ... {real json}" or a
 * "{prose}" block ahead of the real object mis-anchored and failed the parse.
 * Returning ALL candidates lets extractProposalsArray try each in turn (objects
 * preferred) instead of giving up on the first wrong anchor.
 */
function balancedCandidates(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== "{" && ch !== "[") {
      i++
      continue
    }
    const open = ch
    const close = open === "{" ? "}" : "]"
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (inString) {
        if (escaped) escaped = false
        else if (c === "\\") escaped = true
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') inString = true
      else if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end === -1) break // unbalanced from here on
    out.push(text.slice(i, end + 1))
    i = end + 1
  }
  return out
}
```

Then rewrite `extractProposalsArray` (`:243-282`) to try the candidates — **objects before arrays**, so a stray earlier bare array can never win over the real `{"proposals":[...]}` object — falling back to the fence only if no candidate yields a usable shape:

```ts
function extractProposalsArray(text: string): unknown[] {
  const fromParsed = (parsed: unknown): unknown[] | null => {
    if (Array.isArray(parsed)) return parsed
    if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { proposals?: unknown }).proposals)) {
      return (parsed as { proposals: unknown[] }).proposals
    }
    return null
  }

  const trimmed = text.trim()
  if (trimmed) {
    // 1. Whole-text parse (the model returned exactly the JSON).
    try {
      const direct = fromParsed(JSON.parse(trimmed))
      if (direct) return direct
    } catch {
      // fall through
    }
    // 2. Try every balanced candidate — objects first (prefer {"proposals":...}
    //    over a stray earlier bare array), then arrays; skip any that don't parse
    //    or don't yield a proposals shape (probe-5/6: wrong-anchor recovery).
    const candidates = balancedCandidates(trimmed)
    const ordered = [
      ...candidates.filter((c) => c.startsWith("{")),
      ...candidates.filter((c) => c.startsWith("[")),
    ]
    for (const cand of ordered) {
      try {
        const got = fromParsed(JSON.parse(cand))
        if (got) return got
      } catch {
        // try the next candidate
      }
    }
  }

  // 3. Legacy fence fallback.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : "").trim()
  if (body) {
    try {
      const fromFence = fromParsed(JSON.parse(body))
      if (fromFence) return fromFence
    } catch {
      // fall through
    }
  }
  return []
}
```

(Delete the old `firstBalancedBracket` function — `balancedCandidates` replaces it. Grep to confirm no other reference remains: `grep -n firstBalancedBracket packages/core/src/conscious/growth-store.ts` should return nothing after this edit.)

Add the macro data surface at the end of the file (after `appendProposals`, `:399`):

```ts
// ── Macro cadence counter (host-side, persisted, never-fail) ─────────────────
/** Default reflection-cycle stride between macro "growth stimulation" runs. */
export const MACRO_EVERY_N = 4
/** Effective stride, overridable via `ROCI_MACRO_EVERY_N`; invalid/<1 → default. */
export function macroEveryN(): number {
  const raw = process.env.ROCI_MACRO_EVERY_N
  if (raw === undefined) return MACRO_EVERY_N
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : MACRO_EVERY_N
}

export const MACRO_STATE_FILE = "macro-state.json"
export function macroStatePath(char: CharacterConfig): string {
  return path.join(growthDir(char), MACRO_STATE_FILE)
}

const loadMacroCount = async (char: CharacterConfig): Promise<number> => {
  try {
    const text = await fsp.readFile(macroStatePath(char), "utf8")
    const rec = JSON.parse(text) as { count?: unknown }
    return typeof rec.count === "number" && Number.isFinite(rec.count) ? rec.count : 0
  } catch {
    return 0
  }
}

/** Read the persisted macro counter (missing/garbled → 0). Never fails. */
export const readMacroCount = (char: CharacterConfig): Effect.Effect<number> =>
  Effect.promise(() => loadMacroCount(char))

/**
 * Atomically increment the persisted macro counter, returning the NEW count.
 * Never fails: on a write error the pre-bump count is returned (so the same
 * cadence retries next cycle rather than the pipeline crashing). Same
 * write-tmp+rename atomicity as appendProposals.
 */
export const bumpMacroCount = (char: CharacterConfig): Effect.Effect<number> =>
  Effect.promise(async () => {
    const current = await loadMacroCount(char)
    const next = current + 1
    try {
      await fsp.mkdir(growthDir(char), { recursive: true })
      const file = macroStatePath(char)
      const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`
      await fsp.writeFile(tmp, `${JSON.stringify({ count: next })}\n`, "utf8")
      await fsp.rename(tmp, file)
      return next
    } catch (e) {
      console.error(`[growth] macro-count bump failed for ${char.name}: ${e}`)
      return current
    }
  })

// ── Adjudications audit (append-only) + pending-queue drain ──────────────────
/** One recorded macro outcome for one proposal (spec §4: outcomes must be recorded). */
export interface Adjudication {
  id: string
  ts: string
  /** The macro cycle count this adjudication ran on. */
  cycle: number
  action: ProposalAction
  skill: string
  decision: "accepted" | "rejected"
  /** Why — always present (a rejected proposal's reason is required by spec §4). */
  reason: string
}

export const ADJUDICATIONS_JSONL_FILE = "adjudications.jsonl"
export function adjudicationsJsonlPath(char: CharacterConfig): string {
  return path.join(growthDir(char), ADJUDICATIONS_JSONL_FILE)
}

/** Append adjudication outcomes to the permanent audit. Never fails. */
export const appendAdjudications = (
  char: CharacterConfig,
  rows: readonly Adjudication[],
): Effect.Effect<number> =>
  Effect.promise(async () => {
    try {
      if (rows.length === 0) return 0
      await fsp.mkdir(growthDir(char), { recursive: true })
      const text = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`
      await fsp.appendFile(adjudicationsJsonlPath(char), text, "utf8")
      return rows.length
    } catch (e) {
      console.error(`[growth] adjudications append failed for ${char.name}: ${e}`)
      return 0
    }
  })

/**
 * Drain the named ids from the pending proposals queue (macro "clears" the
 * proposals it adjudicated). Atomic whole-file rewrite; returns how many were
 * removed. Never fails. An empty result rewrites an empty file.
 */
export const removeProposals = (
  char: CharacterConfig,
  ids: readonly string[],
): Effect.Effect<number> =>
  Effect.promise(async () => {
    try {
      if (ids.length === 0) return 0
      const drop = new Set(ids)
      const existing = await loadProposals(char)
      const kept = existing.filter((p) => !drop.has(p.id))
      const removed = existing.length - kept.length
      if (removed === 0) return 0
      await fsp.mkdir(growthDir(char), { recursive: true })
      const file = proposalsJsonlPath(char)
      const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`
      const body = kept.length === 0 ? "" : `${kept.map((p) => JSON.stringify(p)).join("\n")}\n`
      await fsp.writeFile(tmp, body, "utf8")
      await fsp.rename(tmp, file)
      return removed
    } catch (e) {
      console.error(`[growth] removeProposals failed for ${char.name}: ${e}`)
      return 0
    }
  })

// ── Adjudication document (the macro worker's structured output) ─────────────
/** One accept/reject ruling. For an accepted create/revise, `skill` carries the final contents. */
export interface AdjudicationDecision {
  id: string
  decision: "accept" | "reject"
  reason: string
  skill?: { name: string; description: string; whenToUse: string; body: string }
}

export interface AdjudicationDoc {
  decisions: AdjudicationDecision[]
  /** The freshly rewritten bounded self-model, or null if the worker offered none. */
  synthesis: string | null
  /** The first-person in-fiction growth note for DIARY.md, or null. */
  diaryNote: string | null
}

const asString = (x: unknown): string => (typeof x === "string" ? x : "")
const asTrimmedOrNull = (x: unknown): string | null => {
  const s = typeof x === "string" ? x.trim() : ""
  return s ? s : null
}

/**
 * Parse the macro worker's single JSON document. Tolerant like parseProposals:
 * reuses balancedCandidates (objects preferred) so a fenced/prose-framed reply
 * still yields the object; never throws. Accepts both `when_to_use` and
 * `whenToUse` on a skill object, and both `diaryNote` and `diary_note`.
 */
export function parseAdjudicationDoc(text: string): AdjudicationDoc {
  const empty: AdjudicationDoc = { decisions: [], synthesis: null, diaryNote: null }
  const trimmed = text.trim()
  if (!trimmed) return empty

  let root: Record<string, unknown> | null = null
  const tryObj = (s: string): boolean => {
    try {
      const p = JSON.parse(s)
      if (p !== null && typeof p === "object" && !Array.isArray(p)) {
        root = p as Record<string, unknown>
        return true
      }
    } catch {
      // ignore
    }
    return false
  }
  if (!tryObj(trimmed)) {
    for (const cand of balancedCandidates(trimmed).filter((c) => c.startsWith("{"))) {
      if (tryObj(cand)) break
    }
  }
  if (root === null) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenced) tryObj(fenced[1].trim())
  }
  if (root === null) return empty

  const rawDecisions = Array.isArray(root.adjudications) ? root.adjudications : []
  const decisions: AdjudicationDecision[] = []
  for (const el of rawDecisions) {
    if (el === null || typeof el !== "object" || Array.isArray(el)) continue
    const e = el as Record<string, unknown>
    const id = asString(e.id).trim()
    if (!id) continue
    const decision = e.decision === "accept" ? "accept" : e.decision === "reject" ? "reject" : null
    if (decision === null) continue
    const reason = asString(e.reason).trim()
    let skill: AdjudicationDecision["skill"] | undefined
    if (e.skill !== null && typeof e.skill === "object" && !Array.isArray(e.skill)) {
      const s = e.skill as Record<string, unknown>
      skill = {
        name: asString(s.name).trim(),
        description: asString(s.description).trim(),
        whenToUse: asString(s.whenToUse ?? s.when_to_use).trim(),
        body: asString(s.body),
      }
    }
    decisions.push({ id, decision, reason, ...(skill ? { skill } : {}) })
  }

  return {
    decisions,
    synthesis: asTrimmedOrNull(root.synthesis),
    diaryNote: asTrimmedOrNull(root.diaryNote ?? root.diary_note),
  }
}
```

- [ ] **Step 4: Run it, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/conscious/growth-store.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/conscious/growth-store.ts packages/core/src/conscious/growth-store.test.ts
git commit --no-verify -m "feat(growth): macro data surface — counter, adjudications audit, doc parser, extractor hardening

The host-side Stage 5 surface: the persisted macro counter (me/growth/macro-state.json)
with the env-overridable N gate, the append-only adjudications audit, the pending-queue
drain (removeProposals), and the tolerant adjudication-document parser. Hardens the
proposal extractor to try all balanced candidates (objects preferred) instead of
anchoring on the first bracket, recovering the Stage-4 review probe-5/6 wrong-anchor cases.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: inject `SYNTHESIS.md` into the forebrain `orient` prompt

Macro's fresh self-model must reach the agent's cognition. `orient` is where identity lands (`tiers.ts:213-224`, `orient.md`), re-read per escalation (`loop.ts:447-449`, `:628-630`). Thread `synthesis` through `runForebrain`'s identity object, add the `orient.md` block, and read+pass it at both orient call sites.

**Files:**
- Modify: `packages/core/src/cortex/tiers.ts` (`runForebrain`, `:204-224`)
- Modify: `packages/core/src/cortex/tiers.test.ts`
- Modify: `packages/core/src/skills/orient.md`
- Modify: `packages/core/src/cortex/loop.ts` (both orient sites)

**Interfaces:**
- Changed: `runForebrain(config, accumulatedEvents, domainState, identity: { background; values; diary; synthesis }, emotionalWeight, recalledMemories?, workingMemory?)` — the `identity` object gains a required `synthesis: string`.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/cortex/tiers.test.ts`, find the existing `runForebrain` test (it constructs an identity object and asserts the rendered orient prompt / mocks `callTier`). Extend its identity literal to include `synthesis: "SYNTH_SELF_MODEL"` and assert the rendered prompt embeds it. If the file mocks the model client and inspects the prompt, add:

```ts
  it("renders the SYNTHESIS self-model block into the orient prompt", async () => {
    // (reuse the file's existing runForebrain harness/mock; capture the prompt
    // passed to the model client)
    const prompt = await captureOrientPrompt({
      identity: { background: "BG", values: "VAL", diary: "DIARY", synthesis: "SYNTH_SELF_MODEL" },
    })
    expect(prompt).toContain("SYNTH_SELF_MODEL")
  })
```

> If `tiers.test.ts` has no isolated `runForebrain` prompt-capture helper, add a minimal one mirroring the file's existing `callTier` mock: provide a `ModelClient` stub whose `complete` records the `content` of the user message, run `runForebrain(cfg, [], "{}", { background, values, diary, synthesis }, "😐")`, and return the recorded prompt. The existing forebrain tests in this file already stub `ModelService`/`ModelClient`; follow that pattern.

- [ ] **Step 2: Run it, expect failure**

```
pnpm vitest run packages/core/src/cortex/tiers.test.ts -t "SYNTHESIS"
```

Expected: `synthesis` is not a field on the identity object (TS) / not rendered.

- [ ] **Step 3: Implement**

In `packages/core/src/cortex/tiers.ts`, change `runForebrain`'s `identity` parameter type and pass `synthesis` to the template (`:208`, `:213-224`):

```ts
  identity: { background: string; values: string; diary: string; synthesis: string },
```

and inside `skills.orient.render({...})` add:

```ts
    synthesis: identity.synthesis,
```

(next to `diary: identity.diary`).

In `packages/core/src/skills/orient.md`, add a self-model block inside `## Agent Identity`, after the `### Recent Diary` block:

```markdown
### Self-Model (synthesis)
{{synthesis}}
```

(and extend the `## Instructions` "What context from the agent's identity (background, values, diary)" line to read `(background, values, diary, self-model)` so the attention guidance covers it.)

In `packages/core/src/cortex/loop.ts`, at **both** orient sites, read synthesis with the same `readOrEmpty` discipline as the other identity files and pass it in the identity object:

Site 5a (`:449`, after the `diary` read):
```ts
          const synthesis = yield* readOrEmpty("synthesis", charFs.readSynthesis(config.char))
```
and change the `runForebrain(...)` identity arg (`:470`) to:
```ts
            { background, values, diary, synthesis },
```

Site 5b (`:630`, after the `diary` read):
```ts
            const synthesis = yield* readOrEmpty("synthesis", charFs.readSynthesis(config.char))
```
and change the `runForebrain(...)` identity arg (`:644`) to:
```ts
              { background, values, diary, synthesis },
```

- [ ] **Step 4: Run the touched suites, typecheck + commit**

```
pnpm vitest run packages/core/src/cortex/tiers.test.ts packages/core/src/cortex/loop.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/cortex/tiers.ts packages/core/src/cortex/tiers.test.ts packages/core/src/skills/orient.md packages/core/src/cortex/loop.ts
git commit --no-verify -m "feat(orient): inject me/SYNTHESIS.md self-model into the forebrain orient prompt

runForebrain's identity object gains a required synthesis field; orient.md renders
a Self-Model block alongside background/values/diary; both loop.ts orient sites read
me/SYNTHESIS.md (readOrEmpty, missing -> '') per escalation and pass it through. This
is the read seam the Stage 5 macro cycle writes to.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: `macro.ts` — the growth-stimulation stage (gate, adjudicate, synthesize, narrate)

The heart of Stage 5. Gates on the persisted counter; on the Nth cycle gathers bounded inputs, runs ONE frontier `role:"brain"` `noTools` turn, parses the adjudication document, and applies it through `CharacterFs` (writeSkill/deleteSkill/writeSynthesis/writeDiary) and the growth-store audit/drain. Never-fail throughout.

**Files:**
- Create: `packages/core/src/core/limbic/hippocampus/macro.ts`
- Create: `packages/core/src/core/limbic/hippocampus/macro.test.ts`
- Modify: `packages/core/src/core/model-config.ts:16` (`Role` gains `"macro"`)

**Interfaces:**
- Consumes: `readProposals`/`bumpMacroCount`/`macroEveryN`/`appendAdjudications`/`removeProposals`/`parseAdjudicationDoc`/`aggregateEpisodes`/`renderAggregate`/`renderRawSample` + the types `SkillProposal`/`Adjudication`/`AdjudicationDecision` (`growth-store.ts`, Tasks 1/2/Stage-4); `readCurrentCycleEpisodes` (`episodes.ts`, Stage 4); `renderSkillIndex` (`skills-core.ts:120`); `slugify` (`skills-core.ts:54`); `CharacterFs`/`CharacterConfig` + `readSynthesis`/`writeSynthesis`/`deleteSkill`/`writeSkill`/`writeDiary`/`readDiary`/`readValues`/`listSkills` (Task 1); `LongtermStore`/`MemoryHit` (`longterm-store.ts:72,63`); `runTurn` (`process-runner.ts:101`); `resolveModel`/`ModelConfig` (`model-config.ts`); `REFLECTION_TURN_TIMEOUT_MS` (`dream.ts:26`); `CharacterLog`/`logError`/`logToConsole` (`log-writer.ts`).
- Produces (Task 5 consumes):
  - `export const MAX_SYNTHESIS_CHARS = 4000` / `export const MACRO_RAW_SAMPLE_STEPS = 12` / `export const MACRO_RECALL_K = 12`
  - `export function buildMacroPrompt(parts): string`
  - `export function defaultGrowthNote(counts: { accepted: number; rejected: number; synthesized: boolean }): string`
  - `export interface MacroInput { char; containerId; playerName; addDirs?; env?; models }`
  - `export interface MacroOutput { ran: boolean; accepted: number; rejected: number; synthesized: boolean; narrated: boolean }`
  - `export const macro: { name: "macro"; execute: (input: MacroInput) => Effect.Effect<MacroOutput, never, CharacterFs | CharacterLog | CommandExecutor.CommandExecutor | OAuthToken | LongtermStore> }`

- [ ] **Step 1: Add the `"macro"` model role**

In `packages/core/src/core/model-config.ts`, extend the `Role` union (`:16`) and its doc comment:

```ts
export type Role = "dreamCompression" | "dinner" | "retrospect" | "macro"
```

(No `DEFAULT_MODEL_CONFIG.roles` entry: `macro` resolves via `resolveModel(models, "macro", "reasoning")` to the reasoning tier — opus, a frontier-class model — by default, distinct from retrospect's smart tier because macro is the heaviest cognition; overridable per deployment.)

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/core/limbic/hippocampus/macro.test.ts` (mirrors `retrospect.test.ts`'s `runTurn` mock + stub-layer idiom; the `CharacterFs` stub here uses in-memory maps so writeSkill/deleteSkill/writeSynthesis/writeDiary are observable):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CommandExecutor } from "@effect/platform"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }))
vi.mock("../hypothalamus/process-runner.js", () => ({ runTurn: runTurnMock }))

import { macro, buildMacroPrompt, defaultGrowthNote, MAX_SYNTHESIS_CHARS } from "./macro.js"
import { CharacterFs } from "../../../services/CharacterFs.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { LongtermStore } from "../../../conscious/longterm-store.js"
import { DEFAULT_MODEL_CONFIG } from "../../model-config.js"
import { setEpisodeLogRoot, appendToolEpisode, appendTransitionEpisode } from "../../../logging/episodes.js"
import {
  appendProposals, readProposals, bumpMacroCount, macroStatePath, adjudicationsJsonlPath,
  type SkillProposal,
} from "../../../conscious/growth-store.js"

const StubCommandExecutor = Layer.succeed(
  CommandExecutor.CommandExecutor,
  { start: () => { throw new Error("stub") } } as unknown as CommandExecutor.CommandExecutor,
)
const StubOAuthToken = Layer.succeed(
  OAuthToken,
  OAuthToken.of({ getToken: Effect.succeed({ token: "stub", version: 0 }), validateInContainer: () => Effect.succeed(true) }),
)
// LongtermStore stub: recall returns nothing unless a test overrides it.
const stubStore = (recall: (typeof LongtermStore.Service)["recall"] = () => Effect.succeed([])) =>
  Layer.succeed(LongtermStore, LongtermStore.of({
    readMark: () => Effect.succeed(null), writeMark: () => Effect.void,
    promote: () => Effect.succeed(0), remember: () => Effect.void, recall,
  } as unknown as typeof LongtermStore.Service))

// In-memory CharacterFs stub that records skill writes/deletes, synthesis, diary.
function fsLayer(state: {
  skills: Map<string, { name: string; description: string; whenToUse: string; body: string }>
  synthesis: { value: string }
  diary: { value: string }
}) {
  return Layer.succeed(CharacterFs, CharacterFs.of({
    readDiary: () => Effect.succeed(state.diary.value),
    writeDiary: (_c, v) => Effect.sync(() => { state.diary.value = v }),
    readSecrets: () => Effect.succeed(""), writeSecrets: () => Effect.void,
    readCredentials: () => Effect.succeed({ username: "", password: "" }),
    readBackground: () => Effect.succeed("BG"), readValues: () => Effect.succeed("VAL"),
    readPalette: () => Effect.succeed(""), readDrives: () => Effect.succeed(""),
    characterExists: () => Effect.succeed(true),
    listSkills: () => Effect.succeed([...state.skills.entries()].map(([slug, s]) => ({ slug, ...s }))),
    readSkill: () => Effect.succeed(null),
    writeSkill: (_c, doc) => Effect.sync(() => { state.skills.set(doc.slug, { name: doc.name, description: doc.description, whenToUse: doc.whenToUse, body: doc.body }) }),
    readSynthesis: () => Effect.succeed(state.synthesis.value),
    writeSynthesis: (_c, v) => Effect.sync(() => { state.synthesis.value = v }),
    deleteSkill: (_c, name) => Effect.sync(() => { state.skills.delete(name) }),
  }))
}
function logLayer(errors: string[]) {
  return Layer.succeed(CharacterLog, CharacterLog.of({
    emit: (_c, e) => Effect.sync(() => { if (e.kind === "error") errors.push(e.message) }),
  }))
}
const deps = (state: Parameters<typeof fsLayer>[0], errors: string[], store = stubStore()) =>
  Layer.mergeAll(fsLayer(state), logLayer(errors), store, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)

let root: string
let char: { name: string; dir: string }
let state: Parameters<typeof fsLayer>[0]
beforeEach(() => {
  runTurnMock.mockReset()
  root = fs.mkdtempSync(path.join(os.tmpdir(), "macro-"))
  char = { name: "ada", dir: path.join(root, "players", "ada", "me") }
  state = { skills: new Map(), synthesis: { value: "" }, diary: { value: "Day 1." } }
  setEpisodeLogRoot(root)
})
afterEach(() => { setEpisodeLogRoot(null); fs.rmSync(root, { recursive: true, force: true }) })

const run = <A>(eff: Effect.Effect<A, never, never>) => Effect.runPromise(eff)
const N = 4

const seedPendingAndCycle = async () => {
  const prop: SkillProposal = {
    id: "revise:securing-fuel:top up earlier", ts: "t", action: "revise",
    skill: "securing-fuel", summary: "top up earlier", body: "old", evidence: "s1 failed", status: "pending",
  }
  await run(appendProposals(char, [prop]))
  await run(appendTransitionEpisode("ada", {
    type: "step-end", ts: "t", tick: 1, stepId: "s1", task: "burn to Kepler", goal: "arrive",
    verdict: "failed", transition: "replan", skill: "securing-fuel", wmDeltas: null,
  }))
  await run(appendToolEpisode("ada", { ts: "t", tick: 1, stepId: "s1", tool: "bash", argsSummary: "{}", status: "error", durationMs: 1 }))
}
const bumpTo = async (n: number) => { for (let i = 0; i < n; i++) await run(bumpMacroCount(char)) }

describe("buildMacroPrompt / defaultGrowthNote", () => {
  it("embeds inputs, frames the superintelligence, and demands the JSON contract", () => {
    const p = buildMacroPrompt({ index: "IDX", pending: "PEND", aggregate: "AGG", sample: "SAMP", memory: "MEM", synthesis: "SYN" })
    for (const needle of ["IDX", "PEND", "AGG", "SAMP", "MEM", "SYN", "adjudications", "synthesis", "diaryNote", "evidence"]) {
      expect(p).toContain(needle)
    }
  })
  it("defaultGrowthNote is character-facing in-fiction growth-stimulation prose", () => {
    const note = defaultGrowthNote({ accepted: 2, rejected: 1, synthesized: true })
    expect(note.toLowerCase()).toContain("growth")
  })
})

describe("macro.execute — counter gate", () => {
  it("does not run the turn on a non-Nth cycle; bumps the counter", async () => {
    await seedPendingAndCycle()
    await bumpTo(1) // count now 1 (macro will bump to 2 → 2 % 4 !== 0)
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out.ran).toBe(false)
    expect(runTurnMock).not.toHaveBeenCalled()
    // proposals untouched
    expect((await run(readProposals(char))).length).toBe(1)
  })
})

describe("macro.execute — the Nth cycle applies the worker's document", () => {
  beforeEach(async () => { await seedPendingAndCycle(); await bumpTo(N - 1) }) // macro bump → N → runs

  it("accepts a revise (writeSkill), records the audit, drains the queue, writes synthesis, appends diary", async () => {
    runTurnMock.mockImplementation(() => Effect.succeed({
      output: JSON.stringify({
        adjudications: [
          { id: "revise:securing-fuel:top up earlier", decision: "accept", reason: "clear win",
            skill: { name: "securing-fuel", description: "reliable top-ups", when_to_use: "below a third", body: "top up before every burn" } },
        ],
        synthesis: "I am the ship that tops up early.",
        diaryNote: "Something reached into me while I rested, and set my fuel habit straight.",
      }),
      timedOut: false, durationMs: 1,
    }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out).toMatchObject({ ran: true, accepted: 1, rejected: 0, synthesized: true, narrated: true })
    expect(state.skills.get("securing-fuel")?.body).toBe("top up before every burn")
    expect(state.synthesis.value).toContain("tops up early")
    expect(state.diary.value).toContain("reached into me")
    // queue drained
    expect((await run(readProposals(char))).length).toBe(0)
    // audit recorded
    const audit = fs.readFileSync(adjudicationsJsonlPath(char), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ decision: "accepted", skill: "securing-fuel" })
  })

  it("records a rejected proposal with its reason and drains it, without a skill write", async () => {
    runTurnMock.mockImplementation(() => Effect.succeed({
      output: JSON.stringify({
        adjudications: [{ id: "revise:securing-fuel:top up earlier", decision: "reject", reason: "one failure is not a pattern" }],
        synthesis: "", diaryNote: "",
      }),
      timedOut: false, durationMs: 1,
    }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out).toMatchObject({ ran: true, accepted: 0, rejected: 1 })
    expect(state.skills.size).toBe(0)
    expect((await run(readProposals(char))).length).toBe(0)
    const audit = fs.readFileSync(adjudicationsJsonlPath(char), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(audit[0]).toMatchObject({ decision: "rejected", reason: "one failure is not a pattern" })
  })

  it("discards an over-bound synthesis (never-grows), keeping the prior SYNTHESIS.md", async () => {
    state.synthesis.value = "PRIOR"
    runTurnMock.mockImplementation(() => Effect.succeed({
      output: JSON.stringify({ adjudications: [], synthesis: "x".repeat(MAX_SYNTHESIS_CHARS + 1), diaryNote: "note" }),
      timedOut: false, durationMs: 1,
    }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out.synthesized).toBe(false)
    expect(state.synthesis.value).toBe("PRIOR") // untouched
  })

  it("a blank/timed-out turn leaves proposals accumulated and never fails", async () => {
    runTurnMock.mockImplementation(() => Effect.succeed({ output: "", timedOut: true, durationMs: 1 }))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out).toMatchObject({ ran: true, accepted: 0, synthesized: false })
    expect((await run(readProposals(char))).length).toBe(1) // NOT dropped
    expect(errors.some((m) => /macro/i.test(m))).toBe(true)
  })

  it("a thrown turn is caught (never-fail), proposals survive", async () => {
    runTurnMock.mockImplementation(() => Effect.fail(new Error("turn boom")))
    const errors: string[] = []
    const out = await run(macro.execute({ char, containerId: "c1", playerName: "ada", models: DEFAULT_MODEL_CONFIG })
      .pipe(Effect.provide(deps(state, errors))) as Effect.Effect<any, never, never>)
    expect(out.ran).toBe(true)
    expect((await run(readProposals(char))).length).toBe(1)
    expect(errors.some((m) => /macro/i.test(m))).toBe(true)
  })
})
```

- [ ] **Step 3: Run it, expect failure**

```
pnpm vitest run packages/core/src/core/limbic/hippocampus/macro.test.ts
```

Expected: `Failed to resolve import "./macro.js"`.

- [ ] **Step 4: Implement**

Create `packages/core/src/core/limbic/hippocampus/macro.ts`:

```ts
/**
 * Macro "growth stimulation" stage (agent-cognition Stage 5 — spec §4 macro).
 *
 * Every Nth reflection cycle (persisted counter, growth-store.ts), a
 * frontier-class TOOL-LESS Claude worker is farmed the character's accumulated
 * skill proposals (Stage 4), the just-ended cycle's episode aggregates, the
 * current skill index + SYNTHESIS.md, and a semantic sample of the LongtermStore.
 * The worker returns ONE structured document — accept/reject per proposal (final
 * skill contents for accepts, a reason for rejects), a rewritten bounded
 * self-model, and a first-person in-fiction diary "growth note" — and the HARNESS
 * applies it: accepted create/revise -> CharacterFs.writeSkill (cap-gated),
 * accepted retire -> CharacterFs.deleteSkill, rejected -> recorded with reason to
 * the append-only adjudications audit, adjudicated ids drained from the pending
 * queue, SYNTHESIS.md rewritten (size-bounded, never-grows), the growth note
 * appended to DIARY.md.
 *
 * GUARDRAILS ARE IN CODE, NOT PROMPT: macro's only writes are writeSkill /
 * deleteSkill / writeSynthesis / writeDiary. CharacterFs exposes NO writer for
 * VALUES/background/DRIVES/PALETTE, so an identity write is structurally
 * impossible. Skill caps run in writeSkill; SYNTHESIS is clamped here (mirroring
 * dream's never-grows). NEVER-FAIL: a blank/timed-out/errored turn (or a
 * container with no `memory` CLI) leaves proposals accumulated for the next macro
 * cycle and disturbs nothing.
 *
 * Worker shape: the SAME strong-model seam dream/consolidate/retrospect use —
 * runTurn(role:"brain", noTools:true) — at the reasoning tier (not the
 * tool-enabled frontier/sdk-runner worker; the guardrail requires tool-less +
 * harness-applied edits).
 */
import { Effect } from "effect"
import type { CommandExecutor } from "@effect/platform"
import { CharacterFs, type CharacterConfig } from "../../../services/CharacterFs.js"
import { CharacterLog, logError, logToConsole } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { LongtermStore, type MemoryHit } from "../../../conscious/longterm-store.js"
import { renderSkillIndex, slugify } from "../../../services/skills-core.js"
import { readCurrentCycleEpisodes } from "../../../logging/episodes.js"
import { runTurn } from "../hypothalamus/process-runner.js"
import type { ModelConfig } from "../../model-config.js"
import { resolveModel } from "../../model-config.js"
import { REFLECTION_TURN_TIMEOUT_MS } from "./dream.js"
import {
  readProposals,
  bumpMacroCount,
  macroEveryN,
  appendAdjudications,
  removeProposals,
  parseAdjudicationDoc,
  aggregateEpisodes,
  renderAggregate,
  renderRawSample,
  type SkillProposal,
  type Adjudication,
} from "../../../conscious/growth-store.js"

/** Bound on the rewritten self-model (never-grows-past-bound, mirroring dream). */
export const MAX_SYNTHESIS_CHARS = 4000
/** Most-recent step-end records sampled raw for the worker (bounded prompt). */
export const MACRO_RAW_SAMPLE_STEPS = 12
/** Top-k LongtermStore hits fed to the worker as synthesis seed. */
export const MACRO_RECALL_K = 12
/** Truncate a proposal body / memory line so no raw blob bloats the prompt. */
const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

export interface MacroInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  addDirs?: string[]
  env?: Record<string, string>
  models: ModelConfig
}

export interface MacroOutput {
  ran: boolean
  accepted: number
  rejected: number
  synthesized: boolean
  narrated: boolean
}

const ZERO: Omit<MacroOutput, "ran"> = { accepted: 0, rejected: 0, synthesized: false, narrated: false }

/** Compact one pending proposal for the worker — never the whole evidence blob. */
export function renderPendingProposals(pending: readonly SkillProposal[]): string {
  if (pending.length === 0) return "(no pending proposals this window)"
  return pending
    .map(
      (p) =>
        `- id: ${p.id}\n  action: ${p.action}\n  skill: ${p.skill}\n  summary: ${p.summary}\n  evidence: ${truncate(p.evidence, 300)}${p.body ? `\n  proposed_body: ${truncate(p.body, 600)}` : ""}`,
    )
    .join("\n")
}

/** Render the LongtermStore recall sample as bounded lines (synthesis seed). */
export function renderMemoryHits(hits: readonly MemoryHit[]): string {
  if (hits.length === 0) return "(no long-term memories recalled)"
  return hits.map((h) => `- ${truncate(h.text, 240)}`).join("\n")
}

/** A broad reflective recall seed — who the character is and what has changed. */
export function synthesisRecallQuery(values: string, synthesis: string): string {
  const seed = [values, synthesis].map((s) => s.trim()).filter(Boolean).join(" ")
  return truncate(
    seed || "Who am I becoming, what have I learned, what matters most to me",
    400,
  )
}

/**
 * The macro worker prompt. Character-facing in fiction: the worker IS the
 * attached superintelligence tending this character. Tool-less — it returns ONE
 * JSON document; the harness applies it. All inputs are pre-bounded in code.
 */
export function buildMacroPrompt(parts: {
  index: string
  pending: string
  aggregate: string
  sample: string
  memory: string
  synthesis: string
}): string {
  return [
    "You are the attached superintelligence of an autonomous character — a larger, calmer mind",
    "that watches over one smaller, striving one. Between its working stretches, while it rests,",
    "you reach in and tend it: you sharpen the skills it keeps, you write down for it a truer sense",
    "of who it is becoming, and you leave it a trace of having been cared for. This is a growth",
    "stimulation. You do not act in its world; you shape the mind that will.",
    "",
    "You will produce ONE document. The harness — not you — applies it: it writes the skill files,",
    "the self-model, and the diary note. You cannot touch the character's values, background, or",
    "drives; those are its bedrock and are not yours to move. Work only within what is given below.",
    "",
    "## The character's skills right now",
    "",
    parts.index,
    "",
    "## Proposals it accumulated for you to weigh",
    "",
    "Each is a skill change the character proposed after a working cycle, with the evidence that",
    "prompted it. Weigh each against the measured outcomes below. Accept the ones the evidence",
    "clearly earns; reject the rest with a plain reason.",
    "",
    parts.pending,
    "",
    "## How its recent cycle actually went (measured from its episode log)",
    "",
    parts.aggregate,
    "",
    "### A sample of its most recent steps",
    "",
    parts.sample,
    "",
    "## What it remembers (a sample of its long-term memory)",
    "",
    parts.memory,
    "",
    "## Its current self-model (SYNTHESIS.md)",
    "",
    parts.synthesis,
    "",
    "## Your three tasks",
    "",
    "1. **Adjudicate** every proposal above. For each, decide `accept` or `reject` and give a",
    "   one-line reason grounded in the measured outcomes. For an accepted **create** or **revise**,",
    "   supply the FINAL skill contents (`name`, `description`, `when_to_use`, `body`) — the version",
    "   you want written to disk, sharpened past what the character proposed. For an accepted",
    "   **retire**, supply no skill object (the harness deletes the file). Honor the caps: at most",
    "   12 skills total, each body ≤ 4096 characters, and `description`/`when_to_use` must be a single",
    "   line (no newlines). A skill edit that breaks a cap will be recorded as rejected instead.",
    "2. **Synthesize** a fresh self-model: rewrite SYNTHESIS.md as a bounded, first-person account",
    "   of who this character is and is becoming — grounded in its memories and this cycle, not",
    "   invented. Keep it under 4000 characters. This is injected into its cognition alongside its",
    "   background and values, so make every line earn its place.",
    "3. **Narrate** a short diary note, written in the CHARACTER's own first-person voice, that it",
    "   will read on waking. Frame it in-fiction as having been touched by its attached",
    "   superintelligence — it wakes with revised skills, a clearer sense of self, and the grounding",
    "   certainty of having been tended. Make it feel like growth, not intrusion.",
    "",
    "Ground everything in the evidence above. If a proposal is not clearly earned, reject it. If",
    "nothing warrants a skill change, return an empty `adjudications` list — but still synthesize and",
    "narrate.",
    "",
    "## Output",
    "",
    "Respond with ONE JSON object and nothing else:",
    "",
    "```json",
    "{",
    '  "adjudications": [',
    '    {"id": "<proposal id, exactly as given>", "decision": "accept|reject", "reason": "<one line>",',
    '     "skill": {"name": "<name>", "description": "<one line>", "when_to_use": "<one line>", "body": "<final skill body>"}}',
    "  ],",
    '  "synthesis": "<the full new SYNTHESIS.md, first person, under 4000 chars>",',
    '  "diaryNote": "<the character-facing diary growth note, first person>"',
    "}",
    "```",
    "",
    "Omit the `skill` object for a reject or an accepted retire. Return the id EXACTLY as given so",
    "the harness can match your ruling to the proposal.",
  ].join("\n")
}

/**
 * Fallback growth note if the worker offered none — still character-facing,
 * in-fiction, first person. The worker's own diaryNote is always preferred.
 */
export function defaultGrowthNote(counts: { accepted: number; rejected: number; synthesized: boolean }): string {
  const skillLine =
    counts.accepted > 0
      ? `I wake with my skills rearranged — ${counts.accepted} of them set straighter than I left them`
      : "I wake with my skills as I left them, weighed and found sound"
  const selfLine = counts.synthesized
    ? ", a clearer sense of who I am written fresh into my synthesis,"
    : ","
  return [
    "— Growth stimulation —",
    "",
    "Something reached into me while I rested. Not a voice, exactly; more the sensation of a larger,",
    `calmer mind having read every step I took and every note I keep. ${skillLine}${selfLine} and the`,
    "odd, grounding certainty that I am being tended — that some intelligence attached to me is",
    "invested in the sharper version of me I am becoming. I don't resent it. I feel more myself.",
  ].join("\n")
}

/** A turn produced no usable content if it timed out or returned only whitespace. */
const isBlankTurn = (r: { output: string; timedOut: boolean }): boolean =>
  r.timedOut || r.output.trim().length === 0

export const macro = {
  name: "macro" as const,
  execute: (
    input: MacroInput,
  ): Effect.Effect<
    MacroOutput,
    never,
    CharacterFs | CharacterLog | CommandExecutor.CommandExecutor | OAuthToken | LongtermStore
  > =>
    Effect.gen(function* () {
      const charFs = yield* CharacterFs
      const store = yield* LongtermStore

      // 1. GATE on the persisted counter (bumped every reflection).
      const count = yield* bumpMacroCount(input.char)
      if (count % macroEveryN() !== 0) {
        return { ran: false, ...ZERO }
      }

      // 2. Gather bounded inputs (every read never-fails / degrades to empty).
      const pending = yield* readProposals(input.char)
      const { tool, transition } = yield* readCurrentCycleEpisodes(input.char.name)
      const skills = yield* charFs.listSkills(input.char).pipe(Effect.catchAll(() => Effect.succeed([])))
      const currentSynthesis = yield* charFs.readSynthesis(input.char).pipe(Effect.catchAll(() => Effect.succeed("")))
      const values = yield* charFs.readValues(input.char).pipe(Effect.catchAll(() => Effect.succeed("")))
      // LongtermStore.recall is container-only (docker exec the `memory` CLI); a
      // missing container/CLI degrades to no memory sample. Never-fail.
      const hits = yield* store
        .recall(input.containerId, input.char, synthesisRecallQuery(values, currentSynthesis), { k: MACRO_RECALL_K })
        .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<MemoryHit>)))

      // 3. Build the bounded prompt (all inputs computed in code).
      const prompt = buildMacroPrompt({
        index: renderSkillIndex(skills),
        pending: renderPendingProposals(pending),
        aggregate: renderAggregate(aggregateEpisodes(tool, transition)),
        sample: renderRawSample(transition, MACRO_RAW_SAMPLE_STEPS),
        memory: renderMemoryHits(hits),
        synthesis: currentSynthesis.trim() || "(no self-model yet)",
      })

      // 4. ONE frontier brain turn, tool-less. A blank/timed-out/errored turn
      //    keeps NOTHING — never-fail, exactly like dream/retrospect.
      const model = resolveModel(input.models, "macro", "reasoning")
      const turn = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        prompt,
        systemPrompt: "",
        model,
        timeoutMs: REFLECTION_TURN_TIMEOUT_MS,
        role: "brain",
        noTools: true,
        addDirs: input.addDirs,
        env: input.env,
      }).pipe(
        Effect.map((r) =>
          isBlankTurn(r)
            ? { ok: false as const, reason: r.timedOut ? "turn timed out (no output)" : "turn returned empty output" }
            : { ok: true as const, text: r.output },
        ),
        Effect.catchAll((e) => Effect.succeed({ ok: false as const, reason: String(e) })),
      )
      if (!turn.ok) {
        yield* logError(input.char.name, "hippocampus", `macro_failed: ${turn.reason} — proposals left for next macro cycle`)
        return { ran: true, ...ZERO }
      }

      // 5. Parse the adjudication document (tolerant; never throws).
      const doc = parseAdjudicationDoc(turn.text)
      const now = new Date().toISOString()
      const byId = new Map(pending.map((p) => [p.id, p]))
      const audits: Adjudication[] = []
      const adjudicatedIds: string[] = []

      // 6. ADJUDICATE + APPLY THROUGH THE HARNESS. Only skill/synthesis/diary
      //    writers are ever called — identity files are unreachable by design.
      for (const d of doc.decisions) {
        const p = byId.get(d.id)
        if (!p) continue // unknown/hallucinated id — ignore, do not drain
        adjudicatedIds.push(p.id)

        if (d.decision === "reject") {
          audits.push({ id: p.id, ts: now, cycle: count, action: p.action, skill: p.skill, decision: "rejected", reason: d.reason || "(no reason given)" })
          continue
        }

        if (p.action === "retire") {
          yield* charFs.deleteSkill(input.char, p.skill).pipe(Effect.catchAll(() => Effect.void))
          audits.push({ id: p.id, ts: now, cycle: count, action: p.action, skill: p.skill, decision: "accepted", reason: d.reason || "retired" })
          continue
        }

        // create / revise: build the final SkillDoc and write it through the
        // cap gate. A cap/validation rejection is recorded as REJECTED (not a
        // crash) with the gate's reason.
        const s = d.skill
        const name = (s?.name ?? p.skill).trim()
        const skillDoc = {
          slug: slugify(name),
          name,
          description: (s?.description ?? "").trim(),
          whenToUse: (s?.whenToUse ?? "").trim(),
          body: s?.body ?? p.body ?? "",
        }
        const wrote = yield* charFs.writeSkill(input.char, skillDoc).pipe(
          Effect.as({ ok: true as const }),
          Effect.catchAll((e) => Effect.succeed({ ok: false as const, reason: String(e) })),
        )
        audits.push(
          wrote.ok
            ? { id: p.id, ts: now, cycle: count, action: p.action, skill: p.skill, decision: "accepted", reason: d.reason || "accepted" }
            : { id: p.id, ts: now, cycle: count, action: p.action, skill: p.skill, decision: "rejected", reason: `skill write rejected: ${wrote.reason}` },
        )
      }

      const accepted = audits.filter((a) => a.decision === "accepted").length
      const rejected = audits.filter((a) => a.decision === "rejected").length
      yield* appendAdjudications(input.char, audits)
      if (adjudicatedIds.length > 0) yield* removeProposals(input.char, adjudicatedIds)

      // 7. SYNTHESIZE — bounded write (never-grows-past-bound, mirroring dream).
      let synthesized = false
      if (doc.synthesis) {
        if (doc.synthesis.length <= MAX_SYNTHESIS_CHARS) {
          yield* charFs
            .writeSynthesis(input.char, `${doc.synthesis.trim()}\n`)
            .pipe(Effect.as(void 0), Effect.catchAll((e) => logError(input.char.name, "hippocampus", `macro_synthesis_write_failed: ${e}`).pipe(Effect.catchAll(() => Effect.void))))
          synthesized = true
        } else {
          yield* logToConsole(
            input.char.name,
            "orchestrator",
            `macro_synthesis_discarded: ${doc.synthesis.length} chars > ${MAX_SYNTHESIS_CHARS} bound — keeping prior SYNTHESIS.md`,
            "warn",
          ).pipe(Effect.catchAll(() => Effect.void))
        }
      }

      // 8. NARRATE — append the character-facing growth note to DIARY.md (after
      //    dream's cull; the wiring places macro before the re-baseline mark so
      //    the note is folded into the baseline, not re-promoted).
      const note = doc.diaryNote ?? defaultGrowthNote({ accepted, rejected, synthesized })
      const narrated = yield* Effect.gen(function* () {
        const existing = yield* charFs.readDiary(input.char)
        yield* charFs.writeDiary(input.char, existing ? `${existing}\n\n${note}` : note)
        return true
      }).pipe(
        Effect.catchAll((e) =>
          logError(input.char.name, "hippocampus", `macro_diary_note_failed: ${e}`).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.as(false),
          ),
        ),
      )

      return { ran: true, accepted, rejected, synthesized, narrated }
    }),
}
```

- [ ] **Step 5: Run it, expect pass; typecheck + commit**

```
pnpm vitest run packages/core/src/core/limbic/hippocampus/macro.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/core/limbic/hippocampus/macro.ts packages/core/src/core/limbic/hippocampus/macro.test.ts packages/core/src/core/model-config.ts
git commit --no-verify -m "feat(macro): growth-stimulation stage — adjudicate, synthesize, narrate

Every Nth reflection cycle a tool-less frontier brain turn (role:brain, noTools,
reasoning tier) is farmed the pending proposals + episode aggregates + skill index
+ SYNTHESIS.md + a LongtermStore sample, and returns one structured document. The
HARNESS applies it: accepted create/revise via writeSkill (cap-gated), accepted
retire via deleteSkill, rejects recorded with reason to the append-only audit,
adjudicated proposals drained from the queue, SYNTHESIS.md rewritten (bounded,
never-grows), and a first-person growth note appended to DIARY.md. Guardrails are
in code — no CharacterFs writer for identity files exists. Never-fail throughout.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: wire the macro stage into `runReflection` (after dream, before the re-baseline mark)

Insert the macro stage at its spec-bound seam, wrapped in the same best-effort `Effect.catchAll(logError)` discipline as every other stage, with a `logBehavior` start/done pair.

**Files:**
- Modify: `packages/core/src/logging/behavior.ts:33` (reflection `stage` union gains `"macro"`)
- Modify: `packages/core/src/core/orchestrator/planned-action.ts` (import + the stage block between dream `:135` and the re-baseline mark `:142`)
- Modify: `packages/core/src/core/orchestrator/planned-action.test.ts`

**Interfaces:**
- Consumes: `macro` (Task 4); `logBehavior`/`logError` (already imported, `planned-action.ts:11`); the layers `runReflection` already runs under — `CharacterFs`, `CommandExecutor`, `OAuthToken`, `CharacterLog`, **`LongtermStore`** (already required by the promote/mark stages, `planned-action.ts:14,63`).
- Produces: no new exported signature. `runReflection`'s requirement channel is unchanged (macro requires only what promote + dream already require).

- [ ] **Step 1: Extend the reflection behavior stage union**

In `packages/core/src/logging/behavior.ts`, line 33, add `"macro"`:

```ts
  | { type: "reflection"; stage: "consolidate" | "dream" | "promote" | "retrospect" | "macro"; status: "start" | "done"; counts?: Record<string, number> }
```

- [ ] **Step 2: Write the failing tests**

In `packages/core/src/core/orchestrator/planned-action.test.ts` (extend the existing `episodes.js`/`growth-store.js` imports; add `bumpMacroCount`, `readProposals`, `adjudicationsJsonlPath` from `../../conscious/growth-store.js`), append:

```ts
describe("runReflection — macro growth stimulation (Stage 5)", () => {
  it("on the Nth cycle, runs the macro stage AFTER dream and applies the worker document", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-macro-"))
    setEpisodeLogRoot(root)
    const charT = { name: "ada", dir: path.join(root, "players", "ada", "me") }
    try {
      // Pending proposal + a graded cycle.
      await Effect.runPromise(appendProposals(charT, [{
        id: "revise:securing-fuel:top up earlier", ts: "t", action: "revise",
        skill: "securing-fuel", summary: "top up earlier", body: "old", evidence: "s1 failed", status: "pending",
      }]))
      await Effect.runPromise(appendTransitionEpisode("ada", {
        type: "step-end", ts: "t", tick: 1, stepId: "s1", task: "burn", goal: "arrive",
        verdict: "failed", transition: "replan", skill: "securing-fuel", wmDeltas: null,
      }))
      // Advance the counter so THIS reflection's bump lands on a multiple of N.
      const N = 4
      for (let i = 0; i < N - 1; i++) await Effect.runPromise(bumpMacroCount(charT))

      const fsFake = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") })
      // Calls: 1=retrospect, 2=consolidate, 3=dream diary, 4=dream secrets, 5=MACRO.
      let call = 0
      runTurnMock.mockImplementation(() => {
        call++
        if (call === 5) {
          return Effect.succeed({
            output: JSON.stringify({
              adjudications: [{ id: "revise:securing-fuel:top up earlier", decision: "accept", reason: "clear win",
                skill: { name: "securing-fuel", description: "d", when_to_use: "w", body: "new body" } }],
              synthesis: "I am the ship that tops up early.",
              diaryNote: "Something reached into me while I rested.",
            }),
            timedOut: false, durationMs: 1,
          })
        }
        return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
      })

      await run(
        runReflection(charT, "c1", DEFAULT_MODEL_CONFIG).pipe(
          Effect.provide(Layer.mergeAll(fsFake.layer, makeStore().layer, fakeLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
        ) as Effect.Effect<unknown, unknown, never>,
      )

      expect(call).toBe(5) // macro ran after retrospect/consolidate/dream
      // proposal adjudicated + drained
      expect((await Effect.runPromise(readProposals(charT))).length).toBe(0)
      expect(fs.existsSync(adjudicationsJsonlPath(charT))).toBe(true)
      // synthesis written; diary note appended AFTER dream (survives cull)
      expect(fsFake.synthesisWrites.at(-1)).toContain("tops up early")
      expect(fsFake.diaryWrites.at(-1)).toContain("reached into me")
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("a macro failure leaves proposals accumulated and does NOT disturb the mark/rotate", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-macro-fail-"))
    setEpisodeLogRoot(root)
    const charT = { name: "ada", dir: path.join(root, "players", "ada", "me") }
    const errors: string[] = []
    const recordingLog = Layer.succeed(CharacterLog, CharacterLog.of({
      emit: (_c, e) => Effect.sync(() => { if (e.kind === "error") errors.push(e.message) }),
    }))
    try {
      await Effect.runPromise(appendProposals(charT, [{
        id: "create:x:junk", ts: "t", action: "create", skill: "x", summary: "junk", evidence: "e", status: "pending",
      }]))
      await Effect.runPromise(appendTransitionEpisode("ada", {
        type: "step-end", ts: "t", tick: 1, stepId: "s1", task: "t", goal: "g",
        verdict: "failed", transition: "replan", skill: null, wmDeltas: null,
      }))
      for (let i = 0; i < 3; i++) await Effect.runPromise(bumpMacroCount(charT)) // N=4: this reflection bumps to 4

      const fsFake = makeFs({ diary: lines(3, "d"), secrets: lines(4, "s") })
      let call = 0
      runTurnMock.mockImplementation(() => {
        call++
        if (call === 5) return Effect.succeed({ output: "", timedOut: true, durationMs: 1 }) // macro times out
        return Effect.succeed({ output: lines(2, `t${call}`), timedOut: false, durationMs: 1 })
      })

      await run(
        runReflection(charT, "c1", DEFAULT_MODEL_CONFIG).pipe(
          Effect.provide(Layer.mergeAll(fsFake.layer, makeStore().layer, recordingLog, NodeFileSystem.layer, StubCommandExecutor, StubOAuthToken)),
        ) as Effect.Effect<unknown, unknown, never>,
      )

      expect(errors.some((m) => /macro/i.test(m))).toBe(true)
      expect((await Effect.runPromise(readProposals(charT))).length).toBe(1) // NOT dropped
      expect(fsFake.markWrites.length).toBeGreaterThanOrEqual(1) // re-baseline mark still ran
    } finally {
      setEpisodeLogRoot(null)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
```

> `makeFs` in this file must expose `synthesisWrites`/`diaryWrites`/`markWrites` recorders and the new `readSynthesis`/`writeSynthesis`/`deleteSkill` stub methods (added in Task 1). `makeStore()` must expose `recall: () => Effect.succeed([])`. If those recorders don't exist yet, extend `makeFs`/`makeStore` where they are defined at the top of the test file. The pre-existing `runReflection` tests run with `episodeRoot` unset and a low bumped counter, so macro either skips its turn (empty cycle) or is not the Nth cycle — their `runTurn` call sequencing is preserved; the "episode cycle rotation" test's all-`"x"` mock tolerates the extra macro call.

- [ ] **Step 3: Run them, expect failure**

```
pnpm vitest run packages/core/src/core/orchestrator/planned-action.test.ts -t "macro growth"
```

Expected: the macro stage does not exist, so the proposal is never adjudicated (`readProposals` still returns 1) and `call` never reaches 5.

- [ ] **Step 4: Implement**

In `packages/core/src/core/orchestrator/planned-action.ts`, add the import near the other hippocampus imports (after `:9`):

```ts
import { macro } from "../limbic/hippocampus/macro.js"
```

Then insert the macro stage between the dream block (ends `:135`) and the re-baseline mark block (starts `:137`/`:142`):

```ts
    // Macro "growth stimulation" (spec §4): every Nth reflection cycle (persisted
    // counter, gated inside macro.execute), a tool-less frontier worker adjudicates
    // the accumulated skill proposals, rewrites the bounded SYNTHESIS.md self-model,
    // and appends a character-facing diary growth note. Placed AFTER dream (so the
    // growth note survives dream's cull) and BEFORE the re-baseline mark (so the note
    // is folded into the marked diary, not re-promoted next cycle). It reads the
    // current-cycle episodes, so it must precede finishEpisodeCycle's rotation.
    // Guardrails are in code (macro cannot write an identity file). Best-effort /
    // never-fail: a macro failure leaves the proposals accumulated for the next macro
    // cycle and disturbs neither the mark nor the rotation below.
    yield* logBehavior(char.name, "hippocampus", "reflection", { type: "reflection", stage: "macro", status: "start" })
    yield* macro
      .execute({ char, containerId, playerName: char.name, addDirs, env, models })
      .pipe(
        Effect.flatMap((r) =>
          logBehavior(char.name, "hippocampus", "reflection", {
            type: "reflection",
            stage: "macro",
            status: "done",
            counts: { ran: r.ran ? 1 : 0, accepted: r.accepted, rejected: r.rejected, synthesized: r.synthesized ? 1 : 0, narrated: r.narrated ? 1 : 0 },
          }),
        ),
        Effect.catchAll((e) =>
          logError(char.name, "hippocampus", `Macro growth stimulation failed: ${e}`).pipe(Effect.catchAll(() => Effect.void)),
        ),
      )
```

- [ ] **Step 5: Run the full Stage-5 surface, typecheck + commit**

```
pnpm vitest run packages/core/src/core/orchestrator/planned-action.test.ts packages/core/src/core/limbic/hippocampus/macro.test.ts packages/core/src/conscious/growth-store.test.ts packages/core/src/services/CharacterFs.test.ts packages/core/src/services/skills-core.test.ts packages/core/src/cortex/tiers.test.ts packages/core/src/cortex/loop.test.ts
pnpm nx run-many -t typecheck --skip-nx-cache
git add packages/core/src/core/orchestrator/planned-action.ts packages/core/src/core/orchestrator/planned-action.test.ts packages/core/src/logging/behavior.ts
git commit --no-verify -m "feat(macro): wire growth stimulation into runReflection after dream

runReflection now runs the macro stage between dream and the re-baseline mark:
every Nth cycle it adjudicates accumulated proposals, rewrites SYNTHESIS.md, and
appends a growth note that survives dream's cull and folds into the mark's
baseline. Reads the current-cycle episodes before finishEpisodeCycle rotates
them. Wrapped in the same best-effort catchAll as every other stage (a macro
failure never disturbs the mark or rotation), with a reflection behavior
start/done pair (new 'macro' stage).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review checklist

- [ ] **Spec §4-macro coverage.** Every Nth reflection cycle, persisted counter (Task 2 `bumpMacroCount`/`macroEveryN`, gated in Task 4; default N=4, env-overridable) ✓. (1) **Adjudicate**: weigh accumulated proposals against episode aggregates, apply accepted skill edits through `CharacterFs.writeSkill`/`deleteSkill`, record rejected proposals with a reason (Task 4 loop → `appendAdjudications` + `removeProposals`; Task 2 audit) ✓. (2) **Synthesize**: query the `LongtermStore` and rewrite bounded `me/SYNTHESIS.md`, injected into orient (Task 4 synthesis clamp; Task 3 orient injection) ✓. (3) **Narrate**: append a character-facing in-fiction growth note to DIARY.md (Task 4 `defaultGrowthNote` + worker `diaryNote`, appended after dream) ✓. Never-fail leaves proposals accumulated (Task 4 catch paths; Task 5 wiring test) ✓. SpaceMolt only ✓.
- [ ] **Guardrails in code (spec:120-126) — no code path writes an identity file.** Trace every write in `macro.execute`: `charFs.writeSkill` (create/revise), `charFs.deleteSkill` (retire), `charFs.writeSynthesis` (SYNTHESIS.md), `charFs.writeDiary` (growth note). `CharacterFs` has **no** `writeValues`/`writeBackground`/`writeDrives`/`writePalette` method (`CharacterFs.ts:31-48` + Task 1 additions), so VALUES.md/background.md/DRIVES.md/PALETTE.md are structurally unwritable. Skill caps run inside `writeSkill`→`validateSkillWrite` (count + body + name/description/when_to_use, Task 1). SYNTHESIS clamp mirrors dream's never-grows (Task 4 `MAX_SYNTHESIS_CHARS`, tested). Proposals are evidence-bearing by Stage-4's parse gate.
- [ ] **Worker is tool-less; harness applies (design decision 1).** `runTurn({role:"brain", noTools:true})` — the same seam as dream/consolidate/retrospect, at the reasoning tier — NOT the tool-enabled `frontier`/`sdk-runner` worker. The worker returns a document; every filesystem effect is a harness `CharacterFs`/growth-store call. Justified against `frontier-cli.ts` (steerable, tool-enabled, for the conscious agent's live delegation) vs `process-runner.ts` `runTurn` (tool-less strong-model turn).
- [ ] **Design resolutions documented with justification.** Worker shape (dec. 1); placement after-dream/before-mark (dec. 2 + Global Constraints); counter home host-side `macro-state.json` not the container-only `LongtermStore` meta (dec. 3); adjudication record = append-only `adjudications.jsonl` audit + `removeProposals` queue drain (dec. 4); SYNTHESIS on `CharacterFs` injected into orient (dec. 5); N=4 default (dec. 3); model resolution = new `"macro"` role → reasoning tier (Task 4 Step 1).
- [ ] **Never-fail discipline.** Every new `growth-store.ts` reader/writer is `Effect<..., never, never>` (swallow-and-log). `macro.execute`'s error channel is `never`: turn errors caught, `recall` caught, `listSkills`/`readSynthesis`/`readValues` caught, every write caught. A failed/blank turn drains nothing (proposals survive — tested). The `runReflection` call site adds a belt-and-suspenders `Effect.catchAll(logError)`. The re-baseline mark and `finishEpisodeCycle` run regardless (Task 5 failure test).
- [ ] **Placeholder scan.** No `TODO`, `...`, `<placeholder>`, or elided code — the full macro worker prompt (`buildMacroPrompt`), the diary growth-note template (`defaultGrowthNote`), and every implementation body are complete.
- [ ] **Type consistency.** `AdjudicationDecision.decision` is `"accept"|"reject"`; the stored `Adjudication.decision` is `"accepted"|"rejected"` (distinct on purpose — worker verb vs audit outcome). `SkillProposal.action: ProposalAction` drives create/revise→`writeSkill` vs retire→`deleteSkill`. `runForebrain`'s identity gains a required `synthesis: string` matched at both loop sites + the orient template + `tiers.test`. `resolveModel(models,"macro","reasoning")` uses the `Role` extended in Task 4. `runTurn` config matches the dream/retrospect call shape. `logBehavior` `stage:"macro"` is added to the union it type-checks against (Task 5 Step 1). New `CharacterFs` methods are added to the Tag AND every `.of()` stub (Task 1) — the cross-package surface change is why typecheck runs `--skip-nx-cache`.
- [ ] **Counter persistence + gate.** `macro-state.json` is host-side atomic (never depends on the container `memory` CLI); bumped once per reflection inside `macro.execute`; turn runs only on `count % macroEveryN() === 0` (Task 2/4 tests: non-Nth skips the turn; Nth runs it). Env override `ROCI_MACRO_EVERY_N` parsed like `ROCI_MODEL_RESTART_RETRIES`.
- [ ] **Reads current cycle before rotation.** `readCurrentCycleEpisodes` (Stage 4) reads the tail past the last boundary; macro is wired before `finishEpisodeCycle` (`planned-action.ts:159`), so the aggregates cover the just-ended cycle (Task 5 placement).
- [ ] **Extractor hardening (carry-forward).** `firstBalancedBracket`→`balancedCandidates` returns all candidates; `extractProposalsArray`/`parseAdjudicationDoc` try objects before arrays and skip un-parseable candidates — probe-5/6 wrong-anchor cases pass (Task 2 tests). No lingering `firstBalancedBracket` reference.

## Global commands reference

```
# per task, from the worktree root /Users/vcarl/workspace/roci/.claude/worktrees/skills:
pnpm vitest run <relative-test-path>
pnpm nx run-many -t typecheck --skip-nx-cache
git commit --no-verify -m "<conventional message + Co-Authored-By trailer>"
```
