# QA punchlist — fresh character run

Written 2026-08-03 after building recall instrumentation on `feat/salience-axes`.
Purpose: this run produces the **first dataset that can answer** the memory-scoring
questions four offline studies dead-ended on. Most checks exist because something was
silently broken and nobody could tell.

**STOP** = fix before continuing; the run won't produce usable data.
**WATCH** = record it; it shapes what the data can prove.

Related: `packages/core/src/logging/recall-telemetry.ts`, `recall-usage.ts`.
Prior findings: memory `salience-measurement-findings`, `recall-instrumentation`.

---

## Preflight

- [ ] **STOP — run from `feat/salience-axes`.** All recall telemetry is on this branch;
      **none exists on `main`**. A run from main silently produces no candidate pool, no
      score components, no usage labels.
- [ ] **STOP — rebuild first:** `pnpm install && npx nx build @roci/core`
      `./roci` runs from source via tsx but imports `@roci/core` from `dist`. Skipping this
      executes the previous compiled build. No error, stale code.
- [ ] **STOP — no other run active** against this character. Concurrent runs interleave logs
      and neither is analysable. Read `roci-qa/CALIBRATION.md` first (prior-run root causes).
- [ ] **WATCH — injection on, seed recorded:**
      `ROCI_RECALL_INJECTION_RATE` (default `0.05`, `0` disables) and
      `ROCI_RECALL_INJECTION_SEED`.
      5% ≈ **50 control observations per 1000 recalls** — the binding constraint on every
      treatment-vs-control comparison. Short run → consider raising (perturbs the agent more).
- [ ] **WATCH — embed server up before the character starts.** `ROCI_EMBED_MODEL` is published
      only on successful spawn and feeds `scoringContext.embedder`. Absent → every record
      stamped with an unknown embedder, cross-run pooling becomes guesswork.
- [ ] **WATCH — no `--bare` flag** (disables OAuth token resolution).

---

## First few minutes — does the plumbing emit

- [ ] **STOP — both streams exist and grow:**
      ```
      players/<name>/logs/recall-telemetry.jsonl
      players/<name>/logs/recall-usage.jsonl
      ```
      Telemetry is fire-and-forget so it never breaks the tick — which means it **fails
      silently**. Absent files after several ticks = instrumentation not running.
- [ ] **STOP — the streams join.** Every usage record carries its recall's `recallId`.
      Anti-join both directions; losses are console-only, so counting is the only way to know.
      *A usage signal that can't be joined to the candidate pool is nearly worthless.*
- [ ] **STOP — `scoringContext` populated, not null.** Check `axisVocabHash`, `axisGlossHash`,
      `constantsHash`, `embedder.model` all carry real values. A stamp that fails to populate
      produces false confidence rather than an error.

---

## The four known defects — do they reproduce on a fresh character?

- [ ] **STOP — does `salienceProfile` share keys with `scoringContext.axisNames`?**
      Compare them **in the same record**. On vcarl they share almost nothing → `salienceWeight`
      returns a constant for every memory → the term is **inert**.
      `character-scaffold.ts` generates `SALIENCE.md` from `PALETTE.md`, so a fresh character
      *should* be consistent (vcarl predates the generator). **Verify, don't assume.** Mismatch
      = the salience half of the run is unmeasurable; fix before proceeding.
- [ ] **STOP — is `dims` being written?** Watch `dimsAxes` on candidates. It is **0 on all 825
      rows** of the existing corpus, which is why no salience or mood study was possible there.
      Also check `dims_a` and `dims_c` **separately** in the store — the C stage (the model's own
      reading) has never once been measured in this project.
- [ ] **WATCH — does `mood.json` appear and does the EMA move?** Watch `mood.norm` and
      `mood.nonZeroAxes`. On vcarl the file doesn't exist → `sit` is exactly `1` on every
      candidate. `norm` stuck at 0 across many ticks = the EMA never received a non-empty
      vector. **This is a plumbing failure that looks exactly like a null result.**
