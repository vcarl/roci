/**
 * B — the ADJUDICATOR (design 2026-07-31 §3).
 *
 * A dedicated model call that receives the memory text, the axis list, and BOTH
 * candidate vectors — the mechanical cosine (A) and the authoring tier's own
 * reading (C) — and produces the authoritative vector, which SUPERSEDES the
 * optimistic base on that row.
 *
 * Why it exists: A and C are each locally reasonable and globally inconsistent.
 * A has no idea what the axes MEAN beyond gloss similarity; C is a different
 * model on every pathway, each with its own implicit rubric. B owns the rubric,
 * so grading is consistent ACROSS memories rather than consistent-within-pathway.
 * It is given the two vectors SEPARATELY, never their mean: the disagreement
 * between them is the evidence it adjudicates on, and a mean destroys it.
 *
 * Why it SUPERSEDES rather than averaging: A and C were its inputs. Averaging B
 * with the base would double-count them. Averaging is reserved for a genuine
 * independent re-score that did not see the first — explicitly out of scope (§9).
 *
 * Why it is a SWEEP rather than a per-write trigger: pathway 6 — the agent's own
 * `memory remember` — is a write the host never observes. There is no trigger to
 * fire on. A sweep over `dims_stage = 'base'` finds those rows regardless, and
 * that single fact determines this whole shape. (`legacy` rows are deliberately
 * NOT swept — the `pending` query filters to `base` alone, so migrating an
 * existing database never enqueues hundreds of historical rows at a model call
 * each.)
 */

import { Effect } from "effect"
import type { CharacterConfig } from "../../../../services/CharacterFs.js"
import { LongtermStore, type PendingMemory } from "./longterm-store.js"
import { callTier, renderAxisBlock, type ActivationRunnerConfig } from "#brain/stem/tier-config.js"
import { parseOr } from "#brain/stem/parse.js"
import { sanitizeSalienceVector, type AxisSpec } from "../../../../core/salience.js"
import { ModelClient } from "../../../../model/client.js"
import { ModelService } from "../../../../services/ModelService.js"
import { logToConsole, logError, type CharacterLog } from "../../../../logging/log-writer.js"

/**
 * Rows adjudicated in ONE sweep. UNTUNED — a deliberately conservative first
 * guess, at the one site that owns it.
 *
 * It is load-bearing because B costs ONE MODEL CALL PER ROW, and the forebrain is
 * a `per-phase` tier (model-tier-spec.ts): at the reflection seam, with the tick
 * loop idle, EACH call spawns, probes and then kills its own server. Ten of those
 * in sequence is already a real slice of a reflection cycle when everything is
 * healthy. Design §10's first guess was 25; that is too much wall-clock for the
 * most deferrable stage in reflection, so it is 10 here.
 *
 * The unswept remainder is not lost — it keeps its optimistic base and is picked
 * up, oldest first, by the next sweep. That is what makes lowering this cheap and
 * raising it the risky direction.
 */
export const SWEEP_ROW_CAP = 10

/**
 * Wall-clock budget for the WHOLE sweep, not per row. The cap above bounds the
 * sweep in rows; without this it is unbounded in TIME, because `withTier` wraps
 * every per-phase call in `acquireReady`, whose own documented caveat is ~2300s of
 * uncapped exponential backoff before a wedged tier gives up — PER ROW. A wedged
 * forebrain could otherwise block a reflection cycle for hours while this function
 * faithfully reports `{0, 0}` at the end.
 *
 * 300s (5min), UNTUNED, chosen relative to the budgets this codebase already sets
 * at the same seam: `REFLECTION_TURN_TIMEOUT_MS` is 480s and `CULL_TURN_TIMEOUT_MS`
 * is 360s (dream.ts). Adjudication is the most deferrable stage in reflection — it
 * is fully resumable and nothing downstream waits on it — so it must never be the
 * longest one. Against SWEEP_ROW_CAP that is a 30s average per row, comfortably
 * over a light-tier spawn plus a small-JSON forebrain completion, so a healthy
 * sweep never approaches it. This is a SAFETY NET, not an expectation.
 *
 * On expiry the sweep returns what it already adjudicated; the rest keep their
 * optimistic base for the next cycle, which is the same degradation every other
 * failure path here takes.
 */
export const SWEEP_DEADLINE_MS = 300_000

/**
 * Consecutive model failures that end a sweep early. A wedged tier does not
 * un-wedge mid-sweep, so grinding through the remaining rows buys nothing.
 *
 * This is NOT redundant with the deadline: it covers the FAST failure mode the
 * deadline is blind to — a non-retryable `ModelError`, or restarts disabled via
 * `ROCI_MODEL_RESTART_RETRIES=0`, where every call fails in milliseconds and the
 * sweep would burn the whole batch without ever nearing 300s. The counter resets
 * on any successful call, so an isolated blip does not end the sweep.
 */
