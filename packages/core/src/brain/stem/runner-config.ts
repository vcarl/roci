import { Effect } from "effect"
import type { CharacterConfig } from "../../services/CharacterFs.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { CharacterLog, logError } from "../../logging/log-writer.js"
import { DEFAULT_CORTEX_MODELS, type CortexModelConfig } from "../../model/handles.js"
import { TEMPLATE_PALETTE } from "../../core/palette.js"
import { buildAxisSpecs, parseVolatility, TEMPLATE_SALIENCE, type AxisSpec } from "../../core/salience.js"
import { TEMPLATE_DRIVES } from "#brain/limbic/hypothalamus/drives.js"
import { publishAxisVocabulary } from "#brain/limbic/hippocampus/memory/scoring-context.js"
import type { Cadence } from "#brain/limbic/hypothalamus/cadence.js"
import type { ActivationRunnerConfig } from "./tier-config.js"

/**
 * Build an `ActivationRunnerConfig` from a character's on-disk artifacts.
 *
 * THE ONE SALIENCE-AXIS DERIVATION SITE (design 2026-07-31 §1). It lived inline
 * in `runActivation` until the adjudicator sweep needed the same vocabulary from
 * the reflection seam, which runs in a different phase and cannot see the loop's
 * local. Extracting it — rather than deriving a second time next to the sweep —
 * is what keeps the host's axis list identical to the one the in-container CLI
 * scored the mechanical (A) vector against. A character whose two derivations
 * disagree is scored against a vocabulary nobody can see.
 *
 * NEVER FAILS. Identity-gen validates the palette at scaffold time and
 * `scaffoldCharacter` aborts loudly on a malformed one — but a human edits these
 * files, so a bad row can reach a live run. The answer here is NOT to abort:
 * degrade to no axis vocabulary, log loudly once, and let every downstream stage
 * keep working (the CLI still computes A; the adjudicator simply has nothing to
 * grade against and leaves the rows at `base`). Losing a session over a cosmetic
 * defect in PALETTE.md would be a worse failure than the one it prevents.
 */
export const buildRunnerConfig = (opts: {
  char: CharacterConfig
  cadence?: Cadence
  models?: CortexModelConfig
}): Effect.Effect<ActivationRunnerConfig, never, CharacterFs | CharacterLog> =>
  Effect.gen(function* () {
    const charFs = yield* CharacterFs
    const palette = yield* charFs
      .readPalette(opts.char)
      .pipe(Effect.catchAll(() => Effect.succeed(TEMPLATE_PALETTE)))
    const drives = yield* charFs
      .readDrives(opts.char)
      .pipe(Effect.catchAll(() => Effect.succeed(TEMPLATE_DRIVES)))
    // The same read the memory gateway makes for the profile weights, made once
    // more here for the ONE scalar that is not an axis: α, the emotional-state
    // EMA's smoothing constant. Reading it beside the axis derivation keeps
    // every per-character salience input on one object, derived once per run.
    const salienceMd = yield* charFs
      .readSalience(opts.char)
      .pipe(Effect.catchAll(() => Effect.succeed(TEMPLATE_SALIENCE)))
    const axes: ReadonlyArray<AxisSpec> = yield* Effect.try(() =>
      buildAxisSpecs(drives, palette),
    ).pipe(
      Effect.catchAll((e) =>
        logError(
          opts.char.name,
          "cortex",
          `salience axis derivation failed; running with no axis vocabulary (memories still get their mechanical vector): ${e}`,
        ).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.as([] as ReadonlyArray<AxisSpec>),
        ),
      ),
    )
    // Mirror the resolved vocabulary into the scoring-context registry so recall
    // telemetry can stamp WHICH axis world produced its numbers. Publication,
    // not re-derivation: this stays the one derivation site, and the stamp is by
    // construction the same list every tier was prompted with. A degraded `[]`
    // publishes as an ABSENCE, so the stamp reads "unpublished" rather than
    // claiming a real empty vocabulary.
    publishAxisVocabulary(opts.char.name, axes)
    return {
      char: opts.char,
      cadence: opts.cadence ?? "planned-action",
      models: opts.models ?? DEFAULT_CORTEX_MODELS,
      palette,
      drives,
      axes,
      volatility: parseVolatility(salienceMd),
    }
  })
