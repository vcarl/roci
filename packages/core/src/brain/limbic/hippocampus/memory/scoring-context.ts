/**
 * Scoring-context stamps: WHICH WORLD produced a recall's numbers.
 *
 * WHY THIS EXISTS. Recall telemetry records scores. Scores are only comparable
 * across records that were produced by the same scoring regime — the same axis
 * vocabulary, the same gloss text (which determines the mechanical vector every
 * `dims` was built from), the same embedder, the same maths, the same knobs.
 * Change any of those mid-corpus and the stream silently becomes two datasets
 * wearing one name: no error, no log line, nothing in the data that says the
 * epoch turned over. Every downstream statistic then averages across the seam.
 *
 * This module is the seam detector. It is deliberately CHEAP (a few short hashes
 * per record) and deliberately PESSIMISTIC: anything the host cannot honestly
 * derive is recorded as unavailable, never invented. A stamp that fails to
 * change when the world changes is worse than no stamp at all, because it
 * produces confidence in pooled data that has actually been corrupted.
 *
 * ── What is genuinely derived, and what is not ───────────────────────────────
 *
 *  DERIVED (changes on its own when the thing changes):
 *   - `axisVocabHash`      names + polarity + ORDER of the axes actually resolved
 *                          at runtime, from the character's own artifacts.
 *   - `axisGlossHash`      the gloss TEXT those axes carry. Reworded gloss ⇒ a
 *                          different embedding ⇒ a different mechanical vector,
 *                          so it must be separable from the vocabulary itself.
 *   - `axisFingerprintHash` hash of `axisFingerprint(specs)` — the exact identity
 *                          the in-container CLI keys its cached gloss VECTORS on.
 *   - `constantsHash`      the live values of every scoring knob.
 *
 *  HAND-MAINTAINED (fallible — see `SCORER_VERSION` in memory-rank.ts):
 *   - `scorerVersion`      the SHAPE of the maths. Nothing enforces its bump.
 *
 *  BEST-EFFORT (may be `null`, and says so):
 *   - `embedder.model`     only known if the launcher published it
 *                          (`EMBED_MODEL_ENV`). Unset ⇒ `modelSource: "unknown"`.
 *
 * ── The axis registry, and why it is a registry ──────────────────────────────
 *
 * `buildRunnerConfig` (brain/stem/runner-config.ts) is documented as THE ONE
 * salience-axis derivation site: the host's axis list has to stay identical to
 * the one the in-container CLI scores against, and a second derivation is
 * exactly how those drift apart. So this module does NOT derive axes. It takes
 * publication from that one site, keyed by character, in the same module-level
 * per-character-context style `logging/episodes.ts` already uses for tick/step.
 * If nothing has published (a code path that never built a runner config, or a
 * derivation that degraded to `[]`), the stamp records `axisSource: "unpublished"`
 * and null hashes — an absence a study can filter on, not a fabricated value.
 */

import { createHash } from "node:crypto"
import { EMBED_DIM } from "@roci/player-tools/memory-sql"
import { axisFingerprint, type AxisSpec } from "../../../../core/salience.js"
import { DEFAULT_EMBED_BASE_URL, EMBED_MODEL_ENV, embedEndpoint } from "./embed-endpoint.js"
import {
  HALF_LIFE_MAX,
  HALF_LIFE_MIN,
  RERANK_OVERFETCH,
  SCORER_VERSION,
  SITUATIONAL_WEIGHT,
  scorerConstants,
} from "./memory-rank.js"

/** Hex chars kept from each sha256. 16 ⇒ 64 bits; collisions are not a concern here. */
const HASH_CHARS = 16

/** Short, stable content hash. Pure; the same input always gives the same digest. */
export function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, HASH_CHARS)
}

/** The decay/ranking knobs in force, by value, for the record. */
export interface DecayConstants {
  readonly HALF_LIFE_MIN: number
  readonly HALF_LIFE_MAX: number
  readonly SITUATIONAL_WEIGHT: number
  readonly RERANK_OVERFETCH: number
}

/** What the host knows about the embedding model that produced every vector. */
export interface EmbedderIdentity {
  /** The concrete URL the in-container CLI POSTs to (host-rewritten). */
  readonly endpoint: string
  /** The dimension both sides DECLARE. Not a measurement — nothing verifies it host-side. */
  readonly declaredDim: number
  /** The model id, if the launcher published one; otherwise null. */
  readonly model: string | null
  /** How `model` was obtained — `"unknown"` means nobody published it. */
  readonly modelSource: "launcher-env" | "unknown"
}

