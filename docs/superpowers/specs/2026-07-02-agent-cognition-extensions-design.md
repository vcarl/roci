# Agent cognition extensions: episode log, working memory, agent-maintained skills, meta-cognitive cycles

**Date:** 2026-07-02
**Status:** Approved
**Scope:** SpaceMolt domain only. The GitHub domain is stale and explicitly out of scope.
**Related prior art:** `2026-06-30-longterm-memory-design.md`, `2026-06-30-cross-boundary-memory-design.md`, `2026-06-28-per-cycle-diary-consolidate-cull-design.md`, `2026-04-18-agent-operating-skills-design.md`

## Goal

Task effectiveness first, with interfaces that identity and self-authorship work can ride on later. Four extensions, each independently useful: a durable episode log the agent's retrospectives can read, a working-memory store with automatic prompt visibility, a library of agent-maintained skills selected at decide time, and meta-cognitive cycles at three timescales that turn experience into skill and self-model revisions.

## Context: current architecture

- **Cortex tick loop.** `runCortex` (`packages/core/src/cortex/loop.ts:114`) runs per tick: drain events → hindbrain observe → forebrain orient → conscious decide/evaluate. The tiers are stateless local MLX completions via `callTier` (`packages/core/src/cortex/tiers.ts`). The only between-tick state is `CortexState` (`packages/core/src/cortex/state.ts:4`): `accumulatedEvents` (wiped each orient), `currentPlan` (DecideResult steps), `currentStepIndex`, and `waitState`. Step reports are discarded after evaluate — nothing durable records what a step did or how it went.
- **Conscious agent.** The tool-using body is OpenCode, run per-turn via docker exec (`opencode run --format json --model <local/id>` with session resume; `packages/core/src/core/limbic/hypothalamus/runtime.ts:12`, `process-runner.ts:154`). Verified against OpenCode v1.17.13: files listed in the `opencode.json` `instructions` array are re-read from disk on every LLM request (`session/instruction.ts`, uncached, inside the per-step loop) and injected into the system prompt as "Instructions from: \<path\>". OpenCode's native todowrite has no automatic per-turn visibility and is memory/SQLite session-scoped, so it is not the foundation here.
- **Stream normalizer.** `packages/core/src/logging/stream-normalizer.ts` already parses tool events into `players/<name>/logs/{stream,thoughts,actions,words}.jsonl`.
- **Character files.** `players/<name>/me/` is accessed via the `CharacterFs` service (`packages/core/src/services/CharacterFs.ts:23`) — read surface for diary/secrets/background/values/palette/drives; the write surface today is only `writeDiary` and `writeSecrets`. Identity is re-read from disk on each escalation (`loop.ts:344-346`).
- **Long-term memory.** `LongtermStore` (`packages/core/src/conscious/longterm-store.ts:72`) is sqlite+sqlite-vec per character at `players/<name>/me/longterm.db`, container-only (sqlite-vec bus-errors host-side on macOS), driven via the generated in-container bun CLI `memory` (`packages/core/src/conscious/memory-cli.ts`), provisioned eagerly at container startup. Hard rule: no lazy provisioning in the cortex loop.
- **Reflection phase.** `runReflection` (`packages/core/src/core/orchestrator/planned-action.ts:36`) runs each cycle: promote new diary entries to longterm → consolidate DIARY.md → dream (compress diary toward 150 lines and compress SECRETS.md, never-grows invariant, normal/good/nightmare variants) → re-baseline the promotion mark. Reflection turns run `role:"brain"`, noTools, via the `claude` binary. A per-step diary micro-reflection already exists (`tiers.ts:347` `runDiaryTurn` → appends DIARY.md).
- **Frontier seam.** The `frontier` bash CLI (`packages/core/src/conscious/frontier-cli.ts`) drives `@anthropic-ai/claude-agent-sdk` `query()` via `sdk-runner.mjs` — the harness's strong-model delegation path. Its character-facing framing (`opencode-config.ts:75-92`) is "a stronger Claude Code worker you drive".
- **Existing skill templates.** The templates in `packages/core/src/skills/` are static OODA prompts for the MLX tiers (observe/orient/decide/evaluate/diary). They are not the agent-maintained skills introduced below and are unchanged by this design.

