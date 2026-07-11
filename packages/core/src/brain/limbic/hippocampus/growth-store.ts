/**
 * Host-side growth-proposal store (agent-cognition Stage 4 — meso retrospect, spec §4).
 *
 * players/<name>/me/growth/proposals.jsonl — append-only JSONL on the shared
 * mount. The per-cycle meso retrospect APPENDS skill create/revise/retire
 * proposals here; proposals accumulate across cycles until the macro cycle
 * (Stage 5) adjudicates and clears them. Meso PROPOSES ONLY — it never edits a
 * skill file or an identity file.
 *
 * Discipline (same as wm-store.ts / episodes.ts): a proposals write must never
 * disturb reflection. Every reader/writer here is Effect<..., never, never> —
 * failures are swallowed after a console.error and degrade to an empty result.
 * Append is persisted as an ATOMIC whole-file rewrite (write-tmp + rename), so
 * dedup and the total cap are enforced without a reader ever seeing a torn file.
 *
 * Read surface for Stage 5 (macro): `readProposals(char)` returns every pending
 * proposal (the SkillProposal[] the adjudicator weighs); `proposalsJsonlPath`
 * locates the file the macro rewrites after adjudication.
 */
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import { slugify } from "../../../services/skills-core.js"
import type { Judgment } from "../../../skills/types.js"
import type {
  ToolEpisode,
  TransitionEpisode,
  StepBoundaryEpisode,
  TierTransitionEpisode,
  WmTransitionEpisode,
} from "../../../logging/episodes.js"

/** A skill change the meso stage proposes for the macro cycle to adjudicate. */
export type ProposalAction = "create" | "revise" | "retire"

/**
 * One accumulated proposal. `evidence` is MANDATORY (spec §4): a proposal that
 * cites no concrete episode data is rejected at parse. `status` is reserved for
 * Stage 5, which flips it to accepted/rejected during adjudication.
 */
export interface SkillProposal {
  /** Stable dedup id: action + skill-slug + normalized summary (see proposalKey). */
  id: string
  /** ISO timestamp the retrospect wrote this proposal. */
  ts: string
  action: ProposalAction
  /** Target skill NAME (create: proposed new name; revise/retire: an existing name). */
  skill: string
  /** One line: what to change and why. */
  summary: string
  /** create/revise: the proposed new body. Omitted for retire. */
  body?: string
  /** REQUIRED concrete episode evidence — step ids, per-skill verdict/tool stats. */
  evidence: string
  /** Reserved for Stage 5: "pending" until the macro cycle adjudicates. */
  status: "pending"
}

/** At most this many proposals from a single retrospect cycle. */
export const MAX_PROPOSALS_PER_CYCLE = 5
/** Hard cap on the accumulated pending file between macro runs (keep newest). */
export const MAX_PENDING_PROPOSALS = 100

// ── Episode aggregation (code-side; the "aggregates computed at read time") ──
export interface SkillAggregate {
  /** Worn skill name, or "(none)" for steps run with no skill. */
  skill: string
  steps: number
  verdicts: Record<Judgment, number>
  toolCalls: number
  toolFailures: number
}

export interface EpisodeAggregate {
  totalSteps: number
  totalToolCalls: number
  totalToolFailures: number
  perSkill: SkillAggregate[]
}

const NONE = "(none)"

function isStepBoundary(rec: TransitionEpisode): rec is StepBoundaryEpisode {
  return rec.type === "step-start" || rec.type === "step-end"
}

function emptyVerdicts(): Record<Judgment, number> {
  return { succeeded: 0, partially_succeeded: 0, failed: 0 }
}

/**
 * Compact per-skill counts from the just-ended cycle's two streams. Step-end
 * records supply steps + verdicts; tool records are joined to the skill worn on
 * their stepId (from the step-start/step-end skill stamp — spec §3). This is the
 * only signal the retrospect turn needs; the raw prompt/output blobs on
 * transition records are deliberately NOT read here (prompt-budget).
 */
