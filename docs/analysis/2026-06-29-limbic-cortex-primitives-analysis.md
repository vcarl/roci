# Limbic system & cortex — core primitives analysis

**Status:** analysis / findings (not a design spec)
**Date:** 2026-06-29
**Scope:** the cortex loop (`packages/core/src/cortex/`) and the limbic system
(`packages/core/src/core/limbic/`), plus a survey of state-of-the-art LLM-agent
memory primitives.

This document is grounded in a read-only trace of the current code. Line
references were accurate at the time of writing; treat them as pointers, not
guarantees. No changes are proposed here — this is the evidence base for a later
design decision.

---

## Motivation

The user suspected the core primitives weren't behaving as intended, with three
specific concerns:

1. Event categorization is too coarse — emotional weight seems assigned to a
   *batch* of events rather than each event individually.
2. Some reasoning may be unnecessary / wasteful.
3. The memory approach (flat files + consolidate + dream-cull) may be behind the
   state of the art.

Four read-only analyses were run (cortex map, limbic map, two follow-up traces,
and a web survey of memory primitives). Findings below.

---

## Thread 1 — Event tagging: the signal exists but drives nothing

**Confirmed: one emotional weight + one disposition per tick-batch.** And the
deeper finding: the emotional signal is currently *inert*.

- Events in a tick are drained into a `tickEvents: string[]` array with **no
  per-event metadata** (`cortex/loop.ts:141–158`).
- `runHindbrain` receives the whole batch and returns a single `ObserveResult`
  (`disposition`, `emotionalWeight`, `reason`) — `cortex/tiers.ts:102–115`,
  `skills/types.ts`. The observe prompt **explicitly** asks for batch
  aggregation: *"Evaluate these events as a batch and produce a single JSON
  response… Your emotional weight should reflect the aggregate reaction across
  all events."* (`skills/observe.md:24`). So the batch behaviour is intentional
  in the prompt — it diverges from the user's intent, but it is not a wiring bug.
- `cortex.emotionalWeight = observe.emotionalWeight` (`loop.ts:205`) stores one
  scalar.

**Downstream consumption (the key result):** `emotionalWeight` is **purely
advisory prompt flavour**. It is:
- logged for humans (`loop.ts:203`),
- injected as "context" into the orient prompt (`tiers.ts:158`,
  `skills/orient.md:35,43`), the evaluate prompt (`skills/evaluate.md:37`), and
  the diary turn (`loop.ts:339`),
- **never** read to branch control flow, gate escalation, or change cadence.

`EventCategory` (`Heartbeat | StateChange | LifecycleReset`,
`thalamus/event-processor.ts:12–15`) is **dead data in the cortex**: every
domain sets it, but the cortex loop never reads it. It is consumed only by the
*break* phase (`orchestrator/planned-action.ts:102`) to skip interrupt checks on
non-`StateChange` events.

**The reframe:** the granularity gap is real, but the prior question is
*consumption*. Adding per-event emotional tags today would be "representation
without consumption." The valuable version of this thread is deciding what the
signal should **drive**. Concrete capabilities that per-event signal would
unlock, with the exact sites that would change:

| Capability (today impossible) | Site to change |
|---|---|
| Selective escalation (1 combat event among 99 heartbeats) | `loop.ts:210` single-`escalate` flag → per-event check |
| Salience-weighted accumulation (alert ranked above noise) | `loop.ts:207–208` flat push → `{event, salience}` tuples; `tiers.ts:152` render with markers |
| Emotion-gated cadence (intense states re-orient faster) | new check after `loop.ts:205` |
| Diary salience ranking | `loop.ts:332` sort before the diary turn |

Representation blockers if pursued: `runHindbrain` returns a scalar
`ObserveResult` (`tiers.ts:102`); `emotionalWeight: string` (`types.ts`);
batch-wide flags at `loop.ts:205–210`.

---

## Thread 2 — Unnecessary reasoning: concentrated in forebrain 5b

Per-tick model-call cost model:

| Call | Thinking | Gating | Verdict |
|---|---|---|---|
| Hindbrain observe | OFF (cheap) | every tick with events | OK; coarse granularity |
| **Forebrain orient (5b, in-session)** | **ON, 16K budget** | **every non-discard tick** | **prime waste** |
| Forebrain orient (5a, idle) | ON, 16K | when no plan / escalate | reasonable |
| Diary turn | ON | every evaluate; discarded on timeout | wasteful tail |
| Conscious decide / evaluate | n/a | on transitions / done-marker / budget | OK |

