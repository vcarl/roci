/**
 * Recall telemetry: one NDJSON record per harness recall, carrying the WHOLE
 * candidate pool the host scored — winners and losers alike — with every
 * component of every score.
 *
 * WHY THIS EXISTS. `rerank` sorts a scored pool and throws away everything but
 * the top `k` hits; the scores, the four factors that produced them, the mood
 * and the salience profile they were computed against, and every rejected
 * candidate all die inside that one expression. Four consecutive statistical
 * studies of the ranker dead-ended on exactly that: the data needed to answer
 * "why did this memory surface and that one not" was never written down. This
 * stream is that data.
 *
 * ── THE HONESTY CLAUSE (read before analysing this stream) ──────────────────
 *
 * `poolTruncatedUpstream` is ALWAYS true and is the single most important field
 * in the record. The pool below is NOT the character's memories, nor even the
 * memories that could have matched: the in-container sqlite-vec KNN has already
 * cut it to `fetchLimit = k × overfetch` rows **by L2 embedding distance alone**
 * before the host sees a single row. Rows the KNN dropped are not materialised
 * anywhere on the host and are unrecoverable from this stream. Any study that
 * treats `candidates` as "what the character could have remembered" is wrong;
 * it is "what survived distance ranking and was then re-scored". Widening it is
 * a container-side change (new verb / larger k), not a host-side one.
 *
 * COVERAGE IS PARTIAL, AND THE RECORD SAYS SO. Every record carries a
 * `coverage` block built from `RECALL_SITES` below; `coverage.site` names which
 * call site produced it and `coverage.uncovered` lists, by name, every recall
 * path this stream does NOT see. Two paths are missing and both are structural:
 *
 *  - `macro-synthesis` (brain/limbic/hippocampus/macro.ts) calls
 *    `LongtermStore.recall` DIRECTLY, bypassing MemoryGateway. It therefore gets
 *    no rerank, no scores, no mood, no stamp, no injection and no record here.
 *    Routing it through the gateway would not be instrumentation — the gateway
 *    reranks, over-fetches ×4 and injects a random candidate at 5%, so it would
 *    change what the reflection tier reads. It is deliberately left alone.
 *  - `agent-container-search` — the conscious agent can run `memory search`
 *    itself inside the container (opencode-config.ts, skills-core.ts). Those
 *    recalls never reach the host at all.
 *
 * So this stream is THREE of the four harness call sites (orient / decide /
 * evaluate), plus none of the agent-initiated ones. An earlier version of this
 * header claimed four; it was wrong.
 *
 * ── Discipline (same as logging/episodes.ts, limbic/mood/mood-store.ts) ──────
 *
 * Plain functions returning Effect<void, never, never>; no Effect service, no
 * layer, no addition to the closed `UnifiedEvent` union. Recall is on the hot
 * path, so a telemetry failure is swallowed after a console.error and can never
 * disturb the tick. Path derivation (`logsDir`) happens INSIDE the promise, so
 * even a malformed CharacterConfig fails into the swallow rather than throwing
 * synchronously into the caller at Effect-construction time.
 *
 * ── Clocks (both are recorded, because they disagree) ────────────────────────
 *
 * `ts`/`nowMs` are the HOST clock — `nowMs` is literally the value `rerank`
 * scored against. A candidate's `ts` (echoed in `ageMs`) came from the
 * CONTAINER clock at insert. `ageMs = nowMs − Date.parse(containerTs)` therefore
 * mixes clocks; that is how the ranker computes it, so it is recorded as
 * computed rather than "corrected" here. `tick` restarts at 0 every run, so
 * every record also carries `epoch` — without it, records cannot be joined
 * across restarts.
 *
 * Types here stay STRUCTURAL on purpose: the logging substrate does not import
 * brain modules (see episodes.ts's `wmDeltas: unknown[]`), so callers in
 * limbic/hippocampus import DOWN into this module and hand it plain objects.
 */
import { Effect } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { logsDir } from "../services/character-paths.js"
import { captureEpisodeAttribution } from "./episodes.js"
import { appendRotatingLine } from "./log-rotation.js"

export const RECALL_TELEMETRY_FILE = "recall-telemetry.jsonl"

/** Max chars of the query text retained verbatim (`queryChars` keeps the truth). */
export const QUERY_MAX = 400

