/**
 * Host-side embed-endpoint resolution for the long-term memory CLI (spec §3).
 *
 * The `memory` binary itself (now in `@roci/player-tools`) POSTs to an
 * already-final URL it reads verbatim from the `MEMORY_EMBED_URL` env var. The
 * loopback → `host.docker.internal` rewrite is a HOST-only concern (the container
 * has no notion of "loopback vs host gateway"), so it stays here in core: core
 * composes the final URL when it builds the docker-exec env for provisioning.
 *
 * Moving this into the bundle would drag a core dependency (`hostInternalBaseUrl`)
 * into the leaf package and re-introduce the circularity trap — so it MUST NOT
 * move (package-design spec §2d/§3).
 */

import { hostInternalBaseUrl } from "../../../../services/host-url.js"

/** Default host embed server base URL (standalone host process; port 8084). */
export const DEFAULT_EMBED_BASE_URL = "http://127.0.0.1:8084/v1"

/**
 * Process-env var by which the launcher publishes WHICH embedding model it
 * actually spawned, so instrumentation can stamp it (scoring-context.ts).
 *
 * The model id lives in `apps/roci/src/embed-server.ts` and in the python
 * server's own default — neither of which `packages/core` can import (apps
 * depend on core, not the reverse). Without this hand-off the host's honest
 * answer to "which embedder produced these vectors" is only a URL, and a
 * SAME-DIMENSION model swap is invisible to every guard in the system (see
 * `axis-score.ts`'s `cosine`, which returns 0 only on a dimension mismatch).
 *
 * Set by the launcher AFTER it has actually spawned the server; unset means
 * "nobody told us", which the stamp records as such rather than guessing.
 */
export const EMBED_MODEL_ENV = "ROCI_EMBED_MODEL"

/** Resolve the concrete embeddings endpoint: host-rewrite the base URL + `/embeddings`. */
export function embedEndpoint(baseUrl: string): string {
  const base = hostInternalBaseUrl(baseUrl).replace(/\/+$/, "")
  return `${base}/embeddings`
}
