/**
 * Named path accessors for a character's on-disk and in-container subtrees.
 *
 * Every per-character path derives from CharacterConfig.root (players/<name>/)
 * through exactly one of these accessors — no consumer joins a raw path against
 * `root` directly, so no site can forget the "me" or "logs" segment. Kept in a
 * sibling module (rather than CharacterFs.ts) so leaf modules like skills-core
 * can import the accessors without a runtime import cycle: this module depends on
 * CharacterFs only for the TYPE (erased at compile), never a value.
 */
import * as path from "node:path"
import type { CharacterConfig } from "./CharacterFs.js"

/** players/<name>/me — the identity/working-memory subtree (DIARY, SECRETS,
 * credentials, background, VALUES, PALETTE, DRIVES, SALIENCE, skills/, SYNTHESIS,
 * wm.json, WM.md, growth/, registration-code.txt, github.json, longterm.db). */
export const meDir = (char: CharacterConfig): string => path.join(char.root, "me")

/** players/<name>/logs — the always-on episode/event log subtree (episodes are
 * not optional: logs always resolve here). */
export const logsDir = (char: CharacterConfig): string => path.join(char.root, "logs")

/** The in-container player cwd /work/players/<name> — the single mapping of a
 * character (or bare name) to its mounted player root inside the container. */
export const containerPlayerRoot = (char: CharacterConfig | string): string =>
  `/work/players/${typeof char === "string" ? char : char.name}`