/**
 * EVERY recall path in the system, covered or not — the single source of truth
 * for the `coverage` block stamped on every record. Silent partial coverage is
 * the exact failure this instrumentation exists to prevent, so the absences are
 * data, not just prose.
 */
export const RECALL_SITES: ReadonlyArray<{
  readonly site: string
  readonly covered: boolean
  readonly why: string
}> = [
  { site: "orient", covered: true, why: "identity-context.ts → MemoryGateway.recall" },
  { site: "decide", covered: true, why: "brain/stem/loop.ts → MemoryGateway.recall" },
  { site: "evaluate", covered: true, why: "brain/stem/loop.ts → MemoryGateway.recall" },
  {
    site: "macro-synthesis",
    covered: false,
    why: "macro.ts calls LongtermStore.recall directly; routing it via the gateway would rerank/overfetch/inject and change what the reflection tier reads",
  },
  {
    site: "agent-container-search",
    covered: false,
    why: "the conscious agent runs `memory search` inside the container; the host never sees it",
  },
]

const UNCOVERED_SITES: ReadonlyArray<string> = RECALL_SITES.filter((s) => !s.covered).map(
  (s) => s.site,
)

/** What this record covers, and what the STREAM does not. */
export interface RecallCoverage {
  /** Which covered call site produced this record. */
  readonly site: string
  /** Recall paths that emit NOTHING to this stream. Never empty — see RECALL_SITES. */
  readonly uncovered: ReadonlyArray<string>
  /** covered sites / all known sites, as a blunt reminder that the stream is partial. */
  readonly coveredSites: number
  readonly knownSites: number
}

/**
 * The composite this candidate WOULD have scored with each term neutralised.
 *
 * Structural mirror of `ScoreCounterfactuals`
 * (brain/limbic/hippocampus/memory/memory-rank.ts) — this module imports nothing
 * from brain/, so the shape is restated rather than imported. Key names are the
 * scorer's own, verbatim, because they are what a study greps for.
 *
 * NONE of these was ever sorted on. `score.composite` is the real number; these
 * are observation. Their point is the one thing the real score cannot show: how
 * much each term is actually doing. Read them against the record-level
 * `counterfactuals` block, which says whether the difference changed the
 * returned SET — a term that shifts every score but never reorders the top-k is
 * inert no matter how large its delta looks.
 */
export interface RecallScoreCounterfactuals {
  /** Recency forced to its no-decay value: the score if memories never decayed. */
  readonly composite_no_decay: number
  /** Recency re-derived at the neutral salience: dims stop modulating the half-life. */
  readonly composite_no_salience: number
  /** The situational (mood) factor forced to its no-mood value. */
  readonly composite_no_situational: number
  /** Reputation forced to 1: provenance stops being a trust weight. */
  readonly composite_no_reputation: number
  /** Every term but relevance neutralised — the container's KNN score, alone. */
  readonly composite_relevance_only: number
}

/** The five multiplicative factors of one composite score, as computed. */
export interface RecallScoreComponents {
  /** Relevance: the container's `1/(1+distance)`, or 0 when non-finite. */
  readonly rel: number
  /** Reputation weight of the row's provenance tier. */
  readonly rep: number
  /** Recency decay at the salience-modulated half-life. */
  readonly rec: number
  /** Situational (mood) factor, `1 + w·cos` ∈ [0.5, 1.5]. The only factor > 1. */
  readonly sit: number
  /** The MAGNITUDE reading of `dims` against the profile — feeds `rec`, not the product. */
  readonly salience: number
  /** `nowMs − Date.parse(hit.ts)`; null when the row's ts is unparseable. Mixed clocks. */
  readonly ageMs: number | null
  /** `rel × rep × rec × sit` — exactly what the ranker sorted on. */
  readonly composite: number
  /** The same score with each term neutralised in turn. Never sorted on. */
  readonly counterfactual: RecallScoreCounterfactuals
}

/**
 * What ONE neutralisation did to the outcome of ONE recall.
 *
 * Structural mirror of `CounterfactualEffect` (memory-rank.ts).
 *
 * **This is the block an analyst actually wants.** The per-candidate
 * counterfactual scores say how much a term moved the numbers; these fields say
 * whether that mattered. `changedReturnedSet: false` on every record for a term
 * is a measurement that the term is inert in production — not an inference from
 * the fact that its value looks constant.
 *
 * Computed against the PRE-injection ranker ordering. Randomised injection
 * changes what reaches the prompt for reasons unrelated to any scoring term, and
 * folding it in would attribute a coin flip to a term.
 */
