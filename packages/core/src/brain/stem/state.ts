import type { DecideResult, Disposition, ObserveResult, WaitState, OrientResult } from "../../skills/types.js"
import type { PlanStep } from "../../core/types.js"
import { isPlainObject } from "./parse.js"

export interface ActivationState {
  accumulatedEvents: string[]
  emotionalWeight: string
  currentPlan: DecideResult | null
  currentStepIndex: number
  waitState: WaitState | null
  lastOrientTick: number
}

export function freshActivationState(): ActivationState {
  return {
    accumulatedEvents: [],
    emotionalWeight: "",
    currentPlan: null,
    currentStepIndex: 0,
    waitState: null,
    lastOrientTick: 0,
  }
}

// ── Limbic drives: per-event appraisal + per-tick escalation ───────────────

/** The escalation ladder (§3.2). Ordered least→most disruptive. */
export type EscalationRung = "none" | "accumulate" | "steer" | "reorient" | "interrupt"

const RUNG_RANK: Record<EscalationRung, number> = {
  none: 0,
  accumulate: 1,
  steer: 2,
  reorient: 3,
  interrupt: 4,
}

/**
 * Weight thresholds for the graded ladder. STEER ≈ 4, REORIENT ≈ 5 (§3.2).
 *
 * Calibration note (observe.md v4): `weight` is SALIENCE ("how much does this
 * matter"), not danger-only. Social/economic/navigation/opportunity/novelty
 * events are now KEPT with a spread of non-zero weights (typically 1–3), where
 * pre-v4 they collapsed to discard/weight-0. That widening does NOT move these
 * thresholds: 1–3 never escalates on weight alone, so a chat or a trade tip
 * accumulates for the forebrain (surfaced via the periodic forced orient)
 * WITHOUT waking a spurious steer/reorient. Weight 4–5 stays reserved for the
 * genuinely pressing/emergency (a real threat OR a must-act-now opportunity),
 * so `steer`/`reorient` keep meaning "act this cycle" / "the world moved
 * materially" — the rubric change is calibration under a stable ladder.
 */
export interface AppraisalThresholds {
  readonly steer: number
  readonly reorient: number
}

/** Default thresholds, tunable per cadence profile (alongside DEFAULT_STEER_CADENCE_TICKS). */
export const DEFAULT_APPRAISAL_THRESHOLDS: AppraisalThresholds = { steer: 4, reorient: 5 }

/**
 * The aggregated per-tick escalation signal (§4.4), reduced from the tick's
 * per-event `ObserveResult`s and consumed directly by the tick loop.
 */
export interface HindbrainEscalation {
  /** The MAX rung across the tick's events (§3.2 ladder). */
  readonly rung: EscalationRung
  /** The highest per-event weight seen this tick (clamped 0–5). */
  readonly maxWeight: number
  /** True when `rung` is `steer` or higher — the only signal the forebrain-wake session needs. */
  readonly escalate: boolean
  /** The highest-weight event's appraisal — drives the tick mood. null when no events. */
  readonly dominant: ObserveResult | null
  /** Raw text of the highest-weight (dominant) event — so the tick's appraisal
   *  behavior event can carry a short human-readable summary without the reduce
   *  re-mining the raw exchanges (§ QA visibility). null when no events. */
  readonly dominantEvent: string | null
  /** Raw text of every non-discard event, for `accumulatedEvents`. */
  readonly accumulated: ReadonlyArray<string>
}

/** A well-formed, non-escalating escalation — the every-tick default and the empty result. */
export function emptyEscalation(): HindbrainEscalation {
  return { rung: "none", maxWeight: 0, escalate: false, dominant: null, dominantEvent: null, accumulated: [] }
}

const DISPOSITIONS: ReadonlySet<Disposition> = new Set(["discard", "accumulate", "escalate"])

/** Clamp any value to an integer in [0, 5]; non-numeric → 0. */
function clampWeight(w: unknown): number {
  const n = typeof w === "number" ? w : Number(w)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(5, Math.round(n)))
}

