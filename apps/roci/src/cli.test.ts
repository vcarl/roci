import { describe, it, expect } from "vitest"
import { Command } from "@effect/cli"
import { Context, Effect, Layer, Option } from "effect"
import { CommandExecutor } from "@effect/platform"
import { NodeFileSystem } from "@effect/platform-node"
import { existsSync, writeFileSync, rmSync } from "node:fs"
import * as path from "node:path"
import { Docker, DockerError, type ContainerInfo } from "@roci/core/services/Docker.js"
import { CharacterLog } from "@roci/core/logging/log-writer.js"
import { CharacterFs } from "@roci/core/services/CharacterFs.js"
import { ModelService, ModelBackendTag } from "@roci/core/services/ModelService.js"
import { rociCommand, serviceLayer, resolveSetupDescription } from "./cli.js"

/**
 * Regression guard for the mlx cold-load bug.
 *
 * Bug: ModelServiceLive (a Layer.scoped that cold-loads the resident 122B mlx
 * server at BUILD time) was merged into the single `serviceLayer` provided to
 * the ROOT command via Command.provide. The root command's transform wraps every
 * dispatched subcommand at runtime, so EVERY subcommand — including `stop`, which
 * only talks to Docker — built that layer and tried to `spawn mlx_lm.server`. On
 * a host without mlx that failed with ENOENT; otherwise it needlessly cold-loaded
 * ~65GB just to stop a container.
 *
 * Fix: the model layer is scoped to the handlers that actually run a session
 * (`start` + the root auto-detect handler). The global `serviceLayer` carries
 * only the non-model layers. These tests assert that contract, in BOTH
 * directions:
 *   - the global serviceLayer / non-model command path must NOT carry the model
 *     layer (no ModelService, no mlx spawn);
 *   - the `start` path MUST carry the model layer (ModelService present; the
 *     backend's spawn/probe seam is actually exercised). That second invariant is
 *     the high-risk one: makeModelService erases its ModelBackend requirement, so
 *     tsc cannot catch a regression that drops the start-path provide — only a
 *     test can.
 */

// Stub Docker for the `stop` handler. Records what it was asked to stop.
const makeStubDocker = (stopped: string[]) =>
  Layer.succeed(
    Docker,
    Docker.of({
      stop: (id: string) =>
        Effect.sync(() => {
          stopped.push(id)
        }),
      listByLabel: () => Effect.succeed([] as ContainerInfo[]),
      status: () => Effect.succeed(null),
      pause: () => Effect.fail(new DockerError("unused")),
      resume: () => Effect.fail(new DockerError("unused")),
      remove: () => Effect.fail(new DockerError("unused")),
      create: () => Effect.fail(new DockerError("unused")),
      build: () => Effect.fail(new DockerError("unused")),
    } as unknown as Context.Tag.Service<Docker>),
  )

const stubCharacterLog = Layer.succeed(
  CharacterLog,
  CharacterLog.of({
    emit: () => Effect.void,
  } as unknown as Context.Tag.Service<CharacterLog>),
)

// Stub CharacterFs so the `start` handler never touches the real filesystem if it
// gets that far. (In the start test below it never does — the model layer fails
// the run before the handler body — but providing it keeps the requirement set
// honest and the test independent of execution order.)
const stubCharacterFs = Layer.succeed(
  CharacterFs,
  CharacterFs.of({
    characterExists: () => Effect.succeed(false),
  } as unknown as Context.Tag.Service<CharacterFs>),
)

// A CommandExecutor whose `start` is a tripwire: any attempt to spawn a process
// throws. `serviceLayer` must never spawn at build time; the `start` path MUST
// (when it cold-loads the model server). `spawned` records whether the tripwire
// fired so a test can assert spawn-vs-no-spawn.
const makeSpawnTripwire = (spawned: { fired: boolean }) =>
  ({
    start: () => {
      spawned.fired = true
      throw new Error("CommandExecutor.start tripwire fired")
    },
  }) as unknown as CommandExecutor.CommandExecutor

describe("setup --description threading", () => {
  // The pure seam that decides what gets passed as scaffoldCharacter's
  // characterDescription. Testing the real generation is not appropriate here:
  // scaffoldCharacter with a description makes a real local-model call. This
  // covers the flag-threading + multi-character guard instead.

  it("threads --description through for a single character", () => {
    const result = resolveSetupDescription(Option.some("a grizzled void-trader"), 1)
    expect(result).toEqual({ ok: true, characterDescription: "a grizzled void-trader" })
  })

  it("preserves blank-template behavior when no --description is given", () => {
    // ok with no characterDescription => scaffoldCharacter writes seed templates.
    expect(resolveSetupDescription(Option.none(), 1)).toEqual({ ok: true })
    expect(resolveSetupDescription(Option.none(), 3)).toEqual({ ok: true })
  })

  it("rejects --description when more than one character is named", () => {
    const result = resolveSetupDescription(Option.some("a grizzled void-trader"), 2)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/single character/)
  })
})