export interface RecallCounterfactualEffect {
  /** Did the SET of memories reaching the prompt change? The headline. */
  readonly changedReturnedSet: boolean
  /** How many of the real top-k survive in the counterfactual top-k. */
  readonly returnedOverlap: number
  /** Did the top-k come back as a different SEQUENCE (set change or reshuffle)? */
  readonly changedReturnedOrder: boolean
  /** Did the ordering of the WHOLE pool change, winners or not? */
  readonly changedPoolOrder: boolean
  /** Spearman rank correlation over the whole pool; 1 = identical. Null below n=2. */
  readonly spearman: number | null
  /** Ids that WOULD have reached the prompt without this term. */
  readonly entered: ReadonlyArray<number>
  /** Ids that would have lost their place. */
  readonly displaced: ReadonlyArray<number>
}

/** Per-term ordering effects for this recall, keyed by the scorer's term names. */
export interface RecallCounterfactuals {
  /** What the comparison was run against. Not the post-injection prompt. */
  readonly basis: "pre-injection-ranker-ordering"
  /** Top-k the comparison used (`min(k, poolSize)`). */
  readonly k: number
  readonly poolSize: number
  readonly terms: Readonly<Record<string, RecallCounterfactualEffect>>
}

/**
 * The three salience vectors for one candidate, side by side — the reason this
 * block exists at all.
 *
 * `dims` (here `merged`) is the ADJUDICATED-or-base ⊕ of A and C. With only that
 * on the wire, the stages are algebraically unrecoverable: you cannot tell a
 * confident A from a confident C, or either from their mean. **The C stage — the
 * authoring model's own reading of what it just wrote — has never once been
 * measured in this project.** These fields are what makes measuring it possible.
 *
 * ── HOW TO READ A NULL (this is the whole point of `wire`) ───────────────────
 *
 * `transmitted: false` ⇒ the in-container CLI predates wire v2 and **never sent
 * these fields**. `a`/`c` are then null because nothing was asked, not because
 * the stage was empty. Filter those rows OUT before concluding anything about
 * stage coverage; a run of them means a stale provisioned bundle in a
 * long-lived container, and the fix is re-provisioning, not a study.
 *
 * `transmitted: true` with `c: null` is a REAL fact: that pathway had no
 * producer (the agent's own `memory remember`, or reflection promotion). `c: {}`
 * is a different real fact — a producer that scored every axis at zero. The
 * store has always distinguished them and so does this.
 *
 * `a: {}` on a transmitted row is also real and specific: the mechanical stage
 * was INERT for that write — the axis artifacts were unreadable, or the gloss
 * embed failed — which is a durable defect worth counting, not noise.
 *
 * These are per-AXIS vectors (one float per axis, order-of-ten keys), not the
 * 384-float embedding. The embedding is not on this path at all; it is
 * retrievable only via the CLI's `embeddings` verb, offline.
 */
export interface RecallStageVectors {
  /** The CLI's line-shape version; null ⇒ pre-v2 bundle. Never defaulted. */
  readonly wire: number | null
  /** Did the CLI actually send the per-stage vectors on this line? */
  readonly transmitted: boolean
  /** MECHANICAL (A) — cosine against the axis glosses, computed at insert. */
  readonly a: Record<string, number> | null
  /** PRODUCER (C) — the authoring tier's own reading. null ⇒ no producer at all. */
  readonly c: Record<string, number> | null
  /** The merged vector recall actually RANKED on (the `dims` column). */
  readonly merged: Record<string, number> | null
  /** Axis counts, so a study can filter on coverage without walking the vectors. */
  readonly aAxes: number | null
  readonly cAxes: number | null
  /** dims columns the CLI could not parse — corruption, reported rather than shown as absence. */
  readonly parseErrors?: ReadonlyArray<string>
}

