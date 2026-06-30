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
    // DRIVES.md is written from the core template even with no description.
    expect(readFileSync(path.join(meDir("tmpl"), "DRIVES.md"), "utf-8")).toContain("- agency —")
    expect(out.summary).toBeUndefined()
  })

  it("merges the domain's domainDrives into DRIVES.md alongside the core drives", async () => {
    const domainWithDrives = {
      identityTemplate: {
        backgroundHints: "h",
        valuesHints: "v",
        domainDrives: [{ name: "voyage", description: "progress toward your destination" }],
      },
    } as unknown as DomainConfig
    await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({ projectRoot: root, characterName: "merged", domainConfig: domainWithDrives, review: autoAcceptReview }),
        layers,
      ),
    )
    const drives = readFileSync(path.join(meDir("merged"), "DRIVES.md"), "utf-8")
    expect(drives).toContain("- safety —")
    expect(drives).toContain("- voyage — progress toward your destination")
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
    // step order: background, values, palette, drives, diary, summary
    const review = scriptedReview([
      { action: "regenerate", feedback: "grimmer" },        // background: re-roll once
      { action: "accept", content: "BG-OK" },               // background: accept edited
      { action: "accept", content: "VAL-OK" },              // values
      { action: "skip" },                                    // palette → TEMPLATE_PALETTE
      { action: "skip" },                                    // drives → core+domain template
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
    // skipped drives falls to the core+domain template (DRIVES.md is written)
    const drives = readFileSync(path.join(meDir("mix"), "DRIVES.md"), "utf-8")
    expect(drives).toContain("# Drives")
    expect(drives).toContain("- safety —")
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
