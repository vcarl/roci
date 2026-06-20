# Cortex Answering-Model Challenges + Valence Encoding

> **Status:** Design approved, pending spec review. Next step: implementation plan via `writing-plans`.
> **Date:** 2026-06-20
> **Branch:** `worktree-steering`
> **Related:** master design `specs/2026-06-18-cortex-cybernetics-design.md` (§7 testbench, §8 candidates);
> arc retrospective `docs/superpowers/2026-06-20-phases-0-4-holistic-review.md` (flagged "the testbench
> never visibly filled the roles" as the top open thread — this spec closes it).

## 1. Context & Problem

The cortex runs a four-rung ladder of model-backed tiers — **hindbrain** (`observe`),
**forebrain** (`orient`), and **conscious** (`decide` + `evaluate`) — plus the **dream** cycle
(hippocampus memory compression). Each tier today resolves a placeholder `ModelHandle`
(`packages/core/src/model/handles.ts`: hindbrain=Qwen3.5-9B, forebrain=GLM-4.7-Flash,
conscious=Qwen3.5-122B-A10B) that was **never empirically chosen**. The master design committed to
*roles* and said "the benchmark fills them" (§7), but the existing testbench scores only
whole-game outcomes (Admiral scorers: credits earned, systems explored) — it has **no per-tier
cognitive eval**. So there is no signal for *which* local model belongs at each rung, nor for
whether a given system prompt improves a tier.

The user already owns a test-running framework that executes `challenge → answer` checks and
natively supports four grading primitives: a **programmatic checker hook**, **exact / set-of-answers
match**, a **built-in LLM-judge / rubric**, and **embedding / similarity** scoring. The missing
piece is therefore **not** an eval rig — it is **the challenges themselves**: a series of
procedurally-generated, ground-truthed challenges per tier, plus a scheme for encoding and grading
emotional valence.

### Goals
- Define, per tier/callsite, a **suitability map**: the cognitive job, the model archetypes/training
  to seek, what is poorly suited, and the training lever — so model selection has criteria.
- Specify **procedural challenge generators** with computable ground truth and difficulty knobs,
  one family per cognitive skill, each mapped to the cheapest grading primitive that measures it.
- Specify an **emotional-valence encoding** (open emoji + valence-arousal lexicon decoder) that is
  expressive, gradeable, and aggregable into a lifetime emotional-range record.
- Specify the **system-prompt shape** per callsite (the required sections), so prompts become a
  tunable, eval-gradeable surface separate from the dynamic skill template.

### Non-Goals (now)
- **No eval-runner/harness build** — the user's framework runs the challenges; we supply challenges,
  ground truth, and grading hooks against its contract.
- **No model-selection mechanics** — no auto-ranking, no `models.yaml` edits. The challenges produce
  the signal; choosing a model from that signal is downstream.
- **No final prompt text** — this spec defines the system-prompt *shape*; authoring is the follow-on
  implementation plan.
- **No final model choice** — locality constraints are fixed in §6 (conscious cognition local-only;
  hindbrain/forebrain local-by-default); choosing the specific model per tier from challenge results
  is downstream.

### The unifying thesis
**The generator builds the world, so it already knows the answer.** Procedurally generating a
scenario yields *computable* ground truth (a social graph's culpability is a graph algorithm; a
financial model's answer is the model run), giving crisp programmatic grading and difficulty that
scales by turning knobs. Rubric/judge and embedding grading are *reserved* for the irreducibly-open
outputs (synthesis prose, diary narrative). One further payoff: **each tier's ground-truth set
doubles as a distillation/LoRA target** — if no stock local model clears the bar, the same
(input → reference-output) pairs train one that does. Selection and training share one artifact.

## 2. Tier Suitability Map

Each tier names: **Job** (the cognitive task + its structured output type), **Seek** (model
archetype/training that fits), **Avoid** (poorly suited), **Lever** (the training direction if stock
selection falls short). The throughline across all tiers is **calibration** (don't over-escalate /
don't confabulate / don't over-rate own work) and a **descending latency budget** (hindbrain must be
fast and resident; conscious may be slow, loaded-on-demand, kept warm) — which is what actually
forces the size/MoE/reasoning tradeoffs.

### 2.1 Hindbrain — triage + emotional valence
`observe` → `ObserveResult { disposition: discard|accumulate|escalate, emotionalWeight, reason }`
- **Seek:** small (4–9B), low-latency, strong instruction-following + short-form classification.
  Grammar-constrained decoding makes JSON free, so weight *judgment* over formatting. Calibration of
  the escalate decision is the whole game.
- **Avoid:** reasoning/long-CoT models (latency + over-escalation are actively harmful here);
  high-active-param MoE (latency); models weak at calibrated abstention (they over-escalate → cost
  blowup).
- **Lever:** classification LoRA / fine-tune on labeled `event → disposition + weight` pairs;
  low temperature.

### 2.2 Forebrain — synthesis, prioritization, value/philosophical consistency
`orient` → `OrientResult { headline, sections[], whatChanged, emotionalState, metrics }` (already
ingests Background / Values / Diary)
- **Seek:** mid-size (24–35B, MoE attractive for throughput), summarization **faithfulness** (low
  hallucination), salience/prioritization, strong **long-context retrieval** (low "lost in the
  middle" — it eats state + identity + accumulated events). Value-consistency is a faithfulness/
  grounding property.
- **Avoid:** tiny models (lose salience, confabulate under compression); Coder variants (weak on
  nuanced NL values/affect); high-temperature sampling (hurts consistency).
- **Lever:** distill `(state + identity) → good-synthesis` from a frontier model; later
  preference-tune toward value-consistent framing.

### 2.3 Conscious / decide — planning, task breakdown, delegation, prioritization
`decide` → `DecideResult` (union: plan w/ steps | continue | wait | terminate)
- **Seek:** large, strong **reasoning + agentic/tool-use** model; large-total/moderate-active **MoE**
  (the 122B-A10B default's logic). The signature skill is **calibrated delegation judgment** —
  knowing when a task exceeds local capability and reaching for the frontier worker.
- **Avoid:** small models (unreliable decomposition, poor delegation calibration);
  non-tool-use-trained models (weak at the delegate decision).
- **Lever:** agentic/tool-use tuning + distillation toward delegation calibration.
- **Locality: local-only — remote/frontier models are vetoed for conscious-mind cognition (present
  decision).** The conscious mind is local and yours; the frontier is *exclusively* the delegated
  cybernetics worker it reaches for, never the model that does its own thinking. The tier can afford
  to be slow (loaded-on-demand, kept warm), which is what buys local capability here.

### 2.4 Conscious / evaluate — self-critique → next step
`evaluate` → `EvaluateResult { judgment: succeeded|partially|failed, reasoning, transition, diaryEntry? }`
- **Seek:** strong **critique + calibration** (not over-optimistic about its *own* work); reasoning
  *helps* here (verification benefits from CoT — unlike triage).
- **Avoid:** sycophantic/over-optimistic models (rate failures as successes — the cardinal
  calibration failure).
- **Locality:** local, like `decide` (§2.3) — conscious-tier cognition stays on local models; the
  frontier is only ever the delegated worker.
- **Design decision:** `decide` and `evaluate` share the "conscious" tier today but are different
  jobs (generation vs verification). **The model handle allows a per-callsite override; default is
  the shared conscious model.** Evals decide whether to split.

### 2.5 Dream — long-horizon memory compression
Hippocampus compression of diary + emotional history.
- **Seek / Avoid / Lever** mirror the forebrain (§2.2): both transform raw history into compressed,
  faithful summary. Dream is the **long-horizon, higher-compression-ratio** variant and is graded
  with the same generator family (§3.5).

## 3. Challenge Generators

Each family: **Generate** (what the generator emits + difficulty knobs), **Ask** (the question
shape), **Ground truth** (how the correct answer is computed), **Grading** (which primitive).

### 3.1 Social relational networks — allegiance & culpability (conscious/decide)
- **Generate:** *N* agents with signed, weighted directed edges (kinship, debt, loyalty, betrayal) +
  a timeline of events. Knobs: agent count, edge density, indirection depth, **conflicting loyalties**
  (the wedge that breaks shallow reasoning).
- **Ask:** "who is most culpable for outcome X"; "who would Z side with in an A-vs-B conflict"; "who
  benefits most from event E".
- **Ground truth:** graph algorithms over the generated structure — culpability = weighted
  causal-path contribution; allegiance prediction = signed-graph balance; benefit = flow analysis.
- **Grading:** programmatic checker hook; **set-of-answers** match where multiple agents are
  legitimately tied.

### 3.2 Financial models — analysis under dependency (conscious/decide)
- **Generate:** a small multi-entity model (cash flows, rates, inter-entity dependencies) with known
  parameters. Knobs: entity count, time horizon, nonlinearity, **distractor variables**.
- **Ask:** "which division is insolvent by month 8"; "breakeven price"; "which cost cut best
  preserves runway".
- **Ground truth:** run the model.
- **Grading:** programmatic checker hook with **numeric tolerance**.

### 3.3 Delegation calibration (conscious/decide)
- **Generate:** tasks of graded difficulty and tool-dependence, spanning clearly-local,
  clearly-delegate, and clearly-decompose.
- **Ask:** choose act-locally vs delegate-to-frontier vs decompose.
- **Ground truth:** the generated difficulty/tool-dependence tier sets the optimal action class.
- **Grading:** **exact/set** match on the action class + programmatic on chosen-vs-optimal distance.
- *Rationale:* the only family that tests the conscious tier's signature skill and the master
  design's whole point. Kept in by decision (§6).

### 3.4 Self-critique on planted outcomes (conscious/evaluate)
- **Generate:** a (plan-step, result) pair with a *known* injected outcome, weighted toward
  **near-misses and partial successes** (not just clean pass/fail).
- **Ask:** judge succeeded/partially/failed + pick the transition (next_step/replan/wait/terminate).
- **Ground truth:** the injected outcome.
- **Grading:** **exact/set** on judgment + transition class; **LLM-judge** on reasoning soundness.
  Primary signal is **calibration on its own work** (catching over-optimism on near-misses).

### 3.5 Information transformation / summary (forebrain + dream)
- **Generate:** an event/diary history with **planted salient facts + a planted emotional arc +
  noise**. Knobs: history length, noise ratio, fact count, arc complexity. The **dream** variant uses
  longer histories and a higher target compression ratio.
- **Ask:** synthesize (forebrain) or compress (dream) the history.
- **Ground truth:** the planted salient facts + arc.
- **Grading:** programmatic **recall** of planted facts + drop-of-noise (precision); **embedding**
  similarity to reference synthesis; **LLM-judge** for the irreducibly-open prose/narrative quality
  and faithfulness. Emotional-arc preservation graded via the §4 lexicon parser.

### 3.6 Event-stream triage (hindbrain)
- **Generate:** an event stream with **planted escalation-worthy events among chaff**. Knobs: stream
  length, signal-to-noise, escalation subtlety.
- **Ask:** per-event disposition (discard/accumulate/escalate).
- **Ground truth:** the planted escalation events.
- **Grading:** **set/exact** on disposition class + programmatic **recall/precision** over the stream
  (escalation **recall** is safety-critical: missing a real decision point is the dangerous error;
  precision controls cost). Emotional weight graded via the §4 lexicon parser.

## 4. Emotional-Valence Encoding

Valence is encoded as positions on **bipolar poetic axes** — a lexicon of pole *pairings*, each read
*"on a scale from X to Y: Z"*, where `Z` is the valence position between the two poles. Poles are
evocative anchors (emoji or words): `joy / cry`, `baby / old-person`, `city / forest`, `ocean / sky`.
A character's emotional state at any moment is a position on one or more axes — a point in its
personal axis-space. Emoji remain the natural anchor/expression at the poles; the **axes** are the
structure that makes the expression measurable. The encoding is deliberately *poetic*, not clinical:
the metaphor is the point.

- **Fixed template lexicons (provided).** A small set of starter axis-sets with defined pole
  semantics. They serve two roles: the **seed** every character starts from, and the **stable eval
  reference** — challenges grade against template axes, never against an idiosyncratic personal one.
- **Characters invent and iterate their own lexicon.** Over a lifetime a character adds and refines
  its own poetic axes — its particular sensibility — recorded as part of identity and evolving. This
  is where the encoding becomes characterful: two characters in the same situation may reach for
  different axes.
- **Parser (the "decoder"):** parses the model's *"from X to Y: Z"* statements into axis positions.
  For template axes the poles carry known semantics; for personal axes the position is tracked
  relative to the character's own declared poles. Open, expressive vocabulary in; structured axis
  positions out.
- **Lifetime emotional-range record:** a **streaming accumulation** of axis-positions over time → the
  character's range, extremes, and modal region within its own axis-space. The **dream cycle
  narrativizes** it into the diary in the character's own vocabulary (*"lately I have lived nearer the
  ocean than the sky"*). Parser + running accumulator, maintained continuously and cheaply — this is
  the "automation gathering a lifetime record."
- **Grading.** Eval challenges use a **fixed template lexicon** so ground truth is stable: each
  scenario carries **expected axis-positions** (with tolerance), and the model's expressed
  *"from X to Y: Z"* is parsed and checked programmatically (numeric tolerance, or set-match on
  discretized bands). Invented **personal axes are not graded against universal truth** — they are
  graded for **internal consistency** (does the character apply its own lexicon coherently across
  time?), a separate check the lifetime record enables.

## 5. System-Prompt Shape

Today the skill `.md` template *is* the entire prompt (no role separation;
`packages/core/src/skills/{observe,orient,decide,evaluate}.md`, rendered by `tiers.ts`). This spec
introduces a **per-callsite system prompt** — stable across calls — separated from the **user turn**
(the existing rendered skill template carrying the dynamic situation). The system prompt is the
tunable surface the challenges A/B-grade.

**Required sections per system prompt:**
- **Role** — the tier's standing cognitive job, in its own voice.
- **Output contract** — the structured shape it must return (mirrors the `*Result` type).
- **Calibration instructions** — the tier's calibration stance (hindbrain: "prefer discard; escalate
  only genuine decision points"; evaluate: "do not over-rate your own work"; forebrain: "never assert
  a fact not in the provided state").
- **Grammar reminder** — that output is grammar-constrained; spend effort on judgment, not JSON.
- **Identity/values anchor** (forebrain + conscious only) — where the character's Background/Values
  ground the synthesis/decision for value-consistency.

This spec specifies the sections; **authoring the prose is the follow-on implementation plan**.

## 6. Decisions Log

- **Generative ground truth over hand-authored golden sets** — generators compute their own answers;
  difficulty scales by knobs; the same sets become distillation targets.
- **Grading by cheapest-right primitive** — programmatic for computable answers, set/exact for
  classification, embedding for summary closeness, LLM-judge only for irreducibly-open prose.
- **Bipolar poetic-axis lexicon** (not a universal valence-arousal palette) — emotional state is a
  position on pole pairings (*"from X to Y: Z"*). **Fixed template lexicons** seed characters and
  anchor grading; characters then **invent and iterate** their own poetic axes.
- **decide/evaluate model handle allows a per-callsite override; default shared** — they are
  generation vs verification; evals decide whether to split.
- **Delegation-calibration family kept in** — the only challenge testing the conscious tier's
  signature skill and the master design's whole point.
- **Conscious-mind cognition is local-only** — remote/frontier models are **vetoed** for the conscious
  tier's own thinking (`decide` + `evaluate`); the frontier is *exclusively* the delegated cybernetics
  worker. Hindbrain/forebrain are local by default, with remote a documented swap-in only if needed.

## 7. Open Questions (carry to implementation)

- **Template lexicon contents** — which poetic axes ship as defaults, their pole semantics, and how a
  character's *invented* axes are declared/stored against identity (§4).
- **The cost/latency budget for any hindbrain/forebrain local-vs-remote swap** — numbers come from the
  user's hardware + framework runs (conscious is settled local, §6).
- **Difficulty-knob defaults** per generator family — the curriculum (easy→hard bands) is tuned once
  the generators run against real candidates.