/**
 * What this memory RESTATED at the moment it was written — the answer to
 * "is memory 486 a restatement of memory 234", which nothing in this system
 * recorded before wire v3.
 *
 * ── HOW TO READ IT ──────────────────────────────────────────────────────────
 *
 * `transmitted: false` ⇒ the in-container CLI predates wire v3 and never sent a
 * lineage block. Everything below is null because nothing was asked. Filter
 * these out; the fix is re-provisioning, not a study.
 *
 * `transmitted: true` and then `state`:
 *  - `"scored"`  — real. `priorId`/`distance`/`similarity` describe the nearest
 *                  memory that already existed when this one was written.
 *  - `"first"`   — the store was EMPTY. A positive fact, not an absence.
 *  - `"unknown"` — the lookup was attempted and failed.
 *  - `"legacy"`  — the row predates lineage; no lookup was ever attempted.
 *  - `null`      — a SELECT list dropped the column. A bug, surfaced not hidden.
 *
 * **`unknown` and `legacy` are NOT `first`.** A study that treats a null
 * `priorId` as "this memory restated nothing" will read a pre-lineage corpus as
 * entirely novel, which is the precise opposite of the truth about it.
 *
 * ── ON `similarity`, AND WHY THERE IS NO `isRestatement` ────────────────────
 *
 * `similarity` is the RAW cosine, stored unrounded and unthresholded, so an
 * analyst can re-threshold without re-running anything. There is deliberately no
 * boolean: measured over the live 825-row corpus, nearest-prior cosine ranks
 * restatements well (AUC 0.94 against an independent lexical-overlap label) but
 * the distribution has no valley — a single mode at 0.84 with 70% of rows above
 * 0.80. Any cut is one corpus's arbitrary choice, and baking it into every
 * future row would destroy the only property that makes this data worth having.
 *
 * `distance` is the raw vec0 (L2) metric the index actually ranked on;
 * `similarity` is the cosine to that same row. They agree in ordering for
 * unit-normalised embeddings and may not for others — both are kept so the
 * disagreement is visible rather than assumed away.
 */
export interface RecallLineage {
  /** Did the CLI actually send a lineage block on this line? Keys off `wire >= 3`. */
  readonly transmitted: boolean
  /** `scored` | `first` | `unknown` | `legacy`; null ⇒ not transmitted, or a dropped column. */
  readonly state: string | null
  /** The memory this one most resembled among those that already existed. */
  readonly priorId: number | null
  /** Raw vec0 (L2) distance to `priorId`. */
  readonly distance: number | null
  /** Cosine to `priorId`. Raw and unthresholded — see above. */
  readonly similarity: number | null
  /**
   * Convenience: is the lineage of this row actually KNOWN? True only for
   * `scored` and `first`. Exists so the commonest filter in any lineage study
   * cannot be got wrong by forgetting one of the two unknown states.
   */
  readonly known: boolean
}

/** One candidate the host scored, in final rank order. */
export interface RecallCandidateRecord {
  readonly id: number
  /** 1-based position after re-ranking (NOT the container's distance order). */
  readonly rank: number
  /**
   * Did this candidate reach the prompt? This is the POST-injection truth — what
   * the character actually saw — not the ranker's verdict. A candidate whose
   * `rank <= k` but whose `returned` is false is the one injection displaced.
   */
  readonly returned: boolean
  /**
   * Why this candidate's `returned` status is what it is.
   *  - `"ranked"` — the ranker decided it (the overwhelming majority).
   *  - `"random"` — it is in the prompt ONLY because randomised injection drew
   *    it uniformly from the rejected portion of the pool. These rows, pooled
   *    across recalls, are the unbiased sample: the control arm.
   */
  readonly injection: "ranked" | "random"
  readonly source: string
  readonly provenance: string
  /** Which scoring stage produced `dims`: base | adjudicated | legacy | absent. */
  readonly stage?: string
  /** Container-clock insert timestamp, verbatim. */
  readonly ts: string
  /** How many axes the row's `dims` carries (0 = unscored/legacy row). */
  readonly dimsAxes: number
  /** A, C and the merged vector side by side. See `RecallStageVectors`. */
  readonly stageVectors: RecallStageVectors
  /** What this memory restated at write time. See `RecallLineage`. */
  readonly lineage: RecallLineage
  readonly score: RecallScoreComponents
}

/** Whether the mood vector is uninformative, absent, or actually doing work. */
export interface MoodDiagnostics {
  /** L2 norm of the state vector. 0 ⇒ `moodMatch` short-circuits ⇒ `sit` ≡ 1. */
  readonly norm: number
  /** Components that are finite and non-zero. */
  readonly nonZeroAxes: number
  /** Total keys present in the vector. */
  readonly axes: number
  /** `{}` — the expected steady state if no producing tier ever emits a vector. */
  readonly empty: boolean
  /** The vector itself; tiny, and otherwise unrecoverable after the fact. */
  readonly state: Record<string, number>
}