**Primary waste:** forebrain 5b runs a full thinking-enabled orient on *every
non-discard tick* (`loop.ts:271`), but the resulting steer directive is only
*sent* every 3rd tick (`DEFAULT_STEER_CADENCE_TICKS = 3`, throttle at
`loop.ts:406`) with capacity-1 coalescing. So **~2 of every 3 expensive orients
are computed and discarded.**

**Design-vs-code gap:** the cortex design says forebrain should wake on
*"material change, or no active plan, or plan stale."* The code wakes it on
**any** non-discard event, including `accumulate` — which `observe.md` itself
defines as *"fold into context for the **next** orientation pass"* (i.e. should
*not* trigger an immediate orient).

**Secondary:** the diary turn uses the thinking-enabled forebrain, runs
unconditionally after every evaluate, and silently discards its output on a 30s
timeout (`loop.ts:332–343`) — budget spent, nothing kept, no log.

**Open question:** does the orient step (situation synthesis) need
chain-of-thought at all, or is the 16K thinking budget over-provisioned? The
budget was raised from 4096 → 16384 to fit "monologue + JSON" (`handles.ts`
comment), without revisiting whether the monologue is needed.

---

## Thread 3 — Memory: the pattern is sound; the lossiness is the risk

### Survey result

The current design (flat `DIARY.md` / `SECRETS.md` + LLM consolidate + dream
cull) is a recognized point on the spectrum: essentially **Generative Agents'
"memory stream + reflection"** minus retrieval scoring, and the dream pass is a
**"sleep-time compute"** consolidation pattern. The single cheapest high-value
upgrade is **retrieval + salience scoring** (`score = relevance × recency ×
importance`), not new storage tech. A **graph DB (Zep/Graphiti) is wrong-sized**
for a single low-entity character; if/when retrieval is warranted, the right
size is an **embedded store (`sqlite-vec`)** — one file, in-container,
CPU-friendly small embedder. Episodic/semantic/procedural is the standard
framing: `DIARY.md` is episodic, `SECRETS.md`/values are semantic, "dreaming" is
the episodic→semantic consolidation step. (Sources at end.)

### Code-grounded lifecycle

**Write sites (4):**
- Per-step append — `loop.ts:345–349` — reads whole diary, concatenates new
  entry, writes back. Unbounded growth during a session; full file I/O per step.
- Consolidate — `hippocampus/consolidate.ts:71` — full rewrite into a coherent
  narrative; may grow.
- Dream diary cull — `hippocampus/dream.ts:133` — full rewrite toward
  `DIARY_TARGET_LINES = 150` (`dream.ts:16`), clamped never to grow (else keep
  original).
- Dream secrets cull — `hippocampus/dream.ts:170` — full rewrite, same clamp.

**Read sites (into prompts) — always whole-file, no retrieval:**
- Hindbrain: no memory reads (events only).
- Forebrain orient (both idle 5a and in-session 5b): **whole** background +
  values + diary (`loop.ts:218–226`, `262–270`; `tiers.ts:154–156`).
- Conscious decide/evaluate: no raw memory — only forebrain's curated sections.
- Diary turn: step context only.
- Consolidate: whole values + whole diary (`consolidate.ts:50–54`).
- Dream culls: whole background + whole secrets + whole diary
  (`dream.ts:78–80, 103, 143`).

**Confirmed:** the whole file is injected every time — no slicing/retrieval
anywhere. **Secrets are never read in the live loop** — only the cull model ever
sees them.

### The risks (where it diverges from best practice)

- **Destructive cull, no raw log.** `DIARY.md` is the only copy; consolidate and
  cull are full rewrites. Once culled, episodic detail is **gone**. Best
  practice is the inverse: keep the raw episodic log append-only as ground
  truth, treat consolidated memory as a derived view.
- **Asymmetric identity protection.** Background/values are read-only context,
  never rewritten (safe). **Secrets and diary are rewritten by the cull** →
  semantic-drift / "memory poisoning" risk. The secrets cull feeds the model the
  diary + background alongside the secrets, so it can reinterpret secrets through
  the narrative. Since secrets aren't used in the live loop, "why cull them at
  all" is a fair question.
- **Retrieval isn't the pressing need yet.** Because the diary is culled to ~150
  lines it always fits in context, so whole-file injection isn't overflowing.
  The active pain is *destructive forgetting*, not prompt overflow. Retrieval
  (e.g. sqlite-vec at the read seams) earns its keep later, once detail stops
  being thrown away and the corpus grows.

