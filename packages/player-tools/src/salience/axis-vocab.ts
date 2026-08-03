/**
 * The salience AXIS VOCABULARY — the single derivation of a character's flat
 * axis namespace (design 2026-07-31 §1), shared by the HOST and the IN-CONTAINER
 * `memory` CLI.
 *
 * It lives in `@roci/player-tools` rather than `@roci/core` for one reason: the
 * A stage of the scoring pipeline (§3) runs inside the container, at insert,
 * because that is the only place the memory's embedding exists — and it must
 * derive the SAME axis list the host derives. A second implementation would
 * drift on exactly the edge cases this module handles (the wrong-arrow row, the
 * HTML comment block, the empty pole, the illegal key), and a character whose
 * host says nine axes while their CLI says seven is scored against a vocabulary
 * nobody can see. One function, two callers.
 *
 * This module is a LEAF: it imports NOTHING (`memory-embed.ts` documents the
 * circularity trap). `core/palette.ts`, `core/salience.ts` and
 * `hypothalamus/drives.ts` re-export from here, so every Phase 1 import site in
 * core keeps working untouched.
 */

/**
 * The emotional palette — a character's nonverbal "voice." Each line is one
 * emotional axis expressed as a 5-emoji gradient from one pole through the
 * middle to the other; the hindbrain paints its gut reaction by picking a
 * position along the gradient (repeat an emoji for intensity) rather than with
 * words. Characters get a personalized palette generated at creation time
 * (identity-gen); this seed is the graceful-degradation default and the eval
 * reference.
 *
 * It lives here, not in core, so the CLI falls back to the SAME palette the host
 * falls back to (`CharacterFs.readPalette`) when `me/PALETTE.md` is absent.
 */
export const TEMPLATE_PALETTE = `🌊 💧 😶 🌤️ ☁️   # sinking → soaring
😱 😟 😐 🙂 😌   # panic → calm
🔥 😤 😐 🧘 🥶   # fury → numb
🏙️ 🚶 😐 🛖 🌲   # stir → stillness
👶 🤩 😐 😪 🧓   # wonder → weariness`

/**
 * The empirically-tuned drive block from the validated v3.2 spike prompt (§4.2a):
 * each line carries the explicit non-physical-threat coverage + the anti-collapse
 * routing cue (money/fuel/quota = sustenance, NOT safety) that lifted the 2B's
 * drive-tagging to a stable ~85%. Keep it verbatim.
 *
 * Same reason as TEMPLATE_PALETTE for living here: host and CLI must fall back
 * to the same drive vocabulary when `me/DRIVES.md` is absent.
 */
export const TEMPLATE_DRIVES = `- safety — your physical integrity, OR someone targeting you personally: being attacked, damaged, threatened, or harassed. (combat, hull/health loss, a hostile actor, abuse aimed at you)
- sustenance — the resources you need to keep operating: running low/out of fuel, energy, money/credits, quota, or API rate budget. (low fuel, rate-limit hit, empty wallet)
- agency — your freedom and ability to act: being blocked, locked out, frozen, disabled, stalled, or facing shutdown. (engines disabled, access revoked, a dependency stalling you, termination)`

/**
 * One derived salience axis (design 2026-07-31 §1). A palette row has NO name —
 * it is identified by its pole pair — so the axis name is the two poles joined
 * with a hyphen, lowercased. The ORDER carries the sign convention: the first
 * pole is negative, the second positive, matching the 5-emoji gradient read
 * left-to-right. `burdened-exhilarated: -0.7` is therefore unambiguously "hard
 * toward burdened" with no side table to consult.
 */
export interface PaletteAxis {
  /** The left-hand pole — the NEGATIVE end of the axis. */
  readonly negative: string
  /** The right-hand pole — the POSITIVE end of the axis. */
  readonly positive: string
  /** `${negative}-${positive}` — a legal `SALIENCE.md` key. */
  readonly name: string
}