export function aggregateEpisodes(
  tool: readonly ToolEpisode[],
  transition: readonly TransitionEpisode[],
): EpisodeAggregate {
  const stepSkill = new Map<string, string>()
  const per = new Map<string, SkillAggregate>()
  const bucket = (skill: string | null): SkillAggregate => {
    const key = skill ?? NONE
    let b = per.get(key)
    if (!b) {
      b = { skill: key, steps: 0, verdicts: emptyVerdicts(), toolCalls: 0, toolFailures: 0 }
      per.set(key, b)
    }
    return b
  }

  for (const rec of transition) {
    if (!isStepBoundary(rec)) continue
    stepSkill.set(rec.stepId, rec.skill ?? NONE)
    if (rec.type === "step-end") {
      const b = bucket(rec.skill)
      b.steps++
      if (rec.verdict) b.verdicts[rec.verdict]++
    }
  }

  let totalToolCalls = 0
  let totalToolFailures = 0
  for (const t of tool) {
    totalToolCalls++
    const failed = t.status === "error"
    if (failed) totalToolFailures++
    const skill = t.stepId != null ? stepSkill.get(t.stepId) ?? NONE : NONE
    const b = bucket(skill)
    b.toolCalls++
    if (failed) b.toolFailures++
  }

  const perSkill = [...per.values()].sort((a, b) => b.steps - a.steps || a.skill.localeCompare(b.skill))
  const totalSteps = perSkill.reduce((n, s) => n + s.steps, 0)
  return { totalSteps, totalToolCalls, totalToolFailures, perSkill }
}

