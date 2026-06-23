import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { makeFakeBackend } from "./model-backend-fake.js"
import { resolveTierSpec } from "./model-tier-spec.js"
import { ReadinessError } from "./model-backend.js"

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e as Effect.Effect<A, E, never>)

describe("FakeBackend", () => {
  it("records spawns/kills/probes and marks spawned servers", async () => {
    const out = await run(Effect.gen(function* () {
      const be = yield* makeFakeBackend()
      const srv = yield* be.spawn(resolveTierSpec("hindbrain")).pipe(Effect.scoped)
      yield* be.readinessProbe(resolveTierSpec("hindbrain"))
      yield* be.kill(srv)
      const log = yield* be.log()
      return { srv, log }
    }))
    expect(out.srv.spawned).toBe(true)
    expect(out.log.spawns).toEqual(["hindbrain"])
    expect(out.log.probes).toEqual(["hindbrain"])
    expect(out.log.kills).toEqual(["hindbrain"])
  })

  it("probe:fail yields a non-timeout ReadinessError", async () => {
    const exit = await Effect.runPromiseExit(
      makeFakeBackend({ probe: { forebrain: "fail" } }).pipe(
        Effect.flatMap((be) => be.readinessProbe(resolveTierSpec("forebrain"))),
      ),
    )
    expect(exit._tag).toBe("Failure")
    // unwrap the failure cause
    const err = (exit as Extract<typeof exit, { _tag: "Failure" }>).cause
    expect(String(err)).toContain("ReadinessError")
  })

  it("isHealthy reflects the script", async () => {
    const healthy = await run(
      makeFakeBackend({ healthy: ["conscious"] }).pipe(
        Effect.flatMap((be) => be.isHealthy(resolveTierSpec("conscious"))),
      ),
    )
    expect(healthy).toBe(true)
  })
})
