# Phases 0–4 Holistic Review — Session Kickoff

> **For the fresh session:** This document is your brief. Read it first, then read the
> sources it cites (do not work from this summary alone — it points at the real artifacts).
> Everything here is grounded in repo files + the SDD ledger as of HEAD `94102e2` on branch
> `worktree-steering`. Run all commands from `/Users/vcarl/workspace/roci/.claude/worktrees/agent-sdk`
> (a git worktree — do **not** remove it).

## 1. What this session does

Conduct a **holistic, arc-level review of the cortex/cybernetics redesign (Phases 0–4)**:
compare the **original intentions** stated at the start of each phase against the **final
results** that landed. The output is a synthesis that **retains the important decisions and
the why, and deliberately drops precise code-level changes** (those live in git + the specs;
re-deriving them is not the goal). Think "what did we set out to build, what did we actually
build, where did they diverge and why, and what durable decisions + debt came out of it."

This is **not** a code review (each phase already passed its own final whole-phase review —
see the ledger). It is a retrospective on intent vs. outcome.

### The product
A written review doc — suggested path `docs/superpowers/2026-06-20-phases-0-4-holistic-review.md` —
structured as: (a) per-phase **intention → result → decisions-kept → drift/deviation → debt**,
then (b) an **arc-level synthesis** (where the ladder ended up vs. what the master design drew,
the load-bearing decisions, the carried debt, and any unfinished intent).

## 2. The arc at a glance

The redesign replaced a pre-cortex harness ("Phase 0") with a four-rung **escalation ladder**:
`hindbrain → forebrain → conscious → cybernetics(frontier)`. Seven implementation units landed
over 3 days (`c141269` → `94102e2`, 2026-06-18 → 2026-06-20).

| Unit | Intention (spec) | Result HEAD | Base |
|---|---|---|---|
| **Phase 0** (baseline) | *the thing being replaced* — see §4 | — | — |
| **Phase 1** — Transport/Payload split | `specs/2026-06-18-cortex-cybernetics-design.md` (master) + the phase-1 plan | `85bb7c7` | `c141269` |
| **Phase 2** — SDK-runner + NDJSON wire protocol | phase-2 plan | `6fa9138` | `c30a82b` |
| **Phase 3** — Steering channel | phase-3 plan + `specs/2026-06-18-cybernetics-agent-sdk-steering-design.md` | `4b37a72` | `ec35ccb` |
| **Phase 4a** — OpenCode conscious-session transport | `specs/…phase4a-opencode-session-design.md` | `5e108d3` | `9602e56` |
| **Phase 4b** — Cortex loop rework (conscious executor + steering) | `specs/…phase4b-cortex-loop-rework-design.md` | `fbdf3a2` | `c76d247` |
| **Phase 4c** — Frontier delegation as a steerable bash tool | `specs/…phase4c-frontier-tool-design.md` | `c20d19c` | `9637704` |
| **Phase 4c follow-ups** — model selection, cybernetics deletion, tidy | `plans/2026-06-20-phase4c-followups.md` | `94102e2` | `bd61920` |

> Note on git topology: `git merge-base main HEAD` = `ec35ccb` (Phase 3's base). So **Phases 1
> & 2 are shared history with `main`** (they predate the branch divergence); Phases 3 → 4c-followups
> are unique to `worktree-steering`. The whole arc is still one ancestry chain: `git log c141269..HEAD`
> walks all of it. The branch is **kept unmerged** by the user's standing choice.

## 3. Authoritative sources (read these, not memory)

**Master design (the overarching intention for the whole arc):**
- `docs/superpowers/specs/2026-06-18-cortex-cybernetics-design.md` — *Cortex / Cybernetics Redesign.*
  Defines the tier ladder, model assignments, the host↔Docker seam, and the **deletion targets**
  (what Phase 0 machinery was slated to die). This is the spine to measure every phase against.

**Cross-cutting design + foundational plans:**
- `docs/superpowers/specs/2026-06-18-cybernetics-agent-sdk-steering-design.md` — tool-using conscious tier + escalation worker (feeds Phases 3/4a/4b).
- `docs/superpowers/plans/2026-06-18-cortex-tiers-and-ladder.md`, `…-cortex-model-provider-seam.md`, `…-cybernetics-delegation.md`, `…-domain-integration-and-deletion.md` — the foundational plans the numbered phases were carved from.

**Per-phase specs (intentions) + plans (intended approach):** see the table in §2; all under
`docs/superpowers/specs/` and `docs/superpowers/plans/` with the dated filenames listed there.

**The results record (authoritative — this is where "what actually happened" lives):**
- SDD ledger: `$(git rev-parse --git-path sdd)/progress.md`
  One section per phase, each with: per-task completion lines, **deferred Minors roll-ups**,
  **controller adjudications/fixes**, and a **Final whole-phase review verdict** ("READY TO MERGE")
  with the deviations that were accepted and why. This is the single richest source for
  intention-vs-result and for the decisions to retain.

**Orientation / architecture:**
- `HARNESS.md` — *Agent Harness.* Describes BOTH the pre-cortex architecture (Phase 0) being replaced
  AND the new cortex/cybernetics design. **Primary context doc.**
- `CLAUDE.md`, `docs/DOMAIN_GUIDE.md`, `docs/MODEL_CONFIG.md`, `docs/OPERATING_SKILLS.md`,
  `docs/cortex-smoke.md`, `README.md`.

**Git:** `git log --oneline c141269..94102e2` (full arc); per-phase ranges via the base→HEAD pairs in §2.

## 4. What "Phase 0" means (no explicit phase-0 doc exists)

"Phase 0" = **the pre-cortex architecture the redesign set out to replace.** Grounding:
- `HARNESS.md` (≈ lines 9–16) documents it: a stateless `claude -p` executor wrapped in an
  **external, 4-Claude-calls-per-tick OODA brain/body state machine** (`channel-session.ts`,
  `ooda-runner.ts`, `session-runner.ts`, operating-skill prompt templates, `dream` memory
  compression) — which "duplicates the agent loop the runtime already runs internally."
- The master design doc's **deletion list** is the negative image of Phase 0: `claude --channels`
  persistence, `session-runner.ts`/`channel-session.ts`, the brain/body split, OODA-as-4-calls,
  the `runtime.ts` binary split, the operating-skill prompt-template machinery.
- Precursor April-2026 work (still inside Phase 0): `specs/2026-04-10-unified-event-log-design.md`,
  `specs/2026-04-18-agent-operating-skills-design.md`, and `plans/2026-04-23-ooda-integration.md`.

The review's Phase-0 section should establish this baseline (the starting intention + the
machinery marked to die) so later phases can be measured as "did we actually replace/delete it?"

