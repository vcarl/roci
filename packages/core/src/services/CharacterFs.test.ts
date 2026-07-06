import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { CharacterFs, CharacterFsLive, SYNTHESIS_FILE, type CharacterConfig } from "./CharacterFs.js"
import { MAX_SKILLS, type SkillDoc } from "./skills-core.js"

let root: string
let char: CharacterConfig
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "charfs-skills-"))
  char = { name: "ada", dir: path.join(root, "players", "ada", "me") }
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const run = <A, E>(e: Effect.Effect<A, E, CharacterFs>) =>
  Effect.runPromise(Effect.provide(e, Layer.provide(CharacterFsLive, NodeFileSystem.layer)))

const doc = (over: Partial<SkillDoc>): SkillDoc => ({
  slug: "x", name: "x", description: "d", whenToUse: "w", body: "b", ...over,
})

describe("CharacterFs skills surface (spec §3)", () => {
  it("listSkills returns [] when the skills dir is missing", async () => {
    expect(await run(Effect.flatMap(CharacterFs, (s) => s.listSkills(char)))).toEqual([])
  })

  it("writeSkill persists a skill; readSkill resolves it by name; listSkills reports its meta", async () => {
    await run(Effect.flatMap(CharacterFs, (s) => s.writeSkill(char, doc({ name: "Securing Fuel", body: "top up early" }))))
    // File landed at the slugified path.
    expect(fs.existsSync(path.join(char.dir, "skills", "securing-fuel.md"))).toBe(true)
    const read = await run(Effect.flatMap(CharacterFs, (s) => s.readSkill(char, "Securing Fuel")))
    expect(read).toMatchObject({ slug: "securing-fuel", name: "Securing Fuel", body: "top up early" })
    const metas = await run(Effect.flatMap(CharacterFs, (s) => s.listSkills(char)))
    expect(metas).toEqual([{ slug: "securing-fuel", name: "Securing Fuel", description: "d", whenToUse: "w" }])
  })

  it("readSkill returns null for a name with no file (degrade-never-fail)", async () => {
    expect(await run(Effect.flatMap(CharacterFs, (s) => s.readSkill(char, "nope")))).toBeNull()
  })

  it("writeSkill enforces the body-size cap", async () => {
    const big = doc({ name: "big", body: "a".repeat(5000) })
    const res = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(CharacterFs, (s) => s.writeSkill(char, big)),
        Layer.provide(CharacterFsLive, NodeFileSystem.layer),
      ).pipe(Effect.either),
    )
    expect(res._tag).toBe("Left")
  })

  it("writeSkill enforces the count cap but allows overwriting an existing slug", async () => {
    for (let i = 0; i < MAX_SKILLS; i++) {
      await run(Effect.flatMap(CharacterFs, (s) => s.writeSkill(char, doc({ name: `skill ${i}` }))))
    }
    // A 13th distinct skill is rejected.
    const rejected = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(CharacterFs, (s) => s.writeSkill(char, doc({ name: "one more" }))),
        Layer.provide(CharacterFsLive, NodeFileSystem.layer),
      ).pipe(Effect.either),
    )
    expect(rejected._tag).toBe("Left")
    // Re-writing an existing slug at the cap succeeds.
    await run(Effect.flatMap(CharacterFs, (s) => s.writeSkill(char, doc({ name: "skill 0", body: "revised" }))))
    const back = await run(Effect.flatMap(CharacterFs, (s) => s.readSkill(char, "skill 0")))
    expect(back?.body).toBe("revised")
  })
})

describe("readSynthesis / writeSynthesis / deleteSkill (Stage 5 macro surface)", () => {
  it("readSynthesis returns '' when SYNTHESIS.md is absent, round-trips after write", async () => {
    expect(await run(Effect.flatMap(CharacterFs, (s) => s.readSynthesis(char)))).toBe("")
    await run(Effect.flatMap(CharacterFs, (s) => s.writeSynthesis(char, "I am the ship that remembers.\n")))
    expect(fs.existsSync(path.join(char.dir, SYNTHESIS_FILE))).toBe(true)
    expect(await run(Effect.flatMap(CharacterFs, (s) => s.readSynthesis(char)))).toBe(
      "I am the ship that remembers.\n",
    )
  })

  it("deleteSkill removes me/skills/<slug>.md and is a no-op when absent", async () => {
    await run(
      Effect.flatMap(CharacterFs, (s) =>
        s.writeSkill(char, doc({ slug: "securing-fuel", name: "securing-fuel", description: "d", whenToUse: "w", body: "b" })),
      ),
    )
    expect(fs.existsSync(path.join(char.dir, "skills", "securing-fuel.md"))).toBe(true)
    await run(Effect.flatMap(CharacterFs, (s) => s.deleteSkill(char, "securing-fuel")))
    expect(fs.existsSync(path.join(char.dir, "skills", "securing-fuel.md"))).toBe(false)
    // idempotent: deleting again does not throw
    await run(Effect.flatMap(CharacterFs, (s) => s.deleteSkill(char, "securing-fuel")))
    expect(await run(Effect.flatMap(CharacterFs, (s) => s.listSkills(char)))).toEqual([])
  })
})