**Retrieval seams (for later):** forebrain diary read (`loop.ts:225`),
consolidate read (`consolidate.ts:50`), dream reads (`dream.ts:78–79`) — all
currently whole-file, all replaceable with a retrieval call.

---

## Thread 4 — Silent degradation: triaged by impact

Both subsystems share a pattern: **prefer "keep looping silently" over "fail
loudly."** Triaged:

**High (data loss / wedged state):**
- Diary turn timeout → empty string, no log → silent diary data loss
  (`loop.ts:332–343`).
- consolidate/dream failure → caught, console-logged only → orchestrator
  proceeds with stale memory (`planned-action.ts:43–54`).
- Turn timeout interrupts Effect fibers but **never kills the Docker process** →
  wedged container strands resources (`hypothalamus/transport.ts:174–180`).
- Plan with `steps:[]` (decision=plan, empty steps) enters active state, never
  executes, never evaluates → can hang (`loop.ts:287–290`).

**Medium (degraded context, hard to diagnose):**
- Swallowed identity reads (background/values/diary) → empty string → model
  loses grounding, no log (`loop.ts:218–270`).
- Palette read failure → silent generic palette (`loop.ts:97`).
- Parse fallbacks fill missing `headline`/`sections` from a fallback marker →
  downstream reads it as real model output (`tiers.ts:162–190`).
- Fragile `[STEP_DONE]` exact substring match → missed completion → silent
  "salvage evaluate" (`state.ts:69`).
- Error/timeout indistinguishable in conscious turn (`output = e.message`,
  `timedOut = false`) — `conscious-thought.ts:129–134`.

**Low (cosmetic / observability):**
- `emotionalWeight` never structured-logged (debug-blind on emotion evolution).
- Asymmetric cull logging: success emits an event, discard only warns to console
  (`dream.ts:119–139`).
- Dead code: `summarizeTimeout` (exported, never called); stale `LIMBIC.md`
  (references `runChannelSession` / `session-runner.ts` / `cycle-runner.ts` that
  no longer exist).

**Why it matters here specifically:** this agent runs unattended. Silent
degradation is most expensive precisely when no human is watching the loop.

---

## The convergence — threads 1, 3, and 4 are one thread

- **Thread 1:** a salience signal (emotional weight) is computed every tick and
  **thrown away** — nothing consumes it.
- **Thread 3:** the memory cull **needs a salience signal** to decide what to
  keep, but has none — so it forgets blindly and irreversibly.
- **Thread 4:** the highest-impact silent failures are all **memory / data-loss**
  modes.

The discarded salience from thread 1 is exactly the input the thread-3 cull
needs to keep the right things instead of forgetting blindly. **A per-event
salience signal feeding a non-destructive, salience-aware consolidation is a
single coherent design direction** — not three separate fixes.

**Thread 2 (wasted forebrain reasoning) is largely independent** — a
tuning/gating problem (when forebrain should wake; whether orient needs CoT),
addressable on its own.

---

## Open questions for the user (intent, not derivable from code)

1. What should the emotional/salience signal actually **drive** — escalation,
   cadence, memory retention, all of the above, or stay advisory?
2. Should forebrain wake on every non-discard event (current) or only on
   material change / stale plan (design intent)? Does orient need CoT?
3. Should the raw episodic diary be retained append-only, with consolidation as
   a derived view (best practice), rather than destructively rewritten?
4. Should secrets be excluded from the cull (they're unused in the live loop and
   at drift risk), or is culling them intentional?
5. Which silent-degradation modes should fail loudly vs. stay best-effort?

---

## Sources (memory survey)

- Generative Agents (memory stream + reflection): https://arxiv.org/abs/2304.03442
- MemGPT: https://arxiv.org/abs/2310.08560 · Letta memory blocks:
  https://www.letta.com/blog/memory-blocks/ · Sleep-time compute:
  https://www.letta.com/blog/sleep-time-compute/ (arXiv:2504.13171)
- Mem0: https://arxiv.org/pdf/2504.19413
- Zep / Graphiti (temporal graph): https://github.com/getzep/graphiti
- A-MEM (NeurIPS 2025): https://arxiv.org/abs/2502.12110
- CoALA (episodic/semantic/procedural): https://arxiv.org/abs/2309.02427
- "Memory in the Age of AI Agents" survey (Dec 2025): https://arxiv.org/pdf/2512.13564
- LongMemEval benchmark: https://arxiv.org/abs/2410.10813
- sqlite-vec: https://github.com/asg017/sqlite-vec

Currency caveat: vendor benchmarks (Zep/Mem0/Cognee) are self-reported and
directional. Foundational systems above are well-established as of writing.
