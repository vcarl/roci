import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { ModelClient } from "../model/client.js"
import { ModelService } from "../services/ModelService.js"
import type { ModelHandle } from "../model/handles.js"
import { scaffoldCharacter, autoAcceptReview, type ReviewDecision, type ReviewFn } from "./character-scaffold.js"
import type { DomainConfig } from "./domain-bundle.js"

// minimal DomainConfig stub — only identityTemplate matters here
const domainConfig = { identityTemplate: { backgroundHints: "h", valuesHints: "v" } } as unknown as DomainConfig

// model returns the prompt's first line tag so we can tell artifacts apart
const taggedClient: Layer.Layer<ModelClient> = Layer.succeed(
  ModelClient,
  ModelClient.of({
    complete: (_h: ModelHandle, messages) =>
      Effect.succeed({ text: `GEN:${messages[0].content.slice(0, 24)}`, raw: {} }),
  }),
)
const passThroughService: Layer.Layer<ModelService> = Layer.succeed(
  ModelService,
  ModelService.of({ withTier: () => (e) => e as never }),
)
const layers = Layer.mergeAll(taggedClient, passThroughService)

// scripted review: pull decisions from a queue keyed by call order
const scriptedReview = (decisions: ReviewDecision[]): ReviewFn => {
  let i = 0
  return () => Effect.succeed(decisions[i++] ?? { action: "accept", content: "FALLBACK" })
}

let root: string
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "scaffold-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const meDir = (name: string) => path.join(root, "players", name, "me")

describe("scaffoldCharacter", () => {
  it("with no description writes plain templates and makes no model call", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({ projectRoot: root, characterName: "tmpl", domainConfig, review: autoAcceptReview }),
        layers,
      ),
    )
    expect(existsSync(path.join(meDir("tmpl"), "background.md"))).toBe(true)
    expect(readFileSync(path.join(meDir("tmpl"), "DIARY.md"), "utf-8")).toContain("# Diary")
    expect(out.summary).toBeUndefined()
  })

  it("with a description generates each artifact and accepts them", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "gen", characterDescription: "a prospector",
          domainConfig, review: autoAcceptReview,
        }),
        layers,
      ),
    )
    const bg = readFileSync(path.join(meDir("gen"), "background.md"), "utf-8")
    expect(bg).toContain("GEN:")
    expect(out.summary).toContain("GEN:")
  })

  it("regenerate threads feedback then accept; skip writes template", async () => {
    // step order: background, values, palette, diary, summary
    const review = scriptedReview([
      { action: "regenerate", feedback: "grimmer" },        // background: re-roll once
      { action: "accept", content: "BG-OK" },               // background: accept edited
      { action: "accept", content: "VAL-OK" },              // values
      { action: "skip" },                                    // palette → TEMPLATE_PALETTE
      { action: "accept", content: "# Diary\nstuff" },      // diary
      { action: "accept", content: "summary text" },        // summary
    ])
    await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "mix", characterDescription: "x",
          domainConfig, review,
        }),
        layers,
      ),
    )
    expect(readFileSync(path.join(meDir("mix"), "background.md"), "utf-8")).toContain("BG-OK")
    // skipped palette falls to the template default
    expect(readFileSync(path.join(meDir("mix"), "PALETTE.md"), "utf-8")).toContain("→")
  })

  it("never overwrites an existing file", async () => {
    // first run
    await Effect.runPromise(Effect.provide(
      scaffoldCharacter({ projectRoot: root, characterName: "keep", domainConfig, review: autoAcceptReview }), layers))
    const before = readFileSync(path.join(meDir("keep"), "background.md"), "utf-8")
    // second run with a description must not overwrite
    await Effect.runPromise(Effect.provide(
      scaffoldCharacter({ projectRoot: root, characterName: "keep", characterDescription: "y", domainConfig, review: autoAcceptReview }), layers))
    expect(readFileSync(path.join(meDir("keep"), "background.md"), "utf-8")).toBe(before)
  })
})
