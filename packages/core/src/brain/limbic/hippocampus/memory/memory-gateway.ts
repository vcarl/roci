import { Context, Effect, Layer } from "effect"
import type { CharacterConfig } from "../../../../services/CharacterFs.js"
import { LongtermStore, type MemoryHit } from "./longterm-store.js"
import type { ObserveResult, OrientResult, DecideResult, EvaluateResult } from "../../../../skills/types.js"

/** One unit to persist: the source phase, the text, and derived tags. */
export interface MemoryWrite {
  readonly source: string
  readonly text: string
  readonly tags: ReadonlyArray<string>
}

const clip = (s: string, n = 500): string => (s.length <= n ? s : s.slice(0, n))
const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)

// ---- Pure capture extractors: what a boundary payload contributes to memory ----

/** Hindbrain observe → memory: the appraisal reason, unless discarded/empty. */
export function observeMemories(observe: ObserveResult): MemoryWrite[] {
  if (observe.disposition === "discard") return []
  const reason = observe.reason?.trim()
  if (!reason) return []
  const tags = [observe.disposition, ...(observe.drive ? [observe.drive] : [])]
  return [{ source: "observe", text: clip(reason), tags }]
}

/** Orient → memory: each section (heading + body) plus whatChanged. */
export function orientMemories(orient: OrientResult): MemoryWrite[] {
  const out: MemoryWrite[] = []
  const sections = Array.isArray(orient.sections) ? orient.sections : []
  for (const s of sections) {
    const body = s.body?.trim()
    if (!body) continue
    out.push({ source: "orient", text: clip(`${s.heading}: ${body}`), tags: [orient.confidence, slug(s.heading)].filter(Boolean) })
  }
  const changed = orient.whatChanged?.trim()
  if (changed) out.push({ source: "orient", text: clip(changed), tags: [orient.confidence, "what-changed"].filter(Boolean) })
  return out
}

/** Decide → memory: plan reasoning + each step's intent (plan decisions only). */
export function decideMemories(decide: DecideResult): MemoryWrite[] {
  if (decide.decision !== "plan") return []
  const out: MemoryWrite[] = []
  const reasoning = decide.reasoning?.trim()
  if (reasoning) out.push({ source: "decide", text: clip(reasoning), tags: ["plan", "reasoning"] })
  const steps = Array.isArray(decide.steps) ? decide.steps : []
  for (const step of steps) {
    const t = `${step.task}: ${step.goal}`.trim()
    if (t) out.push({ source: "decide", text: clip(t), tags: ["plan", "step"] })
  }
  return out
}

/** Evaluate → memory: the judgment + reasoning (an outcome lesson). */
export function evaluateMemories(evalResult: EvaluateResult): MemoryWrite[] {
  const reasoning = evalResult.reasoning?.trim()
  if (!reasoning) return []
  return [{ source: "evaluate", text: clip(`${evalResult.judgment}: ${reasoning}`), tags: [evalResult.judgment] }]
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

/** Render hits as a prompt block under `label`; "" when no hits. Truncated to maxChars (+ ellipsis). */
export function formatRecall(hits: ReadonlyArray<MemoryHit>, label: string, maxChars?: number): string {
  if (hits.length === 0) return ""
  const block = `\n\n## ${label}\n${hits.map((h) => `- ${h.text}`).join("\n")}`
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

export const MemoryGatewayLive: Layer.Layer<MemoryGateway, never, LongtermStore> = Layer.effect(
  MemoryGateway,
  Effect.gen(function* () {
    const store = yield* LongtermStore
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
            .remember(containerId, char, { text, source: write.source, tags: write.tags })
            .pipe(Effect.catchAll(() => Effect.void))
        }),
      recall: (containerId, char, query, opts) =>
        Effect.gen(function* () {
          const q = query.trim()
          if (!q) return ""
          const hits = yield* store
            .recall(containerId, char, q, { k: opts.k, tags: opts.tags })
            .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<MemoryHit>)))
          return formatRecall(hits, opts.label, opts.maxChars)
        }),
    })
  }),
)
