import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Cause, Chunk, Effect, Exit, Layer, Option } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { ModelClient } from "../model/client.js"
import { ModelService } from "../services/ModelService.js"
import type { DomainConfig } from "./domain-bundle.js"

/**
 * The axis-derivation `Effect.try` in `character-scaffold.ts` used to end its
 * `catch` with `: new AxisCollisionError(String(e))` — so ANY unexpected throw
 * was reported as a duplicate salience axis, with `.axis` holding a stringified
 * exception and a message telling the operator to go fix DRIVES.md. Wrong file,
 * wrong problem, and a typed failure the setup command would then CATCH and skip
 * past: a handled-looking report of something nobody diagnosed.
 *
 * The honest shape is a DEFECT. This file proves it, and it is its own file
 * because the only way to inject an unexpected throw into that body is a module
 * mock of `./salience.js`, which vitest applies file-globally — every other
 * scaffold test needs the real derivation.
 */
vi.mock("./salience.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./salience.js")>()
  return {
    ...actual,
    buildAxisList: () => {
      throw new TypeError("boom — not an axis problem at all")
    },
  }
})

const { scaffoldCharacter, autoAcceptReview } = await import("./character-scaffold.js")

const domainConfig = { identityTemplate: { backgroundHints: "h", valuesHints: "v" } } as unknown as DomainConfig

const layers = Layer.mergeAll(
  Layer.succeed(ModelClient, ModelClient.of({ complete: () => Effect.succeed({ text: "GEN", raw: {} }) } as never)),
  Layer.succeed(ModelService, ModelService.of({ withTier: () => (e) => e as never })),
)

let root: string
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "scaffold-defect-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe("scaffoldCharacter — unexpected throws out of the axis derivation", () => {
  it("dies (defect) rather than reporting an unrelated throw as an axis collision", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        scaffoldCharacter({ projectRoot: root, characterName: "boom", domainConfig, review: autoAcceptReview }),
        layers,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    // The discriminator: a TYPED failure would make failureOption Some. It must
    // be None — the throw is not in the error channel at all.
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
    expect(Option.isNone(failure)).toBe(true)

    const defects = Exit.isFailure(exit)
      ? Chunk.toReadonlyArray(Cause.defects(exit.cause))
      : ([] as ReadonlyArray<unknown>)
    expect(defects.length).toBe(1)
    const d = defects[0]
    // The ORIGINAL exception, unwrapped and unrelabelled.
    expect(d).toBeInstanceOf(TypeError)
    expect((d as Error).message).toContain("boom — not an axis problem at all")
    // and emphatically NOT dressed up as a vocabulary defect
    expect((d as Error).message).not.toMatch(/duplicate salience axis/i)
    expect((d as { _tag?: string })._tag).toBeUndefined()
  })

  it("writes no identity files before dying", async () => {
    await Effect.runPromiseExit(
      Effect.provide(
        scaffoldCharacter({ projectRoot: root, characterName: "boom2", domainConfig, review: autoAcceptReview }),
        layers,
      ),
    )
    const { existsSync } = await import("node:fs")
    expect(existsSync(path.join(root, "players", "boom2", "me", "PALETTE.md"))).toBe(false)
  })
})