/**
 * WHICH WORLD produced this record's numbers. Structural mirror of
 * `brain/limbic/hippocampus/memory/scoring-context.ts` — this module never
 * imports brain modules, so the shape is restated rather than imported.
 *
 * SCORES ARE ONLY COMPARABLE WITHIN ONE STAMP. Pool two epochs of this stream
 * without splitting on these fields and every statistic silently averages across
 * a config change. `null`/`"unavailable"` mean the host could not derive the
 * value honestly; they are never placeholders for a real one.
 */
export interface RecallScoringContext {
  /** HAND-MAINTAINED version of the SHAPE of the maths. Nothing enforces its bump. */
  readonly scorerVersion: string
  /** Derived hash of every scoring knob's live value. Changes on its own. */
  readonly constantsHash: string
  /** The decay/ranking knobs in force, by value. */
  readonly constants: {
    readonly HALF_LIFE_MIN: number
    readonly HALF_LIFE_MAX: number
    readonly SITUATIONAL_WEIGHT: number
    readonly RERANK_OVERFETCH: number
  }
  /** Axis names + polarity + order, as resolved at runtime. */
  readonly axisVocabHash: string | null
  /** Axis gloss TEXT — what the mechanical stage embeds. */
  readonly axisGlossHash: string | null
  /** Hash of the CLI's gloss-vector cache key. */
  readonly axisFingerprintHash: string | null
  readonly axisCount: number | null
  readonly axisNames: ReadonlyArray<string> | null
  readonly axisSource: string
  readonly glossAvailability: string
  readonly embedder: {
    readonly endpoint: string
    readonly declaredDim: number
    readonly model: string | null
    readonly modelSource: string
  }
}

/**
 * The realised randomised-injection decision for this recall — the CONFIGURED
 * rate is not enough, because an analyst must be able to verify the rate the run
 * actually realised rather than trust it. `seed` + `drawIndex` replay the exact
 * draws.
 */
export interface RecallInjectionRecord {
  readonly enabled: boolean
  readonly rate: number
  readonly seed: string
  readonly drawIndex: number
  readonly draw: number | null
  readonly pick: number | null
  readonly fired: boolean
  readonly eligibleRejected: number
  /** Id of the candidate injected into the prompt; null unless `fired`. */
  readonly injectedId: number | null
  /** Its 1-based rank in the pool — how deep into the rejects it came from. */
  readonly injectedRank: number | null
  /** Id of the ranked candidate it displaced; null unless `fired`. */
  readonly displacedId: number | null
}

