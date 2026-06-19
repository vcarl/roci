import { Effect, Queue, Stream } from "effect"
import type { Directive } from "./types.js"
import { taskLine, steerLine, endLine } from "../core/limbic/hypothalamus/sdk-payload.js"

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

/**
 * Build the dynamic stdin for a steerable SDK session as a byte stream of NDJSON
 * lines: the initial `task`, then one `steer` line per directive pulled from the
 * (coalescing) queue, then the terminal `end` line once the queue is shut down.
 * Shutting the queue down ends the session (the runner's generator returns →
 * query() completes). Run-to-completion is the degenerate case: shut the queue
 * down with nothing offered → `task` then `end`.
 */
export const buildSteeredStdinStream = (
  task: string,
  steering: Queue.Queue<Directive>,
): Stream.Stream<Uint8Array> =>
  Stream.make(`${taskLine(task)}\n`).pipe(
    Stream.concat(Stream.fromQueue(steering).pipe(Stream.map((d) => `${steerLine(d.text)}\n`))),
    Stream.concat(Stream.make(`${endLine()}\n`)),
    Stream.encodeText,
  )
