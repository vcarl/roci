import { describe, it, expect, vi, beforeEach } from "vitest"
import { Effect, Layer, Queue } from "effect"
import type { CharacterConfig } from "@roci/core/services/CharacterFs.js"
import { CharacterLog } from "@roci/core/logging/log-writer.js"
import type { DomainBundle } from "@roci/core/core/domain-bundle.js"
import type { PhaseContext } from "@roci/core/core/phase.js"

const runActivationMock = vi.fn((..._args: unknown[]) =>
  Effect.succeed({ _tag: "Completed" as const, finalState: {} }),
)

vi.mock("@roci/core/brain/stem/loop.js", () => ({
  runActivation: (...args: unknown[]) => runActivationMock(...args),
}))

// Imported after the mock so phases.ts picks up the mocked runActivation.
const { spaceMoltPhaseRegistry } = await import("./phases.js")

const stubCharacterLog = Layer.succeed(
  CharacterLog,
  CharacterLog.of({ emit: () => Effect.void }),
)

describe("spacemolt activePhase — tick interval wiring (Phase B1)", () => {
  beforeEach(() => {
    runActivationMock.mockClear()
  })

  it("passes tickIntervalMs derived from the connection's tickIntervalSec (×1000) to runActivation", async () => {
    const activePhase = spaceMoltPhaseRegistry.getPhase("active")!
    const char = { name: "vcarl", dir: "/tmp/vcarl" } as CharacterConfig
    const context = {
      char,
      containerId: "container-1",
      containerEnv: {},
      containerAddDirs: [],
      connection: {
        events: {} as Queue.Queue<unknown>,
        initialState: {},
        tickIntervalSec: 10,
        initialTick: 0,
      },
      domainBundle: Layer.empty as unknown as DomainBundle,
    } as unknown as PhaseContext

    await Effect.runPromise(
      activePhase.run(context).pipe(
        Effect.provide(stubCharacterLog),
      ) as Effect.Effect<unknown, unknown, never>,
    )

    expect(runActivationMock).toHaveBeenCalledTimes(1)
    const callArgs = runActivationMock.mock.calls[0]?.[0] as unknown as { tickIntervalMs?: number }
    expect(callArgs.tickIntervalMs).toBe(10_000)
  })

  it("does not hardcode a fixed tickIntervalMs — a different connection cadence flows through", async () => {
    const activePhase = spaceMoltPhaseRegistry.getPhase("active")!
    const char = { name: "vcarl", dir: "/tmp/vcarl" } as CharacterConfig
    const context = {
      char,
      containerId: "container-1",
      containerEnv: {},
      containerAddDirs: [],
      connection: {
        events: {} as Queue.Queue<unknown>,
        initialState: {},
        tickIntervalSec: 45,
        initialTick: 0,
      },
      domainBundle: Layer.empty as unknown as DomainBundle,
    } as unknown as PhaseContext

    await Effect.runPromise(
      activePhase.run(context).pipe(
        Effect.provide(stubCharacterLog),
      ) as Effect.Effect<unknown, unknown, never>,
    )

    const callArgs = runActivationMock.mock.calls[0]?.[0] as unknown as { tickIntervalMs?: number }
    expect(callArgs.tickIntervalMs).toBe(45_000)
  })
})
