# Plan: QA monitor — classify fatal errors + record terminal cause

## Motivation (calibration dogfood loop)

Three consecutive kvothe QA sessions today died the same way: the conscious tier threw
`Fatal error: Model call failed [tier=conscious ...]`. The qa-monitor's `ERROR` anomaly
detector **missed all three** — it only fires on events with `kind === "error"`, but the
fatal message arrives as `kind === "system"`. The deaths were caught only incidentally by the
`PROCESS_DIED` probe (which requires `--session-pid`), and the run-digest records no cause, so
a digest reader cannot tell *why* a run ended. These are the exact open caveats in
`CALIBRATION.md`. This plan closes both, TDD'd against the real crash logs preserved at
`players/kvothe/logs/crash-fixtures/`.

## Global Constraints

- Test framework is **vitest**. Mirror the existing style in `apps/roci/src/qa/*.test.ts`
  (the `ev()` spread helper + `reduce()`/`run()` driver + `expect` on emitted `FeedRecord`s).
- Run scoped tests with `pnpm vitest --run apps/roci/src/qa/<file>.test.ts`.
- TDD: write the failing test first, then the implementation. Every task commits with the
  trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Do **not** add a new input source. The monitor reads only `--events events.jsonl`; the
  fatal text already lives there as a `kind:"system"` message. Stay within that file.
- Keep changes minimal and within `apps/roci/src/qa/`. Do not refactor unrelated detectors.
  Out of scope for this branch (note in CALIBRATION.md as deferred, do not implement):
  classifying `hindbrain:` non-escalate dispositions, `loop_start`, `Entering phase:`, and
  emitting `SESSION_END`.
- Anomaly object shape is `FeedRecord` (`apps/roci/src/qa/types.ts`):
  `{ ts, kind:"anomaly", type, severity, tick, summary, refs? }`.

## Task 1 — `FATAL_ERROR` anomaly detector

**Files:** `apps/roci/src/qa/types.ts`, `apps/roci/src/qa/feed.ts`, `apps/roci/src/qa/feed.test.ts`

**Behavior:** In `feed.ts`'s `reduce()`, add a branch (alongside the existing
`if (ev.kind === "error")` branch) that detects a fatal-error system event and emits a
`FATAL_ERROR` anomaly with `severity: "error"` instead of letting it fall silently through
`classifyEvent` (which returns `null` for it today).

- Add `"FATAL_ERROR"` to the `AnomalyType` union in `types.ts`.
- Match: `ev.kind === "system"` AND `ev.message` matches `/^Fatal error:/`.
- When the message also matches the model-call shape
  `/^Fatal error: Model call failed \[tier=(\w+) model=([^ \]]+)/`, capture `tier` and
  `model`:
  - `summary` = `` `fatal: Model call failed (tier=${tier})` ``
  - `refs` = `{ tier, model }`
- For any other `Fatal error:` message:
  - `summary` = `` `fatal: ${rest}` `` where `rest` is the text after `Fatal error: `
  - no `refs` (or omit)
- The branch must `return` from `reduce()` after pushing the anomaly (do not also run
  `classifyEvent` on the same event), mirroring the existing `kind:"error"` branch's early
  return.

**Tests (write first, must fail before impl):**
1. A `kind:"system"` event with the real fixture message
   `Fatal error: Model call failed [tier=conscious model=mlx-community/Qwen3.5-122B-A10B-4bit endpoint=http://127.0.0.1:8083/v1]: request failed (endpoint unreachable?): TypeError: fetch failed`
   emits one anomaly with `type:"FATAL_ERROR"`, `severity:"error"`, summary containing
   `tier=conscious`, and `refs.tier === "conscious"`.
2. A `kind:"system"` event `Fatal error: something unexpected` emits a `FATAL_ERROR` anomaly
   whose summary contains `something unexpected` and that does not throw on the missing
   model-call shape.
3. A normal `kind:"system"` event (e.g. `hindbrain: discard 😐`) emits **no** `FATAL_ERROR`
   anomaly (guard against over-matching).

## Task 2 — `terminalCause` field in run-digest

**Files:** `apps/roci/src/qa/digest.ts`, `apps/roci/src/qa/digest.test.ts`
**Depends on Task 1** (`FATAL_ERROR` type must exist).

