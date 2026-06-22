import { describe, it, expect } from "vitest"
import { Effect, Stream } from "effect"
import { NodeContext } from "@effect/platform-node"
import { makeMlxBackend, STDERR_TAIL_MAX_LINES, STDERR_TAIL_MAX_LINE_LEN } from "./mlx-backend.js"
import { resolveTierSpec } from "./model-tier-spec.js"
import type { SpawnedProcess } from "./mlx-backend.js"

// These tests drive the mlx backend through the injectable spawn seam
// (`startProcess`) so they NEVER spawn a real mlx_lm.server. A fake process
// emits bytes on a fake stderr stream; we then assert the captured stderr tail
// is retrievable off the RunningServer (and is bounded).
const enc = (s: string) => new TextEncoder().encode(s)

// Build a fake SpawnedProcess whose stderr emits the given chunks then ends.
const fakeProcess = (
  pid: number,
  stderrChunks: ReadonlyArray<string>,
): SpawnedProcess => ({
  pid,
  stderr: Stream.fromIterable(stderrChunks.map(enc)),
  // These tests exercise the stderr-drain path only and never reach kill, so the
  // exit observation is never awaited; `never` keeps the seam shape complete.
  awaitExit: Effect.never,
})

const spec = resolveTierSpec("conscious")

// The stderr drain runs on a background fiber, so the tail populates
// asynchronously (in production it has the whole multi-second readiness poll to
// fill). Poll the tail until it's non-empty, bounded so a genuinely-empty tail
// still fails fast.
const tailWhenReady = (
  server: { stderrTail?: () => Effect.Effect<string> },
): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (!server.stderrTail) return ""
    for (let i = 0; i < 100; i++) {
      const t = yield* server.stderrTail()
      if (t.length > 0) return t
      yield* Effect.sleep("1 millis")
    }
    return yield* server.stderrTail()
  })

describe("mlx backend — stderr capture", () => {
  it("captures the spawned process's stderr into a retrievable tail", async () => {
    const program = Effect.gen(function* () {
      const backend = yield* makeMlxBackend({
        startProcess: () =>
          Effect.succeed(
            fakeProcess(4242, ["loading weights...\n", "OOM: killed\n"]),
          ),
      })
      const server = yield* backend.spawn(spec)
      const tail = yield* tailWhenReady(server)
      return { tail, pid: server.pid }
    }).pipe(Effect.scoped, Effect.provide(NodeContext.layer))

    const { tail, pid } = await Effect.runPromise(program)
    expect(pid).toBe(4242)
    expect(tail).toContain("loading weights...")
    expect(tail).toContain("OOM: killed")
  })

  it("bounds the tail: a flood of stderr lines does not grow unboundedly", async () => {
    const flood = Array.from({ length: STDERR_TAIL_MAX_LINES * 5 }, (_, i) => `line-${i}\n`)
    const program = Effect.gen(function* () {
      const backend = yield* makeMlxBackend({
        startProcess: () => Effect.succeed(fakeProcess(99, flood)),
      })
      const server = yield* backend.spawn(spec)
      const tail = yield* tailWhenReady(server)
      return tail
    }).pipe(Effect.scoped, Effect.provide(NodeContext.layer))

    const tail = await Effect.runPromise(program)
    const lines = tail.split("\n").filter((l) => l.length > 0)
    // The flood (5x the cap) more than fills the ring, so it must hold EXACTLY
    // STDERR_TAIL_MAX_LINES — fewer would mean it drops too aggressively
    // (off-by-one in the slice), more would mean the bound isn't enforced.
    expect(lines.length).toBe(STDERR_TAIL_MAX_LINES)
    // It keeps the MOST RECENT lines (the diagnostic at the moment of death),
    // not the oldest.
    const last = flood[flood.length - 1].trim()
    expect(tail).toContain(last)
    // And it has dropped the earliest line.
    expect(tail).not.toContain("line-0\n")
  })

  it("truncates a single emitted line longer than STDERR_TAIL_MAX_LINE_LEN", async () => {
    // One newline-terminated line whose body exceeds the per-line cap. splitLines
    // emits it as a single completed line, so pushLine's slice should truncate
    // the STORED line to STDERR_TAIL_MAX_LINE_LEN.
    const longLineLen = STDERR_TAIL_MAX_LINE_LEN + 500
    const longLine = "x".repeat(longLineLen)
    const program = Effect.gen(function* () {
      const backend = yield* makeMlxBackend({
        startProcess: () => Effect.succeed(fakeProcess(123, [`${longLine}\n`])),
      })
      const server = yield* backend.spawn(spec)
      const tail = yield* tailWhenReady(server)
      return tail
    }).pipe(Effect.scoped, Effect.provide(NodeContext.layer))

    const tail = await Effect.runPromise(program)
    const lines = tail.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
    // The stored line is capped, not the full emitted length.
    expect(lines[0].length).toBe(STDERR_TAIL_MAX_LINE_LEN)
    expect(lines[0].length).toBeLessThan(longLineLen)
  })

  it("surfaces the captured stderr tail in the ReadinessError when readiness fails", async () => {
    // A fake fetch that never confirms the model → readiness keeps failing.
    const failingFetch: typeof fetch = (async () =>
      ({
        ok: false,
        status: 503,
        json: async () => ({ error: "loading" }),
      }) as unknown as Response) as unknown as typeof fetch

    const program = Effect.gen(function* () {
      const backend = yield* makeMlxBackend({
        fetchImpl: failingFetch,
        startProcess: () =>
          Effect.succeed(fakeProcess(7, ["RuntimeError: model failed to load\n"])),
      })
      const server = yield* backend.spawn(spec)
      yield* tailWhenReady(server) // ensure stderr is captured before probing
      // readinessProbeFor binds the spawned server so the failure can carry its
      // stderr tail.
      return yield* backend.readinessProbeFor!(server).pipe(
        Effect.flip, // we expect a ReadinessError
      )
    }).pipe(Effect.scoped, Effect.provide(NodeContext.layer))

    const err = await Effect.runPromise(program)
    expect(err._tag).toBe("ReadinessError")
    expect(err.message).toContain("RuntimeError: model failed to load")
  })
})