## 1. Episode log (substrate; MVP to verify)

Two append-only JSONL streams per character under `players/<name>/logs/`, split by cadence and fidelity:

- **`episodes-tool.jsonl`** — high cadence, low fidelity. One record per OpenCode tool call, emitted from the existing stream normalizer: `{ts, tick, stepId, tool, argsSummary, status/exit code, durationMs}`. `argsSummary` is truncated to ~200 chars. Full tool responses are never stored.
- **`episodes-transition.jsonl`** — low cadence, full fidelity. One record per OODA tier call and per step boundary: the full rendered prompt inputs and parsed outputs for orient/decide/evaluate/diary, plus step-start/step-end records carrying the evaluate verdict, the skill worn (§3), and working-memory deltas (§2).

**Why JSONL, not sqlite.** The harness writes these host-side, and per-character sqlite is container-only (macOS bus error host-side). JSONL on the shared mount lets the harness write and retro turns read in-container via the RW mount, with no cross-boundary database.

**Rotation.** Retain the last N reflection cycles.

**Aggregates.** Derived figures such as per-skill success rates are computed at read time by retro turns, never maintained incrementally.

**Testing and error handling.** Unit-test the record shapes and the ~200-char `argsSummary` truncation; test the transition records for step boundaries (verdict, worn skill, wm deltas present). The tool stream is emitted from the stream normalizer, which already parses these events — extend its existing tests. Episode writes are logging, not control flow: a failed append must never disturb the tick loop. Verify rotation drops only whole reflection cycles.

## 2. Working memory (`wm`)

### Store

`players/<name>/me/wm.json`, plain JSON on the shared mount. Both the host and container sides write atomically via write-then-rename.

### CLI

A bun script `wm` at `/usr/local/bin/wm`, provisioned eagerly at container startup alongside `memory` (same no-lazy-provisioning rule). Verbs:

- `wm todo "<text>" [--parent <id>]` — create a todo, optionally under a tree parent.
- `wm done <id>` — mark done.
- `wm discard <id>` — set state `discarded`: retained, not done, not in progress, excluded from active renders, visible to retrospectives.

States: `open | done | discarded`. There is deliberately no `wm list` — visibility comes from automatic injection, not from the agent remembering to look.

### Injection

On every mutation, the CLI (and the harness, when it seeds) re-renders a compact human-readable view to `WM.md` next to `wm.json`, showing ids, tree structure, and states. The project `opencode.json` `instructions` array includes that file, so OpenCode re-reads and injects it into the system prompt on every LLM request — automatic, repeated, fresh even mid-turn, with no transcript accumulation. Caveat: system-prompt churn invalidates the provider prompt cache; acceptable, since the conscious model is local MLX.

### Harness integration

- On decide, plan steps are seeded as todos parented under a plan-headline todo, so intent survives replans — today unfinished steps simply vanish with the old plan.
- Evaluate marks the step's todo done.
- A replan discards orphaned todos.
- The open list (capped, tree-rendered) is added to the orient and decide prompt variables.
- `formatStepTask` documents the wm verbs to the agent.
- All wm mutations are also recorded in `episodes-transition.jsonl` (§1).

**Non-goal for v1:** an OpenCode plugin on `tool.execute.after` could mirror native todowrite usage into wm. Noted for the future; not built now.

**Testing and error handling.** Unit-test the state machine (`open`→`done`, `open`→`discarded`), tree parenting, the WM.md render (ids, tree, states, discarded excluded), and atomic write-via-rename on both sides. Test harness seeding: decide seeds steps under a plan-headline todo, evaluate marks done, replan discards orphans. Because writes are atomic renames, a reader never sees a torn file; concurrent host/container mutations resolve to one side's complete state rather than corruption. Verify wm mutations land in the transition episode stream.

## 3. Agent-maintained skills

### Files

`players/<name>/me/skills/<slug>.md` — YAML frontmatter `{name, description, when_to_use}` plus a markdown body. The terminology is plainly "skills": no "hats" metaphor in code, prompts, or docs.

