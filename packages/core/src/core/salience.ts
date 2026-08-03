/**
 * The salience profile — HOW STRONGLY this character reacts to each kind of
 * stimulus. The structural sibling of `palette.ts` (how a character *feels*) and
 * `drives.ts` (what a character *cares about*): salience is a weight per AXIS.
 *
 * The axis list is DERIVED, not open-ended (design 2026-07-31 §1): the core
 * drives, then this domain's drives, then one axis per `PALETTE.md` row named by
 * joining that row's two poles with a hyphen (`grumbling → tender` →
 * `grumbling-tender`). Three tiers, one flat namespace. The old "up to 2
 * model-named extras" clause is retired — the palette does that job properly.
 *
 * This module holds the artifact template, file wrapper, render helper, the
 * host-side parser, the per-character emotional-volatility scalar, and the axis
 * namespace built over the drive + palette artifacts.
 */

import type { DomainDrive } from "#brain/limbic/hypothalamus/drives.js"

/**
 * The axis namespace moved to `@roci/player-tools/axis-vocab` in Phase 2 so the
 * in-container CLI derives it from the SAME code (design 2026-07-31 §3: the
 * mechanical A stage runs at insert, where the embedding is). Re-exported here
 * so every Phase 1 import site keeps working; `salience.ts` still owns the
 * SALIENCE.md artifact itself.
 */
export {
  AxisCollisionError,
  buildAxisList,
  buildAxisSpecs,
  axisFingerprint,
  sanitizeSalienceVector,
  type AxisSpec,
  type AxisPolarity,
} from "@roci/player-tools/axis-vocab"

/**
 * Emotional volatility (`α`) — how fast this character's mood moves. Per
 * character, not global (design 2026-07-31 §2): if WHAT a character finds
 * salient is a trait, HOW FAST their mood moves is the same kind of trait.
 * Phase 3 consumes it as the smoothing constant of the emotional-state EMA;
 * nothing reads it yet. This is the DEFAULT and its clamp — the knob site —
 * not any live character's value.
 */
export const DEFAULT_VOLATILITY = 0.3

/**
 * Floor of the volatility clamp. The range is `(0, 1]`, open at zero: an `α` of
 * exactly 0 would freeze the emotional-state vector permanently, so it must be
 * unreachable through authoring or clamping.
 */
export const VOLATILITY_MIN = 0.01

/**
 * Graceful-degradation default: the dash-less volatility default, then the 3
 * core drives at a neutral 0.5 — so a character created before this identity-gen
 * step still ranks sanely. Core only, exactly mirroring `TEMPLATE_DRIVES`; the
 * domain drive is added at scaffold time by `renderSalienceLines(domainDrives)`,
 * and palette axes are added by the model at the salience step. Keep the
 * `- <axis>: <n>  # <gloss>` line format so it round-trips through
 * `parseSalience`, and keep `Volatility:` WITHOUT a leading dash so it does not.
 */
export const TEMPLATE_SALIENCE = `Volatility: 0.3

- safety: 0.5        # neutral default weighting — no personalized profile yet
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
     axis. The axis list is derived, never open-ended: the core drives + this
     domain's drives (from DRIVES.md), then one axis per PALETTE.md row, named by
     joining that row's two poles with a hyphen ("grumbling to tender" becomes
     "grumbling-tender"). Weights run 0.0 (barely registers) to 1.0 (dominates
     attention); they set both how slowly a memory decays and how strongly it
     surfaces when it matches this character's current mood.
     One line here is not an axis: the volatility line, which says how fast this
     character's mood moves (0.0-1.0). It is written with no leading dash — a
     dash would silently turn it into a phantom axis. -->

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

/**
 * Read this character's emotional volatility (`α`) from a SALIENCE.md body.
 *
 * The line is deliberately DASH-LESS. `parseSalience` (above) anchors on a
 * literal leading `-`, so a dash-less line is invisible to it and volatility can
 * never enter the axis map — with no change to that regex or the artifact's line
 * format. The inverse slip (`- Volatility: 0.3`, WITH a dash) is a real hazard,
 * since every other line has one: it becomes a phantom axis, and is caught by
 * `unknownSalienceAxes` because volatility is not in the derived axis list.
 *
 * Absent / malformed / non-finite → `DEFAULT_VOLATILITY`, matching the
 * `NEUTRAL_SALIENCE` fall-through discipline and keeping every pre-existing
 * SALIENCE.md valid with no migration. Clamped to `[VOLATILITY_MIN, 1]`.
 */
export function parseVolatility(md: string): number {
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*volatility\s*:\s*([-+]?[0-9]*\.?[0-9]+)/i)
    if (!m) continue
    const n = Number(m[1])
    if (!Number.isFinite(n)) continue
    return Math.min(1, Math.max(VOLATILITY_MIN, n))
  }
  return DEFAULT_VOLATILITY
}

/**
 * A generated SALIENCE.md carried a key outside the derived axis list. Under the
 * old design any extra line was legal "character-specific" data; under the axis
 * design membership is derived, so an unknown key is a generation defect
 * (design 2026-07-31 §1, §2). The commonest cause is a `- Volatility: <n>` line
 * written WITH a leading dash, which `parseSalience` reads as a phantom axis.
 */
export class UnknownAxisError extends Error {
  readonly _tag = "UnknownAxisError"
  constructor(
    readonly unknown: ReadonlyArray<string>,
    readonly axes: ReadonlyArray<string>,
  ) {
    super(
      `SALIENCE.md has ${unknown.length} key(s) outside the derived axis list: ` +
        `${unknown.join(", ")}. Expected axes: ${axes.join(", ")}. ` +
        `(A "Volatility" key here means the volatility line was written WITH a ` +
        `leading dash — it must have no leading dash.)`,
    )
    this.name = "UnknownAxisError"
  }
}

/**
 * The parsed-profile keys that are NOT in the derived axis list, sorted. `[]`
 * means the profile is valid. MISSING axes are deliberately not reported: the
 * `TEMPLATE_SALIENCE` fallback is legitimately drive-only, and a memory scored
 * against an axis with no profile weight already degrades to neutral by rule
 * (design 2026-07-31 §8).
 */
export function unknownSalienceAxes(
  profile: Record<string, number>,
  axes: ReadonlyArray<string>,
): string[] {
  const allowed = new Set(axes.map((a) => a.toLowerCase()))
  return Object.keys(profile)
    .filter((k) => !allowed.has(k))
    .sort()
}
