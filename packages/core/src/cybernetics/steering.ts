import { Effect, Queue } from "effect"
import type { Directive } from "./types.js"

/**
 * Create the host-side steering queue: coalescing, capacity 1. A newer directive
 * fully supersedes an un-consumed older one (each payload is a complete,
 * self-contained forebrain synthesis), so `Queue.sliding(1)` — which drops the
 * oldest to admit the newest — is exactly the "newest wins" backpressure the
 * design calls for (§7). Run-to-completion is the degenerate case: the caller
 * never offers, then shuts the queue down.
 */
export const makeSteeringQueue = (): Effect.Effect<Queue.Queue<Directive>> =>
  Queue.sliding<Directive>(1)