/**
 * A palette row that LOOKS like an axis line — gradient content, then a `#`
 * gloss — but yields no usable axis name: a missing or wrong-character arrow
 * (`->`, `—`, the word "to"), an empty pole, poles that normalize away to
 * nothing, more than two poles, or a joined name that is not a legal
 * `SALIENCE.md` key.
 *
 * This fails loudly rather than dropping the line, and that is a deliberate
 * DEPARTURE from `parseDriveNames`' drop-on-malformed behaviour. A dropped drive
 * was never load-bearing; a dropped palette line means the character quietly
 * carries fewer axes than their PALETTE.md shows and every memory is then scored
 * against a vocabulary that does not match the artifact — inert, clean, and
 * unnoticed, exactly the failure class of design §11's 565/565 NULL-dims
 * incident. Sibling of `AxisCollisionError` below.
 */
export class MalformedAxisError extends Error {
  readonly _tag = "MalformedAxisError"
  constructor(readonly line: string) {
    super(
      `Malformed palette axis line: "${line}". A palette row must be ` +
        `<emoji…> # poleA → poleB, with exactly two non-empty poles whose ` +
        `hyphen-joined lowercase name starts with a letter. This is a generation ` +
        `defect — fix PALETTE.md and regenerate.`,
    )
    this.name = "MalformedAxisError"
  }
}

/**
 * Two axes shared a name. The namespace is FLAT, so this cannot be papered over
 * by renaming or last-write-wins (design 2026-07-31 §1). With pole-pair naming a
 * collision requires a hyphen-joined pair to exactly equal a drive name or
 * another derived pair — vanishingly unlikely, and a generation defect when it
 * happens. Fail loudly.
 */
export class AxisCollisionError extends Error {
  readonly _tag = "AxisCollisionError"
  constructor(readonly axis: string) {
    super(
      `Duplicate salience axis "${axis}". The axis namespace is flat (core drives + ` +
        `domain drives + PALETTE.md pole pairs), so two axes cannot share a name. ` +
        `This is a generation defect — fix DRIVES.md or PALETTE.md and regenerate.`,
    )
    this.name = "AxisCollisionError"
  }
}

/**
 * Strip `<!-- … -->` spans from one line, given whether the previous line left a
 * comment open; returns the remaining text and the state for the next line.
 *
 * The comment block is handled EXPLICITLY rather than being skipped by accident
 * of containing no `#`: `paletteFile`'s header comment is prose a human will
 * edit, and the day someone writes a `#` inside it must not be the day
 * derivation starts throwing.
 */
function stripHtmlComments(line: string, inComment: boolean): { text: string; inComment: boolean } {
  let out = ""
  let i = 0
  let open = inComment
  while (i < line.length) {
    if (open) {
      const close = line.indexOf("-->", i)
      if (close === -1) break
      i = close + 3
      open = false
    } else {
      const start = line.indexOf("<!--", i)
      if (start === -1) {
        out += line.slice(i)
        break
      }
      out += line.slice(i, start)
      i = start + 4
      open = true
    }
  }
  return { text: out, inComment: open }
}

/**
 * Does this line even CLAIM to be an axis line? Deliberately NOT "it contains a
 * `→`": a model that writes `# grumbling -> tender`, `# grumbling — tender` or
 * `# grumbling to tender` has written a row that is unmistakably an axis row to
 * a human, and an arrow-gated classifier would derive NOTHING from it — no
 * error, no warning, a character quietly carrying fewer axes than their
 * PALETTE.md shows.
 *
 * The test is: there is content before the `#`, and that content contains NO
 * ASCII letters. That is what separates a GRADIENT (emoji, punctuation and
 * whitespace) from PROSE. Requiring merely "some content" would make any
 * hand-written sentence containing a mid-line `#` claim the axis shape, fail the
 * pole match, and hard-abort the scaffold on a file a human legitimately edited.
 * Prose is not a broken axis row; it is not an axis row at all.
 *
 * `text` must already be comment-stripped (`stripHtmlComments`).
 */
function claimsAxisShape(text: string): boolean {
  const hash = text.indexOf("#")
  if (hash <= 0) return false
  const before = text.slice(0, hash).trim()
  if (before === "") return false
  return !/[A-Za-z]/.test(before)
}

/** `<anything> # poleA → poleB` — the gloss half of a palette row. The pole
 *  groups are `*?`, not `+?`, so an EMPTY pole still matches here and is caught
 *  by the explicit check below rather than silently failing to match. */
const POLE_PAIR_RE = /#\s*([^#→]*?)\s*→\s*([^#→]*?)\s*$/

