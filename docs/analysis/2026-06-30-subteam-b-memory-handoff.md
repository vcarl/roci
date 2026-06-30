# Subteam B — Long-term memory: fresh-session handoff

**Date:** 2026-06-30
**For:** a fresh session starting Subteam B (the last of the C → A → B sequence).
**Role model:** the human operates as **lead-of-leads** (per `~/.claude/CLAUDE.md`):
the human-facing session delegates work to subagents and curates/reviews/commits;
it does not implement directly. A team lead investigates + designs, brings
decisions to the human, then implements test-first under review.

This handoff is grounded in real repo docs — read them, don't trust this summary
alone:
- `HARNESS.md` — core architecture (state-machine event loop, brain/body model,
  6 injectable Effect service layers).
- `docs/DOMAIN_GUIDE.md` — building/extending domains.
- `docs/analysis/2026-06-29-limbic-cortex-primitives-analysis.md` — the evidence
  base, incl. the **memory survey** (Thread on memory tiers) with file:line cites.
- `docs/analysis/2026-06-29-limbic-cortex-project-charter.md` — the project
  charter: the 5 resolved decisions, subteam scopes, coordination hazards, and
  the **A & C outcomes**.
- `docs/superpowers/specs/2026-06-29-limbic-drives-design.md` (A, Rev 3) and
  `docs/superpowers/specs/2026-06-29-reliability-repair-design.md` (C) — the two
  shipped designs.

---

## Where the project stands

Two of three subteams are **shipped** to `main` (reliability first, then drives):

- **Subteam C — Reliability** (wedged-state & data-loss repair): structured
  fail-loud logging (`logError` → `kind:"error"` events), cortex fail-loud on
  diary/identity-read loss + empty-plan drops, orchestrator consolidate/dream
  failures surfaced as errors, an in-container turn timeout wrapper. See the C
  spec; deferred follow-ups are in the charter.
- **Subteam A — Limbic drives** (per-event threat appraisal → graded escalation):
  the hindbrain now appraises events **one at a time** (no batch), with a
  `!stateUpdate` deterministic fast-path; `appraise`/`appraiseTick` reduce
  per-event results into a `HindbrainEscalation`; a graded ladder (steer →
  reorient) makes salience causal. **Hard-interrupt is amygdala-owned** — the 2B
  caps at reorient because it empirically cannot judge abstract drop-everything
  emergencies (spike "Finding 2"). A baseline of innate drives
  (safety/sustenance/agency core + domain-provided) grounds the appraisal.
  - **Cross-session seam (live):** `CortexState.escalation: HindbrainEscalation
    { rung, maxWeight, escalate, dominant, accumulated, reasons }`. `escalate ===
    true` (rung ≥ steer) is the off-rhythm wake signal for the forebrain-wake
    session; guaranteed non-undefined every tick.

**Subteam B is the remaining work.**

---

## Subteam B — scope (from charter decision 3)

Make memory **two-tier**:

1. **Diary stays working memory.** Today the diary is the character's working
   memory: `CharacterFs.readDiary/writeDiary` → `DIARY.md`, managed by the
   hippocampus per-cycle **consolidate → cull** pass (targets a stable size), and
   the conscious agent writes entries via a dedicated per-step turn. Do NOT
   replace this; it is the short-horizon store. (The diary consolidate→cull +
   per-step-write work is already on the branch/`main`.)
2. **Add an append-only LONG-TERM store backed by a vector DB.** New tier for
   durable retrieval across the agent's life. Append-only (charter decision 3 +
   decision 4: even *secrets* may be culled from working memory — that's how
   agents self-evolve their semantic aspects — but the long-term store is the
   durable substrate).
3. **Expose retrieval to the conscious agent as a SUBPROCESS tool, NOT MCP.**
   The human dislikes MCP (`feedback_no_mcp_prefer_subprocess`): expose the
   retrieval capability as a bash/subprocess invocation the in-container agent
   calls, not an MCP server.
4. **The conscious agent has write access** to the long-term store. Not all write
   paths need to be visible in code — that is acceptable (charter decision 3).

**Candidate tech:** `sqlite-vec` (named in the charter as a candidate). Validate
vs. alternatives during design.

