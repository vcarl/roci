import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { MalformedAxisError, paletteFile } from "./palette.js"
import { AxisCollisionError, parseSalience, parseVolatility, UnknownAxisError } from "./salience.js"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { ModelClient } from "../model/client.js"
import { ModelService } from "../services/ModelService.js"
import type { ModelHandle } from "../model/handles.js"
import { scaffoldCharacter, autoAcceptReview, ArtifactUnreadableError, type ReviewDecision, type ReviewFn } from "./character-scaffold.js"
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

// Records every prompt the scaffold sends, so a test can assert on what the
// model was actually ASKED — the only way to prove the derived axes reach the
// salience step. Content comes back from the scripted review, so what this
// returns is irrelevant.
const capturingLayers = (prompts: string[]): Layer.Layer<ModelClient | ModelService> =>
  Layer.mergeAll(
    Layer.succeed(
      ModelClient,
      ModelClient.of({
        complete: (_h: ModelHandle, messages) => {
          prompts.push(messages.map((m) => m.content).join("\n"))
          return Effect.succeed({ text: "GEN", raw: {} })
        },
      }),
    ),
    passThroughService,
  )

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
    // The salience spine mirrors the drive spine: core + the domain drive at neutral 0.5.
    const salience = readFileSync(path.join(meDir("merged"), "SALIENCE.md"), "utf-8")
    expect(salience.startsWith("# Salience")).toBe(true)
    expect(salience).toContain("- safety: 0.5")
    expect(salience).toContain("- voyage: 0.5")
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
    const salience = readFileSync(path.join(meDir("gen"), "SALIENCE.md"), "utf-8")
    expect(salience).toContain("GEN:") // the model-authored salience body was written
  })

  it("regenerate threads feedback then accept; skip writes template", async () => {
    // step order: background, values, palette, drives, diary, summary
    const review = scriptedReview([
      { action: "regenerate", feedback: "grimmer" },        // background: re-roll once
      { action: "accept", content: "BG-OK" },               // background: accept edited
      { action: "accept", content: "VAL-OK" },              // values
      { action: "skip" },                                    // palette → TEMPLATE_PALETTE
      { action: "skip" },                                    // drives → core+domain template
      { action: "skip" },                                    // salience → core+domain template
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
    // skipped salience falls to the core+domain spine (SALIENCE.md is written)
    const salience = readFileSync(path.join(meDir("mix"), "SALIENCE.md"), "utf-8")
    expect(salience).toContain("# Salience")
    expect(salience).toContain("- safety: 0.5")
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

  it("writes the dash-less Volatility default into a template SALIENCE.md", async () => {
    await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({ projectRoot: root, characterName: "vol", domainConfig, review: autoAcceptReview }),
        layers,
      ),
    )
    const salience = readFileSync(path.join(meDir("vol"), "SALIENCE.md"), "utf-8")
    expect(salience).toContain("Volatility: 0.3")
    expect(salience).not.toContain("- Volatility")
    expect(parseVolatility(salience)).toBe(0.3)
  })

  it("rejects a generated SALIENCE.md whose keys are outside the derived axis list", async () => {
    // Accept everything, but hand back a salience body with an off-vocabulary key.
    const review = scriptedReview([
      { action: "accept", content: "BG" },                       // background
      { action: "accept", content: "VAL" },                      // values
      { action: "accept", content: "🙄 😒 😐 😌 🫂 # grumbling → tender" }, // palette
      { action: "accept", content: "- safety — s\n- sustenance — u\n- agency — a" }, // drives
      { action: "accept", content: "- safety: 0.9\n- curiosity: 0.8\nVolatility: 0.4" }, // salience
      { action: "accept", content: "# Diary" },                  // diary
      { action: "accept", content: "summary" },                  // summary
    ])
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "badaxis", characterDescription: "x",
          domainConfig, review,
        }),
        layers,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const err = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
    expect(Option.isSome(err)).toBe(true)
    const value = Option.getOrThrow(err)
    expect(value).toBeInstanceOf(UnknownAxisError)
    expect((value as UnknownAxisError).unknown).toEqual(["curiosity"])
    // it failed BEFORE writing the artifact
    expect(existsSync(path.join(meDir("badaxis"), "SALIENCE.md"))).toBe(false)
  })

  it("rejects a malformed PALETTE.md row as a typed failure, before writing files", async () => {
    const review = scriptedReview([
      { action: "accept", content: "BG" },                       // background
      { action: "accept", content: "VAL" },                      // values
      { action: "accept", content: "🙄 😒 😐 😌 🫂 #  → tender" },  // palette: empty left pole
      { action: "accept", content: "- safety — s\n- sustenance — u\n- agency — a" }, // drives
      { action: "accept", content: "- safety: 0.9\nVolatility: 0.4" }, // salience
      { action: "accept", content: "# Diary" },                  // diary
      { action: "accept", content: "summary" },                  // summary
    ])
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "badpalette", characterDescription: "x",
          domainConfig, review,
        }),
        layers,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const err = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
    // A TYPED failure, not a defect — Cause.failureOption is Some.
    expect(Option.isSome(err)).toBe(true)
    const value = Option.getOrThrow(err)
    expect(value).toBeInstanceOf(MalformedAxisError)
    expect((value as MalformedAxisError).line).toContain("→ tender")
    expect(existsSync(path.join(meDir("badpalette"), "PALETTE.md"))).toBe(false)
  })

  it("accepts a generated SALIENCE.md that weights every derived axis", async () => {
    const review = scriptedReview([
      { action: "accept", content: "BG" },                       // background
      { action: "accept", content: "VAL" },                      // values
      { action: "accept", content: "🙄 😒 😐 😌 🫂 # grumbling → tender" }, // palette
      { action: "accept", content: "- safety — s\n- sustenance — u\n- agency — a" }, // drives
      { action: "accept", content: "- safety: 0.9\n- sustenance: 0.5\n- agency: 0.7\n- grumbling-tender: 0.6\nVolatility: 0.4" }, // salience
      { action: "accept", content: "# Diary" },                  // diary
      { action: "accept", content: "summary" },                  // summary
    ])
    await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "goodaxis", characterDescription: "x",
          domainConfig, review,
        }),
        layers,
      ),
    )
    const salience = readFileSync(path.join(meDir("goodaxis"), "SALIENCE.md"), "utf-8")
    expect(parseSalience(salience)).toEqual({
      safety: 0.9, sustenance: 0.5, agency: 0.7, "grumbling-tender": 0.6,
    })
    expect(parseVolatility(salience)).toBeCloseTo(0.4, 6)
  })

  it("hands the DERIVED AXES to the salience prompt", () => {
    // The headline wiring of this change: the salience step is asked to weight the
    // vocabulary derived from the approved DRIVES.md + PALETTE.md. Nothing else in
    // this suite reads a generated prompt, so delete `ctx.palette` /
    // `ctx.salienceAxes` in character-scaffold.ts and ONLY this test goes red.
    const prompts: string[] = []
    const review = scriptedReview([
      { action: "accept", content: "BG" },                       // background
      { action: "accept", content: "VAL" },                      // values
      { action: "accept", content: "🙄 😒 😐 😌 🫂 # grumbling → tender\n🤨 😑 😶 🧐 🔭 # cynical → curious" }, // palette
      { action: "accept", content: "- safety — s\n- sustenance — u\n- agency — a" }, // drives
      { action: "accept", content: "- safety: 0.9\n- sustenance: 0.5\n- agency: 0.7\n- grumbling-tender: 0.6\n- cynical-curious: 0.4\nVolatility: 0.4" }, // salience
      { action: "accept", content: "# Diary" },                  // diary
      { action: "accept", content: "summary" },                  // summary
    ])
    return Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "wired", characterDescription: "x",
          domainConfig, review,
        }),
        capturingLayers(prompts),
      ),
    ).then(() => {
      const salPrompt = prompts.find((p) => p.includes("SALIENCE profile"))
      expect(salPrompt, "no salience prompt was sent").toBeDefined()
      // the axis list, rendered by buildSaliencePrompt as one "- <axis>" per line
      for (const axis of ["safety", "sustenance", "agency", "grumbling-tender", "cynical-curious"]) {
        expect(salPrompt).toContain(`- ${axis}`)
      }
      // and the palette rides along as context, so the model can see the gradient
      // each derived name came from
      expect(salPrompt).toContain("🙄 😒 😐 😌 🫂 # grumbling → tender")
      // the derived names are NOT in any earlier prompt — they exist only because
      // the derivation site put them there
      expect(prompts.filter((p) => p.includes("grumbling-tender"))).toHaveLength(1)
      // R7: the drive spine the model is SHOWN must be the same effective body the
      // axes were derived from — never one vocabulary shown and another demanded.
      // ctx.baseDrives is re-threaded from the effective drive body and rendered
      // verbatim by buildSaliencePrompt, so the captured prompt string is the
      // pinning surface for it: "- <name> —" (with the description) only occurs
      // in the rendered DRIVES block, never in the bare axis-list block above.
      expect(salPrompt).toContain("- safety — s")
      for (const axis of ["safety", "sustenance", "agency", "grumbling-tender", "cynical-curious"]) {
        // Every DRIVE-tier axis (no hyphen in its name) appears verbatim in the
        // drives block shown to the model.
        if (!axis.includes("-")) expect(salPrompt).toContain(`- ${axis} —`)
      }
    })
  })

  it("R7: shows the ON-DISK drives in the salience prompt, not the freshly generated ones, when they differ", async () => {
    // The wiring test above never pre-seeds DRIVES.md, so effectiveDriveBody ===
    // the in-memory driveBody — a regression where ctx.baseDrives is re-threaded
    // from the STALE in-memory body while axes still derive from the on-disk one
    // would be INVISIBLE there, because there is nothing for the two to diverge
    // on. Force a real divergence: on disk, `stewardship`; generated in memory
    // (discarded by the never-overwrite rule), `voyage`.
    const dir = meDir("shownondisk")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, "DRIVES.md"),
      "# Drives\n\n- safety — s\n- sustenance — u\n- agency — a\n- stewardship — tend what you hold\n",
    )
    const prompts: string[] = []
    const review = scriptedReview([
      { action: "accept", content: "BG" },                       // background
      { action: "accept", content: "VAL" },                      // values
      { action: "accept", content: "🙄 😒 😐 😌 🫂 # grumbling → tender" }, // palette
      // Generated in memory — never reaches disk, but this is the body that
      // would leak into the salience prompt if the re-threading regressed.
      { action: "accept", content: "- safety — s\n- sustenance — u\n- agency — a\n- voyage — go" },
      // Weights the ON-DISK vocabulary; `voyage` would be off-vocabulary here.
      { action: "accept", content: "- stewardship: 0.7\n- grumbling-tender: 0.4\nVolatility: 0.4" },
      { action: "accept", content: "# Diary" },                  // diary
      { action: "accept", content: "summary" },                  // summary
    ])
    await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "shownondisk", characterDescription: "x",
          domainConfig, review,
        }),
        capturingLayers(prompts),
      ),
    )
    const salPrompt = prompts.find((p) => p.includes("SALIENCE profile"))
    expect(salPrompt, "no salience prompt was sent").toBeDefined()
    // The ON-DISK drive line — the one that will actually persist — is shown.
    expect(salPrompt).toContain("- stewardship — tend what you hold")
    // The generated in-memory drive line, discarded by never-overwrite, never
    // reaches the model at all — not the description, not even the bare name.
    expect(salPrompt).not.toContain("voyage")
  })

  it("derives from the ON-DISK palette when one already exists, not the regenerated one", async () => {
    // The blessed way to regenerate ONE artifact: delete it and re-run. PALETTE.md
    // survives, so block 1 regenerates a palette that will be thrown away — and the
    // vocabulary must follow the file that PERSISTS, not the one in memory.
    const dir = meDir("ondisk")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "PALETTE.md"), paletteFile("😐 😐 😐 😐 😐 # steady → frantic"))
    const review = scriptedReview([
      { action: "accept", content: "BG" },                       // background
      { action: "accept", content: "VAL" },                      // values
      { action: "accept", content: "🙄 😒 😐 😌 🫂 # grumbling → tender" }, // palette — DISCARDED, the file exists
      { action: "accept", content: "- safety — s\n- sustenance — u\n- agency — a" }, // drives
      { action: "accept", content: "- safety: 0.9\n- steady-frantic: 0.6\nVolatility: 0.4" }, // salience, keyed to the ON-DISK palette
      { action: "accept", content: "# Diary" },                  // diary
      { action: "accept", content: "summary" },                  // summary
    ])
    await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "ondisk", characterDescription: "x",
          domainConfig, review,
        }),
        layers,
      ),
    )
    // the on-disk palette is untouched…
    expect(readFileSync(path.join(dir, "PALETTE.md"), "utf-8")).toContain("steady → frantic")
    // …and the new SALIENCE.md is keyed to ITS axis, which validated cleanly.
    expect(parseSalience(readFileSync(path.join(dir, "SALIENCE.md"), "utf-8"))).toEqual({
      safety: 0.9, "steady-frantic": 0.6,
    })
  })

  it("rejects a profile keyed to the regenerated palette when PALETTE.md already exists", async () => {
    // The mirror of the test above: weighting `grumbling-tender` is now an UNKNOWN
    // axis, because the palette that will exist on disk has no such row. Loud, not
    // silent.
    const dir = meDir("ondisk2")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "PALETTE.md"), paletteFile("😐 😐 😐 😐 😐 # steady → frantic"))
    const review = scriptedReview([
      { action: "accept", content: "BG" },
      { action: "accept", content: "VAL" },
      { action: "accept", content: "🙄 😒 😐 😌 🫂 # grumbling → tender" },
      { action: "accept", content: "- safety — s\n- sustenance — u\n- agency — a" },
      { action: "accept", content: "- safety: 0.9\n- grumbling-tender: 0.6\nVolatility: 0.4" },
      { action: "accept", content: "# Diary" },
      { action: "accept", content: "summary" },
    ])
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "ondisk2", characterDescription: "x",
          domainConfig, review,
        }),
        layers,
      ),
    )
    const err = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
    expect(Option.isSome(err)).toBe(true)
    const value = Option.getOrThrow(err)
    expect(value).toBeInstanceOf(UnknownAxisError)
    expect((value as UnknownAxisError).unknown).toEqual(["grumbling-tender"])
    expect((value as UnknownAxisError).axes).toContain("steady-frantic")
    expect(existsSync(path.join(dir, "SALIENCE.md"))).toBe(false)
  })

  it("derives on the NO-DESCRIPTION path too: a domain drive colliding with a TEMPLATE_PALETTE pole pair fails typed", async () => {
    // TEMPLATE_PALETTE's second row is "😱 😟 😐 🙂 😌   # panic → calm", which
    // derives the axis "panic-calm". A domain drive of the same name collides in
    // the flat namespace. NOTE the deliberate absence of `characterDescription`:
    // this scaffolds via the plain-template path, which makes no model call and
    // runs no generation step. It therefore pins the property this task exists to
    // establish — derivation is on BOTH paths, at ONE site. Move the derivation
    // back inside `if (characterDescription)` and only THIS test goes red.
    const collidingDomain = {
      identityTemplate: {
        backgroundHints: "h",
        valuesHints: "v",
        domainDrives: [{ name: "panic-calm", description: "collides with the template palette" }],
      },
    } as unknown as DomainConfig
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "collide", domainConfig: collidingDomain,
          review: autoAcceptReview,
        }),
        layers,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const err = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
    // A TYPED failure, not a defect — this is the collision arm of the Effect.try.
    expect(Option.isSome(err)).toBe(true)
    const value = Option.getOrThrow(err)
    expect(value).toBeInstanceOf(AxisCollisionError)
    expect((value as AxisCollisionError).axis).toBe("panic-calm")
    // and it failed before writing anything
    expect(existsSync(path.join(meDir("collide"), "DRIVES.md"))).toBe(false)
    expect(existsSync(path.join(meDir("collide"), "PALETTE.md"))).toBe(false)
  })

  it("validates the SALIENCE.md that will be ON DISK, not the one just generated", async () => {
    // Pre-seed a character dir with an OLD-vocabulary SALIENCE.md and no PALETTE.md
    // — the blessed "delete one artifact and re-run" regeneration path.
    const dir = meDir("stalesal")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, "SALIENCE.md"),
      "# Salience\n\n- safety: 0.9\n- curiosity: 0.8\n",
    )
    const review = scriptedReview([
      { action: "accept", content: "BG" },
      { action: "accept", content: "VAL" },
      { action: "accept", content: "🙄 😒 😐 😌 🫂 # grumbling → tender" },
      { action: "accept", content: "- safety — s\n- sustenance — u\n- agency — a" },
      // The freshly generated profile is CLEAN; the stale one on disk is not.
      { action: "accept", content: "- safety: 0.9\n- grumbling-tender: 0.5\nVolatility: 0.4" },
      { action: "accept", content: "# Diary" },
      { action: "accept", content: "summary" },
    ])
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "stalesal", characterDescription: "x",
          domainConfig, review,
        }),
        layers,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const err = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
    expect(Option.isSome(err)).toBe(true)
    const value = Option.getOrThrow(err)
    expect(value).toBeInstanceOf(UnknownAxisError)
    expect((value as UnknownAxisError).unknown).toEqual(["curiosity"])
  })

  it("still accepts a freshly generated profile when no SALIENCE.md is on disk", async () => {
    const review = scriptedReview([
      { action: "accept", content: "BG" },
      { action: "accept", content: "VAL" },
      { action: "accept", content: "🙄 😒 😐 😌 🫂 # grumbling → tender" },
      { action: "accept", content: "- safety — s\n- sustenance — u\n- agency — a" },
      { action: "accept", content: "- safety: 0.9\n- grumbling-tender: 0.5\nVolatility: 0.4" },
      { action: "accept", content: "# Diary" },
      { action: "accept", content: "summary" },
    ])
    await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "freshsal", characterDescription: "x",
          domainConfig, review,
        }),
        layers,
      ),
    )
    expect(parseSalience(readFileSync(path.join(meDir("freshsal"), "SALIENCE.md"), "utf-8"))).toEqual({
      safety: 0.9, "grumbling-tender": 0.5,
    })
  })

  // Was: "…is a TYPED failure" asserting MalformedAxisError. It was typed, but it
  // named the WRONG PROBLEM — MalformedAxisError's message is fixed text about a
  // malformed palette axis LINE, and `.line` held a filesystem error string. For
  // DRIVES.md and SALIENCE.md the same throw also named the wrong FILE. Typed and
  // wrong is the failure class this branch exists to prevent.
  it("an unreadable PALETTE.md is a typed ArtifactUnreadableError, never a defect and never mislabelled", async () => {
    const dir = meDir("unreadable")
    mkdirSync(dir, { recursive: true })
    // A DIRECTORY where PALETTE.md should be: existsSync is true, readFileSync
    // throws EISDIR. The cheapest portable way to make the read fail.
    mkdirSync(path.join(dir, "PALETTE.md"), { recursive: true })
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        scaffoldCharacter({ projectRoot: root, characterName: "unreadable", domainConfig, review: autoAcceptReview }),
        layers,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    // The discriminator: a DEFECT would make failureOption None.
    const err = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
    expect(Option.isSome(err)).toBe(true)
    const value = Option.getOrThrow(err)
    expect(value).toBeInstanceOf(ArtifactUnreadableError)
    expect(value).not.toBeInstanceOf(MalformedAxisError)
    expect((value as ArtifactUnreadableError).artifact).toContain("PALETTE.md")
    expect((value as ArtifactUnreadableError).cause).toBeDefined()
    // It must not tell the operator to go fix a palette axis line.
    expect((value as ArtifactUnreadableError).message).not.toMatch(/malformed palette axis line/i)
    expect((value as ArtifactUnreadableError).message).toContain("PALETTE.md")
  })

  it("an unreadable DRIVES.md names DRIVES.md, not PALETTE.md", async () => {
    const dir = meDir("unreadabledrives")
    mkdirSync(dir, { recursive: true })
    mkdirSync(path.join(dir, "DRIVES.md"), { recursive: true })
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        scaffoldCharacter({ projectRoot: root, characterName: "unreadabledrives", domainConfig, review: autoAcceptReview }),
        layers,
      ),
    )
    const err = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
    expect(Option.isSome(err)).toBe(true)
    const value = Option.getOrThrow(err)
    expect(value).toBeInstanceOf(ArtifactUnreadableError)
    expect((value as ArtifactUnreadableError).artifact).toContain("DRIVES.md")
    expect((value as ArtifactUnreadableError).message).not.toContain("PALETTE.md")
  })

  // The SECOND Effect.try site — the on-disk SALIENCE.md read, which had the same
  // mislabelling and additionally routed anything unexpected to AxisCollisionError.
  it("an unreadable SALIENCE.md is a typed ArtifactUnreadableError naming SALIENCE.md", async () => {
    const dir = meDir("unreadablesal")
    mkdirSync(dir, { recursive: true })
    mkdirSync(path.join(dir, "SALIENCE.md"), { recursive: true })
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        scaffoldCharacter({ projectRoot: root, characterName: "unreadablesal", domainConfig, review: autoAcceptReview }),
        layers,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const err = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
    expect(Option.isSome(err)).toBe(true)
    const value = Option.getOrThrow(err)
    expect(value).toBeInstanceOf(ArtifactUnreadableError)
    expect(value).not.toBeInstanceOf(AxisCollisionError)
    expect((value as ArtifactUnreadableError).artifact).toContain("SALIENCE.md")
  })

  it("R4: derives drive axes from the ON-DISK DRIVES.md when one already exists", async () => {
    const dir = meDir("ondiskdrives")
    mkdirSync(dir, { recursive: true })
    // On disk: a drive spine WITHOUT the domain's `voyage` drive but WITH an
    // extra `stewardship`. Derivation must follow this file, not the template.
    writeFileSync(
      path.join(dir, "DRIVES.md"),
      "# Drives\n\n- safety — s\n- sustenance — u\n- agency — a\n- stewardship — tend what you hold\n",
    )
    const review = scriptedReview([
      { action: "accept", content: "BG" },
      { action: "accept", content: "VAL" },
      { action: "accept", content: "🙄 😒 😐 😌 🫂 # grumbling → tender" },
      { action: "accept", content: "- safety — s\n- sustenance — u\n- agency — a\n- voyage — go" },
      // Weights the ON-DISK vocabulary. `voyage` would be off-vocabulary here.
      { action: "accept", content: "- stewardship: 0.7\n- grumbling-tender: 0.4\nVolatility: 0.4" },
      { action: "accept", content: "# Diary" },
      { action: "accept", content: "summary" },
    ])
    await Effect.runPromise(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "ondiskdrives", characterDescription: "x",
          domainConfig, review,
        }),
        layers,
      ),
    )
    // It accepted a profile keyed to the ON-DISK drives; the generated DRIVES.md
    // was discarded by the never-overwrite rule, exactly as derivation assumed.
    const drives = readFileSync(path.join(dir, "DRIVES.md"), "utf-8")
    expect(drives).toContain("stewardship")
    expect(drives).not.toContain("voyage")
  })

  it("R5: a pre-existing DRIVES.md lacking the domain drive aborts BEFORE any file is written", async () => {
    const dir = meDir("nodomdrive")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "DRIVES.md"), "# Drives\n\n- safety — s\n- sustenance — u\n- agency — a\n")
    // Template path: no description, so salienceBody = renderSalienceLines(domainDrives),
    // which carries a `voyage` row the on-disk DRIVES.md does not license. (The
    // module-level `domainConfig` stub has no domainDrives, so this needs the same
    // "voyage" domain drive the "merges the domain's domainDrives" test above uses
    // — otherwise nothing invokes voyage anywhere and there is nothing to abort on.)
    const domainWithVoyage = {
      identityTemplate: {
        backgroundHints: "h",
        valuesHints: "v",
        domainDrives: [{ name: "voyage", description: "progress toward your destination" }],
      },
    } as unknown as DomainConfig
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        scaffoldCharacter({
          projectRoot: root, characterName: "nodomdrive", domainConfig: domainWithVoyage, review: autoAcceptReview,
        }),
        layers,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const err = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
    expect(Option.isSome(err)).toBe(true)
    const value = Option.getOrThrow(err)
    expect(value).toBeInstanceOf(UnknownAxisError)
    expect((value as UnknownAxisError).unknown).toEqual(["voyage"])
    // Nothing written — the abort precedes the write loop.
    expect(existsSync(path.join(dir, "SALIENCE.md"))).toBe(false)
    expect(existsSync(path.join(dir, "PALETTE.md"))).toBe(false)
  })
})
