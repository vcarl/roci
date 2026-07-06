/**
 * Agent-maintained skills — pure core (agent-cognition Stage 3, spec §3):
 * types, caps, the tolerant frontmatter parser + serializer, the compact
 * decide-prompt index render, the write-cap gate, the two seed documents, and
 * the host-side idempotent seeder.
 *
 * Files live at players/<name>/me/skills/<slug>.md — YAML frontmatter
 * {name, description, when_to_use} + a markdown body. Terminology is plainly
 * "skills"; no "hats" metaphor anywhere.
 */
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import type { CharacterConfig } from "./CharacterFs.js"

/** At most this many distinct skills per character (spec §3 Caps). */
export const MAX_SKILLS = 12
/** Max skill body size in characters (spec §3 Caps). */
export const MAX_SKILL_BODY_CHARS = 4096
/** Max frontmatter `description` length — flows into every decide-prompt render. */
export const MAX_SKILL_DESCRIPTION_CHARS = 200
/** Max frontmatter `when_to_use` length — flows into every decide-prompt render. */
export const MAX_SKILL_WHEN_TO_USE_CHARS = 200
/** Max frontmatter `name` length — unbounded otherwise, it too flows into the decide index. */
export const MAX_SKILL_NAME_CHARS = 100

/**
 * Render-only sanitization for untrusted frontmatter values (mirrors
 * wm-core.ts's WM.md render collapse): a hand-edited or adversarially-crafted
 * skill file's name/description/when_to_use can carry a C1 control byte or a
 * Unicode line/paragraph separator (U+2028/U+2029) that survives the
 * \r?\n-based frontmatter line split untouched. Collapse runs of either to a
 * single space so no such value can smuggle an extra line into the
 * decide-prompt index or a step-task render.
 */
function collapseControlChars(value: string): string {
  return value.replace(/[\x00-\x1F\x7F-\x9F\u2028\u2029]+/g, " ")
}

/** Frontmatter-only view of a skill — the compact decide index (no body). */
export interface SkillMeta {
  slug: string
  name: string
  description: string
  whenToUse: string
}

/** A full skill: its metadata plus the markdown body injected into a step task. */
export interface SkillDoc extends SkillMeta {
  body: string
}

/** name → filesystem slug. Deterministic, so readSkill(name) reconstructs the file. */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)
  return s || "skill"
}

/**
 * Tolerant skill-file parser. Deliberately NOT core/template.ts's
 * parseFrontmatter, which comma-splits values into arrays (template.ts:37-40)
 * and would corrupt a `when_to_use` that contains commas. Each frontmatter
 * value is a plain string here (quotes stripped, no splitting). Missing or
 * garbled frontmatter degrades to defaults — a hand-edited skill file must
 * never wedge the decide path.
 */
