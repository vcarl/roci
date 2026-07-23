import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CharacterConfig } from "./CharacterFs.js"
import { meDir } from "./character-paths.js"
import {
  MAX_SKILLS,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_WHEN_TO_USE_CHARS,
  MAX_SKILL_NAME_CHARS,
  slugify,
  parseSkillFile,
  serializeSkillFile,
  renderSkillIndex,
  validateSkillWrite,
  SEED_SKILLS,
  ensureSeedSkills,
  type SkillDoc,
} from "./skills-core.js"

describe("slugify", () => {
  it("lowercases, replaces non-alphanumerics with hyphens, trims runs", () => {
    expect(slugify("Editing Skills")).toBe("editing-skills")
    expect(slugify("  Fuel!! Runs?  ")).toBe("fuel-runs")
    expect(slugify("learning")).toBe("learning")
  })
  it("never returns empty", () => {
    expect(slugify("!!!")).toBe("skill")
  })
})

describe("parseSkillFile / serializeSkillFile", () => {
  it("round-trips a well-formed skill, keeping a comma in when_to_use as ONE string (not an array)", () => {
    const doc: SkillDoc = {
      slug: "learning",
      name: "learning",
      description: "Capture a lesson.",
      whenToUse: "when something surprised you, went wrong, or worked unexpectedly well",
      body: "# Learning\n\nDo the thing.\n\n---\n\nMore.",
    }
    const parsed = parseSkillFile("learning", serializeSkillFile(doc))
    expect(parsed).toEqual(doc)
    // The comma did NOT split whenToUse into an array (the parseFrontmatter bug).
    expect(typeof parsed.whenToUse).toBe("string")
  })
  it("is tolerant: garbage / no frontmatter → defaults, never throws", () => {
    const p = parseSkillFile("weird", "no frontmatter here")
    expect(p.slug).toBe("weird")
    expect(p.name).toBe("weird") // falls back to slug
    expect(p.description).toBe("")
    expect(p.whenToUse).toBe("")
    expect(p.body).toBe("no frontmatter here")
  })
  it("body may itself contain '---' fences without breaking the parse", () => {
    const doc: SkillDoc = { slug: "x", name: "x", description: "d", whenToUse: "w", body: "A\n\n---\n\nB\n\n---\n\nC" }
    expect(parseSkillFile("x", serializeSkillFile(doc)).body).toBe("A\n\n---\n\nB\n\n---\n\nC")
  })
  it("CRLF round-trip: a CRLF-encoded serialized skill parses cleanly, no leaked frontmatter", () => {
    const doc: SkillDoc = {
      slug: "y", name: "y", description: "dd", whenToUse: "ww", body: "line one\nline two",
    }
    const crlf = serializeSkillFile(doc).replace(/\n/g, "\r\n")
    expect(parseSkillFile("y", crlf)).toEqual(doc)
  })

  it("collapses C1 control bytes and U+2028/U+2029 in name/description/when_to_use at parse time", () => {
    // A hand-edited (or adversarially-crafted) skill file can carry a C1
    // control byte or a Unicode line/paragraph separator inside a frontmatter
    // value. \r?\n-splitting the frontmatter block doesn't break on either, so
    // without this collapse they'd survive verbatim into every decide-prompt
    // render (skills-core.ts:96-101) — the same class of prompt-injection risk
    // wm-core.ts:221 already collapses for WM.md render.
    const raw = [
      "---",
      "name: fuelruns", // U+0085 NEL, a C1 control byte
      "description: top up", // U+2028 LINE SEPARATOR
      "when_to_use: before burn", // U+2029 PARAGRAPH SEPARATOR
      "---",
      "",
      "body",
    ].join("\n")
    const parsed = parseSkillFile("fuel-runs", raw)
    expect(parsed.name).toBe("fuel runs")
    expect(parsed.description).toBe("top up")
    expect(parsed.whenToUse).toBe("before burn")
    // And the collapse survives into the decide-prompt index render.
    expect(renderSkillIndex([parsed])).toBe(
      "- fuel runs — top up (use when: before burn)",
    )
  })
})

describe("renderSkillIndex", () => {
  it("renders one compact line per skill (name + description + when_to_use), NO bodies", () => {
    const index = renderSkillIndex([
      { slug: "learning", name: "learning", description: "Capture a lesson.", whenToUse: "after a surprise" },
      { slug: "editing-skills", name: "editing-skills", description: "Author skills well.", whenToUse: "before editing me/skills" },
    ])
    expect(index).toBe(
      [
        "- learning — Capture a lesson. (use when: after a surprise)",
        "- editing-skills — Author skills well. (use when: before editing me/skills)",
      ].join("\n"),
    )
  })
  it("returns a placeholder when there are no skills", () => {
    expect(renderSkillIndex([])).toBe("(no skills yet)")
  })
})