/** Compact human-readable digest of the aggregates for the retrospect prompt. */
export function renderAggregate(agg: EpisodeAggregate): string {
  const head = `Cycle totals: ${agg.totalSteps} steps, ${agg.totalToolCalls} tool calls, ${agg.totalToolFailures} failed.`
  if (agg.perSkill.length === 0) return `${head}\n(no per-skill activity recorded)`
  const rows = agg.perSkill.map(
    (s) =>
      `- ${s.skill}: ${s.steps} steps (succeeded ${s.verdicts.succeeded}, partial ${s.verdicts.partially_succeeded}, failed ${s.verdicts.failed}); ${s.toolCalls} tool calls, ${s.toolFailures} failed`,
  )
  return [head, ...rows].join("\n")
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

/**
 * A bounded raw sample: only the last `cap` step-END records, one truncated line
 * each (task/skill/verdict/transition). Never emits the full rendered prompts or
 * outputs the transition stream also carries — that is what keeps the prompt
 * within a brain turn's budget.
 */
export function renderRawSample(transition: readonly TransitionEpisode[], cap: number): string {
  const ends = transition.filter((r): r is StepBoundaryEpisode => r.type === "step-end")
  const tail = ends.slice(-cap)
  if (tail.length === 0) return "(no completed steps this cycle)"
  return tail
    .map(
      (s) =>
        `- [${s.stepId}] skill=${s.skill ?? NONE} verdict=${s.verdict ?? "?"} transition=${s.transition ?? "?"} :: ${truncate(s.task, 120)}`,
    )
    .join("\n")
}

// ── Full-fidelity transition digest (tier + wm) ──────────────────────────────
/**
 * The full-fidelity transition stream (tier calls + wm mutations) was write-only:
 * aggregateEpisodes/renderRawSample read ONLY step-boundary + tool records, so a
 * cycle whose signal lived entirely in the orient/decide/evaluate outputs (e.g. a
 * long step that surfaced a bug) reached the retrospect turn as nothing, and it
 * proposed nothing. This projection wires a BOUNDED read of the tier + wm records
 * into the prompt. Bounding is the whole point (the consumer is a local model and
 * a single rendered prompt can be tens of KB):
 *   - COUNT-capped per type (newest kept).
 *   - CHAR-capped per excerpt, and only the PARSED OUTPUT is excerpted — the full
 *     rendered `prompt` blob is NEVER emitted (same discipline as renderRawSample).
 *   - Newest-first, so the most recent activity leads.
 */
export const TIER_DIGEST_MAX_RECORDS = 12
export const WM_DIGEST_MAX_RECORDS = 8
/** Per-record excerpt cap for a tier output / wm delta summary. */
export const TRANSITION_EXCERPT_MAX = 240

function isTierRec(r: TransitionEpisode): r is TierTransitionEpisode {
  return r.type === "tier"
}
function isWmRec(r: TransitionEpisode): r is WmTransitionEpisode {
  return r.type === "wm"
}

/** One-line, whitespace-collapsed, char-capped summary of a parsed output. Never the prompt. */
function summarizeTransitionValue(value: unknown): string {
  let s: string
  try {
    s = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  } catch {
    s = "[unserializable]"
  }
  return truncate(s.replace(/\s+/g, " ").trim(), TRANSITION_EXCERPT_MAX)
}

/**
 * A bounded digest of the cycle's tier transitions and wm activity for the
 * retrospect prompt. Reads type:"tier" (orient/decide/evaluate/diary parsed
 * outputs, with the orient discriminator) and type:"wm" records the aggregate/
 * raw-sample projections skip. Count- and char-capped, newest-first.
 */
export function renderTransitionDigest(transition: readonly TransitionEpisode[]): string {
  const tiers = transition.filter(isTierRec).slice(-TIER_DIGEST_MAX_RECORDS).reverse()
  const wms = transition.filter(isWmRec).slice(-WM_DIGEST_MAX_RECORDS).reverse()

  const lines: string[] = ["Tier transitions (newest first; parsed output only — prompts omitted):"]
  if (tiers.length === 0) {
    lines.push("(no tier transitions recorded this cycle)")
  } else {
    for (const t of tiers) {
      const kind = t.phase === "orient" && t.orientKind ? `/${t.orientKind}` : ""
      lines.push(
        `- [${t.stepId ?? "—"}] ${t.phase}${kind} tick=${t.tick ?? "?"} :: ${summarizeTransitionValue(t.output)}`,
      )
    }
  }

  lines.push("", "Working-memory activity (newest first):")
  if (wms.length === 0) {
    lines.push("(no working-memory mutations recorded this cycle)")
  } else {
    for (const w of wms) {
      const n = Array.isArray(w.deltas) ? w.deltas.length : 0
      lines.push(
        `- [${w.stepId ?? "—"}] tick=${w.tick ?? "?"} ${n} delta(s) :: ${summarizeTransitionValue(w.deltas)}`,
      )
    }
  }
  return lines.join("\n")
}

// ── Proposal parsing (tolerant; evidence-required; capped) ───────────────────
/** Stable dedup identity: action + slugified skill + normalized summary. */
export function proposalKey(action: ProposalAction, skill: string, summary: string): string {
  return `${action}:${slugify(skill)}:${summary.trim().toLowerCase().replace(/\s+/g, " ")}`
}

function isAction(x: unknown): x is ProposalAction {
  return x === "create" || x === "revise" || x === "retire"
}

/**
 * Find every balanced top-level bracketed value in `text`, string-aware (ignores
 * brackets/quotes inside double-quoted strings, including escaped quotes).
 * Returns an array of every balanced candidate, in positional order — candidates
 * are NOT reordered here; the caller tries objects before arrays itself (see
 * extractProposalsArray). Replicated self-contained from brain/stem/parse.ts (see
 * module header) to avoid a conscious/ -> cortex/ edge.
 *
 * Stage-4 review hardening (probe-5/6): the old single-candidate scan anchored on
 * the FIRST opening bracket, so prose like "options [a, b] ... {real json}" or a
 * "{prose}" block ahead of the real object mis-anchored and failed the parse.
 * Returning ALL candidates lets extractProposalsArray try each in turn (objects
 * preferred) instead of giving up on the first wrong anchor.
 */
function balancedCandidates(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== "{" && ch !== "[") {
      i++
      continue
    }
    const open = ch
    const close = open === "{" ? "}" : "]"
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (inString) {
        if (escaped) escaped = false
        else if (c === "\\") escaped = true
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') inString = true
      else if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end === -1) break // unbalanced from here on
    out.push(text.slice(i, end + 1))
    i = end + 1
  }
  return out
}

