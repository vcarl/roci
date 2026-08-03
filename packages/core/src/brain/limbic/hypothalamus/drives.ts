/**
 * Innate biological drives — the reference frame the hindbrain appraises each
 * event against (Subteam A / limbic drives). Drives are *what the character
 * cares about*; the palette (`palette.ts`) is *how it feels*. They are
 * companions: same home (the character template), same per-event observe prompt.
 *
 * The three CORE drives are domain-agnostic survival motivators (Maslow's two
 * most primal tiers + autonomy/continuity). Domains contribute their own drives
 * via `DomainConfig.identityTemplate.domainDrives`, merged with the core at
 * scaffold / identity-gen time into the character's `DRIVES.md`.
 */

/**
 * `TEMPLATE_DRIVES` and `parseDriveNames` moved to
 * `@roci/player-tools/axis-vocab` in Phase 2: the in-container `memory` CLI
 * derives the drive tier of the salience axis namespace from the same code the
 * host does (design 2026-07-31 §1, §3). Re-exported here so every import site —
 * `tiers-limbic.ts`, `character-scaffold.ts`, `tools/appraisal-eval/run.ts` —
 * is untouched. `parseDriveLines` is the superset that carries descriptions.
 *
 * The extra `import` is not redundant with the `export … from`: a re-export
 * creates no local binding, and `renderDriveLines` below still needs one.
 */
import { TEMPLATE_DRIVES } from "@roci/player-tools/axis-vocab"

export {
  TEMPLATE_DRIVES,
  parseDriveNames,
  parseDriveLines,
  type DriveLine,
} from "@roci/player-tools/axis-vocab"

/** The closed core drive vocabulary (severity order safety > sustenance > agency). */
export const CORE_DRIVE_NAMES: ReadonlyArray<string> = ["safety", "sustenance", "agency"]

/** A domain-provided drive — a mission-specific motivator merged with the core. */
export interface DomainDrive {
  readonly name: string
  readonly description: string
}

/**
 * Render the drive reference block: the 3 core drives, then one
 * `- name — description` row per domain drive. This is the closed vocabulary the
 * per-event tagger maps each event onto; `parseDriveNames` recovers the names
 * for validation.
 */
export function renderDriveLines(domainDrives?: ReadonlyArray<DomainDrive>): string {
  if (!domainDrives || domainDrives.length === 0) return TEMPLATE_DRIVES
  const rows = domainDrives.map((d) => `- ${d.name} — ${d.description}`).join("\n")
  return `${TEMPLATE_DRIVES}\n${rows}`
}

/** Wrap a drive body in the human-readable DRIVES.md file header (mirror paletteFile). */
export const drivesFile = (body: string): string =>
  `# Drives
<!-- This character's innate survival motivators — what they care about, the
     reference frame the hindbrain weighs each event against. The first three are
     universal core drives; any below them are domain-specific. A threat to ANY
     drive is real and need not be physical. -->

${body.trim()}
`
