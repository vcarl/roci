/**
 * The salience profile — HOW STRONGLY this character reacts to each kind of
 * stimulus. The structural sibling of `palette.ts` (how a character *feels*) and
 * `drives.ts` (what a character *cares about*): salience is a weight per stimulus
 * dimension. Dimensions are the drive taxonomy as a fixed spine (the 3 core
 * drives + the one domain drive) plus up to 2 model-named character-specific
 * extras. Characters get a personalized profile generated at creation time
 * (identity-gen); this module holds the artifact template, file wrapper, render
 * helper, and the host-side parser. (design 2026-07-21 §2.)
 *
 * Phase 2 is identity-gen ONLY — this module has no dependency on the memory
 * module. Phase 3's ranking loads the parsed profile and uses it as a decay knob.
 */

import type { DomainDrive } from "#brain/limbic/hypothalamus/drives.js"

/**
 * Graceful-degradation default: the 3 core drives at a neutral 0.5, no extras —
 * so a character created before this identity-gen step still ranks sanely. Core
 * only, exactly mirroring `TEMPLATE_DRIVES`; the domain drive is added at scaffold
 * time by `renderSalienceLines(domainDrives)`. Keep the `- <dim>: <n>  # <gloss>`
 * line format so it round-trips through `parseSalience`.
 */
export const TEMPLATE_SALIENCE = `- safety: 0.5        # neutral default weighting — no personalized profile yet
- sustenance: 0.5    # neutral default weighting — no personalized profile yet
- agency: 0.5        # neutral default weighting — no personalized profile yet`

/**
 * Render the default salience spine: the 3 core drives, then one neutral 0.5 row
 * per domain drive. Mirrors `renderDriveLines(domainDrives)` — this is the
 * scaffold default a character starts from (and what an operator skip falls back
 * to) before the model personalizes the weights.
 */
export function renderSalienceLines(domainDrives?: ReadonlyArray<DomainDrive>): string {
  if (!domainDrives || domainDrives.length === 0) return TEMPLATE_SALIENCE
  const rows = domainDrives
    .map((d) => `- ${d.name}: 0.5  # neutral default weighting — no personalized profile yet`)
    .join("\n")
  return `${TEMPLATE_SALIENCE}\n${rows}`
}

/** Wrap a salience body in the human-readable SALIENCE.md file header (mirror paletteFile/drivesFile). */
export const salienceFile = (body: string): string =>
  `# Salience
<!-- How strongly this character reacts to each kind of stimulus — a weight per
     dimension. The first lines are the core drives + this domain's drive (the
     fixed spine); any extra lines are character-specific. Scores run 0.0 (barely
     registers) to 1.0 (dominates attention). Later drives a memory's decay rate. -->

${body.trim()}
`

/**
 * Parse a SALIENCE.md body into `{ dimension: score }`. Mirrors `parseDriveNames`'
 * regex approach: one `- <dimension>: <number>  # <gloss>` line → one entry;
 * scores clamped to [0,1]; malformed / non-dimension lines dropped. The optional
 * leading sign lets a stray negative clamp to 0 rather than silently drop.
 */
export function parseSalience(md: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of md.split("\n")) {
    const m = line.match(/^-\s*([A-Za-z][\w-]*)\s*:\s*([-+]?[0-9]*\.?[0-9]+)/)
    if (!m) continue
    const n = Number(m[2])
    if (!Number.isFinite(n)) continue
    out[m[1].toLowerCase()] = Math.min(1, Math.max(0, n))
  }
  return out
}
