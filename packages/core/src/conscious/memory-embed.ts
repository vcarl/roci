/**
 * Embedding client for the long-term memory store (spec §3/§8). POSTs plain text
 * (NO instruction prefix — proven by the spike for bge-small) to the host embed
 * server's OpenAI-shape `/v1/embeddings` and returns the validated 384-dim vector.
 *
 * The base URL is injected and rewritten loopback → `host.docker.internal` the
 * same way the conscious provider's host URL is (`hostInternalBaseUrl`), so an
 * in-container caller reaches the host server over the allowed host gateway. This
 * TS client mirrors the fetch the generated bun CLI performs; it is unit-tested
 * with an injected fetch so the request/response contract is locked.
 */

import { hostInternalBaseUrl } from "./opencode-config.js"
import { parseEmbedResponse } from "./memory-format.js"

/** Default host embed server base URL (standalone host process; port 8084). */
export const DEFAULT_EMBED_BASE_URL = "http://127.0.0.1:8084/v1"

/** Resolve the concrete embeddings endpoint: host-rewrite the base URL + `/embeddings`. */
export function embedEndpoint(baseUrl: string): string {
  const base = hostInternalBaseUrl(baseUrl).replace(/\/+$/, "")
  return `${base}/embeddings`
}

/**
 * Embed `text` against the host embed server. Throws (loud) on a non-ok response
 * or any shape/dimension mismatch — the caller must not write a corrupt vector.
 */
export async function embed(
  text: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number[]> {
  const res = await fetchImpl(embedEndpoint(baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text }),
  })
  if (!res.ok) {
    throw new Error(`embed request failed: HTTP ${res.status}`)
  }
  const json = await res.json()
  return parseEmbedResponse(json)
}