---

## First things to establish (design pass)

- **Where memory lives today:** `services/CharacterFs.ts` (DIARY.md read/write),
  `core/limbic/hippocampus/` (consolidate/dream/cull — the diary working-memory
  manager). Read the memory survey in the analysis doc for the full map.
- **How the in-container agent invokes tools today:** trace how the conscious
  agent (opencode/Claude Code in the Docker container) runs subprocess commands,
  so the retrieval tool follows the existing pattern (see the hypothalamus
  transport/payload code: `core/limbic/hypothalamus/`).
- **Embedding model + vector store choice:** what embedding model is available
  on the host (local model server runs native on host —
  `reference_model_server_diagnostic`), and whether `sqlite-vec` (or alternative)
  fits the deployment (the container shares a volume with the host?).
- **Write path & schema:** append-only record shape (text, embedding, timestamp,
  provenance/tags), how the conscious agent writes (explicit tool vs. a
  consolidation hook off the diary cull), and the retrieval interface (query →
  top-k with metadata).
- **Relationship to the diary cull:** when working-memory entries are culled,
  should they be promoted into the long-term store first? (Likely yes — the cull
  is the natural consolidation point.)

---

## Proven workflow (what worked for C and A — reuse it)

1. **Team lead: investigation + design FIRST, no code.** Map the current state
   with file:line cites; propose 2–3 approaches per decision with tradeoffs +
   a recommendation; write a spec to `docs/superpowers/specs/`. The
   `superpowers:brainstorming` HARD-GATE applies: no implementation before an
   approved design.
2. **Lead-of-leads curates → brings decisions to the human** via batched
   multiple-choice questions. Record resolutions in the charter.
3. **If the design is model-dependent, SPIKE before building.** A's spike caught
   that the 2B couldn't do abstract-emergency interrupts *before* a loop was
   built around a dead signal. For B, if retrieval quality / embedding behavior
   is uncertain, measure it empirically first. (Model servers:
   `mlx_lm.server --model <m> --port <p>`; bring up only what's needed, not a
   full `roci start`.)
4. **Implement test-first**, one unit at a time. Pure helpers first
   (the project's TDD norm — see `cortex/state.ts`/`parse.ts` style).
5. **Independent review** (a separate reviewer subagent), fold nits test-first.
6. **Lead-of-leads curates the commits** (commit only when the human asks).

---

## Operational learnings (avoid re-hitting these)

- **Worktree discipline:** all work in the worktree
  `.claude/worktrees/dream-sequence` (branch `worktree-dream-sequence`); use
  `git -C <worktree>`; absolute paths inside the worktree; never edit the main
  checkout. `isolation:worktree` subagents fork from the repo base, not your
  moving HEAD — reconcile on merge.
- **Relayed-approval deadlock:** a subagent given a hard "do not implement" gate
  may refuse to act on *coordinator-relayed* user approval (it treats only the
  user's own messages as authoritative) — and the coordinator is its only
  channel, so it deadlocks. **Fix: don't argue; launch a FRESH agent whose first
  instruction is the go.** Durable design docs make the swap lossless.
- **Pre-commit hook builds the full working tree** (`nx run-many -t build`, all
  4 projects) on every commit — so incremental commits all build green as long
  as the full on-disk set is green; order commits so each is logically coherent.
- **The cortex is a hot, contended path.** Other sessions touch it (forebrain
  wake, proactive discovery). Expect rebase conflicts in `cortex/{loop,state,
  tiers,types}` and validate the full suite after any rebase.
- **No MCP** — expose agent capabilities as subprocess/bash invocations.
- **Don't spawn large simultaneous research fan-outs** — 1–2 focused subagents.

---

## Deferred follow-ups carried forward (not B's core scope, but adjacent)

- **A:** abstract drop-everything emergencies as deterministic amygdala-style
  state rules (the 2B can't judge them); the complementary hindbrain-interrupt
  rung is plumbed+gated but unexercised by the 2B.
- **C:** issue-3 live-container orphan reaping verification; active
  interrupt-path kill (`docker exec pkill`); issue-2 consecutive-failure
  escalation counter. (See charter "Subteam C — outcome".)
