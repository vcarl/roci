import { Context, Effect, Layer, Clock } from "effect"
import { CharacterFs, type CharacterConfig } from "../../../../services/CharacterFs.js"
import { LongtermStore, type MemoryHit } from "./longterm-store.js"
import type { ObserveResult, OrientResult, DecideResult, EvaluateResult } from "../../../../skills/types.js"
import { rerank, RERANK_OVERFETCH } from "./memory-rank.js"
import { parseSalience, TEMPLATE_SALIENCE } from "../../../../core/salience.js"

/** One unit to persist: the source phase, the text, derived tags, and an optional salience signature. */
export interface MemoryWrite {
  readonly source: string
  readonly text: string
  readonly tags: ReadonlyArray<string>
  /**
   * The PRODUCER (C) vector — the authoring tier's own reading of this memory
   * across the character's axis namespace (design 2026-07-31 §3). NOT the final
   * signature: the in-container CLI merges it with the mechanical (A) vector it
   * computes at insert, and the adjudicator later supersedes the mean. Absent /
   * empty is legitimate — the row still gets A.
   */
  readonly dims?: Record<string, number>
}

const clip = (s: string, n = 500): string => (s.length <= n ? s : s.slice(0, n))
const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)

// ---- Pure capture extractors: what a boundary payload contributes to memory ----

/**
 * Hindbrain observe → memory: the appraisal reason, unless discarded/empty.
 *
 * `dims` is the observe tier's OWN axis vector (design 2026-07-31 §3, stage C),
 * emitted in the appraisal call the hindbrain already makes. It replaces the v1
 * single-fired-drive one-hot `{ [drive]: weight / 5 }`, which could only ever
 * describe one axis and only on this one pathway. The `drive` tag on the memory
 * is untouched — that is escalation-adjacent metadata, not a score.
 */
export function observeMemories(observe: ObserveResult): MemoryWrite[] {
  if (observe.disposition === "discard") return []
  const reason = observe.reason?.trim()
  if (!reason) return []
  const tags = [observe.disposition, ...(observe.drive ? [observe.drive] : [])]
  return [{ source: "observe", text: clip(reason), tags, dims: observe.salience ?? {} }]
}

/**
 * Orient → memory: each section (heading + body) plus whatChanged.
 *
 * Every write carries the SAME producer (C) vector — the one the forebrain
 * emitted for this assessment (design 2026-07-31 §3, pathway 2). One reading per
 * result, not one per fragment: the tier scored the situation, and its sections
 * are how it wrote that situation up. `{}` rather than `undefined` when the tier
 * produced nothing, so the codec's omit-empty rule handles it uniformly.
 */
export function orientMemories(orient: OrientResult): MemoryWrite[] {
  const out: MemoryWrite[] = []
  const dims = orient.salience ?? {}
  const sections = Array.isArray(orient.sections) ? orient.sections : []
  for (const s of sections) {
    const body = s.body?.trim()
    if (!body) continue
    out.push({
      source: "orient",
      text: clip(`${s.heading}: ${body}`),
      tags: [orient.confidence, slug(s.heading)].filter(Boolean),
      dims,
    })
  }
  const changed = orient.whatChanged?.trim()
  if (changed) {
    out.push({
      source: "orient",
      text: clip(changed),
      tags: [orient.confidence, "what-changed"].filter(Boolean),
      dims,
    })
  }
  return out
}

/**
 * Decide → memory: plan reasoning + each step's intent (plan decisions only).
 *
 * Every write carries the SAME producer (C) vector the conscious tier emitted
 * for this decision (design 2026-07-31 §3, pathway 3). One reading per decision,
 * not one per step: the tier scored the moment, and the steps are how it chose
 * to act on it.
 */
export function decideMemories(decide: DecideResult): MemoryWrite[] {
  if (decide.decision !== "plan") return []
  const out: MemoryWrite[] = []
  const dims = decide.salience ?? {}
  const reasoning = decide.reasoning?.trim()
  if (reasoning) out.push({ source: "decide", text: clip(reasoning), tags: ["plan", "reasoning"], dims })
  const steps = Array.isArray(decide.steps) ? decide.steps : []
  for (const step of steps) {
    const t = `${step.task}: ${step.goal}`.trim()
    if (t) out.push({ source: "decide", text: clip(t), tags: ["plan", "step"], dims })
  }
  return out
}

/**
 * Evaluate → memory: the judgment + reasoning (an outcome lesson), carrying the
 * producer (C) vector the tier emitted for this outcome (design §3, pathway 4).
 */
export function evaluateMemories(evalResult: EvaluateResult): MemoryWrite[] {
  const reasoning = evalResult.reasoning?.trim()
  if (!reasoning) return []
  return [
    {
      source: "evaluate",
      text: clip(`${evalResult.judgment}: ${reasoning}`),
      tags: [evalResult.judgment],
      dims: evalResult.salience ?? {},
    },
  ]
}

// ---- Pure recall query builders ----