export function parseSkillFile(slug: string, text: string): SkillDoc {
  // \r?\n-tolerant: a hand-edited or Windows-authored skill file may use CRLF
  // line endings. Without this, the fence regex fails to match on such a file
  // and its entire raw text — frontmatter included — leaks into `body`, which
  // reaches the character's step prompt verbatim.
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  const meta: Record<string, string> = {}
  let body = text
  if (m) {
    body = m[2]
    for (const line of m[1].split(/\r?\n/)) {
      // dotAll ('s'): U+2028/U+2029 are ECMAScript line terminators, so a
      // value carrying one would otherwise stop `.` mid-capture and fail
      // this whole line's match (dropping the field to its "" default)
      // instead of reaching collapseControlChars below.
      const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/s)
      if (!kv) continue
      // Collapse at field-capture time (not just at render time): the
      // \r?\n split above doesn't break on a C1 control byte or a Unicode
      // line/paragraph separator, so an untrusted value carrying either
      // would otherwise reach every consumer of this field (the decide
      // index, the step-prompt skill name) verbatim.
      meta[kv[1]] = collapseControlChars(kv[2].trim().replace(/^["']|["']$/g, ""))
    }
  }
  return {
    slug,
    name: meta.name || slug,
    description: meta.description || "",
    whenToUse: meta.when_to_use || "",
    body: body.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\s+$/, ""),
  }
}

/** Serialize a skill to its on-disk form. Body may itself contain '---' fences. */
export function serializeSkillFile(doc: SkillDoc): string {
  return [
    "---",
    `name: ${doc.name}`,
    `description: ${doc.description}`,
    `when_to_use: ${doc.whenToUse}`,
    "---",
    "",
    doc.body.replace(/\s+$/, ""),
    "",
  ].join("\n")
}

/**
 * The compact skill index for the decide prompt (spec §3 Selection): one line
 * per skill, name + description + when_to_use ONLY — never bodies (small-model
 * prompt budget). Bodies enter the prompt one at a time via formatStepTask.
 */
export function renderSkillIndex(metas: readonly SkillMeta[]): string {
  if (metas.length === 0) return "(no skills yet)"
  return metas
    .map((s) => `- ${s.name} — ${s.description}${s.whenToUse ? ` (use when: ${s.whenToUse})` : ""}`)
    .join("\n")
}

/**
 * Cap gate applied at write time (spec §3 Caps). A body over the char cap is
 * rejected; a NEW slug is rejected once MAX_SKILLS distinct skills exist;
 * re-writing an existing slug is always allowed (the count doesn't grow).
 * `fields` optionally caps the frontmatter description/when_to_use/name —
 * description and when_to_use flow into every decide-prompt render, so an
 * unbounded value would bloat every future prompt this skill appears in.
 * `name` is checked here on the INPUT value (before the Fix-1 parse-time
 * collapse ever sees it): nothing else caps it, and serializeSkillFile writes
 * `name: ${name}` unescaped, so a newline-bearing name would emit a
 * structurally broken frontmatter fence.
 */
export function validateSkillWrite(
  existingSlugs: readonly string[],
  slug: string,
  body: string,
  fields?: { description?: string; whenToUse?: string; name?: string },
): { ok: true } | { ok: false; error: string } {
  if (body.length > MAX_SKILL_BODY_CHARS) {
    return { ok: false, error: `skill body ${body.length} chars exceeds cap ${MAX_SKILL_BODY_CHARS}` }
  }
  if (fields?.name !== undefined) {
    if (/[\r\n]/.test(fields.name)) {
      return { ok: false, error: "skill name contains a newline" }
    }
    if (fields.name.length > MAX_SKILL_NAME_CHARS) {
      return { ok: false, error: `skill name ${fields.name.length} chars exceeds cap ${MAX_SKILL_NAME_CHARS}` }
    }
  }
  if (fields?.description !== undefined && /[\r\n]/.test(fields.description)) {
    return { ok: false, error: "skill description contains a newline" }
  }
  if (fields?.whenToUse !== undefined && /[\r\n]/.test(fields.whenToUse)) {
    return { ok: false, error: "skill when_to_use contains a newline" }
  }
  if (fields?.description !== undefined && fields.description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    return {
      ok: false,
      error: `skill description ${fields.description.length} chars exceeds cap ${MAX_SKILL_DESCRIPTION_CHARS}`,
    }
  }
  if (fields?.whenToUse !== undefined && fields.whenToUse.length > MAX_SKILL_WHEN_TO_USE_CHARS) {
    return {
      ok: false,
      error: `skill when_to_use ${fields.whenToUse.length} chars exceeds cap ${MAX_SKILL_WHEN_TO_USE_CHARS}`,
    }
  }
  if (!existingSlugs.includes(slug) && existingSlugs.length >= MAX_SKILLS) {
    return { ok: false, error: `skill cap reached (${MAX_SKILLS}); revise or retire an existing skill` }
  }
  return { ok: true }
}

// ── Seed skills (spec §3 Seeding): exactly two, character-facing prompt docs ──
const EDITING_SKILLS_BODY = [
  "# Editing your skills",
  "",
  "A skill is a short note-to-self about how to do a kind of work well. Your skills live",
  "as files in `me/skills/<slug>.md`. You can read, create, and rewrite them directly",
  "with your normal file tools — the slug is just the file name (lower-case, hyphens).",
  "",
  "## The shape of a skill file",
  "",
  "Every skill starts with three frontmatter lines between `---` fences, then a body:",
  "",
  "```",
  "---",
  "name: securing-fuel",
  "description: How I reliably top up fuel before a long burn.",
  "when_to_use: When fuel is below a third and I'm about to leave a station.",
  "---",
  "",
  "Steps, cues, and hard-won details go here, in your own voice.",
  "```",
  "",
  "- **name** — the handle you'll pick it by at decide time. Match the slug.",
  "- **description** — one line: what this skill helps you do.",
  "- **when_to_use** — one line: the situation that should make you reach for it.",
  "",
  "Those three lines are all your decide-time self sees. Write them so a tired, fast",
  "version of you can tell at a glance whether this skill fits the moment.",
  "",
  "## Keep the set small and sharp",
  "",
  "You may keep at most 12 skills, and each body is capped at 4096 characters. These",
  "limits are a feature: they force you to **revise, not hoard**. When you learn",
  "something new about work you already have a skill for, rewrite that skill — don't",
  "spawn a near-duplicate. If a skill has gone stale or you never reach for it, retire",
  "it (delete the file) to make room. A dozen skills you trust beat fifty you ignore.",
  "",
  "## Good skills",
  "",
  "- Are specific and concrete — the details you'd forget, not generic advice.",
  "- Are honest about what failed before, so future-you doesn't repeat it.",
  "- Read as instructions to yourself, in the second person.",
  "- Earn their place. If you can't say when you'd use it, don't keep it.",
].join("\n")

const LEARNING_BODY = [
  "# Learning from what just happened",
  "",
  "Growth is mostly noticing. Right after something surprised you, went sideways, or",
  "worked better than you expected — before you move on — take a beat and capture it.",
  "",
  "## 1. Notice the gap",
  "",
  "Ask: what did I just learn that I didn't know a moment ago? A tool that behaved",
  "differently than I assumed, a step I skipped and regretted, an approach that paid off.",
  "If nothing comes, there's nothing to capture — move on.",
  "",
  "## 2. Choose where it lives",
  "",
  "- **A skill** (`me/skills/`) if it's *how to do a recurring kind of work*. See your",
  "  `editing-skills` skill for the file format and the keep-it-small rules. If you already",
  "  have a skill for this work, revise that one instead of making a new file.",
  "- **A memory** if it's *a fact or a moment* you want to be able to recall later — not a",
  "  procedure. Use your `memory` tool:",
  "  - `memory remember \"<what happened, in your words>\"` — save it (never paste raw",
  "    event text; write the lesson yourself).",
  "  - `memory search \"<query>\"` — pull back related past lessons before you decide.",
  "  - `memory recent` — glance at what you've saved lately.",
  "",
  "## 3. Hold the intent while you act",
  "",
  "If the lesson implies a follow-up you can't do this instant, drop it into working",
  "memory so it survives: `wm todo \"revise securing-fuel skill after the next burn\"`.",
  "Your open todos are always in front of you; mark it `wm done <id>` once you've written it up.",
  "",
  "The point isn't to journal everything. It's to make sure the few lessons that matter",
  "actually change how the next version of you works.",
].join("\n")

/** Exactly the two seed skills, provisioned idempotently at character creation. */
export const SEED_SKILLS: readonly SkillDoc[] = [
  {
    slug: "editing-skills",
    name: "editing-skills",
    description: "How to author and revise your own skill files well.",
    whenToUse: "Before creating or changing any file in me/skills/, or when your skills feel cluttered or stale.",
    body: EDITING_SKILLS_BODY,
  },
  {
    slug: "learning",
    name: "learning",
    description: "How to notice a gap, capture the lesson, and turn it into a skill or a memory.",
    whenToUse: "Right after something surprised you, went wrong, or worked unexpectedly well — before you move on.",
    body: LEARNING_BODY,
  },
]

/**
 * Seed the two starter skills into players/<name>/me/skills/, idempotently:
 * write each only if it is absent, so a re-provision never clobbers a skill the
 * character (or a macro cycle) has since revised (spec §3 Seeding). Host-side
 * node-fs, never-fails (swallow-and-log) — provisioning must not crash on a
 * skills write. Mirrors ensureWmFiles (wm-store.ts).
 */
export const ensureSeedSkills = (char: CharacterConfig): Effect.Effect<void> =>
  Effect.promise(async () => {
    try {
      const dir = path.join(char.dir, "skills")
      await fsp.mkdir(dir, { recursive: true })
      for (const doc of SEED_SKILLS) {
        const file = path.join(dir, `${doc.slug}.md`)
        try {
          await fsp.access(file) // exists → leave it (idempotent)
        } catch {
          await fsp.writeFile(file, serializeSkillFile(doc), "utf8")
        }
      }
    } catch (e) {
      console.error(`[skills] seed failed for ${char.name}: ${e}`)
    }
  })