/** Normalize a raw drive label: null-ish → null; otherwise lowercased+trimmed. */
function normalizeDrive(raw: unknown, knownDrives?: ReadonlyArray<string>): string | null {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim().toLowerCase()
  if (s === "" || s === "null" || s === "none") return null
  if (knownDrives && knownDrives.length > 0) {
    const known = knownDrives.map((d) => d.toLowerCase())
    return known.includes(s) ? s : null
  }
  return s
}

/**
 * Validate + clamp a single (possibly-malformed) per-event appraisal into a
 * well-formed `ObserveResult`. Pure; never throws. `weight` is clamped to 0–5,
 * `drive` validated against the closed vocabulary (`knownDrives`) → null on
 * miss, `disposition` defaulted to the safe `accumulate`, `interrupt` coerced to
 * a strict boolean (default false). The model's structured output passes through
 * here before it can drive control flow.
 */
export function appraise(
  raw: Partial<ObserveResult> | Record<string, unknown>,
  knownDrives?: ReadonlyArray<string>,
): ObserveResult {
  const r = raw as Record<string, unknown>
  const disposition = DISPOSITIONS.has(r.disposition as Disposition)
    ? (r.disposition as Disposition)
    : "accumulate"
  const emotionalWeight = typeof r.emotionalWeight === "string" && r.emotionalWeight.length > 0
    ? r.emotionalWeight
    : "😐"
  const interrupt = r.interrupt === true || r.interrupt === "true"
  return {
    disposition,
    emotionalWeight,
    drive: normalizeDrive(r.drive, knownDrives),
    weight: clampWeight(r.weight),
    interrupt,
    reason: typeof r.reason === "string" ? r.reason : "",
  }
}

/** The escalation rung a single appraised event earns (§3.2). */
function eventRung(o: ObserveResult, thresholds: AppraisalThresholds): EscalationRung {
  // Hard-interrupt is gated behind an explicit `interrupt:true` — never weight
  // alone (the 2B caps at reorient; this rung exists for the amygdala / a future
  // stronger tier / a genuine redundant physical-attack appraisal — §3.2 REV3).
  if (o.interrupt === true) return "interrupt"
  const w = clampWeight(o.weight)
  if (w >= thresholds.reorient) return "reorient"
  // An `escalate` disposition floors the event at steer even when weight is low.
  if (w >= thresholds.steer || o.disposition === "escalate") return "steer"
  if (o.disposition !== "discard") return "accumulate"
  return "none"
}

/**
 * Reduce the tick's per-event appraisals into one `HindbrainEscalation` (§4.4).
 * Pure. The tick rung is the MAX rung across events; `dominant` is the
 * highest-weight event (ties → first); `accumulated` is the raw text of every
 * non-discard event.
 */
export function appraiseTick(
  results: ReadonlyArray<{ event: string; observe: ObserveResult }>,
  thresholds: AppraisalThresholds,
): HindbrainEscalation {
  if (results.length === 0) return emptyEscalation()

  let rung: EscalationRung = "none"
  let maxWeight = 0
  let dominant: ObserveResult | null = null
  let dominantEvent: string | null = null
  const accumulated: string[] = []

  for (const { event, observe } of results) {
    const w = clampWeight(observe.weight)
    const r = eventRung(observe, thresholds)
    if (RUNG_RANK[r] > RUNG_RANK[rung]) rung = r
    if (dominant === null || w > maxWeight) {
      maxWeight = w
      dominant = observe
      dominantEvent = event
    }
    if (observe.disposition !== "discard") accumulated.push(event)
  }

  return {
    rung,
    maxWeight,
    escalate: RUNG_RANK[rung] >= RUNG_RANK.steer,
    dominant,
    dominantEvent,
    accumulated,
  }
}

/**
 * A compact one-line summary of a raw event's text for the appraisal behavior
 * event (QA visibility). The event text is the loop's `type: <type>\n<json>`
 * shape; this pulls the type and the first ~80 chars of the payload so
 * distribution QA reads a legible label off the behavior stream without mining
 * the raw observe exchanges. Pure; tolerant of any shape.
 */