## 5. Subagent scheduling discipline (the user's explicit concern)

This is a large unit. **Do not fan out all seven phases at once.** The structure that keeps it
mindful: each phase's inputs are *bounded* (a spec + a plan + one ledger section), so each
analysis is a focused, cheap subagent — but they run in **small batches of ≤2 concurrent**,
with the controller curating each result into the running synthesis before launching the next batch.

**Recommended sequence (≈8 subagents, never >2 in flight):**
1. **Context pass (1 agent):** Phase 0 baseline + master-design intention. Reads `HARNESS.md`
   (old arch + deletion list), the master design doc, and the precursor April specs. Produces:
   "the starting point" + "the overarching intention/ladder as designed."
2. **Per-phase comparison agents, batched 2 at a time:**
   - Batch B: Phase 1 ‖ Phase 2
   - Batch C: Phase 3 ‖ Phase 4a
   - Batch D: Phase 4b ‖ Phase 4c (fold the 4c follow-ups into the Phase-4c agent)
   Each agent reads ONLY its phase's **spec (intention) + plan (intended approach) + the matching
   ledger section (actual result, deferred items, final-review verdict)**. It must **NOT** read
   code diffs — decisions and outcomes only. Output: a ≤1-page structured comparison (template below).
3. **Synthesis (controller, or 1 agent):** read the 7 structured outputs → the arc-level narrative.

**Per-phase agent output template** (hand this to each):
- **Intention** — what this phase set out to do (from its spec), in 2–4 bullets.
- **Result** — what actually landed (from the ledger), including the final-review verdict.
- **Decisions kept** — the durable design decisions + the *why* (the knowledge to retain).
- **Drift / accepted deviations** — where the result diverged from the plan and why it was accepted.
- **Debt carried** — deferred Minors / known watch-items / future-work seams left open.

**Guardrails:** ≤2 subagents concurrent; bounded inputs per agent (no broad codebase crawls — this
is a docs/ledger synthesis, not a code hunt); controller writes the synthesis doc incrementally so
progress survives compaction; if a phase's ledger section is large, the agent summarizes it, it
doesn't quote it wholesale.

## 6. First actions for the fresh session

1. Read this kickoff, then `HARNESS.md` and the master design doc (`…2026-06-18-cortex-cybernetics-design.md`)
   yourself for orientation (≈10 min of reading — worth doing directly, not via subagent).
2. Open the ledger (`$(git rev-parse --git-path sdd)/progress.md`) and skim the section headers +
   final-review verdicts to calibrate scope.
3. Create the synthesis doc skeleton (`docs/superpowers/2026-06-20-phases-0-4-holistic-review.md`)
   with the per-phase + synthesis structure from §1.
4. Run the §5 schedule: context pass → batched per-phase agents → synthesis. Curate each result
   into the skeleton as it returns.
5. Present the arc-level synthesis to the user; iterate.

## 7. Standing constraints (carry into the fresh session)

- Commit messages (if any) end EXACTLY with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Docs-only commits may use `--no-verify`; stage explicit paths (`git add <path>`), **never `git add -A`**
  — there are stray untracked files in the worktree (`sdd/phase4a-spike-report.md`, empty `test-output.log`)
  that must not be swept into commits. (The user may want to gitignore/remove them.)
- Use subagents for discrete units; controller curates/reviews/synthesizes. Don't spawn large
  simultaneous fan-outs (the §5 discipline). No MCP. Don't remove the `.claude/worktrees/agent-sdk` worktree.
- Ground every claim in a real doc/ledger/commit citation — no synthesized-from-memory framing.