/**
 * Pull the proposals array out of a brain turn's text. Never throws.
 *
 * Order of attempts (string-aware, so a ```-containing skill `body`/`evidence`
 * value can never truncate the parse):
 *  1. Whole-text `JSON.parse` (the model returned exactly the JSON, no fence).
 *  2. Try every balanced candidate — objects first (prefer {"proposals":...}
 *     over a stray earlier bare array), then arrays; skip any that don't parse
 *     or don't yield a proposals shape (probe-5/6: wrong-anchor recovery).
 *  3. The legacy fence-regex extraction, kept only as a last-ditch fallback.
 *
 * Accepts either a top-level `{"proposals":[...]}` object (what the prompt
 * asks for) or a bare `[...]`.
 */
function extractProposalsArray(text: string): unknown[] {
  const fromParsed = (parsed: unknown): unknown[] | null => {
    if (Array.isArray(parsed)) return parsed
    if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { proposals?: unknown }).proposals)) {
      return (parsed as { proposals: unknown[] }).proposals
    }
    return null
  }

  const trimmed = text.trim()
  if (trimmed) {
    // 1. Whole-text parse (the model returned exactly the JSON).
    try {
      const direct = fromParsed(JSON.parse(trimmed))
      if (direct) return direct
    } catch {
      // fall through
    }
    // 2. Try every balanced candidate — objects first (prefer {"proposals":...}
    //    over a stray earlier bare array), then arrays; skip any that don't parse
    //    or don't yield a proposals shape (probe-5/6: wrong-anchor recovery).
    const candidates = balancedCandidates(trimmed)
    const ordered = [
      ...candidates.filter((c) => c.startsWith("{")),
      ...candidates.filter((c) => c.startsWith("[")),
    ]
    for (const cand of ordered) {
      try {
        const got = fromParsed(JSON.parse(cand))
        if (got) return got
      } catch {
        // try the next candidate
      }
    }
  }

  // 3. Legacy fence fallback.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : "").trim()
  if (body) {
    try {
      const fromFence = fromParsed(JSON.parse(body))
      if (fromFence) return fromFence
    } catch {
      // fall through
    }
  }
  return []
}

/**
 * Parse + validate the turn's proposals. Drops any candidate missing a valid
 * `action`, a non-empty `skill`/`summary`, or (spec §4) a non-empty `evidence`.
 * Assigns the stable id/ts/status and caps to MAX_PROPOSALS_PER_CYCLE.
 */
export function parseProposals(text: string, now: string): SkillProposal[] {
  const out: SkillProposal[] = []
  for (const el of extractProposalsArray(text)) {
    if (el === null || typeof el !== "object" || Array.isArray(el)) continue
    const e = el as Record<string, unknown>
    if (!isAction(e.action)) continue
    const skill = typeof e.skill === "string" ? e.skill.trim() : ""
    if (!skill) continue
    const summary = typeof e.summary === "string" ? e.summary.trim() : ""
    if (!summary) continue
    const evidence = typeof e.evidence === "string" ? e.evidence.trim() : ""
    if (!evidence) continue // evidence REQUIRED — rejected at parse (spec §4)
    const body = typeof e.body === "string" ? e.body : undefined
    out.push({
      id: proposalKey(e.action, skill, summary),
      ts: now,
      action: e.action,
      skill,
      summary,
      ...(body !== undefined ? { body } : {}),
      evidence,
      status: "pending",
    })
    if (out.length >= MAX_PROPOSALS_PER_CYCLE) break
  }
  return out
}