export function summarizeEventText(text: string | null): string {
  if (!text) return ""
  const fp = eventFingerprint(text)
  const nl = text.indexOf("\n")
  const payload = (nl >= 0 ? text.slice(nl + 1) : text).replace(/\s+/g, " ").trim()
  const head = payload.length > 80 ? `${payload.slice(0, 80)}…` : payload
  return head ? `${fp.type}: ${head}` : fp.type
}

// ── Mechanical event dedup (upstream of the hindbrain) ───────────────────────

/**
 * Sliding-window size (in ticks) for the per-event dedup fingerprint history.
 * Run-3 appraised the same "New station … in-system" observation ~35× at
 * w=2/accumulate — flooding accumulatedEvents/WM and burning 2B inference on a
 * stimulus the agent had already habituated to. A ~40-tick window (≈ the forced
 * orient cadence × several) is long enough to swallow a burst of near-identical
 * frames yet short enough that a genuinely recurring condition re-surfaces once
 * the window rolls past.
 */
export const DEDUP_WINDOW_TICKS = 40

/**
 * Payload keys whose value is inherently volatile (a monotonic clock / sequence
 * / staleness age) and so must NOT distinguish two otherwise-identical events —
 * an `observation_update` for the same station differs only by `tick` frame to
 * frame. Stripped from the fingerprint so those near-identical frames collapse.
 */
const VOLATILE_FINGERPRINT_KEYS: ReadonlySet<string> = new Set([
  "tick",
  "timestamp",
  "ts",
  "time",
  "server_time",
  "servertime",
  "seq",
  "sequence",
  "stateagesec",
  "age",
  "latency",
  "latencyms",
  "now",
])

/**
 * The dedup fingerprint of one event: its coarse `type` (for the seen-N-times
 * family count) and a finer `full` key (type + its salient scalar payload) for
 * the exact/near-identical repeat test.
 *
 * "Salient" = the top-level SCALAR identity fields of the event payload
 * (`poi_id`, `system_id`, `unknown_signature`, …), sorted and joined. Nested
 * objects/ARRAYS are dropped — they carry the transient churn (the shifting
 * `system_changed`/`nearby_changed` player lists) that made two "same station"
 * frames look distinct — and volatile clock/seq keys are stripped. So two
 * `observation_update`s announcing the same station collapse to one `full` key
 * even as their player deltas differ. Pure; never throws (an unparseable
 * payload falls back to the trimmed raw text so exact repeats still dedup).
 */
export interface EventFingerprint {
  readonly type: string
  readonly full: string
}

export function eventFingerprint(text: string): EventFingerprint {
  const nl = text.indexOf("\n")
  const firstLine = (nl >= 0 ? text.slice(0, nl) : text).trim()
  const typeMatch = /^type:\s*(.+)$/i.exec(firstLine)
  const type = typeMatch ? typeMatch[1].trim() : "unknown"
  const jsonPart = nl >= 0 ? text.slice(nl + 1).trim() : ""
  let sig = ""
  try {
    const obj = JSON.parse(jsonPart)
    const base = isPlainObject(obj) && isPlainObject(obj.payload) ? obj.payload : obj
    if (isPlainObject(base)) {
      const parts: string[] = []
      for (const [k, v] of Object.entries(base)) {
        if (k === "type") continue
        if (VOLATILE_FINGERPRINT_KEYS.has(k.toLowerCase())) continue
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          parts.push(`${k}=${String(v)}`)
        }
      }
      parts.sort()
      sig = parts.join("|")
    } else {
      sig = String(obj)
    }
  } catch {
    // Unparseable payload → key on the exact trimmed text (exact repeats still dedup).
    sig = jsonPart
  }
  return { type, full: `${type} ${sig}` }
}

/** True for chat / player-message event types — NEVER deduped-to-discard (owner
 *  directive: chats always accumulate); they are annotated but always passed
 *  through to the hindbrain. */
export function isChatEventType(type: string): boolean {
  return /chat|message/i.test(type)
}

/** One entry in the loop's sliding fingerprint history. */
export interface DedupWindowEntry {
  readonly full: string
  readonly type: string
  readonly tick: number
}