/**
 * Lowercase a pole and collapse everything that is not `[a-z0-9]` into single
 * hyphens, so a multi-word pole ("wide eyed") still yields a key `parseSalience`
 * can read (`/^-\s*([A-Za-z][\w-]*)\s*:/`).
 */
function normalizePole(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Derive this palette's salience axes, in file order.
 *
 * Two cases, two responses:
 *  - no axis shape at all (heading, HTML comment, blank line, prose) → skip
 *    silently; it is simply not an axis line.
 *  - axis shape but no usable name → throw `MalformedAxisError`; a broken axis
 *    is a generation defect, exactly like a duplicate axis name. This includes a
 *    row whose arrow is missing or is the wrong character.
 *
 * NOTE: this reads the palette; it never writes to it. `PALETTE.md`'s format is
 * unchanged by the axis design (spec §2).
 *
 * @throws {MalformedAxisError}
 */
export function parsePaletteAxes(md: string): PaletteAxis[] {
  const out: PaletteAxis[] = []
  let inComment = false
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd()
    const stripped = stripHtmlComments(line, inComment)
    inComment = stripped.inComment
    if (!claimsAxisShape(stripped.text)) continue
    const m = stripped.text.match(POLE_PAIR_RE)
    if (!m) throw new MalformedAxisError(line)
    const negative = normalizePole(m[1])
    const positive = normalizePole(m[2])
    const name = `${negative}-${positive}`
    if (!negative || !positive || !/^[A-Za-z][\w-]*$/.test(name)) {
      throw new MalformedAxisError(line)
    }
    out.push({ negative, positive, name })
  }
  return out
}

/** Just the derived axis names, in file order. @throws {MalformedAxisError} */
export function paletteAxisNames(md: string): string[] {
  return parsePaletteAxes(md).map((a) => a.name)
}

/** One `- <name> — <description>` row of a DRIVES.md body. */
export interface DriveLine {
  readonly name: string
  readonly description: string
}

/**
 * Extract name AND description from a drive block. `parseDriveNames` is defined
 * in terms of this, so the two can never disagree about what counts as a drive
 * row. Unlike the palette parser this DROPS malformed rows silently — that is
 * the long-standing behaviour of the drive vocabulary and Phase 1 deliberately
 * did not change it (a dropped drive was never load-bearing; the observe prompt
 * simply offers one fewer label).
 */
export function parseDriveLines(text: string): DriveLine[] {
  const out: DriveLine[] = []
  for (const line of text.split("\n")) {
    const m = line.match(/^-\s*([A-Za-z][\w-]*)\s*—\s*(.*)$/)
    if (m) out.push({ name: m[1].toLowerCase(), description: m[2].trim() })
  }
  return out
}

/** Extract the drive names from a drive block ("- <name> — …" lines). */
export function parseDriveNames(text: string): string[] {
  return parseDriveLines(text).map((d) => d.name)
}

/**
 * Build this character's full axis list: core drives + domain drives (from the
 * DRIVES.md body) then palette axes (from the PALETTE.md body), concatenated
 * into ONE FLAT NAMESPACE in that order (design 2026-07-31 §1).
 *
 * @throws {AxisCollisionError}
 * @throws {MalformedAxisError}
 */
export function buildAxisList(driveBody: string, paletteBody: string): string[] {
  return buildAxisSpecs(driveBody, paletteBody).map((s) => s.name)
}

/** Unipolar (drive) or bipolar (palette) — spec §6. */
export type AxisPolarity = "unipolar" | "bipolar"

/**
 * One axis, with everything a SCORER needs: its name, its polarity, and the
 * text(s) whose embeddings the mechanical A stage cosines against (spec §3).
 *
 * A bipolar palette axis carries TWO glosses, one per pole, because A's reading
 * of it is signed: `cos(memory, positiveGloss) − cos(memory, negativeGloss)`. A
 * unipolar drive axis carries one — `negativeGloss` is `""` and is never
 * embedded. Collapsing a palette axis to a single gloss would throw away exactly
 * the direction information §5's situational job needs.
 */
export interface AxisSpec {
  readonly name: string
  readonly polarity: AxisPolarity
  /** Embedded for the POSITIVE pole (bipolar) or for the whole axis (unipolar). */
  readonly positiveGloss: string
  /** Embedded for the NEGATIVE pole. Always `""` for a unipolar axis. */
  readonly negativeGloss: string
}