// ── Store IO (never fails) ───────────────────────────────────────────────────
export const PROPOSALS_JSONL_FILE = "proposals.jsonl"
export function growthDir(char: CharacterConfig): string {
  return path.join(char.dir, "growth")
}
export function proposalsJsonlPath(char: CharacterConfig): string {
  return path.join(growthDir(char), PROPOSALS_JSONL_FILE)
}

/** Tolerant validator for a stored line (the file may be hand-edited). */
function isStoredProposal(rec: unknown): rec is SkillProposal {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return false
  const r = rec as Record<string, unknown>
  return (
    typeof r.id === "string" &&
    isAction(r.action) &&
    typeof r.skill === "string" &&
    typeof r.summary === "string" &&
    typeof r.evidence === "string" &&
    r.evidence.trim().length > 0 &&
    r.status === "pending"
  )
}

const loadProposals = async (char: CharacterConfig): Promise<SkillProposal[]> => {
  try {
    const text = await fsp.readFile(proposalsJsonlPath(char), "utf8")
    const out: SkillProposal[] = []
    for (const line of text.split("\n")) {
      const t = line.trim()
      if (!t) continue
      try {
        const rec = JSON.parse(t)
        if (isStoredProposal(rec)) out.push(rec)
      } catch {
        // drop a torn/garbled line, keep the rest
      }
    }
    return out
  } catch {
    return []
  }
}

/** Read all pending proposals (Stage 5 macro read surface). Never fails. */
export const readProposals = (char: CharacterConfig): Effect.Effect<SkillProposal[]> =>
  Effect.promise(() => loadProposals(char))

/**
 * Append proposals: drop ids already pending (exact-duplicate dedup), enforce
 * the total cap by keeping the newest MAX_PENDING_PROPOSALS, and persist the
 * whole set atomically (write-tmp + rename). Returns the number actually
 * appended. Never fails — a write error logs and returns 0.
 */