### CharacterFs surface

New methods `listSkills`, `readSkill`, `writeSkill`. The intrinsic forcing function lives in harness code: the harness itself reads and writes skills through this surface. The agent can also edit skill files directly via its RW mount, but the system never depends on it choosing to.

### Selection

The decide prompt receives a compact skill index (name + description + when_to_use). `DecideResult` gains an optional `skill` field. The chosen skill's body is injected into `formatStepTask` for the conscious agent. The worn skill is recorded on step episode records (§1), which is what enables meso-level grading of skills against outcomes.

### Caps

Enforced at write time by `writeSkill`: at most ~12 skills, and a maximum body size.

### Seeding

Characters start with exactly two skills, provisioned at character creation:

- **`editing-skills`** — how to author and revise a skill file well.
- **`learning`** — how to notice a gap, capture a lesson, and turn it into skill or memory.

All further skills emerge from the metacognitive cycles (§4). We make no attempt to predict the skills agents will need.

**Testing and error handling.** Unit-test `listSkills`/`readSkill`/`writeSkill`, including cap enforcement (count and body size) rejecting oversize writes. Test that the decide prompt renders the skill index, that a `skill` field in `DecideResult` injects the body into `formatStepTask`, and that a decide result with no skill (or a skill name that no longer exists on disk — the agent can edit files directly) degrades to a plain step task rather than failing the step. Verify the worn skill appears on step episode records.

## 4. Meta-cognitive cycles (micro / meso / macro)

Three timescales; the first exists, the other two are new.

### Micro — per step (exists, unchanged)

The per-step diary turn (`tiers.ts:347` `runDiaryTurn`) already appends to DIARY.md after each step. No changes.

### Meso — per reflection cycle (new)

A new retrospect stage in `runReflection`, placed after the promote stage so nothing is lost to the diary cull. The retrospect turn reads the cycle's episode streams (§1) and the skill index (§3), and appends proposals to `players/<name>/me/growth/proposals.jsonl` — create/revise/retire skill actions, each citing episode evidence. Meso proposes only; it never applies edits.

### Macro — every Nth reflection cycle (new)

"Growth stimulation", gated by a persisted counter and farmed to a frontier-class Claude worker via the harness's strong-model seam — the same infrastructure as the `frontier` tool and `sdk-runner`. It does three things:

1. **Adjudicate.** Weigh accumulated proposals against episode aggregates; apply accepted skill edits through `CharacterFs`; record rejected proposals with a reason.
2. **Synthesize.** Query the `LongtermStore` and rewrite `me/SYNTHESIS.md`, a bounded self-model injected into orient alongside background/values/diary.
3. **Narrate.** Append a character-facing growth note to DIARY.md, framed in-fiction as a "growth stimulation" from the character's attached superintelligence. The character wakes with revised skills, a fresh synthesis, and a diary trace of having been prodded.

### Guardrails

- Macro edits skills and SYNTHESIS.md only — never VALUES.md, background.md, or DRIVES.md. Identity files stay read-only at runtime.
- Skill caps (§3) are enforced on macro's writes like any other.
- Proposals must cite episode evidence.
- SYNTHESIS.md is size-bounded, mirroring the dream stage's never-grows discipline.

**Testing and error handling.** Test the meso stage's placement after promote (a retrospect failure must not disturb promote/consolidate/dream), the proposals.jsonl append shape, and that proposals without evidence citations are rejected. Test the macro counter's persistence across sessions and that the guardrails hold: a write targeting VALUES.md, background.md, or DRIVES.md is refused; SYNTHESIS.md writes exceeding the size bound are refused; skill edits pass through `writeSkill` cap enforcement. Adjudication outcomes (accepted and rejected-with-reason) must be recorded. A failed frontier call leaves proposals accumulated for the next macro cycle rather than dropping them.

## 5. Scope and build order

SpaceMolt only; the GitHub domain is stale and out of scope. Each stage is independently useful and lands in sequence:

1. Episode log (§1)
2. Working memory (§2)
3. Skill library + decide/step injection (§3)
4. Meso retrospect (§4)
5. Macro growth stimulation (§4)