**Behavior:** Add `terminalCause: string | null` to `RunDigest` and populate it in `foldDigest`
as records arrive, with precedence so the *cause* is reported over its mere *consequence*:

- Precedence (highest wins, never downgraded once set to a higher rank):
  `FATAL_ERROR` (rank 3) > `PROCESS_DIED` (rank 2) > `SESSION_END` (rank 1).
- On a `FATAL_ERROR` anomaly: set `terminalCause` to that record's `summary` (e.g.
  `fatal: Model call failed (tier=conscious)`). This must win even if a later
  `PROCESS_DIED` arrives (in real runs the fatal error fires first, then the process exits).
- On a `PROCESS_DIED` anomaly: set `terminalCause` to its `summary` (e.g.
  `session process 45107 exited`) only if no higher-rank cause is already set.
- On a `SESSION_END` transition: set `terminalCause` to `"session ended"` only if nothing
  higher is set.
- Default `terminalCause: null` (run still going, killed externally, or no terminal record).
- `foldDigest` must remain a pure fold (same input → same output); no clocks/IO.

**Tests (write first, must fail before impl):**
1. Folding a sequence ending in a `FATAL_ERROR` anomaly yields `terminalCause` containing
   `tier=conscious` (use the summary from Task 1).
2. Folding `[... , FATAL_ERROR, PROCESS_DIED]` (the real ordering) yields a `terminalCause`
   reflecting the **FATAL_ERROR**, not the process-exit — proving precedence.
3. Folding a sequence with only `PROCESS_DIED` (no fatal) yields a `terminalCause` reflecting
   the process exit.
4. Folding a sequence with no terminal records yields `terminalCause === null`.

## Task 3 — `DEGRADED_TIER` anomaly detector (added from live-run grading)

**Files:** `apps/roci/src/qa/types.ts`, `apps/roci/src/qa/feed.ts`, `apps/roci/src/qa/feed.test.ts`

**Driver:** During the 2026-06-21 kvothe run, tick 4 emitted `hindbrain: undefined undefined`
(disposition AND emotionalWeight both undefined — a tier output parse failure that `parseOr`
swallowed). The monitor dropped it silently (`classifyEvent` returns null). This is the exact
"silent fallback hides a degraded tier" failure mode. Detect it.

**Behavior:** In `feed.ts`'s `reduce()`, add a branch that detects a tier-output parse failure
and emits a `DEGRADED_TIER` anomaly with `severity: "warn"` (it is recoverable, not fatal).

- Add `"DEGRADED_TIER"` to the `AnomalyType` union in `types.ts`.
- Match: `ev.kind === "system"` AND message matches a tier line whose payload is `undefined`
  / empty — anchor the regex on the REAL observed string. Expected shape:
  `/^(hindbrain|forebrain|conscious): undefined\b/` (the implementer MUST confirm the exact
  string from the preserved fixture and adjust the regex to match it precisely).
- `summary` = `` `degraded tier: ${tier} produced no usable output` ``, `refs = { tier }`.
- Early-`return` after pushing the anomaly (do not also run `classifyEvent`).
- Must NOT fire on healthy tier lines like `hindbrain: accumulate 😊😊😊` or
  `forebrain (in-session): docked — docked`.

**Tests (write first, must fail before impl):**
1. The real fixture line (exact string from the run) emits one `DEGRADED_TIER` anomaly,
   `severity:"warn"`, `refs.tier === "hindbrain"`.
2. A healthy `hindbrain: accumulate 😊😊😊` event emits NO `DEGRADED_TIER` anomaly.
3. A healthy `forebrain (in-session): docked — docked` event emits NO `DEGRADED_TIER`
   anomaly (guard against matching legitimate terse-but-real headlines).

## Out of scope / deferred (record in CALIBRATION.md)

- Emitting `SESSION_END` (nothing emits it today) — needed for a "clean" terminalCause.
- Classifying `hindbrain:` discard/continue/accumulate, `loop_start`, `Entering phase:`.
- A cold-load/latency anomaly (firstForebrainMs was ~183s) and a "no PLAN reached by tick N"
  detector.
- Revisiting the conscious-tier model: the 122B (`Qwen3.5-122B-A10B-4bit`) crashed every
  session; this branch switches conscious to `QwQ-32B-4bit` for stability (commit dceb202).
  The human should decide whether to keep the 122B with a dedicated warm port + longer
  timeout, or adopt the smaller reasoning model.