export const appendProposals = (
  char: CharacterConfig,
  proposals: readonly SkillProposal[],
): Effect.Effect<number> =>
  Effect.promise(async () => {
    try {
      if (proposals.length === 0) return 0
      const existing = await loadProposals(char)
      const seen = new Set(existing.map((p) => p.id))
      const fresh: SkillProposal[] = []
      for (const p of proposals) {
        if (seen.has(p.id)) continue
        seen.add(p.id) // dedup WITHIN this batch too, not just against disk
        fresh.push(p)
      }
      if (fresh.length === 0) return 0
      let all = existing.concat(fresh)
      if (all.length > MAX_PENDING_PROPOSALS) all = all.slice(all.length - MAX_PENDING_PROPOSALS)
      await fsp.mkdir(growthDir(char), { recursive: true })
      const file = proposalsJsonlPath(char)
      const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`
      await fsp.writeFile(tmp, `${all.map((p) => JSON.stringify(p)).join("\n")}\n`, "utf8")
      await fsp.rename(tmp, file)
      return fresh.length
    } catch (e) {
      console.error(`[growth] append failed for ${char.name}: ${e}`)
      return 0
    }
  })

// ── Macro cadence counter (host-side, persisted, never-fail) ─────────────────
/** Default reflection-cycle stride between macro "growth stimulation" runs. */
export const MACRO_EVERY_N = 4
/** Effective stride, overridable via `ROCI_MACRO_EVERY_N`; invalid/<1 → default. */
export function macroEveryN(): number {
  const raw = process.env.ROCI_MACRO_EVERY_N
  if (raw === undefined) return MACRO_EVERY_N
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : MACRO_EVERY_N
}

export const MACRO_STATE_FILE = "macro-state.json"
export function macroStatePath(char: CharacterConfig): string {
  return path.join(growthDir(char), MACRO_STATE_FILE)
}

const loadMacroCount = async (char: CharacterConfig): Promise<number> => {
  try {
    const text = await fsp.readFile(macroStatePath(char), "utf8")
    const rec = JSON.parse(text) as { count?: unknown }
    return typeof rec.count === "number" && Number.isFinite(rec.count) ? rec.count : 0
  } catch {
    return 0
  }
}

/** Read the persisted macro counter (missing/garbled → 0). Never fails. */
export const readMacroCount = (char: CharacterConfig): Effect.Effect<number> =>
  Effect.promise(() => loadMacroCount(char))

/** Outcome of a macro-counter bump: the count to gate on, and whether the
 * increment actually PERSISTED. `advanced:false` means the write failed and the
 * returned count is the STALE pre-bump value — the caller must fail closed
 * (skip macro) rather than gate on it, because a counter frozen on a multiple of
 * N would otherwise re-fire the macro turn every single cycle. */
export interface MacroBump {
  count: number
  advanced: boolean
}

/**
 * Atomically increment the persisted macro counter, returning `{count, advanced}`.
 * Never fails. On a successful persist: `{count: next, advanced: true}`. On a
 * write error: `{count: current (stale), advanced: false}` — the same cadence
 * retries next cycle rather than the pipeline crashing, and the caller fails
 * closed on `advanced === false` so a frozen-at-a-multiple counter can't re-fire
 * macro every cycle. Same write-tmp+rename atomicity as appendProposals.
 */
export const bumpMacroCount = (char: CharacterConfig): Effect.Effect<MacroBump> =>
  Effect.promise(async () => {
    const current = await loadMacroCount(char)
    const next = current + 1
    try {
      await fsp.mkdir(growthDir(char), { recursive: true })
      const file = macroStatePath(char)
      const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`
      await fsp.writeFile(tmp, `${JSON.stringify({ count: next })}\n`, "utf8")
      await fsp.rename(tmp, file)
      return { count: next, advanced: true }
    } catch (e) {
      console.error(
        `[growth] macro-count bump failed for ${char.name}: ${e}; ` +
          `macro counter unavailable — macro will not fire this cycle (failing closed)`,
      )
      return { count: current, advanced: false }
    }
  })

// ── Adjudications audit (append-only) + pending-queue drain ──────────────────
/** One recorded macro outcome for one proposal (spec §4: outcomes must be recorded). */
export interface Adjudication {
  id: string
  ts: string
  /** The macro cycle count this adjudication ran on. */
  cycle: number
  action: ProposalAction
  skill: string
  decision: "accepted" | "rejected"
  /** Why — always present (a rejected proposal's reason is required by spec §4). */
  reason: string
}

export const ADJUDICATIONS_JSONL_FILE = "adjudications.jsonl"
export function adjudicationsJsonlPath(char: CharacterConfig): string {
  return path.join(growthDir(char), ADJUDICATIONS_JSONL_FILE)
}

/** Append adjudication outcomes to the permanent audit. Never fails. */
export const appendAdjudications = (
  char: CharacterConfig,
  rows: readonly Adjudication[],
): Effect.Effect<number> =>
  Effect.promise(async () => {
    try {
      if (rows.length === 0) return 0
      await fsp.mkdir(growthDir(char), { recursive: true })
      const text = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`
      await fsp.appendFile(adjudicationsJsonlPath(char), text, "utf8")
      return rows.length
    } catch (e) {
      console.error(`[growth] adjudications append failed for ${char.name}: ${e}`)
      return 0
    }
  })

/**
 * Drain the named ids from the pending proposals queue (macro "clears" the
 * proposals it adjudicated). Atomic whole-file rewrite; returns how many were
 * removed. Never fails. An empty result rewrites an empty file.
 */
export const removeProposals = (
  char: CharacterConfig,
  ids: readonly string[],
): Effect.Effect<number> =>
  Effect.promise(async () => {
    try {
      if (ids.length === 0) return 0
      const drop = new Set(ids)
      const existing = await loadProposals(char)
      const kept = existing.filter((p) => !drop.has(p.id))
      const removed = existing.length - kept.length
      if (removed === 0) return 0
      await fsp.mkdir(growthDir(char), { recursive: true })
      const file = proposalsJsonlPath(char)
      const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`
      const body = kept.length === 0 ? "" : `${kept.map((p) => JSON.stringify(p)).join("\n")}\n`
      await fsp.writeFile(tmp, body, "utf8")
      await fsp.rename(tmp, file)
      return removed
    } catch (e) {
      console.error(`[growth] removeProposals failed for ${char.name}: ${e}`)
      return 0
    }
  })