/** The record as written to disk. */
export interface RecallTelemetryRecord {
  readonly type: "recall"
  /**
   * THE JOIN KEY. Unique per recall for the lifetime of the process (a per-layer
   * nonce + a monotonic sequence), and the id `logging/recall-usage.ts` stamps on
   * the outcome record for this same recall. Without it the usage signal cannot
   * be joined back to the candidate pool and its scores, which would make it
   * nearly worthless.
   */
  readonly recallId: string
  /** Host-clock ISO timestamp of the write. */
  readonly ts: string
  /** Host-clock ms the ranker actually scored against (the `nowMs` in `rec`/`ageMs`). */
  readonly nowMs: number
  readonly character: string
  readonly tick: number | null
  readonly stepId: string | null
  /** Run epoch — REQUIRED for any cross-restart join, since `tick` restarts at 0. */
  readonly epoch: string | null
  /**
   * The caller's prompt-block label. NOT a call-site id — decide and evaluate
   * both use "Relevant memories". Split on `coverage.site` instead.
   */
  readonly label: string
  /** Which recall paths this stream sees, and which it does not. */
  readonly coverage: RecallCoverage
  /** Query text, truncated to QUERY_MAX. */
  readonly query: string
  readonly queryChars: number
  /** Tag filter, when the caller used one (changes the container's own overfetch). */
  readonly tags?: ReadonlyArray<string>
  /** Hits the caller asked for. */
  readonly k: number
  /** Host over-fetch multiplier (RERANK_OVERFETCH). */
  readonly overfetch: number
  /** `k × overfetch` — the row limit handed to the in-container KNN. */
  readonly fetchLimit: number
  /** Candidates the host actually received and scored. */
  readonly poolSize: number
  /** Candidates that reached the prompt (= min(k, poolSize)). */
  readonly returnedCount: number
  /**
   * The CLI wire contract this recall actually ran against — a RECORD-level
   * rollup of the per-candidate `stageVectors.wire`, because "is this record
   * usable for a stage study" must be answerable without walking the pool (and
   * must still be answerable when the pool is empty).
   *
   * `observed < expected` or `null` means the container is running a stale
   * provisioned bundle. Every `stageVectors.a`/`.c` in the record is then null
   * for a transport reason, and the record must be EXCLUDED from any stage
   * analysis rather than counted as evidence of empty stages.
   */
  readonly wire: {
    /** What the host build expects (`RECALL_WIRE_VERSION`). */
    readonly expected: number
    /** What the CLI stamped. null ⇒ pre-v2 CLI, or an empty pool. */
    readonly observed: number | null
    /** Did the per-stage vectors (v2) actually cross the wire on this recall? */
    readonly stageVectorsTransmitted: boolean
    /**
     * Did the lineage block (v3) cross the wire? A SEPARATE flag with a
     * separate threshold — a v2 bundle satisfies the one above and not this
     * one, and one flag serving both would make a stale bundle's absent
     * lineage look like genuinely absent ancestry.
     */
    readonly lineageTransmitted: boolean
  }
  /** ALWAYS true — see the honesty clause in this module's header. */
  readonly poolTruncatedUpstream: true
  /** What did the upstream truncation rank by. */
  readonly poolTruncationBasis: "l2_distance_knn"
  readonly mood: MoodDiagnostics
  /** The salience profile in effect (process-cached, so it can be staler than SALIENCE.md). */
  readonly salienceProfile: Record<string, number>
  /** Which scoring world produced these numbers. Split any pooled analysis on it. */
  readonly scoringContext: RecallScoringContext
  /** What randomised injection actually did on this recall. */
  readonly injection: RecallInjectionRecord
  /** Did neutralising each term change what came back? See `RecallCounterfactuals`. */
  readonly counterfactuals: RecallCounterfactuals
  readonly candidates: ReadonlyArray<RecallCandidateRecord>
}

/**
 * Structural input for one candidate — duck-typed so this module never imports
 * `MemoryHit` (or anything else under brain/).
 */
export interface RecallCandidateInput {
  readonly id: number
  readonly source: string
  readonly provenance: string
  readonly ts: string
  readonly stage?: string
  readonly dims?: Record<string, number> | null
  /** Wire version the CLI stamped; undefined ⇒ pre-v2, fields never transmitted. */
  readonly wire?: number
  readonly dimsA?: Record<string, number> | null
  readonly dimsC?: Record<string, number> | null
  readonly dimsParseErrors?: ReadonlyArray<string>
  /**
   * The CLI's wire-v3 lineage block, verbatim (wire spelling). Undefined ⇒ a
   * pre-v3 bundle sent none. Structural, so this module still imports nothing
   * from brain/ or player-tools.
   */
  readonly lineage?: {
    readonly state?: string | null
    readonly prior_id?: number | null
    readonly distance?: number | null
    readonly similarity?: number | null
  } | null
  /** POST-injection: did this candidate reach the prompt? */
  readonly returned: boolean
  /** `"random"` on the injected candidate only. */
  readonly injection: "ranked" | "random"
  readonly score: RecallScoreComponents
}

/** What the gateway knows about a recall, minus the stamps this module adds. */
export interface RecallTelemetryInput {
  /** Unique id for this recall; also stamped on the usage record (recall-usage.ts). */
  readonly recallId: string
  /** Which covered call site this is — must be one of `RECALL_SITES`. */
  readonly site: string
  readonly label: string
  readonly query: string
  readonly tags?: ReadonlyArray<string>
  readonly k: number
  readonly overfetch: number
  readonly nowMs: number
  /**
   * `RECALL_WIRE_VERSION` as the HOST build knows it. Passed in rather than
   * imported so this module keeps importing nothing but node/effect/services —
   * and so there is exactly one definition of the constant (the CLI's), never a
   * restated copy here that could drift from it.
   */
  readonly expectedWire: number
  readonly mood: Record<string, number>
  readonly salienceProfile: Record<string, number>
  readonly scoringContext: RecallScoringContext
  /** The realised injection decision, minus the candidate ids this module fills in. */
  readonly injection: Omit<
    RecallInjectionRecord,
    "injectedId" | "injectedRank" | "displacedId"
  > & {
    readonly injectedIndex: number | null
    readonly displacedIndex: number | null
  }
  /**
   * Per-term ordering effects, computed by `counterfactualEffects` over the
   * PRE-injection ranker output. Passed in rather than derived here: this module
   * has no access to the sort, and re-implementing it would be a second copy of
   * the ranking rule free to drift from the real one.
   */
  readonly counterfactuals: Readonly<Record<string, RecallCounterfactualEffect>>
  /** In RANK order (the ranker's order), winners first. */
  readonly candidates: ReadonlyArray<RecallCandidateInput>
}