/**
 * Count, within the `window`-tick sliding history, how many prior entries share
 * this event's exact `full` fingerprint (`exactCount`) and how many share its
 * coarse `type` family (`typeCount`). Pure — the loop owns the mutable history
 * and the discard/annotate decision; this only reads it.
 */
export function countRecentFingerprints(
  recent: ReadonlyArray<DedupWindowEntry>,
  fp: EventFingerprint,
  tick: number,
  window: number,
): { exactCount: number; typeCount: number } {
  let exactCount = 0
  let typeCount = 0
  for (const e of recent) {
    if (tick - e.tick > window) continue
    if (e.type === fp.type) typeCount++
    if (e.full === fp.full) exactCount++
  }
  return { exactCount, typeCount }
}

/** Force an orient when events have piled up for `orientInterval` ticks without one. */
export function shouldForceOrient(state: ActivationState, tick: number, orientInterval: number): boolean {
  return state.accumulatedEvents.length > 0 && tick - state.lastOrientTick >= orientInterval
}

/**
 * The steps of a plan decision, or [] for any other decision.
 *
 * A small conscious model can emit a parseable `{"decision":"plan"}` with no
 * `steps` (or `steps` a non-array). `parseOr`'s fallback is a DIFFERENT union
 * variant (`{decision:"continue",...}`) so it does not supply `steps` → a
 * "plan" decision can reach here with `steps` undefined/non-array. The
 * `Array.isArray` guard makes this always return a real array, so callers can
 * `.length` / `.map` / index it without throwing.
 */
export function planSteps(plan: DecideResult | null): readonly PlanStep[] {
  return decideSteps(plan)
}

/**
 * The actionable plan steps of a decide result — always a real array.
 * Returns [] unless `decide.decision === "plan"` AND `decide.steps` is a
 * genuine array. A "plan" decision whose `steps` is missing/non-array/empty
 * yields [] (no actionable steps), which the loop treats as "don't start a
 * plan" rather than crashing on `decide.steps.length`.
 */
export function decideSteps(decide: DecideResult | null): readonly PlanStep[] {
  if (decide && decide.decision === "plan" && Array.isArray(decide.steps)) {
    return decide.steps
  }
  return []
}

/**
 * Keep `DecideResult.skill` a string-or-absent value at the parse boundary
 * (spec §3 Selection). A small conscious model can emit `skill` as a number,
 * object, array, or empty string; keep it only when it is a non-empty trimmed
 * string, drop it otherwise, so the loop reads either a real skill name or
 * nothing. Mirrors normalizeTransition (tiers.ts) — pure; never throws.
 *
 * Also folds the two near-misses a model naturally produces: the `editing-skills`
 * seed skill teaches that skills live as files at `me/skills/<slug>.md`, so the
 * decider may name one by its filename or path ("securing-fuel.md",
 * "me/skills/securing-fuel.md") rather than its bare name. readSkill's slugify
 * folds case/spaces but would mangle a path or a `.md` suffix into a "-md" slug
 * that never matches — a silent warn-drop. Strip any leading path and a trailing
 * `.md` here so those resolve like the bare name; a value that reduces to empty
 * is dropped like whitespace-only junk.
 */
export function sanitizeDecideSkill(decide: DecideResult): DecideResult {
  const raw = (decide as { skill?: unknown }).skill
  if (typeof raw === "string") {
    const cleaned = raw
      .trim()
      .replace(/^.*[/\\]/, "") // drop any leading me/skills/-style path
      .replace(/\.md$/i, "") // drop a copied-from-filename extension
      .trim()
    if (cleaned) return { ...decide, skill: cleaned }
  }
  const { skill: _drop, ...rest } = decide as DecideResult & { skill?: unknown }
  return rest as DecideResult
}

/**
 * Returns true when a discover decision has a well-formed payload: a `discover`
 * object whose `questions` is a non-empty array.
 *
 * Mirrors decideSteps: the static type says `discover` is non-optional on the
 * discover variant, but a small model can emit `{"decision":"discover","reasoning":"x"}`
 * with no `discover` key. The cast to unknown pierces the static type so we can do
 * the runtime check without TS complaining about a redundant optional-chain.
 * The loop-branch guard uses this to degrade safely instead of crashing in
 * discoverToPlan when `decide.discover` is undefined at runtime.
 */
