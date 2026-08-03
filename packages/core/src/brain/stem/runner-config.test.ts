import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { buildRunnerConfig } from "./runner-config.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { TEMPLATE_PALETTE } from "../../core/palette.js"
import { DEFAULT_VOLATILITY } from "../../core/salience.js"
import { TEMPLATE_DRIVES } from "#brain/limbic/hypothalamus/drives.js"
import { CharacterLog } from "../../logging/log-writer.js"
import type { UnifiedEvent } from "../../logging/events.js"

const char = { name: "ada", root: "/work/players/ada" }

function fsLayer(opts: { palette?: string; drives?: string; salience?: string; fail?: boolean }) {
  const read = (v: string | undefined) =>
    opts.fail ? Effect.fail(new Error("no such file")) : Effect.succeed(v ?? "")
  return Layer.succeed(
    CharacterFs,
    CharacterFs.of({
      readDiary: () => Effect.succeed(""),
      writeDiary: () => Effect.void,
      readSecrets: () => Effect.succeed(""),
      writeSecrets: () => Effect.void,
      readCredentials: () => Effect.succeed({ username: "", password: "" }),
      readBackground: () => Effect.succeed(""),
      readValues: () => Effect.succeed(""),
      readPalette: () => read(opts.palette) as never,
      readDrives: () => read(opts.drives) as never,
      readSalience: () => read(opts.salience) as never,
      characterExists: () => Effect.succeed(true),
      listSkills: () => Effect.succeed([]),
      readSkill: () => Effect.succeed(null),
      writeSkill: () => Effect.void,
      readSynthesis: () => Effect.succeed(""),
      writeSynthesis: () => Effect.void,
      deleteSkill: () => Effect.void,
    }),
  )
}

const logLayer = (sink: UnifiedEvent[]) =>
  Layer.succeed(
    CharacterLog,
    CharacterLog.of({
      emit: (_c, e) =>
        Effect.sync(() => {
          sink.push(e)
        }),
    }),
  )

const build = (fs: Layer.Layer<CharacterFs>, sink: UnifiedEvent[] = []) =>
  Effect.runPromise(
    buildRunnerConfig({ char }).pipe(Effect.provide(Layer.mergeAll(fs, logLayer(sink)))),
  )

describe("buildRunnerConfig — the ONE salience-axis derivation site", () => {
  it("derives the axis vocabulary from the character's own DRIVES.md + PALETTE.md", async () => {
    const cfg = await build(
      fsLayer({
        drives: "- safety — your physical integrity\n- voyage — progress toward your destination",
        palette: "😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated",
      }),
    )
    expect(cfg.axes?.map((a) => a.name)).toEqual(["safety", "voyage", "burdened-exhilarated"])
    expect(cfg.axes?.find((a) => a.name === "burdened-exhilarated")?.polarity).toBe("bipolar")
  })

  it("falls back to the template artifacts when the files cannot be read", async () => {
    const cfg = await build(fsLayer({ fail: true }))
    expect(cfg.palette).toBe(TEMPLATE_PALETTE)
    expect(cfg.drives).toBe(TEMPLATE_DRIVES)
    expect((cfg.axes ?? []).length).toBeGreaterThan(0)
  })

  it("degrades to NO vocabulary and logs loudly on a malformed palette — never fails", async () => {
    const sink: UnifiedEvent[] = []
    // "to" instead of the arrow: a MalformedAxisError, which must not cost a run.
    const cfg = await build(
      fsLayer({ drives: "- safety — x", palette: "😫 😮‍💨 😐 🤩 🚀 # burdened to exhilarated" }),
      sink,
    )
    expect(cfg.axes).toEqual([])
    // logError, not a silenceable info line.
    expect(sink.some((e) => e.kind === "error")).toBe(true)
  })

  it("reads the character's emotional volatility (α) from SALIENCE.md", async () => {
    const cfg = await build(
      fsLayer({
        drives: "- safety — your physical integrity",
        palette: "😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated",
        salience: "Volatility: 0.75\n\n- safety: 0.9",
      }),
    )
    expect(cfg.volatility).toBeCloseTo(0.75, 6)
  })

  it("falls back to the default volatility when SALIENCE.md is unreadable", async () => {
    const cfg = await build(fsLayer({ fail: true }))
    expect(cfg.volatility).toBeCloseTo(DEFAULT_VOLATILITY, 6)
  })

  it("falls back to the default volatility when the line is absent", async () => {
    const cfg = await build(
      fsLayer({
        drives: "- safety — your physical integrity",
        palette: "😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated",
        salience: "- safety: 0.9",
      }),
    )
    expect(cfg.volatility).toBeCloseTo(DEFAULT_VOLATILITY, 6)
  })
})