- [ ] **STOP — is decay drowning relevance?** Corrected 2026-08-03 by per-term counterfactuals:
      decay is **not** inert — it **dominates**. Neutralising it changed the returned set on all
      three measured recalls (overlap 0/5, 1/5, 1/2; Spearman **−0.49 / −0.25 / −0.05**,
      anti-correlated). Live ranking is `rel × rec`, not `rel × rep`.
      Cause is tuning: `halfLife(0.4) ≈ 13.9 h` against a weeks-old corpus collapses the composite
      to **"newest first"**. On a fresh character all memories are young, so watch whether `rec`
      spans orders of magnitude within a single pool. **`HALF_LIFE_MIN/MAX` (`[1h, 30d]`, an
      unvalidated first guess) want retuning before any ranking study means anything.**

---

## Once memories accumulate — do the signals have range?

- [ ] **STOP — does the usage metric have usable dynamic range?**
      *The open question the run exists to answer.* Plot `contentContainment` across returned
      candidates. The one real pair measured so far: **0.06–0.10, no 3-gram match anywhere**, on
      memories the output was plainly about — this agent paraphrases rather than quotes.
      Spike at zero with no separation ⇒ **textual overlap is not a usable label**; fix is
      embedding similarity (embed server already supports it). Learn this in hour one.
- [ ] **WATCH — is injection firing at the configured rate?** Count `injection.fired` against
      record count. Configured, seeded and recorded per-recall specifically so this is checkable.
      A configured-but-not-firing control arm is worse than none — the analysis assumes it exists.
- [ ] **WATCH — read the per-term counterfactuals; don't re-derive them.** Every candidate now
      carries `counterfactual.composite_no_{decay,salience,situational,reputation}` and
      `composite_relevance_only`, plus a per-recall `changedReturnedSet` / `spearman` rollup.
      Measured on vcarl: **salience and situational Spearman exactly 1.0000 (inert), reputation
      never changed a returned set, decay changed all three.** On a fresh character salience and
      mood should stop being inert once `dims` and `mood.json` exist — if they stay at Spearman
      1.0000, the terms are still not reaching the ranker.

---

## Behaviour — known failure modes from prior runs

- [ ] **WATCH — does the agent ever close anything out?** Prior runs never committed. Diagnosed
      causes: no intra-step budget/progress detection, blind replan, tool-affordance mismatch.
      Watch whether steps terminate on completion or on exhaustion, and whether replans repeat
      prior plans verbatim.
- [ ] **WATCH — CLI fumbles and decide timeouts.** Conscious tier on gpt-oss showed ~**22% body
      CLI-fumble**; there is **no decide timeout** on the conscious tier. Both distort tick pacing
      → distorts memory ages → feeds recency. They contaminate telemetry, not just annoy.
- [ ] **WATCH — restatement rate.** The existing corpus is **60–70% the same handful of facts
      restated**, which is why 614 of 825 records were unlabellable. Sample new memories early.
      Same rate on a fresh character = a memory-**writing** problem no scoring change fixes, and
      it caps what any future study can conclude.

---

## Before analysing

- [ ] **WATCH — version stamps never changed mid-run.** Group by
      `axisVocabHash` + `constantsHash` + `scorerVersion`. More than one group ⇒ config moved
      mid-run; analyse groups separately. Note `scorerVersion` is **manually maintained** — it
      will not catch a formula change nobody bumped it for.
- [ ] **WATCH — remember what the stream does not contain.**
      Coverage is **3 of 5 recall paths** (stated on every record). Missing:
      `macro-synthesis` — the **largest retrieval in the system**, k=12, builds `SYNTHESIS.md` —
      and the agent's own in-container `memory search`. Any "does ranking help" conclusion
      silently excludes the biggest retrieval.
      Also: the logged pool is **already truncated in-container** to 4×k by L2 distance
      (`poolTruncatedUpstream`). It is not the true candidate set.
- [ ] **WATCH — run the trivial baselines first:** character count, recency, random — **before**
      any designed feature. Character count scored **0.772 and beat every designed feature**
      offline, and that was found in the *third* study. First row of every table.
- [ ] **WATCH — every number against a matched null.** Random-word axes beat the designed axes
      for **7 of 10** variants offline. A number without its null is not a result.

---

## The one that generalises

**A control computed inside a label set cannot detect a defect in that label set.** Placebo
prompts, paraphrase checks and matched nulls all passed against model-generated labels and all
failed against human ones. That is the argument for the injection arm and the usage stream —
they are the only signals here not authored by a process that shares our assumptions.

**Scope.** Every prior number is one character, one domain, on a corpus from runtimes known to be
broken. This run's job is to **produce a dataset that can answer these questions**, not to confirm
anything.