export function isWellFormedDiscover(
  decide: DecideResult | null,
): decide is Extract<DecideResult, { decision: "discover" }> {
  if (!decide || decide.decision !== "discover") return false
  const raw = decide as unknown as { discover?: { questions?: unknown } }
  return (
    raw.discover !== undefined &&
    Array.isArray(raw.discover.questions) &&
    (raw.discover.questions as unknown[]).length > 0
  )
}

/**
 * Translate a `discover` decision into a synthetic one-step `plan` decision so it
 * reuses the existing step→evaluate execution path (hybrid-C — no new loop
 * machinery). The single step's `task` is "discover"; the questions become its
 * goal; tier and timeoutTicks carry straight through to the step's fields.
 */
export function discoverToPlan(
  decide: Extract<DecideResult, { decision: "discover" }>,
): DecideResult {
  return {
    decision: "plan",
    reasoning: decide.reasoning,
    steps: [
      {
        task: "discover",
        goal: `Discover your world. Answer: ${decide.discover.questions.join("; ")}`,
        tier: decide.discover.tier,
        successCondition:
          "Findings on environment, capabilities, and available paths reported back.",
        timeoutTicks: decide.discover.timeoutTicks,
      },
    ],
  }
}

/**
 * The execution-block invariant: an "active" plan (`currentPlan !== null`) whose
 * actionable steps are empty. Such a plan would wedge the loop — the execution
 * block keeps finding no step at `currentStepIndex`, never executes, never
 * evaluates, never advances. The plan-assignment guard (`decideSteps(...).length
 * > 0`) makes this unreachable through the normal path, so a `true` here signals
 * a genuine invariant violation the loop must fail loudly on and self-heal from.
 */
export function isWedgedEmptyPlan(currentPlan: DecideResult | null): boolean {
  return currentPlan !== null && decideSteps(currentPlan).length === 0
}

/**
 * Literal marker the conscious agent is instructed to print when it has fully
 * met the current step's success condition. 4b ships the mechanism; phrasing
 * robustness tuning and the escalation-request marker are Phase 4c.
 */
export const STEP_DONE_MARKER = "[STEP_DONE]"

/**
 * Returns true if the output contains the completion marker, indicating the
 * agent self-reported success. Tolerant of surrounding text; case-sensitive.
 * runConsciousEvaluate remains the arbiter — a premature marker → replan/wait.
 */
export function detectCompletion(output: string): boolean {
  return output.includes(STEP_DONE_MARKER)
}

/**
 * Render a forebrain OrientResult into a concise steering directive.
 * The text is model-generated (laundered upstream by the forebrain) —
 * this function only formats; it never embeds raw inbound event text.
 */
export function formatSteerDirective(orient: OrientResult): string {
  const parts: string[] = [
    `Situation update: ${orient.headline}`,
    `What changed: ${orient.whatChanged}`,
  ]
  for (const section of orient.sections) {
    parts.push(`${section.heading}: ${section.body}`)
  }
  return parts.join("\n")
}

/**
 * The title for a plan's headline WM todo (spec §2). Sourced from the orient
 * `headline` — but the orient headline is a narrative ASSESSMENT of the
 * situation, not a plan directive, and a small forebrain routinely confabulates
 * a stale narrative there (run-3: WM.md carried the plan title "t23 Drifted to
 * isolated Horizon system…", a confabulated headline, over a correct child
 * step). `DecideResult` carries no title-shaped field — only free-form
 * `reasoning` and the per-step task/goal — so the headline IS the only concise
 * title source at the seed seam. Prefix it "(assessment) " so a stale narrative
 * can never masquerade in WM.md as an actionable plan the agent committed to.
 * Pure; idempotent (never double-prefixes); tolerant of an empty headline.
 */
export function planTitleFromHeadline(headline: string): string {
  const trimmed = headline.trim()
  if (trimmed === "") return "(assessment)"
  if (trimmed.startsWith("(assessment)")) return trimmed
  return `(assessment) ${trimmed}`
}

