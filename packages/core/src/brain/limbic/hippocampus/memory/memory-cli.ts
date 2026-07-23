import { Effect } from "effect"
import { Docker, type DockerError } from "../../../../services/Docker.js"
import { installContainerCli } from "../../../../services/install-cli.js"
import { readPlayerToolBundle } from "../../../../services/player-tools-bundle.js"

/**
 * Host-side provisioning for the in-container `memory` CLI. The CLI itself — an
 * append-only sqlite-vec store — now lives in `@roci/player-tools` (`src/memory/`)
 * and ships as a bundled bun artifact (`dist/bundles/memory`): the code the leaf
 * package's tests exercise IS the shipped binary, no host-generated string that
 * can drift (package-design spec §1/§2). This module keeps only what stays in core
 * per §2c: the install path constant + the provisioning that reads the bundle and
 * base64-pipes it in. Per-run config (the embed endpoint) is delivered at
 * INVOCATION time via `MEMORY_EMBED_URL` by `longterm-store.ts` (§3), not baked here.
 */

/** Where the bundled `memory` CLI is installed inside the container (on PATH). */
export const MEMORY_CLI_PATH = "/usr/local/bin/memory"

/**
 * Install the in-container `memory` CLI by reading the built `@roci/player-tools`
 * bundle artifact and base64-piping it in via the shared `installContainerCli`
 * idiom (spec §2f/§3). The db lives in node-owned `players/<name>/me/`, so writes
 * still work under the node runtime user.
 *
 * Reading the bundle is wrapped in `Effect.try` so a missing artifact (misordered
 * build) surfaces through the error channel — the eager provisioning at startup
 * fails LOUD (naming `nx build @roci/player-tools`) rather than lazily. The error
 * channel PROPAGATES: the caller (`provisionImpl`) logs it loud and continues
 * (best-effort), so a breakage shows up in logs, not as a later "command not found".
 */
export function provisionMemoryCli(
  containerId: string,
): Effect.Effect<void, DockerError | Error, Docker> {
  return Effect.try({
    try: () => readPlayerToolBundle("memory"),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  }).pipe(Effect.flatMap((script) => installContainerCli(containerId, MEMORY_CLI_PATH, script)))
}