// ── Adjudication document (the macro worker's structured output) ─────────────
/** One accept/reject ruling. For an accepted create/revise, `skill` carries the final contents. */
export interface AdjudicationDecision {
  id: string
  decision: "accept" | "reject"
  reason: string
  skill?: { name: string; description: string; whenToUse: string; body: string }
}

export interface AdjudicationDoc {
  decisions: AdjudicationDecision[]
  /** The freshly rewritten bounded memory index, or null if the worker offered none. */
  synthesis: string | null
  /** The first-person in-fiction growth note for DIARY.md, or null. */
  diaryNote: string | null
}

const asString = (x: unknown): string => (typeof x === "string" ? x : "")
const asTrimmedOrNull = (x: unknown): string | null => {
  const s = typeof x === "string" ? x.trim() : ""
  return s ? s : null
}

/**
 * Parse the macro worker's single JSON document. Tolerant like parseProposals:
 * reuses balancedCandidates (objects preferred) so a fenced/prose-framed reply
 * still yields the object; never throws. Accepts both `when_to_use` and
 * `whenToUse` on a skill object, and both `diaryNote` and `diary_note`.
 */
export function parseAdjudicationDoc(text: string): AdjudicationDoc {
  const empty: AdjudicationDoc = { decisions: [], synthesis: null, diaryNote: null }
  const trimmed = text.trim()
  if (!trimmed) return empty

  let root: Record<string, unknown> | null = null
  const tryObj = (s: string): boolean => {
    try {
      const p = JSON.parse(s)
      if (p !== null && typeof p === "object" && !Array.isArray(p)) {
        root = p as Record<string, unknown>
        return true
      }
    } catch {
      // ignore
    }
    return false
  }
  if (!tryObj(trimmed)) {
    for (const cand of balancedCandidates(trimmed).filter((c) => c.startsWith("{"))) {
      if (tryObj(cand)) break
    }
  }
  if (root === null) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenced) tryObj(fenced[1].trim())
  }
  if (root === null) return empty

  const rootData = root as Record<string, unknown>
  const rawDecisions = Array.isArray(rootData.adjudications) ? rootData.adjudications : []
  const decisions: AdjudicationDecision[] = []
  for (const el of rawDecisions) {
    if (el === null || typeof el !== "object" || Array.isArray(el)) continue
    const e = el as Record<string, unknown>
    const id = asString(e.id).trim()
    if (!id) continue
    const decision = e.decision === "accept" ? "accept" : e.decision === "reject" ? "reject" : null
    if (decision === null) continue
    const reason = asString(e.reason).trim()
    let skill: AdjudicationDecision["skill"] | undefined
    if (e.skill !== null && typeof e.skill === "object" && !Array.isArray(e.skill)) {
      const s = e.skill as Record<string, unknown>
      skill = {
        name: asString(s.name).trim(),
        description: asString(s.description).trim(),
        whenToUse: asString(s.whenToUse ?? s.when_to_use).trim(),
        body: asString(s.body),
      }
    }
    decisions.push({ id, decision, reason, skill })
  }

  return {
    decisions,
    synthesis: asTrimmedOrNull(rootData.synthesis),
    diaryNote: asTrimmedOrNull(rootData.diaryNote ?? rootData.diary_note),
  }
}
