/**
 * Locate + read the built `@roci/player-tools` in-container CLI bundles (spec §2f).
 *
 * Provisioning installs the EXACT bundle artifact the leaf package's tests exercise
 * — "the tested code IS the shipped code". The bundle path is resolved through the
 * PACKAGE BOUNDARY (createRequire of the package's own package.json), never a
 * brittle relative `../../node_modules/...` walk, so a single mechanism survives
 * both contexts core runs in:
 *
 *   - deployed dist: this module runs from `@roci/core`'s dist; `createRequire`
 *     resolves `@roci/player-tools/package.json` via node_modules to the real
 *     package root; the bundle is `<pkgRoot>/dist/bundles/<name>`.
 *   - src / vitest: core's tests run the TS source; the package.json subpath is NOT
 *     one of the vitest resolve.alias-rewritten flat subpaths, so `createRequire`
 *     (native Node resolution, bypassing Vite) still resolves it through the
 *     node_modules symlink to the same real package root + `dist/bundles/<name>`.
 *
 * The bundle always lives at `<pkgRoot>/dist/bundles/` regardless of whether the
 * CALLER is src or dist, because it is produced by the package's own `build`
 * (`tsc && node scripts/bundle.mjs`) — so resolving off the package root, not off
 * this module's own URL, is what makes it context-independent.
 */

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)

export type PlayerToolBundle = "memory" | "wm"

/** Absolute path to a built player-tools bundle artifact, via the package boundary. */
export function playerToolBundlePath(name: PlayerToolBundle): string {
  const pkgJson = require.resolve("@roci/player-tools/package.json")
  return join(dirname(pkgJson), "dist", "bundles", name)
}

/**
 * Read a bundle artifact as UTF-8. Fails LOUD — naming `nx build @roci/player-tools`
 * — when the artifact is absent. Provisioning is eager at container startup
 * (orchestrator.ts), so a misordered build (core provisioning before the leaf
 * package's bundle step ran) must surface here, at provision time, rather than
 * lazily as a later in-container `exit 127` the agent silently hits.
 */
export function readPlayerToolBundle(name: PlayerToolBundle): string {
  const path = playerToolBundlePath(name)
  try {
    return readFileSync(path, "utf8")
  } catch (cause) {
    throw new Error(
      `@roci/player-tools bundle "${name}" not found at ${path} — run \`nx build @roci/player-tools\` ` +
        `before provisioning (the leaf package's bundle step must precede core startup). ` +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}
