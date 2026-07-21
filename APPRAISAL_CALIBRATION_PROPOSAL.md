# Appraisal calibration — diagnosis, experiments, and proposals

**Branch: `feat/appraisal-calibration`** (off `feat/overnight-refinement`), 5 commits, unmerged. Per-sample eval results and prompt-variant history live on `appraisal-calibration-archive`, not in these commits. Everything below is experimentally grounded: diagnosed from 1,051 live appraisals, iterated against a new offline eval harness that drives the real Qwen3.5-2B hindbrain model, and spot-confirmed live. Out of scope per your direction: familiarity/amnesia (memory-provenance branch owns it).

## TL;DR

The hindbrain wasn't appraising — it was **parroting the prompt's own worked examples** (48% of live reasons were verbatim slot-fills, including the prompt's *Bad* examples), reading **raw unlabeled JSON** it can't parse (ships and status messages became "stations"; `fuel:6` in a 9.3KB blob was invisible), and being **sabotaged by a mislabeled repeat-annotation** that told it genuinely-new frames were duplicates. Chat never reached it at all — killed upstream at the inert gate, before the chat exemption I'd added could apply. Fixes for all of this are implemented on the branch and measured: **offline eval 50% → 100% pass (150 samples), fabrication 17.2% → 0%, category errors 33.3% → 0%, genuine-combat escalation 0% → 100%, example-echo 57% → 18%** — and a 31-minute live run showed zero template echoes and correct digests with no escalation false-positives.

## Diagnosis (each root-caused with hand-walked evidence)

1. **Few-shot echo — the master cause.** Concrete example sentences in observe.md sat as close to the answer slot as the event itself; a 2B pattern-matches the nearest fluent exemplar. "Hull damage taken — safety, must react" (8 live occurrences on full-hull frames, all 3 of the window's escalations) is the prompt's own **Bad** example being parroted.
2. **Raw-JSON rendering.** Events arrived as `type: X\n<raw JSON>`. Any proper-noun token slot-filled the one "New station ___" template: a player's ship *Threshold*, a status message "Context is Consciousness", the system name Deep Range — all became stations.
3. **CULT "threat" bias.** No standing/reputation data exists for player clans in any payload — the threat was invented from the tag string alone.
4. **Range collapse.** Weight 1 had no worked example → never emitted. "social" isn't in the drive taxonomy (by design). The 23-emoji gradient palette collapsed to 5 in practice — but **measured simplification made everything worse** (100%→86.7% pass); the rich palette is load-bearing.
5. **`drive:"null"` string literal** — quoted placeholder in the output template; already neutralized downstream by `normalizeDrive`, cosmetic.
6. **Post-jump swallow — NOT a fingerprint bug.** The iter-5 fingerprint correctly distinguished post-jump frames (they reached the model); the `(seen Nx recently)` annotation was keyed on the *type-family* count, so a changed frame got labeled "(seen 10x)" and the rubric-obedient model discarded it.
7. **Chat never reached observe — zero, ever.** `handleChatMessage` returns no `stateUpdate` → classified inert → discarded upstream of the chat dedup exemption, which was unreachable dead code for real chat.

## Implemented on the branch (review-ready)

| Unit | Change | Evidence |
|---|---|---|
| eval harness | **Offline eval harness** (`tools/appraisal-eval/`): 30 fixtures from real payloads across 12 failure categories, real mlx model, runtime-identical assembly (imports production functions), scores fabrication/category-errors/escalation-FP/echo/entropy/schema. | Baseline measured: 50% pass. Reusable for any future prompt/model change. |
| de-echo + mech fixes | **observe.md v7→v8 (de-echoed)**: type-keyed decision rules, hard combat-escalation contract, placeholder (non-quotable) example reasons, Bads as rules not sentences, faction-tag rule, unquoted null. **exactCount annotation fix** (one-liner in loop.ts). **Chat inert-gate bypass** (chat-typed events forced non-inert). **Guard reason-scrub** (guarded appraisals lead with truth + "model claimed:" provenance; drive nulled on unsupported safety). | Eval 50%→100%; combat probe went from *described-but-scored-w2* to escalate/w5/safety/interrupt. +8 unit tests. |
| STATUS digest | **STATUS digest**: one structured line under `type:` on snapshot events (fuel/hull % with LOW/CRITICAL bands from existing domain thresholds, location, capped nearby roster, trailing `ALERT:`/`no alerts` verdict token). Domain-built (`event-digest.ts`), exposed via optional method on the existing `StateRenderer` seam (no layer leakage), composed **after** fingerprinting (dedup identity provably untouched). | Fuel-low fixture now passes *for the right reason*: "Fuel critically low at 6%, requiring immediate refuel" w3/sustenance, 3/3 samples (previously passed by accident via the nearby list). 100% overall held. |
| (live) | 31-min validation run (post-digest) | Zero template echoes (baseline window: 9), digests present/correct on all 3 snapshot types, first-time frames unannotated, repeats capped at window edge, 0 escalations, 0 crashes, clean sweep. Agent crafted copper wiring and queued the cpu_co_processor craft. |
| tool trace | **Mechanical tool trace in evaluate** (owner-approved): `## Tool Calls This Step` — per-call description, ≤120-char command, runtime, output size, ok/FAILED — rendered from ToolEpisodes with a weigh-mechanical-over-narrative instruction; OpenCode normalizer hardened (no silent drops, no throws on malformed lines). Honest limitation: OpenCode exposes no bash exit codes (status completed/error only); probes in place if a future state adds them. Decide-side trace = noted follow-up. | 96/96 affected tests; evaluate now sees "the body ran `buy_listing` and it returned error" instead of trusting prose. |

## What the 2B responds to (transferable lessons)

- The `type:` token is the one thing it reads reliably — decision rules keyed on it beat semantic instructions about the payload every time.
- Reason free-text and structured fields **decouple**: it can describe a threat perfectly while scoring it w2/null. Structured outputs need hard IF-THEN contracts, not vibes.
- Any quotable sentence in the prompt becomes a universal template — including the ones labeled *Bad*. Examples must be placeholders or abstract descriptions.
- Trailing verdict tokens (`ALERT: fuel low` / `no alerts`) work where "scan the JSON for fuel" does not. If a number matters, put it in a labeled line; the model will not dig for it.
- Placement matters at this scale: the digest above the `type:` line broke the repeat-discard reflex; under it, everything held.

## Proposed next (not implemented — your call)

1. **Domain-side chat as StateChange** (deeper fix than the core-side gate): `handleChatMessage` should emit a real state append so chat is organically non-inert and flows through the same accumulate/memory path as other changes. Removes the special case.
2. **Synthetic navigation events**: emit a labeled "you jumped to X / docked at Y" event on location change so arrival salience never depends on the 2B diffing snapshots. (The annotation fix makes arrivals *reach* the model; this would make them *unmissable*.)
3. **Full labeled pre-rendering**: extend the digest approach until the raw JSON blob can be dropped from the prompt entirely — smaller prompts, no parse burden. The STATUS line is the proven first step.
4. **One busier live window** to close the validation gap: the quiet docked run couldn't exercise post-jump appraisal, chat arrival, or the guards live. A run with travel + a chat message (even self-sent from a second account) would finish the proof.
5. Housekeeping: `state.ts` contains a byte that makes `file(1)` classify it as data (`grep` needs `-a`) — worth normalizing; weight-entropy stretch target (1.8 bits) needs a w4 resource-block fixture if you care about it; `observation_update` digest lacks the `no alerts` suffix (cosmetic inconsistency).

## Carried-over open items (from the overnight branch, unchanged)

opencode→mlx stuck-request root cause (recovery works, throughput pays); deliberative commit-gap; client-v2 `session_replaced` reconnect decision; 16 pre-existing core test failures (reflection/dream + wm-lifecycle).

## Review path

`git log feat/overnight-refinement..feat/appraisal-calibration` — 5 commits, each independently revertable; experiment artifacts (results/, candidates/) are gitignored, full history on `appraisal-calibration-archive`. The eval harness makes any future observe.md edit a 60-second measurement instead of a live-run gamble: `cd tools/appraisal-eval && bun run.ts --samples 3`.