/** The full stamp written onto every recall telemetry record. */
export interface ScoringContext {
  /** HAND-MAINTAINED shape version of the maths (memory-rank.ts). Fallible. */
  readonly scorerVersion: string
  /** Derived hash of every scoring knob's live VALUE. Not fallible. */
  readonly constantsHash: string
  readonly constants: DecayConstants
  /** Axis names + polarity + order. Null when nothing published a vocabulary. */
  readonly axisVocabHash: string | null
  /** Axis gloss TEXT. Null when unavailable; never invented. */
  readonly axisGlossHash: string | null
  /** Hash of the CLI's own gloss-vector cache key (`axisFingerprint`). */
  readonly axisFingerprintHash: string | null
  readonly axisCount: number | null
  /** The vocabulary itself, in order — cheap, and makes a record self-describing. */
  readonly axisNames: ReadonlyArray<string> | null
  readonly axisSource: "runner-config" | "unpublished"
  /** Whether the gloss text was actually visible to the host for hashing. */
  readonly glossAvailability: "host-resolved" | "unavailable"
  readonly embedder: EmbedderIdentity
}

// ---- The axis registry (published by the ONE derivation site) ---------------

const publishedAxes = new Map<string, ReadonlyArray<AxisSpec>>()

/**
 * Publish the axis vocabulary resolved for `characterName`. Called by
 * `buildRunnerConfig` ONLY — this is a mirror of that one derivation, never a
 * second one. Idempotent; a later run overwrites an earlier one.
 *
 * An EMPTY list is published as an absence rather than as "a vocabulary with
 * zero axes": `buildRunnerConfig` degrades to `[]` when PALETTE.md is malformed,
 * and a stamp claiming a real (empty) vocabulary would hide that degradation.
 */
export function publishAxisVocabulary(
  characterName: string,
  axes: ReadonlyArray<AxisSpec>,
): void {
  if (axes.length === 0) {
    publishedAxes.delete(characterName)
    return
  }
  publishedAxes.set(characterName, axes)
}

/** The published vocabulary, or undefined. */
export function publishedAxisVocabulary(
  characterName: string,
): ReadonlyArray<AxisSpec> | undefined {
  return publishedAxes.get(characterName)
}

/** Drop a character's published vocabulary. For tests and teardown. */
export function clearAxisVocabulary(characterName?: string): void {
  if (characterName === undefined) publishedAxes.clear()
  else publishedAxes.delete(characterName)
}

// ---- Stamp assembly --------------------------------------------------------

/**
 * Hash of the axis VOCABULARY — names, polarity, and order, and nothing else.
 * Separate from the gloss hash on purpose: renaming an axis and rewording its
 * gloss are different events with different consequences, and a study needs to
 * be able to tell them apart.
 */
export function axisVocabularyHash(axes: ReadonlyArray<AxisSpec>): string {
  return shortHash(JSON.stringify(axes.map((a) => [a.name, a.polarity])))
}

/**
 * Hash of the axis GLOSS TEXT, in axis order. The glosses are what the A stage
 * embeds, so a reworded gloss re-bases every subsequently-scored `dims` even
 * though the vocabulary is unchanged.
 */
export function axisGlossHash(axes: ReadonlyArray<AxisSpec>): string {
  return shortHash(
    JSON.stringify(axes.map((a) => [a.name, a.positiveGloss, a.negativeGloss])),
  )
}

/** The embedder as the host understands it. `model` is null unless published. */
export function embedderIdentity(env: NodeJS.ProcessEnv = process.env): EmbedderIdentity {
  const model = env[EMBED_MODEL_ENV]?.trim()
  return {
    endpoint: embedEndpoint(DEFAULT_EMBED_BASE_URL),
    declaredDim: EMBED_DIM,
    model: model && model.length > 0 ? model : null,
    modelSource: model && model.length > 0 ? "launcher-env" : "unknown",
  }
}

/**
 * Assemble the stamp for one recall. Pure apart from reading the process env and
 * the axis registry; never throws.
 */
export function buildScoringContext(
  characterName: string,
  env: NodeJS.ProcessEnv = process.env,
): ScoringContext {
  const axes = publishedAxes.get(characterName)
  const constants: DecayConstants = {
    HALF_LIFE_MIN,
    HALF_LIFE_MAX,
    SITUATIONAL_WEIGHT,
    RERANK_OVERFETCH,
  }
  return {
    scorerVersion: SCORER_VERSION,
    constantsHash: shortHash(JSON.stringify(scorerConstants())),
    constants,
    axisVocabHash: axes ? axisVocabularyHash(axes) : null,
    axisGlossHash: axes ? axisGlossHash(axes) : null,
    axisFingerprintHash: axes ? shortHash(axisFingerprint(axes)) : null,
    axisCount: axes ? axes.length : null,
    axisNames: axes ? axes.map((a) => a.name) : null,
    axisSource: axes ? "runner-config" : "unpublished",
    glossAvailability: axes ? "host-resolved" : "unavailable",
    embedder: embedderIdentity(env),
  }
}