describe("cli model-layer scoping", () => {
  it("the production serviceLayer does NOT provide ModelService or the mlx backend", async () => {
    // The global serviceLayer is provided to the ROOT command and inherited by
    // every subcommand. It must NOT contain the model layer, otherwise the mlx
    // cold-load returns for stop/status/pause/etc. We build the real exported
    // layer and assert the model tags are absent from the resulting context.
    //
    // HERMETICITY: serviceLayer bakes in the real OAuthTokenLive, which reads
    // `<cwd>/.oauth-token` at BUILD time and FAILS the whole layer when the file is
    // absent. (OAuthTokenLive's deps — ProjectRoot, CharacterLog — are self-provided
    // inside cli.ts, so the slice cannot be swapped from outside.) That made this
    // test pass only when a token fixture happened to exist in the cwd: green
    // locally, RED in a clean checkout / CI. We make it deterministic by laying down
    // a throwaway token fixture at exactly the path OAuthTokenLive reads, and we
    // remove ONLY a fixture we created (never a pre-existing real token). The value
    // is irrelevant — the assertion is purely about which tags are/aren't in the
    // built context, not about the token itself.
    const tokenPath = path.resolve(process.cwd(), ".oauth-token")
    const preExisting = existsSync(tokenPath)
    if (!preExisting) writeFileSync(tokenPath, "sk-ant-test-fixture\n")

    // Tripwire CommandExecutor: a green build proves serviceLayer spawned NO
    // process — the model backend is no longer part of it.
    const spawned = { fired: false }
    try {
      const ctx = await Effect.runPromise(
        Effect.scoped(Layer.build(serviceLayer)).pipe(
          Effect.provide(NodeFileSystem.layer),
          Effect.provideService(CommandExecutor.CommandExecutor, makeSpawnTripwire(spawned)),
        ),
      )

      // Intent: prove the global layer carries neither model tag and spawned nothing.
      expect(Context.getOption(ctx, ModelService)._tag).toBe("None")
      expect(Context.getOption(ctx, ModelBackendTag)._tag).toBe("None")
      expect(spawned.fired).toBe(false)
    } finally {
      if (!preExisting) rmSync(tokenPath, { force: true })
    }
  })

  it("running `stop --domain spacemolt` completes with NO ModelService in context", async () => {
    const stopped: string[] = []

    // Build the command with a stub global layer that mirrors the production
    // structure MINUS any model layer. This exercises the real composed
    // rociCommand / stop handler and proves the stop path requires only
    // Docker + CharacterLog — never ModelService.
    const provided = rociCommand.pipe(
      Command.provide(Layer.mergeAll(makeStubDocker(stopped), stubCharacterLog)),
    )
    const run = Command.run(provided, { name: "roci", version: "test" })

    // argv shape: [node, script, ...args]
    await Effect.runPromise(
      run(["node", "roci", "stop", "--domain", "spacemolt"]) as Effect.Effect<void, unknown, never>,
    )

    expect(stopped).toContain("roci-spacemolt")
  })

  it("running `roci start` DOES provide the model layer (the start path cold-loads the model server)", async () => {
    // Critical-coverage test for the highest-risk half of the fix. makeModelService
    // erases its ModelBackend requirement to `never`, so tsc CANNOT catch a
    // regression that drops the start-path `Command.provide(modelServiceLayer)` —
    // only a test (or a live run) can. We dispatch `roci start` through the REAL
    // composed rociCommand (same Command.run path the stop test uses) and prove
    // the model layer is present on the start branch by observing that building it
    // actually drives the model backend's spawn seam.
    //
    // How we make it hermetic and deterministic:
    //   - stub fetch so the resident tier's readiness probe (isHealthy) resolves
    //     offline as "not ready" — no real network — which forces a spawn;
    //   - a tripwire CommandExecutor whose `start` records that it fired and throws,
    //     so the cold-load attempt is observed without launching mlx_lm.server;
    //   - stub Docker / CharacterLog / CharacterFs so nothing else touches the real
    //     world. The model layer fails the run (tripwire), but only AFTER proving it
    //     was built on the start path — which is exactly the invariant under test.
    const spawned = { fired: false }
    const originalFetch = globalThis.fetch
    const originalRestartRetries = process.env.ROCI_MODEL_RESTART_RETRIES
    // Offline fetch: reject every request so probeOnce classifies the tier as not
    // ready and the backend proceeds to spawn (where the tripwire fires).
    globalThis.fetch = (() =>
      Promise.reject(new Error("offline: no model server in test"))) as typeof fetch
    // Disable model-server restarts: the tripwire spawn can never succeed, so the
    // production restart loop would retry it with exponential backoff past the test
    // timeout. 0 restarts makes the first tripwire failure surface immediately,
    // which is exactly the fail-fast the assertions below expect.
    process.env.ROCI_MODEL_RESTART_RETRIES = "0"

    try {
      const provided = rociCommand.pipe(
        Command.provide(
          Layer.mergeAll(makeStubDocker([]), stubCharacterLog, stubCharacterFs),
        ),
      )
      const run = Command.run(provided, { name: "roci", version: "test" })

      // `--domain __none__` matches no configured domain, so resolveConfigs returns
      // [] and the start handler would return early — but the model layer is
      // acquired by Command.provide BEFORE the handler body runs, so the spawn
      // tripwire fires first regardless. We expect the run to fail with the tripwire
      // error; the assertion is that the spawn seam was exercised at all (i.e. the
      // model layer WAS provided on the start path).
      const exit = await Effect.runPromiseExit(
        run(["node", "roci", "start", "--domain", "__none__"]).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, makeSpawnTripwire(spawned)),
        ) as Effect.Effect<void, unknown, never>,
      )

      // The run did NOT succeed (the model layer build hit the spawn tripwire)...
      expect(exit._tag).toBe("Failure")
      // ...and, load-bearing: the spawn seam was reached, which can only happen if
      // modelServiceLayer was provided on the start branch. A regression that drops
      // the start-path provide would never reach the backend → `fired` stays false.
      expect(spawned.fired).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      if (originalRestartRetries === undefined) delete process.env.ROCI_MODEL_RESTART_RETRIES
      else process.env.ROCI_MODEL_RESTART_RETRIES = originalRestartRetries
    }
  })
})