/** The instructions handed to the conscious agent for one plan step. */
export function formatStepTask(step: PlanStep, headline: string, skillBody?: string): string {
  const skillSection =
    skillBody && skillBody.trim() ? ["## Skill in use", skillBody.trim()].join("\n") : null
  return [
    `# Task: ${step.task}`,
    `Context: ${headline}`,
    `## Goal\n${step.goal}`,
    `## Success condition\n${step.successCondition}`,
    // Worn skill (spec §3): the decide-chosen skill's body, injected for this
    // step. Absent/unknown skill → no section (degrade-never-fail in the loop).
    ...(skillSection ? [skillSection] : []),
    // Working-memory verbs (spec §2: "formatStepTask documents the wm verbs
    // to the agent"). This is the single doc site — WM.md itself (injected
    // into every request via opencode instructions) stays pure data.
    [
      "## Working memory",
      "Your open todos are always visible as WM.md in your context. Keep them current with the `wm` bash command:",
      '- `wm todo "<text>" [--parent <id>]` — add a todo (prints its id)',
      "- `wm done <id>` — mark it done",
      "- `wm discard <id>` — drop it without doing it (kept for later review)",
      "There is no `wm list` — WM.md is the list.",
    ].join("\n"),
    `Do this work now. When finished, report concisely what you did and whether the success condition is met. When you have fully met the success condition, print exactly: ${STEP_DONE_MARKER}`,
  ].join("\n\n")
}

/** Wrap a worker's text output as the execution report fed to evaluate. */
export function formatExecutionReport(output: string): string {
  const trimmed = output.trim()
  return trimmed.length > 0 ? trimmed : "Worker produced no output."
}

// ── Ground-truth domain state (D2/D3/N2) ─────────────────────────────────────

/**
 * Metric keys whose value is conventionally a 0–1 ratio of a resource to its
 * capacity — the domain classifier emits `fuel = ship.fuel / ship.max_fuel`,
 * `hull = ship.hull / ship.max_hull`, etc. Rendered as a bare float, a small
 * model misreads `0.49` as "49 units" or `1` as "1 unit — critical" (observed
 * run-2, 03:42). These are rendered as an unambiguous percent wherever they feed
 * a prompt.
 *
 * NOTE: the normalization itself happens DOMAIN-SIDE
 * (packages/domain-spacemolt/src/situation-classifier.ts derives the ratios; the
 * domain's `summarize` puts them in `metrics.fuel`/`metrics.hull`). Core cannot
 * make the domain emit absolute X/Y, so it renders unambiguously at the
 * prompt-construction seam instead.
 */
const RATIO_METRIC_KEYS: ReadonlySet<string> = new Set(["fuel", "hull", "shield"])

/**
 * Render metric units unambiguously (N2). A ratio-convention key
 * (fuel/hull/shield) holding a number in [0,1] becomes a percent string
 * (`0.49` → `"49%"`, `1` → `"100%"`). Every other key/value passes through
 * untouched — an already-absolute value (fuel `49`, cargoUsed `2`) is out of
 * [0,1] so it is left as-is, and a value already rendered as a string (`"49%"`)
 * is not a number so it is left as-is. Pure; returns a new record.
 */
export function normalizeMetricUnits(
  metrics: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(metrics)) {
    out[k] = RATIO_METRIC_KEYS.has(k) && typeof v === "number" && v >= 0 && v <= 1
      ? `${Math.round(v * 100)}%`
      : v
  }
  return out
}

/**
 * Extract the domain classifier's structured metrics object from a serialized
 * situation summary (`JSON.stringify(SituationSummary)` — the `summaryJson`
 * threaded through the loop). Returns `{}` on any parse miss or when `.metrics`
 * is absent / not an object, so callers never throw on a malformed snapshot.
 * Only scalar (string|number|boolean) values survive.
 */
