import { Effect } from "effect"
import { Docker, type DockerError } from "../../../services/Docker.js"
import { installContainerCli } from "../../../services/install-cli.js"
import { readPlayerToolBundle } from "../../../services/player-tools-bundle.js"

/**
 * Host-side provisioning for the in-container `wm` CLI. The CLI itself — a
 * plain-JSON working-memory store with three verbs (todo/done/discard) and NO
 * `list` — now lives in `@roci/player-tools` (`src/wm/`) and ships as a bundled bun
 * artifact (`dist/bundles/wm`), calling the tested `wm-core` state machine
 * directly. That retires the old `Function.prototype.toString()` embedding, which
 * rested on an unenforced self-contained contract (package-design spec §1b/§2).
 * This module keeps only what stays in core per §2c: the install path constant +
 * the provisioning that reads the bundle and base64-pipes it in.
 */

/** Where the bundled `wm` CLI is installed inside the container (on PATH). */
export const WM_CLI_PATH = "/usr/local/bin/wm"

/**
 * Install the in-container `wm` CLI by reading the built `@roci/player-tools` wm
 * bundle artifact and base64-piping it in via `installContainerCli` (idempotent;
 * root exec — see install-cli.ts). `wm` needs no per-run env: its store paths
 * (`me/wm.json`, `me/WM.md`) are cwd-relative and baked into the bundle.
 *
 * Reading the bundle is wrapped in `Effect.try` so a missing artifact (misordered
 * build) surfaces through the error channel — eager provisioning fails LOUD
 * (naming `nx build @roci/player-tools`) rather than lazily. The error channel
 * PROPAGATES: the caller (orchestrator startup) logs it loud and continues, so a
 * breakage shows up in logs instead of only as a later "command not found".
 */
export function provisionWmCli(containerId: string): Effect.Effect<void, DockerError | Error, Docker> {
  return Effect.try({
    try: () => readPlayerToolBundle("wm"),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  }).pipe(Effect.flatMap((script) => installContainerCli(containerId, WM_CLI_PATH, script)))
}
