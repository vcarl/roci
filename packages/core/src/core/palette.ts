/**
 * PALETTE.md — the character's emotional voice, and (design 2026-07-31 §1) the
 * source of their character-tier salience axes.
 *
 * The DERIVATION now lives in `@roci/player-tools/axis-vocab` so the host and
 * the in-container `memory` CLI share exactly one implementation (Phase 2 §3:
 * the A stage runs inside the CLI, where the embedding is). This module keeps
 * the host-only file wrapper and re-exports the rest, so every Phase 1 import
 * site — `character-scaffold.ts`, `tiers-limbic.ts`, `salience.ts`, the tests —
 * is untouched.
 */

export {
  TEMPLATE_PALETTE,
  MalformedAxisError,
  parsePaletteAxes,
  paletteAxisNames,
  type PaletteAxis,
} from "@roci/player-tools/axis-vocab"

/** Wrap a palette body in the human-readable PALETTE.md file header. */
export const paletteFile = (body: string): string =>
  `# Palette
<!-- This character's emotional voice — the axes they feel along. Each row is a
     5-emoji gradient from one pole to the other. Paint feelings by picking the
     position along the gradient that fits; repeat an emoji to show intensity
     (😟😟😟 = deep toward that pole); mix axes when a feeling is tangled. -->

${body.trim()}
`
