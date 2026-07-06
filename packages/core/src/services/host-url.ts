/**
 * Layer-neutral host-URL rewrite. An in-container caller reaches a host process
 * over the Docker host gateway, so a host-loopback base URL (127.0.0.1 / localhost
 * / 0.0.0.0) must be rewritten to `host.docker.internal`.
 *
 * This is a pure, self-contained helper with two consumers in different layers:
 * the conscious provider config (cortex) and the long-term-memory embed client
 * (limbic). It lives here — in the neutral `services/` layer — so neither layer
 * has to import from the other (see the cortex ⊥ limbic invariant).
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0"])

/** Rewrite a host-loopback base URL to the container's route to the host. */
export function hostInternalBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (LOOPBACK_HOSTS.has(url.hostname)) {
    url.hostname = "host.docker.internal"
  }
  return url.toString().replace(/\/$/, baseUrl.endsWith("/") ? "/" : "")
}