export const MAX_CONSECUTIVE_MODEL_FAILURES = 3

/**
 * The adjudicator's prompt. Pure, so the rubric is unit-testable without a
 * model, and a TS builder rather than a `.md` skill because it takes structured
 * per-row inputs rather than a fixed slot set.
 *
 * The two candidates are labelled by WHAT THEY ARE rather than by letter: "A"
 * and "C" mean something to this codebase and nothing to the model, and a model
 * told to reconcile "A and C" has to guess which is which before it can weigh
 * them.
 *
 * The whole answer IS the salience vector here, so there is no terminal field
 * for it to sit before — unlike observe/orient/decide/evaluate, where `salience`
 * is deliberately placed ahead of the closing field.
 */
export function buildAdjudicatePrompt(input: {
  text: string
  axes: ReadonlyArray<AxisSpec>
  dimsA: Record<string, number>
  dimsC: Record<string, number> | null
}): string {
  // "Nobody scored this" and "the scorer put every axis at zero" are different
  // facts, and B is told WHICH ONE IT HAS in words — never as a bare `null` or a
  // bare `{}` it would have to interpret.
  //
  // BOTH candidates get this treatment. `dims_a = '{}'` is the memory CLI's
  // queryable signal that the mechanical stage was INERT (memory-run.ts) — no
  // embedding, no gloss vectors, no reading at all. Rendering that as a scored
  // `{}` would tell the adjudicator the similarity pass looked and found nothing,
  // which is a different claim and not a true one.
  const first =
    Object.keys(input.dimsA).length === 0
      ? "The mechanical text-SIMILARITY pass produced no reading at all for this memory — it is absent, not a score of zero."
      : `A mechanical text-SIMILARITY pass scored it:\n${JSON.stringify(input.dimsA)}`
  const second =
    input.dimsC === null
      ? "There is no second opinion for this memory — it was written directly, with no tier scoring it."
      : `The tier that WROTE THE MEMORY scored it:\n${JSON.stringify(input.dimsC)}`
  return `You are settling how one remembered moment should be filed for a character.

## The memory

${input.text}

## The axes it is filed against

${renderAxisBlock(input.axes)}

## Two candidate readings

${first}

${second}

The similarity pass has no idea what these axes mean to this character — it only
compares wording. The tier that wrote the memory was in the moment but grades on
its own private scale, which drifts from every other tier's. You are the one
consistent grader, so your reading is the one that is kept.

Use the candidates as evidence, not as instructions. IGNORE them entirely where
they are wrong.

## Answer

Give a value for every axis listed above, using the exact axis names.

A drive axis runs 0.0 (does not bear on it) to 1.0 (dominates it) — never
negative. A palette axis is signed and runs pole to pole: the FIRST pole in its
hyphenated name is the negative end, the second is the positive end, and 0.0 is
the neutral middle. Each axis line above states its own range.

Respond with ONLY a JSON object, no commentary:
{"<axis>": <number>, …}`
}

/**
 * Run one adjudication sweep. NEVER FAILS: reflection is best-effort throughout,
 * and a stuck adjudicator must not cost a character their diary cull. Every
 * failure mode — the store, the model, an unparseable answer — degrades to
 * "leave the row at `base` and try again next cycle", which is exactly what the
 * stage marker exists to make safe.
 *
 * One row at a time, sequentially. Adjudication is off the hot path by design;
 * parallelising it would put N concurrent forebrain calls against a
 * single-process local server and turn a background chore into contention.
 *
 * NEVER FAILS is not the same as NEVER STALLS, and this is the only `callTier`
 * outside the tick loop — at a seam where no forebrain server is warm, so every
 * row spawns, probes and kills its own (`per-phase` lifecycle). Three bounds keep
 * that honest: SWEEP_ROW_CAP (rows), SWEEP_DEADLINE_MS (wall clock, for the slow
 * failure mode) and MAX_CONSECUTIVE_MODEL_FAILURES (for the fast one). All three
 * degrade the same way — the rows they do not reach keep their optimistic base.
 *
 * It runs on the FOREBRAIN, not the conscious tier. Spec §10 implies conscious,
 * but with the conscious tier on a GGUF `gpt-oss-20b`, a capped batch of
 * sequential adjudications per reflection is minutes-to-hours and would starve
 * the cortex.
 * Adjudication is a bounded classification over supplied text with two candidate
 * answers already in hand — forebrain-class work. Changing the tier here is a
 * one-token edit, and the cap should drop with it.
 */
export const runSalienceSweep = (opts: {
  char: CharacterConfig
  containerId: string
  config: ActivationRunnerConfig
}): Effect.Effect<
  { adjudicated: number; skipped: number },
  never,
  LongtermStore | ModelClient | ModelService | CharacterLog
