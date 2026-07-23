/**
 * Embedding client for the long-term memory store (spec §3/§8). POSTs plain text
 * (NO instruction prefix — proven by the spike for bge-small) to the host embed
 * server's OpenAI-shape `/v1/embeddings` and returns the validated 384-dim vector.
 *
 * This module is a LEAF of `@roci/player-tools`: it runs inside the agent
 * container and must depend on NOTHING in `@roci/core` (the circularity trap,
 * package-design spec §2d). It therefore takes an ALREADY-FINAL endpoint URL and
 * POSTs to it VERBATIM — the loopback → `host.docker.internal` rewrite is a
 * host-only concern (`embedEndpoint` in core; spec §3) applied when core composes
 * the `MEMORY_EMBED_URL` env var. This TS client mirrors the fetch the shipped bun
 * binary performs; it is unit-tested with an injected fetch so the request/response
 * contract is locked.
 */

import { parseEmbedResponse } from "./memory-format.js"

/**
 * Cold-start tolerance for the FIRST real embed call. The host embed server is
 * launched best-effort ALONGSIDE `roci start` and loads its model lazily, so the
 * first `remember`/`search` after boot can race the load: the connection is
 * refused (server not bound yet), or the server answers HTTP 503 while weights
 * load, or a request hangs. Without retry the very first long-term-memory call
 * threw and aborted, leaving memory dark for the whole session. We retry these
 * TRANSIENT conditions with capped exponential backoff and a per-attempt timeout.
 *
 * We do NOT retry clearly-permanent failures: a 4xx (bad request) or a 200 with a
 * malformed/wrong-dimension body is not a load race, so those fail fast.
 */
export interface EmbedRetryOptions {
  /** Total attempts (initial + retries). Default 7. */
  readonly attempts?: number
  /** Base backoff before the 2nd attempt; doubles each retry. Default 500ms. */
  readonly baseDelayMs?: number
  /** Upper bound on a single backoff delay. Default 8000ms. */
  readonly maxDelayMs?: number
  /** Per-attempt request timeout (AbortController). Default 10000ms. */
  readonly timeoutMs?: number
  /** Injected sleep so tests don't pay real wall-clock backoff. */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Defaults sized for a tiny bge-small model whose first load adds latency. The
 * realistic cold-start path is connection-refused / HTTP 503 that returns FAST,
 * so the dominant cost is the backoff sum: 500+1000+2000+4000+8000+8000 ≈ 23.5s
 * of waiting across 7 attempts — within a ~20-30s budget — before giving up. The
 * per-attempt timeout only bites a genuinely hung connection.
 */
const DEFAULT_RETRY: Required<Omit<EmbedRetryOptions, "sleep">> = {
  attempts: 7,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  timeoutMs: 10_000,
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Capped exponential backoff for the gap BEFORE attempt `attemptIndex+1`
 * (0-based): `min(maxDelayMs, baseDelayMs * 2^attemptIndex)`. Pure + exported so
 * the schedule is unit-testable.
 */
export function backoffDelayMs(attemptIndex: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** attemptIndex)
}

/**
 * A non-ok HTTP status is RETRYABLE only when it's a server-side / transient
 * condition: any 5xx (503 while the model loads, 502/504 from a proxy), or the
 * 408/429 throttling codes. Every other 4xx is a permanent client error and
 * fails fast.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

/**
 * Embed `text` against the host embed server at the FINAL `endpoint` URL (used
 * verbatim — the host-rewrite already ran in core; spec §3). Tolerant of
 * cold-start: retries connection-refused / 5xx / timeout with capped exponential
 * backoff, but throws (loud) on a permanent 4xx or any shape/dimension mismatch —
 * the caller must never write a corrupt vector, and must not hang forever on a
 * dead server.
 */
export async function embed(
  text: string,
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
  options: EmbedRetryOptions = {},
): Promise<number[]> {
  const attempts = options.attempts ?? DEFAULT_RETRY.attempts
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs
  const timeoutMs = options.timeoutMs ?? DEFAULT_RETRY.timeoutMs
  const sleep = options.sleep ?? defaultSleep
  const url = endpoint
  const body = JSON.stringify({ input: text })

  let lastError = new Error("embed: no attempt was made")
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(backoffDelayMs(attempt - 1, baseDelayMs, maxDelayMs))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      })
    } catch (e) {
      // Connection refused (server not bound yet) or an AbortError from the
      // per-attempt timeout — both are transient cold-start conditions; retry.
      lastError = e instanceof Error ? e : new Error(String(e))
      continue
    } finally {
      clearTimeout(timer)
    }

    if (res.ok) {
      // A 200 means the server is up: a parse/dimension error here is a permanent
      // corrupt-body failure, NOT a cold-start race, so it propagates (no retry).
      const json = await res.json()
      return parseEmbedResponse(json)
    }
    if (isRetryableStatus(res.status)) {
      lastError = new Error(`embed request failed: HTTP ${res.status}`)
      continue
    }
    // Permanent client error (e.g. 400) — fail fast without burning the budget.
    throw new Error(`embed request failed: HTTP ${res.status}`)
  }
  throw new Error(`embed request failed after ${attempts} attempts: ${lastError.message}`)
}