/** L2 norm / non-zero count / emptiness of a mood vector. Pure; never throws. */
export function moodDiagnostics(state: Record<string, number>): MoodDiagnostics {
  const keys = Object.keys(state)
  let sumSq = 0
  let nonZero = 0
  for (const k of keys) {
    const v = state[k]
    if (typeof v !== "number" || !Number.isFinite(v)) continue
    sumSq += v * v
    if (v !== 0) nonZero += 1
  }
  return {
    norm: Math.sqrt(sumSq),
    nonZeroAxes: nonZero,
    axes: keys.length,
    empty: keys.length === 0,
    state,
  }
}

/** Key count of a vector, or null when the vector itself is absent. */
const axesOf = (v: Record<string, number> | null | undefined): number | null =>
  v === null || v === undefined ? null : Object.keys(v).length

/**
 * Build one candidate's stage-vector block. The ONE decision encoded here is
 * that `transmitted` keys off the presence of the CLI's `wire` stamp — NOT off
 * whether `a`/`c` happen to be non-null. Keying off the values would collapse
 * "a stale bundle sent nothing" into "the stage is empty", which are opposite
 * conclusions about the same nulls.
 */
function stageVectorsOf(c: RecallCandidateInput): RecallStageVectors {
  const transmitted = typeof c.wire === "number" && c.wire >= 2
  return {
    wire: typeof c.wire === "number" ? c.wire : null,
    transmitted,
    a: transmitted ? (c.dimsA ?? null) : null,
    c: transmitted ? (c.dimsC ?? null) : null,
    merged: c.dims ?? null,
    aAxes: transmitted ? axesOf(c.dimsA) : null,
    cAxes: transmitted ? axesOf(c.dimsC) : null,
    ...(c.dimsParseErrors && c.dimsParseErrors.length > 0
      ? { parseErrors: [...c.dimsParseErrors] }
      : {}),
  }
}

/**
 * The two lineage states that mean "we actually know". `unknown` and `legacy`
 * are both real answers to a different question — "why don't we know" — and
 * neither is `first`.
 */
const KNOWN_LINEAGE_STATES = new Set(["scored", "first"])

/**
 * Build one candidate's lineage block.
 *
 * `transmitted` keys off `wire >= 3` — its OWN threshold, deliberately not the
 * `>= 2` the stage vectors use. A v2 bundle sends `dims_a`/`dims_c` and no
 * lineage at all; sharing one flag would report its nulls as real emptiness,
 * which is the entire failure mode the wire stamp exists to prevent, arriving
 * one version later through the back door.
 */
function lineageOf(c: RecallCandidateInput): RecallLineage {
  const transmitted = typeof c.wire === "number" && c.wire >= 3
  if (!transmitted || !c.lineage) {
    return { transmitted, state: null, priorId: null, distance: null, similarity: null, known: false }
  }
  const state = c.lineage.state ?? null
  return {
    transmitted,
    state,
    priorId: numOrNull(c.lineage.prior_id),
    distance: numOrNull(c.lineage.distance),
    similarity: numOrNull(c.lineage.similarity),
    known: state !== null && KNOWN_LINEAGE_STATES.has(state),
  }
}

/** A finite number, or null. Never coerces a missing value into a real one. */
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null

/** The id at `i`, or null when `i` is null / out of range. Never throws. */
function atIndex(
  candidates: ReadonlyArray<RecallCandidateInput>,
  i: number | null,
): number | null {
  if (i === null || i < 0 || i >= candidates.length) return null
  return candidates[i].id
}

