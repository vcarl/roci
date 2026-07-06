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
 *
 * The text below is the empirically-tuned drive block from the validated v3.2
 * spike prompt (§4.2a): each line carries the explicit non-physical-threat
 * coverage + the anti-collapse routing cue (money/fuel/quota = sustenance, NOT
 * safety) that lifted the 2B's drive-tagging to a stable ~85%. Keep it verbatim.
 */
export const TEMPLATE_DRIVES = `- safety — your physical integrity, OR someone targeting you personally: being attacked, damaged, threatened, or harassed. (combat, hull/health loss, a hostile actor, abuse aimed at you)
- sustenance — the resources you need to keep operating: running low/out of fuel, energy, money/credits, quota, or API rate budget. (low fuel, rate-limit hit, empty wallet)
- agency — your freedom and ability to act: being blocked, locked out, frozen, disabled, stalled, or facing shutdown. (engines disabled, access revoked, a dependency stalling you, termination)`

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

/** Extract the drive names from a drive block ("- <name> — …" lines). */
export function parseDriveNames(text: string): string[] {
  const names: string[] = []
  for (const line of text.split("\n")) {
    const m = line.match(/^-\s*([A-Za-z][\w-]*)\s*—/)
    if (m) names.push(m[1].toLowerCase())
  }
  return names
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