/**
 * The full axis list as SPECS — the same names, in the same order, that
 * `buildAxisList` returns, each carrying its polarity and gloss text. This is
 * the single derivation; `buildAxisList` is a projection of it.
 *
 * Drive glosses are `"<name>: <description>"` — the name alone is too short to
 * embed usefully, and the description is the reference frame the hindbrain
 * already appraises against. Palette glosses are the raw pole words with hyphens
 * read back as spaces ("wide-eyed" → "wide eyed"), because a hyphenated
 * compound embeds worse than the phrase it stands for.
 *
 * @throws {AxisCollisionError} on a duplicate name across the flat namespace.
 * @throws {MalformedAxisError} from `parsePaletteAxes`.
 */
export function buildAxisSpecs(driveBody: string, paletteBody: string): AxisSpec[] {
  const specs: AxisSpec[] = []
  const seen = new Set<string>()
  const push = (spec: AxisSpec): void => {
    if (seen.has(spec.name)) throw new AxisCollisionError(spec.name)
    seen.add(spec.name)
    specs.push(spec)
  }
  for (const d of parseDriveLines(driveBody)) {
    push({
      name: d.name,
      polarity: "unipolar",
      positiveGloss: d.description ? `${d.name}: ${d.description}` : d.name,
      negativeGloss: "",
    })
  }
  for (const a of parsePaletteAxes(paletteBody)) {
    push({
      name: a.name,
      polarity: "bipolar",
      positiveGloss: a.positive.replace(/-/g, " "),
      negativeGloss: a.negative.replace(/-/g, " "),
    })
  }
  return specs
}

/**
 * A stable identity for an axis list AND its gloss texts, used as the cache key
 * for the CLI's embedded gloss vectors. It must change when a gloss is REWORDED,
 * not only when an axis is added or removed — a reworded drive description means
 * a different embedding, and reusing the old vector would score every subsequent
 * memory against text nobody wrote.
 *
 * A plain JSON join rather than a hash: this is compared, never transmitted, and
 * a hash would need `node:crypto` in a module that is deliberately import-free.
 */
export function axisFingerprint(specs: ReadonlyArray<AxisSpec>): string {
  return JSON.stringify(
    specs.map((s) => [s.name, s.polarity, s.positiveGloss, s.negativeGloss]),
  )
}

/**
 * Validate a MODEL-AUTHORED salience vector against the closed axis vocabulary
 * (the C stage of spec §3). Structurally the sibling of `appraise`'s drive
 * validation: a model's output must pass through a mechanical clamp before it
 * can be stored.
 *
 *  - a key outside `specs` is DROPPED (the model invented an axis)
 *  - a value that is not a number or a numeric string is DROPPED, and so is one
 *    that coerces to a non-finite number (never store NaN — `salienceWeight`
 *    would propagate it into the whole composite score). The type gate is not
 *    redundant with `Number.isFinite`: `null`, `true`, `""` and `[]` all coerce
 *    to a FINITE number, so a finiteness check alone would store a 0 (or a 1)
 *    the model never wrote, and an axis silently pinned at 0 is indistinguishable
 *    from one the model deliberately scored 0.
 *  - a unipolar drive axis clamps to `[0, 1]`; a negative "how much did this
 *    bear on safety" is meaningless
 *  - a bipolar palette axis clamps to `[-1, +1]` and KEEPS ITS SIGN; the sign is
 *    the whole point of the palette tier (spec §6)
 *
 * Never throws. A malformed vector degrades to `{}`, which the CLI's ⊕ merge
 * then treats as "no C" — the memory still gets its mechanical A vector.
 */
export function sanitizeSalienceVector(
  raw: unknown,
  specs: ReadonlyArray<AxisSpec>,
): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const byName = new Map(specs.map((s) => [s.name, s]))
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const spec = byName.get(String(key).trim().toLowerCase())
    if (!spec) continue
    if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) continue
    const n = Number(value)
    if (!Number.isFinite(n)) continue
    out[spec.name] =
      spec.polarity === "bipolar" ? Math.min(1, Math.max(-1, n)) : Math.min(1, Math.max(0, n))
  }
  return out
}