/**
 * Assemble the on-disk record, stamping host clock + episode attribution
 * (tick/stepId/epoch). Pure apart from the two stamps; exported so a test can
 * assert the shape without touching the filesystem.
 */
export function buildRecallRecord(
  char: CharacterConfig,
  input: RecallTelemetryInput,
  now: () => string = () => new Date().toISOString(),
): RecallTelemetryRecord {
  const attribution = captureEpisodeAttribution(char.name)
  const q = input.query
  return {
    type: "recall",
    recallId: input.recallId,
    ts: now(),
    nowMs: input.nowMs,
    character: char.name,
    tick: attribution.tick,
    stepId: attribution.stepId,
    epoch: attribution.epoch,
    label: input.label,
    coverage: {
      site: input.site,
      uncovered: UNCOVERED_SITES,
      coveredSites: RECALL_SITES.length - UNCOVERED_SITES.length,
      knownSites: RECALL_SITES.length,
    },
    query: q.length <= QUERY_MAX ? q : `${q.slice(0, QUERY_MAX)}…`,
    queryChars: q.length,
    ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {}),
    k: input.k,
    overfetch: input.overfetch,
    fetchLimit: input.k * input.overfetch,
    poolSize: input.candidates.length,
    returnedCount: input.candidates.filter((c) => c.returned).length,
    wire: (() => {
      // One CLI invocation produced every candidate, so the pool is homogeneous;
      // take the MINIMUM anyway so a future mixed pool degrades to the weakest
      // line rather than the luckiest one.
      const seen = input.candidates.map((c) => (typeof c.wire === "number" ? c.wire : 0))
      const observed = seen.length === 0 ? null : Math.min(...seen)
      return {
        expected: input.expectedWire,
        observed: observed === 0 ? null : observed,
        stageVectorsTransmitted: observed !== null && observed >= 2,
        lineageTransmitted: observed !== null && observed >= 3,
      }
    })(),
    poolTruncatedUpstream: true,
    poolTruncationBasis: "l2_distance_knn",
    mood: moodDiagnostics(input.mood),
    salienceProfile: input.salienceProfile,
    scoringContext: input.scoringContext,
    injection: {
      enabled: input.injection.enabled,
      rate: input.injection.rate,
      seed: input.injection.seed,
      drawIndex: input.injection.drawIndex,
      draw: input.injection.draw,
      pick: input.injection.pick,
      fired: input.injection.fired,
      eligibleRejected: input.injection.eligibleRejected,
      injectedId: atIndex(input.candidates, input.injection.injectedIndex),
      injectedRank:
        input.injection.injectedIndex === null ? null : input.injection.injectedIndex + 1,
      displacedId: atIndex(input.candidates, input.injection.displacedIndex),
    },
    counterfactuals: {
      basis: "pre-injection-ranker-ordering",
      k: Math.min(input.k, input.candidates.length),
      poolSize: input.candidates.length,
      terms: input.counterfactuals,
    },
    candidates: input.candidates.map((c, i) => ({
      id: c.id,
      rank: i + 1,
      returned: c.returned,
      injection: c.injection,
      source: c.source,
      provenance: c.provenance,
      ...(c.stage !== undefined ? { stage: c.stage } : {}),
      ts: c.ts,
      dimsAxes: c.dims ? Object.keys(c.dims).length : 0,
      stageVectors: stageVectorsOf(c),
      lineage: lineageOf(c),
      score: c.score,
    })),
  }
}

/**
 * Append one recall record. NEVER FAILS and never throws into the caller: path
 * derivation, serialization and IO all sit inside the swallowed promise, so a
 * character with an unusable root degrades to a console.error rather than
 * breaking a recall.
 *
 * Rotation (logging/log-rotation.ts) is size-based and DELETES NOTHING — the
 * active file is renamed to the next segment number and a fresh one started,
 * with marker lines on both sides of the seam. See that module's header before
 * concatenating segments.
 */
export const appendRecallTelemetry = (
  char: CharacterConfig,
  input: RecallTelemetryInput,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      const dir = logsDir(char)
      const line = `${JSON.stringify(buildRecallRecord(char, input))}\n`
      await appendRotatingLine(dir, RECALL_TELEMETRY_FILE, line)
    },
    catch: (e) => e,
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() =>
        console.error(`[recall-telemetry] append failed for ${char?.name}: ${e}`),
      ),
    ),
  )