describe("validateSkillWrite — caps (spec §3)", () => {
  it("rejects a body over MAX_SKILL_BODY_CHARS", () => {
    const r = validateSkillWrite([], "big", "a".repeat(MAX_SKILL_BODY_CHARS + 1))
    expect(r.ok).toBe(false)
  })
  it("rejects a NEW skill once MAX_SKILLS distinct skills exist", () => {
    const slugs = Array.from({ length: MAX_SKILLS }, (_, i) => `s${i}`)
    expect(validateSkillWrite(slugs, "one-more", "body").ok).toBe(false)
    // ...but re-writing an EXISTING slug at the cap is allowed (count doesn't grow).
    expect(validateSkillWrite(slugs, "s0", "body").ok).toBe(true)
  })
  it("allows a new skill under the cap", () => {
    expect(validateSkillWrite(["a", "b"], "c", "body").ok).toBe(true)
  })
  it("rejects a description over MAX_SKILL_DESCRIPTION_CHARS", () => {
    const r = validateSkillWrite([], "s", "body", { description: "d".repeat(MAX_SKILL_DESCRIPTION_CHARS + 1) })
    expect(r.ok).toBe(false)
  })
  it("rejects a when_to_use over MAX_SKILL_WHEN_TO_USE_CHARS", () => {
    const r = validateSkillWrite([], "s", "body", { whenToUse: "w".repeat(MAX_SKILL_WHEN_TO_USE_CHARS + 1) })
    expect(r.ok).toBe(false)
  })
  it("allows description/whenToUse within their caps", () => {
    const r = validateSkillWrite([], "s", "body", {
      description: "d".repeat(MAX_SKILL_DESCRIPTION_CHARS),
      whenToUse: "w".repeat(MAX_SKILL_WHEN_TO_USE_CHARS),
    })
    expect(r.ok).toBe(true)
  })
  it("rejects a name over MAX_SKILL_NAME_CHARS", () => {
    const r = validateSkillWrite([], "s", "body", { name: "n".repeat(MAX_SKILL_NAME_CHARS + 1) })
    expect(r.ok).toBe(false)
  })
  it("rejects a name containing a newline — serializeSkillFile writes it unescaped as `name: ${name}`,\n      so an embedded \\n or \\r would break the frontmatter fence structurally", () => {
    expect(validateSkillWrite([], "s", "body", { name: "evil\nname" }).ok).toBe(false)
    expect(validateSkillWrite([], "s", "body", { name: "evil\rname" }).ok).toBe(false)
  })
  it("allows a name within cap and free of newlines", () => {
    expect(validateSkillWrite([], "s", "body", { name: "n".repeat(MAX_SKILL_NAME_CHARS) }).ok).toBe(true)
  })
  it("rejects a newline in description or when_to_use (macro passes model strings)", () => {
    expect(validateSkillWrite([], "s", "body", { description: "line1\nline2" })).toEqual({
      ok: false,
      error: "skill description contains a newline",
    })
    expect(validateSkillWrite([], "s", "body", { whenToUse: "when a\nwhen b" })).toEqual({
      ok: false,
      error: "skill when_to_use contains a newline",
    })
    // a clean single-line value still passes
    expect(validateSkillWrite([], "s", "body", { description: "clean", whenToUse: "clean" })).toEqual({ ok: true })
  })
})

describe("SEED_SKILLS", () => {
  it("is exactly editing-skills and learning, both well-formed and within caps", () => {
    expect(SEED_SKILLS.map((s) => s.slug)).toEqual(["editing-skills", "learning"])
    for (const s of SEED_SKILLS) {
      expect(s.name).toBe(s.slug)
      expect(s.description.length).toBeGreaterThan(0)
      expect(s.whenToUse.length).toBeGreaterThan(0)
      expect(s.body.length).toBeLessThanOrEqual(MAX_SKILL_BODY_CHARS)
      // Grounded in the character's real tools.
      expect(s.body).toContain("me/skills/")
    }
    // editing-skills teaches the frontmatter keys and the caps.
    const editing = SEED_SKILLS[0].body
    expect(editing).toContain("when_to_use")
    expect(editing).toContain(String(MAX_SKILLS))
    // learning teaches the memory verbs and points at editing-skills.
    const learning = SEED_SKILLS[1].body
    expect(learning).toMatch(/memory (remember|search|recent)/)
    expect(learning).toContain("editing-skills")
  })
})

describe("ensureSeedSkills — idempotent host seeding", () => {
  let root: string
  let char: CharacterConfig
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-seed-"))
    char = { name: "ada", root: path.join(root, "players", "ada") }
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("seeds both skill files, then leaves an edited file untouched on re-run", async () => {
    await Effect.runPromise(ensureSeedSkills(char))
    const dir = path.join(meDir(char), "skills")
    expect(fs.readdirSync(dir).sort()).toEqual(["editing-skills.md", "learning.md"])
    expect(fs.readFileSync(path.join(dir, "learning.md"), "utf8")).toContain("name: learning")

    // Simulate the agent revising a skill, then a re-provision.
    fs.writeFileSync(path.join(dir, "learning.md"), "MY OWN VERSION")
    await Effect.runPromise(ensureSeedSkills(char))
    expect(fs.readFileSync(path.join(dir, "learning.md"), "utf8")).toBe("MY OWN VERSION")
  })

  it("never fails even when the skills dir path is unwritable", async () => {
    // Make players/ a FILE so mkdir -p fails.
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "players"), "not a directory")
    await expect(Effect.runPromise(ensureSeedSkills(char))).resolves.toBeUndefined()
  })
})