> =>
  Effect.gen(function* () {
    const { char, containerId, config } = opts
    // The axis vocabulary is TAKEN FROM CONFIG, never re-derived here: one
    // derivation per run is what keeps the host's axis list identical to the
    // one the CLI scored A against.
    const axes = config.axes ?? []
    if (axes.length === 0) {
      // No vocabulary means nothing coherent to adjudicate against. Leaving the
      // rows at `base` is correct: they keep their mechanical vector, and the
      // next sweep after the palette is fixed picks them up.
      return { adjudicated: 0, skipped: 0 }
    }
    const store = yield* LongtermStore
    const pending: ReadonlyArray<PendingMemory> = yield* store
      .pending(containerId, char, SWEEP_ROW_CAP)
      .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<PendingMemory>)))
    if (pending.length === 0) return { adjudicated: 0, skipped: 0 }

    // The loop's state lives OUTSIDE the deadline-wrapped effect on purpose: when
    // the deadline interrupts the loop mid-row, the work already committed is
    // still reported honestly rather than discarded with the fiber. A record
    // rather than plain `let`s because it is written inside that effect and read
    // after it.
    const run: {
      adjudicated: number
      consecutiveModelFailures: number
      stoppedEarly: "deadline" | "wedged tier" | null
    } = { adjudicated: 0, consecutiveModelFailures: 0, stoppedEarly: null }

    yield* Effect.gen(function* () {
      for (const row of pending) {
        const prompt = buildAdjudicatePrompt({
          text: row.text,
          axes,
          dimsA: row.dimsA,
          dimsC: row.dimsC,
        })
        // A MODEL failure and an UNUSABLE ANSWER are both "leave the row at
        // `base`", but only the first says anything about the tier's health, so
        // the break counter has to tell them apart.
        const outcome = yield* callTier(config, "forebrain", "adjudicate", prompt).pipe(
          Effect.map((text) => ({
            called: true,
            dims: sanitizeSalienceVector(parseOr<unknown>(text, {}), axes),
          })),
          Effect.catchAll(() =>
            Effect.succeed({ called: false, dims: {} as Record<string, number> }),
          ),
        )
        if (!outcome.called) {
          run.consecutiveModelFailures += 1
          if (run.consecutiveModelFailures >= MAX_CONSECUTIVE_MODEL_FAILURES) {
            run.stoppedEarly = "wedged tier"
            return
          }
          continue
        }
        run.consecutiveModelFailures = 0
        // An empty vector is NOT written. Superseding a real base with `{}` would
        // turn a scored memory into a neutral one on the strength of a parse miss —
        // strictly worse than leaving it at `base` for the next sweep.
        if (Object.keys(outcome.dims).length === 0) continue
        const wrote = yield* store
          .adjudicate(containerId, char, row.id, outcome.dims)
          .pipe(Effect.as(true), Effect.catchAll(() => Effect.succeed(false)))
        if (wrote) run.adjudicated += 1
      }
    }).pipe(
      Effect.timeout(`${SWEEP_DEADLINE_MS} millis`),
      // The inner effect's error channel is `never`, so this catches only the
      // TimeoutException — the deadline is a stop signal, not a failure.
      Effect.catchAll(() =>
        Effect.sync(() => {
          run.stoppedEarly = "deadline"
        }),
      ),
    )

    // Every pending row is either adjudicated or still at `base` — including the
    // ones an early stop never reached. Deriving `skipped` rather than counting it
    // keeps that invariant true on every exit path.
    const adjudicated = run.adjudicated
    const skipped = pending.length - adjudicated

    // An early stop is an OPERATIONAL fact — the tier is wedged, or the seam is
    // slower than its budget — so it goes out at a level `LOG_LEVEL=warn` cannot
    // swallow. The ordinary summary stays an info line.
    if (run.stoppedEarly !== null) {
      yield* logError(
        char.name,
        "hippocampus",
        `Salience sweep stopped early (${run.stoppedEarly}) — adjudicated ${adjudicated} of ${pending.length}; the rest keep their base vector for the next cycle`,
      ).pipe(Effect.catchAll(() => Effect.void))
    } else if (pending.length > 0) {
      yield* logToConsole(
        char.name,
        "hippocampus",
        `Salience sweep — adjudicated ${adjudicated}, left ${skipped} for the next cycle (${pending.length} were pending, cap ${SWEEP_ROW_CAP})`,
      ).pipe(Effect.catchAll(() => Effect.void))
    }
    return { adjudicated, skipped }
  }).pipe(
    Effect.catchAllDefect((d) =>
      logError(opts.char.name, "hippocampus", `Salience sweep defect: ${String(d)}`).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.as({ adjudicated: 0, skipped: 0 }),
      ),
    ),
  )
