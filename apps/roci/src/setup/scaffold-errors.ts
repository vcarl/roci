/**
 * The setup path's per-CHARACTER failure policy, in one place.
 *
 * Both setup entry points — the non-interactive `roci setup` in `cli.ts` and the
 * interactive `runGuidedSetup` — loop over characters and write `config.json`
 * ONCE after the loop. So an uncaught scaffold failure on the last character
 * silently unregisters every character scaffolded before it, and the containment
 * is to log, skip that character, and keep going.
 *
 * That containment only works if the log is LOUD. It was written with
 * `logToConsole`, which builds a `kind:"system"` event that `classifyLevel` ranks
 * `info` — so under `LOG_LEVEL=warn` (or `error`) the one line explaining why a
 * character never registered was filtered out of the console, and the operator
 * saw a setup run that simply ended with a character missing. Catching per
 * character has to make a failure MORE visible than crashing did, not less.
 *
 * `logError` is the mechanism: it emits a true `kind:"error"` event, which
 * `classifyLevel` resolves to `error` — the top rank, so `passesThreshold` is
 * true for every possible console threshold. Preferred over passing an explicit
 * `level: "error"` to `logToConsole` because the event stays honestly typed in
 * `events.jsonl` too (a `kind:"system"` line labelled error would be filterable
 * by kind but not by intent), and because it is what every other genuine failure
 * site in the codebase uses.
 *
 * It lives in its own module because `cli.ts` already imports from
 * `guided-setup.ts` (one-way), so this is the only home both can share without a
 * cycle — and because a policy applied in two places is the kind that drifts.
 */

import { AxisCollisionError, UnknownAxisError } from "@roci/core/core/salience.js"
import { MalformedAxisError } from "@roci/core/core/palette.js"
import { ArtifactUnreadableError } from "@roci/core/core/character-scaffold.js"
import { logError } from "@roci/core/logging/log-writer.js"

/**
 * The scaffold failures that are a defect in ONE character's identity artifacts,
 * and so must skip that character rather than abort the whole run.
 *
 * `ArtifactUnreadableError` belongs here for the same reason the other three do:
 * an unreadable `PALETTE.md` under `players/<name>/me/` is that character's
 * problem and says nothing about the next one. Every OTHER failure in
 * `scaffoldCharacter`'s union (model, spawn, readiness, empty generation) is
 * environmental and will hit the next character too — those stay uncaught.
 */
export type PerCharacterScaffoldError =
  | AxisCollisionError
  | MalformedAxisError
  | UnknownAxisError
  | ArtifactUnreadableError

export const isPerCharacterScaffoldError = (e: unknown): e is PerCharacterScaffoldError =>
  e instanceof AxisCollisionError ||
  e instanceof MalformedAxisError ||
  e instanceof UnknownAxisError ||
  e instanceof ArtifactUnreadableError

/**
 * Report a skipped character at a level no ordinary console threshold can hide.
 * A `LogWriterError` from the underlying write is deliberately NOT swallowed —
 * the whole point of this module is that this report reaches someone.
 */
export const logScaffoldSkip = (characterName: string, e: PerCharacterScaffoldError) =>
  logError(
    "setup",
    "cli",
    `Identity generation for ${characterName} produced an inconsistent salience vocabulary — skipping this character (others are unaffected).\n  ${e.message}`,
  )

/**
 * The sibling case: domain-specific setup reported errors, so the character is
 * not written to `config.json`. Same failure mode as above — a character that
 * silently does not exist after a run that looked like it finished — so it gets
 * the same unsuppressable channel.
 */
export const logRegistrationSkip = (characterName: string) =>
  logError("setup", "cli", `Skipping config.json registration for ${characterName} due to errors`)