export function orientQuery(accumulatedEvents: ReadonlyArray<string>, emotionalWeight: string): string {
  if (accumulatedEvents.length === 0) return ""
  return clip(`${emotionalWeight} ${accumulatedEvents.join(" ")}`.trim(), 400)
}
export function decideQuery(orient: OrientResult): string {
  return clip(`${orient.headline} ${orient.whatChanged}`.trim(), 400)
}
export function evaluateQuery(task: string, goal: string): string {
  return clip(`${task} ${goal}`.trim(), 400)
}

// ---- Pure recall formatter ----

/** Coarse human age bucket from a millisecond delta. Unknown for NaN/negative. */
export function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "age unknown"
  const min = ageMs / 60_000
  if (min < 1) return "~1m ago"
  if (min < 60) return `~${Math.round(min)}m ago`
  const hr = min / 60
  if (hr < 48) return `~${Math.round(hr)}h ago`
  return `~${Math.round(hr / 24)}d ago`
}

/**
 * Render hits as a prompt block under `label`; "" when no hits. Each line is
 * annotated `- (<provenance> · <age>) <text>` so the model can weigh a grounded
 * observation against an inference. Truncated to maxChars (+ ellipsis).
 */
export function formatRecall(
  hits: ReadonlyArray<MemoryHit>,
  label: string,
  nowMs: number,
  maxChars?: number,
): string {
  if (hits.length === 0) return ""
  const lines = hits.map(
    (h) => `- (${h.provenance} · ${formatAge(nowMs - Date.parse(h.ts))}) ${h.text}`,
  )
  const block = `\n\n## ${label}\n${lines.join("\n")}`
  if (maxChars && block.length > maxChars) return `${block.slice(0, maxChars)}…`
  return block
}

// ---- Service ----

const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ")
const DEDUP_CAP = 512

export interface MemoryGatewayApi {
  readonly remember: (containerId: string, char: CharacterConfig, write: MemoryWrite) => Effect.Effect<void, never>
  readonly recall: (
    containerId: string,
    char: CharacterConfig,
    query: string,
    opts: { readonly k: number; readonly label: string; readonly maxChars?: number; readonly tags?: ReadonlyArray<string> },
  ) => Effect.Effect<string, never>
}

export class MemoryGateway extends Context.Tag("MemoryGateway")<MemoryGateway, MemoryGatewayApi>() {}

export const MemoryGatewayLive: Layer.Layer<MemoryGateway, never, LongtermStore | CharacterFs> = Layer.effect(
  MemoryGateway,
  Effect.gen(function* () {
    const store = yield* LongtermStore
    const charFs = yield* CharacterFs
    // Per-(container,char) rolling set of normalized texts written this process, for dedup.
    const seen = new Map<string, Set<string>>()
    const seenFor = (key: string): Set<string> => {
      let s = seen.get(key)
      if (!s) {
        s = new Set<string>()
        seen.set(key, s)
      }
      return s
    }
    // Per-(container,char) parsed salience profile cache — readSalience shells no
    // container, but parsing every recall is wasteful (Phase 3 §9). The profile is
    // authored once at scaffold time, so caching for the process lifetime is safe.
    const profileCache = new Map<string, Record<string, number>>()
    const loadSalience = (containerId: string, char: CharacterConfig) =>
      Effect.gen(function* () {
        const key = `${containerId}:${char.name}`
        const cached = profileCache.get(key)
        if (cached) return cached
        const md = yield* charFs
          .readSalience(char)
          .pipe(Effect.catchAll(() => Effect.succeed(TEMPLATE_SALIENCE)))
        const profile = parseSalience(md)
        profileCache.set(key, profile)
        return profile
      })
    return MemoryGateway.of({
      remember: (containerId, char, write) =>
        Effect.gen(function* () {
          const text = write.text.trim()
          if (!text) return
          const set = seenFor(`${containerId}:${char.name}`)
          const norm = normalize(text)
          if (set.has(norm)) return
          set.add(norm)
          if (set.size > DEDUP_CAP) {
            const oldest = set.values().next().value // Set preserves insertion order → oldest first
            if (oldest !== undefined) set.delete(oldest)
          }
          yield* store
            .remember(containerId, char, { text, source: write.source, tags: write.tags, dims: write.dims })
            .pipe(Effect.catchAll(() => Effect.void))
        }),
      recall: (containerId, char, query, opts) =>
        Effect.gen(function* () {
          const q = query.trim()
          if (!q) return ""
          // Over-fetch, then re-rank down to k by relevance × trust × salience-decay.
          const hits = yield* store
            .recall(containerId, char, q, { k: opts.k * RERANK_OVERFETCH, tags: opts.tags })
            .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<MemoryHit>)))
          const now = yield* Clock.currentTimeMillis
          const salience = yield* loadSalience(containerId, char)
          const ranked = rerank(hits, opts.k, now, salience)
          return formatRecall(ranked, opts.label, now, opts.maxChars)
        }),
    })
  }),
)
