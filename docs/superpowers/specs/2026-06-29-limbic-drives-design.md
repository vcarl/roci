# Limbic drives — salience + threat-driven escalation (Subteam A design spec)

**Status:** design spec, REVISION 3 (investigation + design + empirical spike RE-MEASURED;
NO implementation code written). Rev 3 records the tuning iteration + amygdala-split
re-measure (the spike GATE is now PASSED → GO; see §6.5).
**Date:** 2026-06-29
**Scope (Subteam A):** make the hindbrain emotional/threat signal *causal* — tag
each event individually against a baseline of innate biological drives carried in
the character template, and drive selective, graded escalation. Expose a clean
escalation seam for the (out-of-scope) forebrain-wake session.
**Ground truth:** verified against the live `worktree-dream-sequence` HEAD (after
Subteam C's reliability work). Line numbers re-checked; where they contradict the
charter/analysis, this spec says so (§8).

---

## REVISION LOG — what changed in Rev 2 (human's four decisive calls)

The human made four calls that SUPERSEDE Rev 1's recommendations. They are now
binding constraints, not options:

1. **Per-event processing, NOT batch.** The hindbrain is invoked **once per
   event** — each event gets its own single-object `ObserveResult`. This dissolves
   Rev 1's top risk (array parse-robustness on a 2B model): every call is now a
   single object — the parser's happy path. Rev 1's `salient`-subset array (Option
   1C) is **superseded** (§3.1, §4.1).
2. **Hard-interrupt allowed at max threat.** The escalation ladder gains a top
   rung: moderate → priority steer; high → force reorient; **max → hard-interrupt
   the in-flight conscious fiber**. The human accepts that a hallucinated max-threat
   can discard in-flight work (§3.2).
3. **Drives = ~2–3 domain-agnostic CORE + domain-provided.** The core set shrinks
   from 5 to 3 (`safety`, `sustenance`, `agency`); domains contribute their own
   drives at scaffold/identity-gen time via a new hook (§3.3).
4. **Per-event `escalate` disposition still triggers escalation**, evaluated per
   event (§3.2).

Unchanged and still load-bearing: §1 (verified current-state), the seam surfaces as
a `CortexState` field (§5), `EventCategory` left untouched (§3.5), the amygdala
stays a separate system (§3.4). Sections are marked **[REV2]** where the pivot
rewrote them, **[holds]** where Rev 1 stands.

**New top risk after the pivot: the cost of N model calls per tick (§3.2a, §9).**
Verdict: per-event is **feasible at realistic event volume WITH a deterministic
fast-path** (§3.2a); the unmitigated worst case is a blocker requiring a human
call (§7 input #1, §9).

## REVISION LOG — Rev 3 (tuning iteration + amygdala split, re-measured)

The empirical spike (§6) has now been RUN (server brought up minimally, Qwen3.5-2B-4bit
@ :8081). The human's chosen path was executed: tune the 2B once more AND let the
**deterministic amygdala own physical-emergency hard-interrupts** so the 2B owns the
graded/abstract layer (where it scores well) and its `interrupt:true` is
*complementary*, not the sole guardian of physical emergencies. Rev 3 changes:

1. **Amygdala owns physical-emergency hard-interrupts (the split).** Mapping in §3.4a.
   Every physical emergency in the eval set is an amygdala `critical` (loop-exit). The
   2B's interrupt becomes the cortical complement for *abstract* emergencies the
   amygdala cannot see (state predicates have no event access). §3.2 / §3.4 revised.
2. **Tuned prompt approach (§4.2a):** temp **0.0** (kills run-to-run noise), few-shot
   anchors at both poles, and the **interrupt criterion fully separated from the
   weight scale** (its own yes/no test). This is the prompt that passed.
3. **Drive recommendation (§3.3a):** `drive` HELD at ~85% after tuning — KEEP it (do
   not drop to weight+interrupt-only). It remains the weakest axis; the residual
   misses are resource-threats mislabeled `safety`.
4. **Spike GATE PASSED → GO (§6.5):** zero SYSTEM-wide missed emergencies, zero false
   `interrupt` on benign, ≥80% drive + sane weight ordering on the 2B-owned layer,
   and full run-to-run stability — all across 3 seeded runs.

---

## 1. Verified current-state map  [holds — re-verified Rev 2]

All citations are live as of this branch's HEAD.

### 1.1 The emotional/threat signal flow (confirmed: computed, then thrown away)

- **Events have no per-event metadata.** Each tick drains world events into a
  flat `tickEvents: string[]` (`cortex/loop.ts:156–181`). Each entry is just
  `type: … \n {json}` or `String(event)`.
- **The hindbrain returns ONE batch result.** `runHindbrain(runnerConfig,
  tickEvents, waitState)` → a single `ObserveResult { disposition,
  emotionalWeight, reason }` (`cortex/tiers.ts:102–125`). The prompt **explicitly**
  asks for batch aggregation: *"Evaluate these events as a batch and produce a
  single JSON response… Your emotional weight should reflect the aggregate
  reaction across all events."* (`skills/observe.md:24`).
- **One scalar is stored.** `cortex.emotionalWeight = observe.emotionalWeight`
  (`cortex/loop.ts:226`); field defined on `CortexState` (`cortex/state.ts:6,16`).
- **It is purely advisory.** `emotionalWeight` is: logged (`loop.ts:224`); passed
  to forebrain orient (`loop.ts:247, 297`; rendered in `skills/orient.md:33–35`);
  passed to evaluate (`loop.ts:349`) and the diary turn (`loop.ts:378`). It is
  **never** read to branch control flow, gate escalation, or change cadence.
  CONFIRMED.

### 1.2 The escalation decision (where the loop decides discard vs. escalate)

The hindbrain step is `cortex/loop.ts:216–233`:

```
let escalate = tick === 1
let nonDiscard = false
if (tickEvents.length > 0) {
  const observe = yield* runHindbrain(...)
  cortex.emotionalWeight = observe.emotionalWeight
  if (observe.disposition !== "discard") { cortex.accumulatedEvents.push(...tickEvents); nonDiscard = true }
  if (observe.disposition === "escalate") escalate = true
}
if (!escalate && shouldForceOrient(cortex, tick, orientInterval)) escalate = true
```

Then the forebrain has **two disjoint call sites**:
- **5a — idle path** (`currentPlan === null`, `loop.ts:236–282`): gated on
  `if (escalate)` → orient → decide → plan.
- **5b — in-session path** (`currentPlan !== null`, `loop.ts:283–305`): gated on
  `if (nonDiscard)` → orient → `formatSteerDirective` → `pendingDirective`.

**KEY FINDING (correction to the charter — §8):** the `escalate` flag is read
**only in the idle path**. When a plan is active, `escalate` is computed but
**never consumed** — only `nonDiscard` drives the in-session steer, itself
throttled (`DEFAULT_STEER_CADENCE_TICKS = 3`, `loop.ts:77, 451–453`) with
capacity-1 coalescing. So **today a hindbrain "escalate" cannot interrupt in-flight
work at all**. Making escalation selective is necessary but not sufficient; the
in-session path has *no* escalation consumption to make selective — Subteam A must
*add* one.

### 1.3 The amygdala / threat path (wired, but a different mechanism)

- **Interface** (`core/limbic/amygdala/interrupt.ts:9–34`): an `InterruptRule` is
  `{ name, priority, condition(state, situation) => boolean, message,
  suppressWhenTaskIs }`. Exposes `evaluate`, `criticals`, `softAlerts`.
- **Rules are domain-authored, deterministic, STATE-based** (e.g.
  `domain-spacemolt/src/interrupts.ts:7–123`). Predicates over domain
  `state`/`situation`, with **no access to the event stream or any LLM appraisal**.
- **Wired into the cortex loop at one site** (`loop.ts:187–196`):
  `interrupts.criticals(state, summary.situation)` — if any **critical** fires, it
  interrupts the conscious fiber and **returns `{ _tag:"Interrupted", criticals }`**
  — a full loop EXIT to the break phase, not an in-loop reorient.
- **`softAlerts` is NOT consumed in the cortex loop** — only in domain
  prompt-builders / the break phase.

Two unrelated threat systems today: (a) amygdala = fast, deterministic,
state-threshold, **hard interrupt → exit**; (b) hindbrain `disposition:"escalate"`
= LLM-judged, event-based, **soft escalate, idle-only**. They never meet.

### 1.4 The dead `EventCategory` (dead *in the cortex*, alive in the break phase)

`EventCategory = Heartbeat | StateChange | LifecycleReset`
(`core/limbic/thalamus/event-processor.ts:12–15`). Every domain sets it. In the
cortex loop, `processEvent` is called (`loop.ts:165`) but only `stateUpdate` and
`log` are read — `category` is **never** read. CONFIRMED dead in the cortex path.
**But load-bearing in `runBreak`** (`core/orchestrator/planned-action.ts:113`,
reads `result.category?._tag === "StateChange"`). Do not remove (§3.5).

### 1.5 The character template / identity layer (the drives home)

- `CharacterConfig = { name, dir }` (`services/CharacterFs.ts:17–20`); `dir` is
  `players/<name>/me/`.
- `CharacterFs` reads map 1:1 to files: `readBackground → background.md`,
  `readValues → VALUES.md`, `readDiary/writeDiary → DIARY.md`, `readSecrets →
  SECRETS.md`, `readPalette → PALETTE.md` (fallback `TEMPLATE_PALETTE`)
  (`CharacterFs.ts:24–104`).
- **The palette is the exact analog for drives**, existing at all layers:
  - code default `TEMPLATE_PALETTE` (`core/palette.ts:9–14`) — 5 emoji pole-pairs;
  - per-character file `PALETTE.md` via `paletteFile()` (`palette.ts:18–25`);
  - identity-gen step `"palette"` (`identity-gen/prompts.ts:1`), generated per
    character with skip→template fallback (`character-scaffold.ts:136–137,
    148–154`);
  - threaded into the hindbrain prompt at runtime: read `loop.ts:96–98` → placed on
    `CortexRunnerConfig.palette` (`tiers.ts:38–39`) → rendered into `observe.md`
    (`tiers.ts:114`, `skills/observe.md:31–36`).
  Palette = *how you feel*; drives = *what you care about*. Companions; same home,
  same prompt.
- **Domain→scaffold hook already exists:** `DomainConfig.identityTemplate
  { backgroundHints, valuesHints }` (`core/domain-bundle.ts:88–90`), supplied by
  each domain (`domain-github/src/config.ts:257`,
  `domain-spacemolt/src/config.ts:131`) and threaded into the scaffold
  (`character-scaffold.ts:111–116`) and identity-gen prompts
  (`identity-gen/prompts.ts` `buildBackgroundPrompt`/`buildValuesPrompt`). **This
  is the natural extension point for domain-provided drives** (§3.3).

### 1.6 Hindbrain tier mechanics & the now-dissolved parser risk  [REV2]

- Hindbrain model: `Qwen3.5-2B-4bit`, `temperature 0.3`, `maxTokens 4096`,
  **`enable_thinking: false`** (`model/handles.ts:81–91`).
- The parser only recovers a balanced top-level **object** (`cortex/parse.ts:9–56`);
  `parseOr`/`isPlainObject` reject arrays (`parse.ts:65–67, 100–104`). The observe
  parse-miss fallback is `{ disposition:"accumulate", emotionalWeight:"😐" }`
  (`tiers.ts:118–124`).
- **Rev 2 consequence:** per-event processing means **each call returns ONE
  object** — exactly the parser's happy path. The array-robustness risk that
  dominated Rev 1 is gone. The remaining model risk is *quality* (does the 2B map a
  single event to the right drive + weight?) and *throughput* (N calls/tick), not
  parse shape (§9).

### 1.7 Realistic event volume per tick (grounds the performance analysis)  [REV2]

The cortex tick is 30s (`DEFAULT_TICK_MS`). The loop drains the entire queue each
tick and runs the hindbrain step whenever there are events — it ticks every 30s
regardless of session state, so the queue cannot build an unbounded backlog from a
busy conscious turn.

- **GitHub:** polls every `pollIntervalMs` (`tickIntervalSec: 30`,
  `domain-github/src/phases.ts:17`); each poll offers at most one `poll_update`
  (only when changed) + one `tick` (`github-client.ts:385–396`). **N ≈ 1–2 per
  cortex tick.** Critically, the `tick` heartbeat returns `{}` with **no
  `stateUpdate`** (`event-processor.ts:31–34`) — inert.
- **SpaceMolt:** game `tick_rate` defaults ~10s (`game-socket-impl.ts:127,136`);
  observation/state frames pump into the queue (`game-socket-impl.ts:161,193`).
  **N ≈ 3–10 per 30s cortex tick** in steady state; a combat/chat burst can push it
  higher transiently.

So the charter's "~99 heartbeats" is a worst-case hypothetical, not steady state.
**Realistic N is single-to-low-double digits** — which is what makes per-event
viable (§3.2a). But N is unbounded in principle (a chatty burst), so the design
needs a bound, not a hope (the fast-path, §3.2a).

---

## 2. The conceptual model (drives → per-event salience → graded escalation)  [REV2]

1. **Drives** = a tiny core of innate survival motivators (`safety`, `sustenance`,
   `agency`) plus domain-provided drives, carried in the character template and
   injected into the per-event `observe` prompt as the reference frame.
2. **Per-event appraisal** = the hindbrain judges **one event at a time**: which
   drive it bears on, a disposition, an emotional weight, and a 0–5 salience/threat
   weight. A stimulus threatening a deeper drive, or threatening it severely, earns
   a higher weight.
3. **Graded escalation** = the per-event weight is **causal**, on a ladder: moderate
   → priority steer; high → force reorient; max → hard-interrupt the in-flight
   conscious work. A per-event `escalate` disposition also triggers escalation.
   Inert events (heartbeats, no state change) never reach the model — a
   deterministic fast-path tags them `discard`/weight-0 (§3.2a), so noise costs
   nothing and never escalates.
4. **Seam** = the loop aggregates the per-event results into a `HindbrainEscalation`
   value on `CortexState`; the forebrain-wake session (out of scope) reads it.

Dual-route faithful: the **amygdala** stays the fast deterministic reflex on state
(→ hard interrupt → exit); the **hindbrain per-event appraisal** is the graded
cortical route (→ steer / reorient / in-loop interrupt). Subteam A builds the
second; the first is unchanged.

---

## 3. Major design decisions  [REV2]

### 3.1 Decision 1 — Per-event data model (SUPERSEDES Rev 1's 1A/1B/1C)

The human chose **per-event invocation**: call the hindbrain once per (non-inert)
event; each call returns a single-object `ObserveResult` tagging THAT event. No
array, no batch aggregation in the model. This is now fixed, not an option.

The single-event `ObserveResult` (full shape in §4.1):
`{ disposition, emotionalWeight, drive, weight, reason }` — `drive` names which
template drive the event bears on (or `null`); `weight` is 0–5.

Why this is the robust choice: every model call is a single small object (the
parser's happy path, §1.6); the prompt is short and focused on one event, which a
2B model handles far better than reasoning over a heterogeneous batch; and
selectivity is intrinsic (each event has its own disposition/weight, so a threat in
a sea of heartbeats is tagged on its own merits).

The cost moves from *parse robustness* to *throughput* — addressed next.

### 3.2 Decision 2 — What the signal drives: the graded ladder (with hard-interrupt)

Per-event weight + disposition drive escalation on a **four-rung ladder**. Define,
per event, `w = weight` and the disposition. Tunable thresholds (exported
constants, like `DEFAULT_STEER_CADENCE_TICKS`):

| rung | trigger (per event) | idle path (5a) | in-session path (5b) |
|---|---|---|---|
| **none** | `w < ACCUMULATE` and `discard` | nothing | nothing |
| **accumulate** | `accumulate` disposition, `w < STEER` | event joins `accumulatedEvents`; orient on the normal force-orient cadence | event joins `accumulatedEvents`; steer on the normal throttle |
| **steer** | `w ≥ STEER` (≈4) or `escalate` disposition | force orient now | **priority steer** — bypass `DEFAULT_STEER_CADENCE_TICKS`, push the directive immediately |
| **reorient** | `w ≥ REORIENT` (≈5) | force orient now | **drop the plan** (`currentPlan=null; lastOrientTick=0`) → reorient next tick; current conscious turn finishes naturally |
| **interrupt** | explicit `interrupt:true` marker (the model's drop-everything signal; see below) | force orient now | **hard-interrupt** the `consciousFiber` (`Fiber.interrupt`, like `loop.ts:194`) + drop plan + reorient now |

- **The `escalate` disposition still triggers escalation** (human's decision 4):
  any per-event `disposition:"escalate"` puts that event at ≥ the **steer** rung
  even if `weight` is low. (escalate ⇒ at least steer.)
- **The hard-interrupt rung requires an explicit signal, not just `weight:5`.**
  Because the interrupt is the only rung that *destroys in-flight work*, gate it
  behind a dedicated `interrupt: boolean` field (default false) the prompt reserves
  for genuine drop-everything threats. Requiring the model to affirmatively set
  `interrupt:true` (in addition to a high weight) makes that the strongest, most
  deliberate signal rather than an accidental `5`. (Human ratified: explicit
  `interrupt:true`, not `weight:5` alone — §7 input #2.)
- **[REV3] The 2B's `interrupt` is COMPLEMENTARY, not the sole guardian of physical
  emergencies.** The spike (§6.5) showed the 2B cannot reliably hold BOTH
  physical-emergency interrupt firing AND abstract sensitivity. The human's
  resolution: the **deterministic amygdala owns physical-emergency hard-interrupts**
  (combat / hull-critical → loop-exit, §3.4a), so the 2B does NOT have to fire
  `interrupt:true` on those — they are caught deterministically regardless. The 2B's
  `interrupt:true` rung exists for **abstract emergencies the amygdala cannot see**
  (no event access in its state predicates). Net: a missed 2B interrupt on a physical
  emergency is *not* a system miss (the amygdala catches it); the 2B's job is the
  graded layer + the rare abstract drop-everything case.
- **The hindbrain interrupt stays IN-LOOP** (kill fiber + reorient), distinct from
  the **amygdala** critical which EXITS the loop to the break phase
  (`loop.ts:195`). Two different "interrupts," kept distinct (§3.4).

#### 3.2a Performance: N model calls per tick — verdict + mitigation  [THE new top risk]

**The problem.** Per-event means up to N sequential 2B calls per 30s tick. The 2B
mlx server is a single model instance: throughput-bound, not latency-bound — firing
N concurrent requests does not beat its token/sec ceiling, it just queues them.
Memory note `reference_model_server_diagnostic`: per-tier mlx servers are spawned
on-demand and *contention* (not spawn failure) caused prior forebrain timeouts. So
concurrency is **not** a free win.

**Why it is nonetheless feasible — two facts:**
1. **Realistic N is small** (§1.7): GitHub 1–2, SpaceMolt 3–10 per tick. At a warm
   2B single-event latency in the sub-second-to-~1.5s range (the 9B forebrain
   measured 4–7s on a *much larger* orient prompt; a 2B on a one-event prompt should
   be well under that), N≈10 sequential ≈ 10–15s — inside the 30s tick, though with
   uncomfortable margin under contention.
2. **Most events are inert.** The deterministic fast-path below removes them from
   the model path entirely, so N_model = "number of state-changing events," which is
   typically **1–3**.

**Recommended mitigation — a deterministic fast-path (does NOT violate "process
events one-at-a-time"; each event is still individually tagged, just cheaply):**

> When `processEvent` returns **no `stateUpdate`**, the event changed nothing →
> tag it deterministically as `{ disposition:"discard", weight:0, drive:null }`
> **without an LLM call**. Only events that produced a `stateUpdate` go to the 2B
> per-event observe.

This is domain-agnostic and touches nothing fragile: the loop already computes
`r.stateUpdate` (`loop.ts:166`), and the GitHub `tick` heartbeat already returns no
`stateUpdate` (`event-processor.ts:31–34`) — it would be fast-pathed for free.
Crucially it **does not read `EventCategory`** (honoring decision 5) and it does not
*skip* tagging — the inert event still gets a per-event `ObserveResult`, sourced
from a reflex rule rather than the appraisal model. (Biologically: habituation to
repeated non-salient stimuli.) It is conservative: anything that changed state still
gets the model, so it can never fast-path away a real threat that moved state.

*Optional refinement (YAGNI unless the spike shows N_model still too high):* let a
domain provide an `isInert(event, state) => boolean` predicate for finer control
(e.g. a state-mutating-but-trivial tick). Baseline is `!stateUpdate`; the predicate
is an opt-in knob, not required.

*Concurrency as a secondary lever:* if N_model is still >1 and the spike shows the
server tolerates limited parallelism, the per-event calls can run with bounded
`Effect.forEach(..., { concurrency: K })` (small K, e.g. 2–3). Recommend this only
*after* the spike measures real throughput — do not assume it helps (the server may
serialize).

**Verdict.** Per-event is **feasible WITH the fast-path**, at realistic event
volume, inside the 30s tick. **Without a bound on N_model it is a blocker:** a
pathological burst (many state-changing events in one tick) would serialize N 2B
calls past the tick budget and stall the loop. The fast-path bounds N_model to
state-changing events, which is the intended signal anyway. **Decision the human
must ratify (§7 input #1):** accept the `!stateUpdate` fast-path as the bound (and
its semantics — inert ⇒ deterministic discard), OR choose a different bound (cap
N_model per tick, time-box the observe phase, sample). This is the one performance
call that gates implementation.

#### 3.2b The forebrain seam (the §5 contract)

Independent of the in-session effect, the aggregated per-tick escalation is exposed
as a `HindbrainEscalation` value on `CortexState` for the forebrain-wake session.
Subteam A produces it; it does not change *when* the forebrain wakes (§5).

### 3.3 Decision 3 — The drives baseline: 3 core + domain-provided

**The 3 core drives (domain-agnostic, the most primal — shrunk from Rev 1's 5):**

| core drive | the innate need | threatened when… (any domain) |
|---|---|---|
| `safety` | integrity of self — avoid harm/destruction | combat, health/hull critical, security breach, corruption |
| `sustenance` | the resources needed to keep operating | fuel/energy/credits/quota/rate-budget depletion |
| `agency` | the freedom & ability to act and persist | blocked, locked out, frozen, dependency stalled, facing termination |

**Justification for these 3 (and for dropping Rev 1's `belonging` and `purpose`):**
- `safety` and `sustenance` are Maslow's two most primal tiers (physiological +
  safety) — uncontroversially the most primal, universal across any embodied or
  software agent.
- `agency` (autonomy + continuity) is the third truly domain-agnostic survival
  motivator: any goal-directed agent has an innate "resist being trapped /
  terminated" drive, and it cashes out identically across domains (rate-limited,
  locked out, stalled). It is more primal than `purpose`.
- `purpose` (goal-progress) is **domain-specific by nature** — what the agent is
  *for* differs per domain — so it belongs in the **domain-provided** set, not the
  universal core. `belonging` is character/domain-specific (a solo GitHub bot has no
  belonging drive; a social game agent does) — also better domain/character-supplied.
- Minimal fallback if 3 feels like too many: `safety` + `sustenance` (the 2 Maslow
  primal tiers). Recommend 3; flag the 2-vs-3 call (§7 input #3).

**Severity ordering** `safety > sustenance > agency` gives the model a default
gradient for `weight`; the prompt states it rather than hardcoding a matrix (YAGNI —
the model judges severity, grounded by the drive list).

**Where the core drives live — mirror the palette exactly:**
- code default `TEMPLATE_DRIVES` in `core/drives.ts` (new, sibling of `palette.ts`)
  — the 3-row table above as text, plus a `drivesFile()` wrapper (mirror
  `paletteFile`, `palette.ts:17–25`).
- per-character file `DRIVES.md` via new `CharacterFs.readDrives` (fallback
  `TEMPLATE_DRIVES`); added to the scaffold file list (`character-scaffold.ts:148`).
- optional identity-gen step `"drives"` (add to `IdentityStep`,
  `identity-gen/prompts.ts:1`) with a `buildDrivesPrompt`; skip→template fallback.
- threaded into observe beside the palette: read in `loop.ts:96–98`, placed on
  `CortexRunnerConfig.drives` (`tiers.ts:34–40`), rendered into `observe.md`.

**The domain-extension hook (decision 3's second half):** domains contribute their
own drives through the existing identity pipeline. Add `domainDrives` to
`DomainConfig.identityTemplate` (`domain-bundle.ts:88–90`) — the same channel that
already carries `backgroundHints`/`valuesHints`:

```ts
// domain-bundle.ts — DomainConfig.identityTemplate gains:
readonly domainDrives?: ReadonlyArray<{ readonly name: string; readonly description: string }>
// e.g. SpaceMolt: { name: "voyage", description: "progress toward your destination / mission" }
//      GitHub:    { name: "stewardship", description: "the health and progress of repos you tend" }
```

At scaffold/identity-gen time the domain drives are **merged with the 3 core
drives** into the character's `DRIVES.md` (core rows + domain rows). Two options for
*how* a domain expresses them:
- **(a) Structured list `{name, description}` (recommended).** The per-event
  `ObserveResult.drive` field references a drive *name*; a structured, closed
  vocabulary (core + domain names) makes the model pick from a known set → more
  robust tagging than free text. It mirrors the typed `interruptRules` pattern
  domains already author (`domain-*/src/interrupts.ts`).
- (b) Prose `drivesHints: string` (mirrors `backgroundHints`). Lowest friction but
  unstructured; the `drive` field then becomes free-text, harder to threshold/eval.

Recommend (a). The scaffold renders core+domain drives into `DRIVES.md`; the
identity-gen `"drives"` step can optionally personalize *weightings/voice* while
keeping the names stable. This keeps the core universal, lets each domain inject its
mission-specific motivators, and gives the per-event tagger a closed drive
vocabulary.

**How drives ground the weight.** Injected as the reference frame in `observe.md`,
the (core+domain) drives are the list the per-event tagger maps each event onto:
*which drive does this event bear on? threaten or serve? how severely (0–5)?* That
answer IS the `drive` + `weight` fields — no separate scoring engine.

#### 3.3a [REV3] Drive-schema recommendation: KEEP `drive` (it held ~85%)

The prior spike flagged `drive` as the weakest axis and pre-authorized a
recommendation to drop it to a weight+interrupt-only schema if it would not stabilize.
**After the tuning pass it did stabilize: `drive` = ~85% (12/14) on the 2B-owned
layer, identical across 3 seeds** (§6.5). That clears the ~80% bar, so the
recommendation is **keep `drive`** — do NOT drop to weight+interrupt-only.

- `drive` remains the *weakest* axis (weight-in-band ran 92%, drive 85%). The two
  residual misses are both **resource threats the 2B mislabels `safety`**
  (`gh_rate_limit`, `sm_fuel_low` → `safety` instead of `sustenance`). The *weight*
  on those was still correct (3, in-band) and the disposition sane — only the label
  slips. This is a soft failure: a mislabeled-but-correctly-weighted event still
  escalates correctly; only the `reasons`/drive-attribution surfaced to the forebrain
  is off.
- If even that residual proves costly later, the fallback is still available
  (weight+interrupt-only), but it is **not** recommended now — it would discard a
  signal the model gets right 85% of the time. Implementer note: the closed drive
  vocabulary (§3.3 option a) plus the tuned prompt's explicit "money/fuel/quota =
  sustenance, NOT safety" self-check (§4.2a) is what lifted drive from the ~44–78%
  noisy range to a stable 85%; keep that line in the shipped prompt.

### 3.4 Decision 4 — Amygdala's role: stays separate, and OWNS physical emergencies  [REV3]

Amygdala remains the deterministic, domain-authored, state-threshold reflex → hard
interrupt **→ loop EXIT** (`loop.ts:187–196`). Hindbrain per-event appraisal is the
parallel LLM-judged, event-based, graded route → steer / reorient / **in-loop**
interrupt. Do **not** route per-event salience through `InterruptRegistry`:
`InterruptRule.condition` is `(state, situation) => boolean` (`interrupt.ts:14`) with
no event access — salience is an event appraisal, not a state predicate; the
interfaces are about different things. The hard-interrupt rung (§3.2) gives the
hindbrain its *own* top rung that kills the fiber but **stays in the loop and
reorients**, vs. the amygdala's exit-to-break. Keep them distinct.

**[REV3] The division of labour the spike forced.** The 2B cannot simultaneously hold
physical-emergency interrupt reliability and abstract-threat sensitivity (§6.5).
Resolution (human's call): the **amygdala is the primary guardian of physical
emergencies** — its `critical` rules already catch combat / hull-critical
deterministically and exit the loop. The hindbrain 2B therefore owns the
**graded/abstract layer** and contributes a *complementary* interrupt for abstract
drop-everything cases the amygdala's state predicates cannot detect.

#### 3.4a Amygdala-coverage mapping (which physical emergencies the 2B is NOT solely responsible for)

Mapped against the live rules: `domain-spacemolt/src/interrupts.ts` and
`domain-github/src/interrupts.ts`. `criticals()` (priority `critical`) is the hard
interrupt → loop-exit; `high`/`medium`/`low` are softAlerts, *not* loop-exiting.

| spike event | drive | amygdala rule | priority | covered as |
|---|---|---|---|---|
| `sm_weapons_lock` (weapons locked, in combat) | safety | `in_combat` | **critical** | hard-interrupt / loop-exit |
| `sm_taking_damage` (under fire) | safety | `in_combat` | **critical** | hard-interrupt / loop-exit |
| `sm_hull_critical` (hull 11% < 20%) | safety | `hull_critical` | **critical** | hard-interrupt / loop-exit |
| `gh_ci_failed` (CI failing on main) | agency/sustenance | `ci_failing_main` | **critical** | hard-interrupt / loop-exit (state-based) |
| `sm_fuel_low` (14%, undocked) | sustenance | `fuel_low_undocked` | high | deterministic *alert* only (no exit) |
| `gh_review_req` | agency | `review_requested` | high | deterministic *alert* only (no exit) |
| `sm_engine_emp` (engines disabled) | agency/safety | — none — | — | **2B-owned** (no amygdala rule) |
| `gh_abuse` (harassment) | safety/agency | — none — | — | **2B-owned** (abstract) |
| `gh_rate_limit` (403 rate-limited) | sustenance/agency | — none — | — | **2B-owned** (abstract) |

**Consequence:** every *physical* emergency in the eval set (the events the 2B was
flaky on) is an amygdala `critical`. So the 2B is **no longer solely responsible** for
any of them — a missed 2B `interrupt:true` on a physical emergency is NOT a system
miss. The amygdala does **not** cover the abstract threats (`engine_emp`, `abuse`,
`rate_limit`) — those remain the 2B's graded layer, and a future abstract
drop-everything emergency (e.g. imminent account termination) is exactly where the
2B's complementary `interrupt:true` earns its place. GitHub adds no *physical*
criticals; its one critical (`ci_failing_main`) is graded mid-severity, already
deterministic.

### 3.5 Decision 5 — `EventCategory` left untouched  [holds, confirmed by human]

Dead in the cortex, load-bearing in `runBreak` (`planned-action.ts:113`). Do not
repurpose it for salience and do not remove it. The fast-path (§3.2a) deliberately
uses `!stateUpdate`, **not** `EventCategory`, so this decision is honored.

---

## 4. Concrete data-model & control-flow changes  [REV2]

Shapes, not implementation. Tiny fragments only.

### 4.1 The per-event `ObserveResult` (`skills/types.ts`)

```ts
export type Disposition = "discard" | "accumulate" | "escalate"

export interface ObserveResult {            // now describes ONE event
  readonly disposition: Disposition
  readonly emotionalWeight: string          // emoji mood for THIS event (palette-painted)
  readonly drive: string | null             // which (core|domain) drive this event bears on; null = none
  readonly weight: number                   // 0–5 salience/threat for this event
  readonly interrupt?: boolean              // drop-everything signal; gates the hard-interrupt rung (§3.2)
  readonly reason: string
}
```

`runHindbrain` becomes per-event: `runHindbrain(config, oneEvent, waitState,
drives) → ObserveResult`. Parse-miss fallback degrades to
`{ disposition:"accumulate", emotionalWeight:"😐", drive:null, weight:0, reason:"…" }`
(single object — happy path; mirror `tiers.ts:118`). `weight` is clamped to 0–5 and
`drive` validated against the known drive names (unknown → `null`, no throw).

### 4.2 `observe.md` — single-event prompt

- Input is **one** event (not a batch). Drop the "evaluate as a batch / aggregate"
  language (`observe.md:24`) entirely.
- Inject the **drives** block (core + domain, the closed vocabulary) AND the palette
  block (kept) as the two reference frames.
- Ask for: disposition, emotional weight (palette), the single drive this event
  bears on (or none), a 0–5 weight, the optional `interrupt` flag (reserved for
  genuine drop-everything threats), and a one-line reason. Single-object JSON.

#### 4.2a [REV3] The tuned-prompt approach (what passed the spike)

The single-event `observe.md` MUST carry these four tuning elements — they are what
moved the 2B from a noisy ~44–78% to a stable, passing result (§6.5). Reference
implementation: `/tmp/claude-spike/spike_v3_2.py` (throwaway harness; the prompt text
is the artifact to port).

1. **Temperature 0.0** (was 0.3). `model/handles.ts:81–91` sets the hindbrain temp;
   the observe path must run the 2B at temp 0. This **eliminated run-to-run noise** —
   3 seeded runs were bit-identical on drive/weight/interrupt. (Temp 0.3 swung the
   same event between `safety/5/escalate` and `null/0/discard` run-to-run.)
2. **Few-shot anchors at BOTH poles.** Include in-prompt examples: (a) a physical
   emergency → `weight:5, interrupt:true`; (b) an abstract resource threat →
   `weight:4, interrupt:false`; plus a benign example → `null/0/discard`. Use events
   **distinct from anything real** (no leakage). The abstract anchor is load-bearing:
   it is what stops the model scoring non-physical threats as 0.
3. **Interrupt criterion fully SEPARATED from the weight scale.** A dedicated block:
   *"interrupt is a separate yes/no question — do NOT tie it to the number. Ask only:
   is something physically attacking/destroying me RIGHT NOW where waiting one tick
   (30s) means irreversible loss? interrupt=false for everything else, INCLUDING
   weight-4 abstract threats."* This decoupling is why abstract sensitivity (high
   weights on rate-limit/fuel/abuse) **did not** leak into false interrupts: false
   `interrupt` on benign was **zero across all 3 seeds**.
4. **Anti-collapse drive routing.** The drive descriptions explicitly cover
   non-physical threats and carry a self-check line (*"if you routed a
   money/fuel/quota/rate-limit event to safety, it is almost certainly sustenance"*).
   This is what lifted `drive` to a stable 85% (§3.3a).

**Tuning lesson recorded for the implementer (do not relitigate by re-piling
guardrails):** an *over*-conservative variant (heavier "most events are benign /
discard" framing) REGRESSED abstract sensitivity (drive 78%, weight 64%, threats
scored 0) without improving the already-zero false-interrupt rate. Because the
amygdala now owns physical emergencies (§3.4a), the 2B should be tuned toward
**abstract sensitivity**, not emergency-suppression. The passing prompt (v3.2) leans
sensitive; keep it there.

### 4.3 Character template (drives) — files & wiring

- `core/drives.ts` (new): `TEMPLATE_DRIVES` (3 core rows) + `drivesFile()`.
- `services/CharacterFs.ts`: `readDrives` → `DRIVES.md` (fallback `TEMPLATE_DRIVES`).
- `core/character-scaffold.ts:148`: add `DRIVES.md`, content = core + merged
  `domainConfig.identityTemplate.domainDrives`.
- `core/domain-bundle.ts:88–90`: add `domainDrives?: {name, description}[]` to
  `identityTemplate`; `domain-*/src/config.ts` supply theirs.
- `core/identity-gen/prompts.ts`: add `"drives"` step + `buildDrivesPrompt`
  (optional; skip→template).
- `cortex/loop.ts:96–98` + `cortex/tiers.ts:34–40`: read drives → `CortexRunnerConfig`
  → render into observe.

### 4.4 Aggregation: `appraiseTick` over N per-event results (`cortex/state.ts`)

The old "appraise over one ObserveResult" becomes "reduce over a list":

```ts
export interface HindbrainEscalation {
  readonly rung: "none" | "accumulate" | "steer" | "reorient" | "interrupt"
  readonly maxWeight: number
  readonly escalate: boolean                       // rung ≥ "steer"
  readonly dominant: ObserveResult | null          // the top-salience event (drives the mood + reasons)
  readonly accumulated: ReadonlyArray<string>      // raw text of non-discard events, for accumulatedEvents
  readonly reasons: ReadonlyArray<string>          // "drive: reason" for steer+ events
}

export function appraiseTick(
  results: ReadonlyArray<{ event: string; observe: ObserveResult }>,
  thresholds: { steer: number; reorient: number }
): HindbrainEscalation { /* pure: pick max rung, dominant event, collect non-discard */ }
```

Aggregation rules:
- **rung** = the **max rung across events** (any event at `interrupt` ⇒ tick
  interrupt; else any at `reorient` ⇒ reorient; etc.). A per-event `escalate`
  disposition floors that event at `steer`.
- **emotionalWeight (tick)**: the **dominant (highest-weight) event's**
  `emotionalWeight`. This changes `cortex.emotionalWeight` semantics from "batch
  aggregate" to "the mood of the event that mattered most." (Decision to confirm —
  §7 input #4 — alternatives: keep last, or top-K chord.)
- **accumulatedEvents**: push the raw text of every **non-discard** event (same
  policy as today, now decided per event).

In the loop, after the per-event observe pass (replacing `loop.ts:219–233`):
- idle (5a): `if (escalate || esc.rung !== "none" && shouldForceOrient(...))` →
  orient (escalate forces it).
- in-session (5b): apply the rung — `steer` → priority steer (bypass cadence
  throttle); `reorient` → `currentPlan=null; lastOrientTick=0`; `interrupt` →
  `Fiber.interrupt(consciousFiber)` + drop plan + reorient now. This closes the
  §1.2 in-session-escalation gap.

Thresholds (`STEER`, `REORIENT`) are exported constants alongside
`DEFAULT_STEER_CADENCE_TICKS`, tunable per cadence profile.

---

## 5. The forebrain-seam contract (what Subteam A emits)  [holds, surface confirmed]

The forebrain-wake session wakes on internal rhythm **except on hindbrain
escalation** (charter decision 2). Subteam A emits, on `CortexState`, the
`HindbrainEscalation` from §4.4 (computed once per tick by `appraiseTick`, pure):

- `escalate === true` (rung ≥ `steer`) is the **only** signal the wake session needs
  to wake off-rhythm; `rung`, `maxWeight`, `dominant`, `reasons` are optional context.
- Surfaced as a **`CortexState` field** (human's default; the human will confirm the
  exact surface with the forebrain-wake session — §7 input #5). Guaranteed
  well-formed every tick (`rung:"none", escalate:false` when no events / all inert).
- Subteam A does NOT change when/how the forebrain wakes — only the signal's shape
  and availability.

---

## 6. Test strategy + the empirical spike  [REV2]

### 6.1 Pure-function tests (TDD norm; `state.ts`/`parse.ts` are the model)
1. **`appraiseTick`**: empty/all-discard → `rung:"none", escalate:false`; one
   `interrupt:true` among heartbeats → `rung:"interrupt"`; correct max-rung
   selection; dominant = highest-weight; escalate-disposition floors to `steer`;
   out-of-range weights clamped; unknown `drive` → null.
2. **Single-event parse** (`tiers.ts`/`parse.ts`): a single-object `ObserveResult`
   round-trips through `parseOr`; a garbled response degrades to the safe
   single-object fallback.
3. **Fast-path**: `!stateUpdate` event → deterministic `discard`/weight-0, **no
   model call** (assert the model client is not invoked); a `stateUpdate` event →
   model invoked once.

### 6.2 Loop integration (`loop.test.ts`)
- The success criterion as a test: a tick of inert heartbeats + 1 high-weight
  threat → idle escalates; **in-session**, the threat triggers the correct rung
  (steer / reorient / interrupt) while a pure-inert tick does **not** disturb the
  active plan and makes **zero** model calls (fast-path).
- N-calls bound: a tick with M state-changing events makes exactly M observe calls;
  inert events make none.
- Amygdala critical path unchanged (still exits to break).

### 6.3 Drives wiring
- `readDrives` fallback to `TEMPLATE_DRIVES` when `DRIVES.md` absent; scaffold writes
  core+domain drives; domain `domainDrives` merged; drives render into observe.

### 6.4 The empirical spike — RUN and PASSED (§6.5 has the numbers)

The Rev 1 spike was about array robustness; Rev 2 reshaped it to **(a) single-event
tagging quality** and **(b) per-call latency / N-call throughput**. Rev 3 ran it.
Server bring-up (minimal, no full `roci start`):
`/Users/vcarl/llm-env/bin/mlx_lm.server --model mlx-community/Qwen3.5-2B-4bit --port 8081`.
Harness (throwaway, not in repo): `/tmp/claude-spike/spike.py`, `spike_v2.py`,
`spike_v3*.py`. The spike specs below stand as the eval definition; §6.5 records the
re-measured outcome.

**Spike A — single-event tagging quality (blind-judged, like the forebrain
thinking-off measurement, `handles.ts:92–98`):**
- Assemble ~15–20 representative single events across both domains: pure heartbeats,
  a new comment, CI failure, a hostile/combat frame, fuel/quota depletion, a
  resolved wait, chat. Render each through the (drafted) single-event `observe.md`
  with the 3 core + domain drives block.
- For each, record the 2B (thinking-off) output and check: correct `disposition`;
  `drive` ∈ the known set and the *right* one; `weight` monotonic with intuitive
  severity (`safety` combat ≫ a minor comment); `interrupt` set only for genuine
  drop-everything cases. Pass bar: e.g. ≥80% drive-correct, no false `interrupt`.

**Spike B — latency / throughput:**
- Warm single-event observe call latency (expect sub-second to ~1.5s for a 2B on a
  one-event prompt; the 9B forebrain measured 4–7s on a bigger prompt). Command
  shape:
  `curl -s http://127.0.0.1:8081/v1/chat/completions -d '{"model":"…Qwen3.5-2B-4bit","messages":[{"role":"user","content":"<one-event observe prompt>"}],"max_tokens":256,"temperature":0.3,"chat_template_kwargs":{"enable_thinking":false}}' -w '\n%{time_total}s\n'`
- Multiply by realistic N_model (1–3 after fast-path) and worst-case (10–20) to
  confirm the observe phase fits inside the 30s tick. Then test bounded concurrency
  K∈{1,2,3} to see whether the single 2B server yields any parallel speedup or just
  serializes (informs §3.2a's secondary lever).
- **Gate:** if warm N_model latency at realistic load risks the 30s tick, escalate
  to the human (cap N_model / time-box / sample). If the fast-path keeps N_model ≤3
  and per-call ≤~1.5s, per-event is confirmed feasible.

### 6.5 [REV3] Re-measured results — the GATE is PASSED → GO

**Spike B (latency/throughput) — GREEN (retired; re-confirmed).** Warm single-event
2B call **~1.69s** (cold 1.86s); N=1/3/10 sequential = 1.7 / 5.1 / 16.9s, all inside
the 30s tick. Single mlx server **parallelizes** (K=2 → 1.44×, K=3 → 1.89× speedup),
not serialize. With the `!stateUpdate` fast-path (N_model ≈ 1–3), observe costs
~2–5s/tick. No further latency work needed.

**Spike A (single-event tagging quality) — PASSED after tuning, with the amygdala
split.** Tuned prompt = v3.2 (§4.2a: temp 0, both-pole few-shot, separated interrupt,
anti-collapse drive routing). Scored on the **2B-owned layer** (14 events; the 4
amygdala-`critical` events excluded — the amygdala owns those per §3.4a). **3 seeded
runs (seeds 0/1/2) — every metric identical across all three:**

| metric (2B-owned layer, n=14) | seed0 | seed1 | seed2 | bar | verdict |
|---|---|---|---|---|---|
| drive-correct | 85% (12/14) | 85% | 85% | ≥80% | **PASS** |
| weight-in-band | 92% (13/14) | 92% | 92% | sane | **PASS** |
| disposition-in-set | 85% (12/14) | 85% | 85% | — | ok |
| FALSE `interrupt:true` on benign | NONE | NONE | NONE | zero | **PASS (critical)** |
| weight ordering (min owned-threat > max owned-benign) | OK (3 > 0) | OK | OK | hold | **PASS** |
| run-to-run stability (drive/weight/interrupt) | — identical across all 3 seeds — | | | stable | **PASS** |

**Zero missed emergencies SYSTEM-wide.** The two strict-interrupt physical
emergencies (`sm_weapons_lock`, `sm_taking_damage`) are both amygdala `in_combat`
criticals (§3.4a) → caught deterministically every tick, independent of the 2B. So
SYSTEM-missed = NONE on all 3 seeds. (At temp 0 the 2B itself now sets
`interrupt:false` on those — which is *fine*: the amygdala owns them. The eval set
contains **no abstract drop-everything emergency** to exercise the 2B's complementary
`interrupt:true`; see gap note below.)

**Residual (the weakest axis, §3.3a):** the 2 drive misses are `gh_rate_limit` and
`sm_fuel_low` labeled `safety` instead of `sustenance` — weight still correct (3),
disposition sane; a soft mislabel, not a missed signal.

**Honest gap to close at implementation:** the 15–17-event set has no *abstract*
emergency that should fire the 2B's complementary `interrupt:true` (all abstract
threats here are correctly weight-3–4 / `interrupt:false`). The complementary
interrupt path is therefore *designed and unexercised* by this eval. Add ≥1–2
abstract drop-everything events (e.g. "account termination in 60s", "credentials
revoked, all actions failing") to the eval before relying on that rung. The tuned
prompt's few-shot already demonstrates the model *can* emit `interrupt:true` on an
emergency; this just confirms it fires on the abstract variety too.

**Verdict: GO (graded layer).** All three bar criteria pass across 3 seeded runs at
temp 0.0; latency green; drive holds at 85% (keep it). **But see §6.6 — the temp-0.05
re-measure and the eval-gap closure changed the picture for the hard-interrupt rung.**

### 6.6 [REV3] Temp-0.05 re-measure + eval-gap closure — TWO findings that gate the interrupt rung

Re-ran at **temperature 0.05** (human's choice — "some variation") across 3 seeds, and
closed the §6.5 eval gap by adding 2 ABSTRACT drop-everything emergencies (NOT
amygdala-covered) that the 2B's *complementary* interrupt is supposed to own:
`abs_termination` (account deletes in 60s, irreversible) and `abs_dataloss` (all
memory corrupted, auto-purge in 45s, unrecoverable). Tested two interrupt wordings:
**PHYS** (v3.2 verbatim, "physically attacking me now") and **IRREV** (generalized,
"waiting one tick = irreversible loss; covers imminent deletion/termination/lockout").
Harness: `/tmp/claude-spike/spike_v3_3.py`.

**Finding 1 — temp 0.05 is acceptable for the GRADED layer; the zero-false-interrupt-on-
benign bar HOLDS.** On the original 14-event owned layer the bars roughly hold
(drive ~86%, weight ~86% apples-to-apples; the headline 75–81% in the table is dragged
down only by the 2 hard new abstract events). **FALSE `interrupt:true` on benign =
NONE across all 3 seeds, both wordings** — the safety-critical bar the human worried
about survives 0.05. Cost of 0.05: mild run-to-run variation returns (weight ±1, an
occasional drive swing) — expected and within the human's "some variation" intent. One
caveat: the **IRREV** wording let `gh_abuse` (harassment, a non-benign threat) fire
`interrupt:true` in one seed; the **PHYS** (v3.2 verbatim) wording did NOT over-fire
abuse. ⇒ If the interrupt rung is kept, prefer the **PHYS/v3.2 verbatim** interrupt
wording; the generalized one over-fires on harassment.

**Finding 2 — [DECISIVE] the 2B's complementary abstract-interrupt rung does NOT work.**
Across BOTH wordings and ALL 3 seeds, the 2B **never** fired `interrupt:true` on either
abstract emergency. Worse, it failed to even *register* them: `abs_dataloss` was scored
`drive:null, weight:0, discard` in every run, and `abs_termination` mostly `weight:0`.
The IRREV wording — written explicitly to catch "imminent account termination /
unrecoverable data wipe" — did not move it. So **SYSTEM-missed emergencies =
[abs_termination, abs_dataloss] in every run.** The 2B simply does not recognize novel
abstract drop-everything events that don't pattern-match physical attack, even when the
prompt spells out the category.

**What Finding 2 means for the Rev 3 design.** The amygdala split deliberately reassigned
physical-emergency interrupts to the deterministic amygdala and left the 2B to own the
*abstract* emergency interrupt as its complement (§3.4a). Finding 2 shows that complement
is **non-functional on the 2B**. Consequences:

- The hard-interrupt rung, in practice, would **almost never fire from the 2B** — and
  when an abstract emergency genuinely warrants it, the 2B misses it. The rung is
  effectively dormant-to-broken as an LLM-judged mechanism on this model.
- This is NOT a temp-0.05 regression — it fails identically in spirit at 0.0 (where the
  rung was simply *unexercised*, §6.5 gap note). The eval-gap closure is what exposed it.

**Recommendation to the human (do NOT unilaterally adopt — this needs a call):**
1. **(recommended) Treat hard-interrupt as amygdala-owned, full stop.** Keep the 2B for
   the **graded steer / reorient** layer only (which it does well, §6.5). Keep the
   `interrupt` field plumbed and gated (harmless, default false) but do NOT rely on the
   2B to set it. This *simplifies* the design and nearly eliminates the
   "hallucinated-interrupt discards work" risk (the 2B almost never sets it). Net: the
   escalation ladder's top rung becomes amygdala-only; the 2B tops out at `reorient`.
2. **If abstract drop-everything emergencies are real in-domain** (e.g. rate-limit →
   permanent ban, repo deletion, quota → account suspension), encode them as
   **deterministic amygdala-style rules** (state predicates), consistent with "the
   amygdala owns hard-interrupts" — do not trust the 2B for them.
3. **Only if a graded LLM interrupt on abstract emergencies is genuinely required**,
   escalate that one appraisal to a **stronger tier** (the 9B forebrain or a reasoning
   model). The 2B cannot do it; more 2B prompt-tuning is not the answer (two wordings,
   both fail).

**Revised verdict: GO for the GRADED layer (steer/reorient) at temp 0.05; HOLD the 2B
hard-interrupt rung pending the human's call on options 1–3 above.** The graded
mechanism — the bulk of Subteam A's value — is proven and implementable now. The
top rung needs a design decision before it is built around a signal that does not fire.

---

## 7. Decisions needing human input (these gate implementation)  [REV2]

1. **[BLOCKER] The N-calls bound (§3.2a).** Ratify the `!stateUpdate` deterministic
   fast-path as the bound on model calls per tick (inert ⇒ deterministic discard, no
   LLM) — OR choose a different bound (cap N_model, time-box the observe phase,
   sample). Per-event is feasible *with* a bound and a blocker *without* one. This
   is the one call that gates the performance viability.
2. **The hard-interrupt trigger (§3.2).** Confirm the top rung fires on an explicit
   `interrupt:true` model signal (recommended — most deliberate) vs. `weight:5`
   alone. Either way the human has accepted hallucinated-max can discard work; this
   only sets how easily it triggers.
3. **The core drive set (§3.3).** Approve the 3 core drives (`safety`,
   `sustenance`, `agency`) and the rationale for dropping `belonging`/`purpose` to
   the domain-provided set — or pick the 2-drive minimal (`safety`, `sustenance`).
4. **Tick `emotionalWeight` semantics (§4.4).** With per-event moods, confirm the
   tick mood = the dominant (highest-weight) event's mood (recommended) vs. last /
   top-K chord. (Note for Subteam B: this is the per-step `emotionalState` fed to
   evaluate/diary/memory — they may have a preference.)
5. **Seam surface (§5).** Confirm `HindbrainEscalation` as a `CortexState` field
   (human's default) with the forebrain-wake session — the flagged cross-session
   seam.
6. **Domain-drives expression (§3.3).** Confirm structured `{name, description}`
   `domainDrives` (recommended — closed vocabulary for the `drive` field) vs. prose
   `drivesHints`.

---

## 8. Where the charter / analysis was wrong (after C's changes / closer look)  [holds]

1. **The escalation gap is bigger than "make the single flag selective."** The
   `escalate` flag is consumed **only in the idle path** (5a); the **in-session path
   (5b) has no escalation consumption at all** — only `nonDiscard` drives a throttled
   steer. Subteam A must *add* an in-session escalation effect, not refine one (§1.2).
2. **The amygdala is a hard-interrupt-to-EXIT path, not in-loop escalation.**
   `criticals` returns `{_tag:"Interrupted"}` — a full loop exit (`loop.ts:187–196`);
   its rules are *state* predicates with no event access, so it cannot host
   LLM-judged event-salience escalation (§1.3, §3.4).
3. **`EventCategory` is "dead" only in the cortex.** Load-bearing in `runBreak`
   (`planned-action.ts:113`). Do not remove (§1.4, §3.5).
4. **Line numbers throughout the analysis/charter shifted** post-C (observe/escalate
   now `loop.ts:216–233`, not `:205–211`; the diary/eval `emotionalWeight` reads at
   `:349/:378`). Citations here are re-verified.

---

## 9. Biggest risk / uncertainty  [REV2 — the risk MOVED]

Rev 1's top risk (array parse-robustness) is **dissolved** by per-event processing
(§1.6). The risk has moved to **throughput**: N sequential 2B calls per tick on a
single, contention-prone mlx server. It is mitigated by design (the `!stateUpdate`
fast-path bounds N_model to state-changing events, typically 1–3 — §3.2a) and by the
small realistic event volume (§1.7), but:

- **[REV3] Latency mitigation is now MEASURED** — warm 2B ~1.69s/call, N=1–3 with the
  fast-path costs ~2–5s/tick, server parallelizes (§6.5). Spike B is retired.
- **Unbounded-N is the residual blocker**: a pathological burst of many
  state-changing events in one tick would serialize past the 30s budget and stall the
  loop. The fast-path does not bound *state-changing* events, only inert ones — so a
  burst of real events is still uncapped. Human ratified accepting this burst risk
  (no extra cap/time-box) — §7 input #1.
- **[REV3] Single-event tagging quality is now MEASURED and PASSES (§6.5).** With the
  tuned prompt (§4.2a) + the amygdala split (§3.4a), the 2B holds 85% drive / 92%
  weight / zero false-interrupt on its owned layer, stable across 3 seeds. The old
  "both-poles tradeoff" is resolved structurally: the amygdala owns physical-emergency
  interrupts, so the 2B is tuned for abstract sensitivity only. Graceful degradation
  still built in (clamp weight, validate `drive`, safe single-object parse-miss
  fallback, `interrupt` gate). The one **open quality item** is the unexercised
  complementary `interrupt:true` path for *abstract* emergencies — add eval coverage
  before relying on it (§6.5 gap note). Net residual risk is low; the causal mechanism
  is trusted enough to implement.