export function extractDomainMetrics(
  summaryJson: string,
): Record<string, string | number | boolean> {
  let parsed: unknown
  try {
    parsed = JSON.parse(summaryJson)
  } catch {
    return {}
  }
  if (!isPlainObject(parsed)) return {}
  const m = (parsed as { metrics?: unknown }).metrics
  if (!isPlainObject(m)) return {}
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v
  }
  return out
}

/**
 * D3 override — stamp the domain's authoritative structured metrics over a
 * forebrain synthesis so downstream consumers (decide, steer directive, tier
 * logs) never see a confabulated value for a fact the system already knows.
 *
 * The 9B forebrain routinely lets stale diary/WM/recalled-memory narrative
 * override its freshly-injected state: run-2 (03:42) emitted metrics
 * `{situationType:"drifting", location:"Phase Drift", system:"Horizon"}` while
 * the injected ground truth said docked at First Step, fuel 100/100.
 * Instructions alone do not fix a model this small, so it is corrected
 * mechanically.
 *
 * Contract:
 *  - Every key the ground-truth metrics provides WINS over the synthesis value
 *    (fuel/hull/situationType/inCombat/…), unit-normalized (N2).
 *  - Synthesis-only metric keys the snapshot does not carry are LEFT ALONE — the
 *    model may surface a derived signal the classifier doesn't — but they are
 *    STILL unit-normalized (N2): a run-3 orient synthesized its OWN `fuel:1,
 *    hull:1` bare floats while the domain state carried no top-level `metrics`,
 *    so ground was empty; the old early-return left those floats un-normalized
 *    and `fuel:1` (meaning full) reached the transition/episode records instead
 *    of `"100%"`. Normalizing the FINAL merged object (not just the ground
 *    subset) fixes every consumer — tier records included — at this one seam.
 *  - An empty ground-truth set (parse miss / no metrics) still normalizes the
 *    synthesis metrics; it never blanks or invents a value.
 *  - JUDGMENT fields (headline, sections, whatChanged, emotionalState,
 *    confidence) are untouched — only `metrics` is rewritten.
 */
export function applyGroundTruthMetrics(
  orient: OrientResult,
  ground: Record<string, string | number | boolean>,
): OrientResult {
  const merged =
    Object.keys(ground).length === 0 ? orient.metrics : { ...orient.metrics, ...ground }
  return { ...orient, metrics: normalizeMetricUnits(merged) }
}

/**
 * D2 render — a compact, human-readable "ground truth, live" view of the domain
 * summary for the decide prompt. The forebrain synthesis the decider reads can
 * confabulate the present (run-2: "stranded, fuel critical" while docked with
 * full fuel); this section hands decide the live snapshot directly so it can
 * ground its choice. Prefers the rich section prose (the briefing carries
 * absolute "Fuel: 49/100" plus location/station), then appends a unit-normalized
 * metrics line. Falls back to the raw JSON string on a parse miss — still ground
 * truth, just unformatted. Pure; never throws.
 */
export function renderDomainStateForPrompt(summaryJson: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(summaryJson)
  } catch {
    return summaryJson.trim()
  }
  if (!isPlainObject(parsed)) return summaryJson.trim()

  const lines: string[] = []
  const situation = parsed.situation
  const metricsObj = extractDomainMetrics(summaryJson)
  const situationType =
    (isPlainObject(situation) && typeof situation.type === "string" ? situation.type : undefined) ??
    (typeof metricsObj.situationType === "string" ? metricsObj.situationType : undefined)
  if (situationType) lines.push(`Situation: ${situationType}`)
  if (typeof parsed.headline === "string" && parsed.headline.trim()) lines.push(parsed.headline)

  const sections = parsed.sections
  if (Array.isArray(sections)) {
    for (const s of sections) {
      if (isPlainObject(s) && typeof s.heading === "string" && typeof s.body === "string") {
        lines.push(`\n${s.heading}:\n${s.body}`)
      }
    }
  }

  if (Object.keys(metricsObj).length > 0) {
    const flat = Object.entries(normalizeMetricUnits(metricsObj))
      .map(([k, v]) => `${k}=${v}`)
      .join("  ")
    lines.push(`\nMetrics: ${flat}`)
  }

  return lines.length > 0 ? lines.join("\n") : summaryJson.trim()
}
