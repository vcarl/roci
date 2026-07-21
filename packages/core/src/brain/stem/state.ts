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

// ── Mechanical appraisal guards (Task 1 — post-model clamps) ─────────────────
//
// The 2B hindbrain cannot be reliably prompt-guarded against fabricating a
// threat (overnight run: it appraised a `logged_in` handshake — hull 100/100,
// no hull field in the payload — as `w=4, steer, "Hull damage taken"`). These
// two pure guards run AFTER the model returns and only ever DOWNGRADE: a
// control-plane/lifecycle frame is capped so it can never escalate, and a
// safety-drive escalation whose reason claims damage must have real combat
// evidence in the payload or it is knocked back to a plain accumulate.

/**
 * Control-plane / lifecycle frame types (SpaceMolt `ServerEvent` control frames,
 * plus the `reconnected` lifecycle notification). These are handshake / ack /
 * session-lifecycle frames that carry NO threat semantics — a `logged_in` or
 * `welcome` can never be an attack. They may still accumulate at low weight
 * (they mark a real state transition worth remembering) but must NEVER escalate.
 *
 * DELIBERATELY EXCLUDES the error frames (`error`, `action_error`, and the
 * synthetic `api_error`): a 429/quota/blocked frame is a genuine agency/
 * sustenance pressure the ladder is meant to surface (observe.md's own w=4
 * escalate example), so capping it would suppress a real signal.
 */
export const CONTROL_PLANE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "welcome",
  "logged_in",
  "registered",
  "ok",
  "result",
  "action_result",
  "reconnected",
])

/** The hard weight cap a control-plane frame's appraisal may keep (accumulate band). */
export const CONTROL_PLANE_MAX_WEIGHT = 2

/** The weight a downgraded unsupported-threat appraisal is knocked back to. */
export const UNSUPPORTED_THREAT_WEIGHT = 2

/** True for a control-plane / lifecycle frame type (case-insensitive). */
export function isControlPlaneEventType(type: string): boolean {
  return CONTROL_PLANE_EVENT_TYPES.has(type.trim().toLowerCase())
}

/**
 * Compact a model-supplied reason for embedding as the `model claimed: …`
 * provenance suffix of a guard-rewritten reason (Task 1, fix 3). Whitespace-
 * collapsed and truncated to ~`max` chars so QA can still see what the model
 * tried without the fabricated clause LEADING the stored reason. Empty → "(none)".
 */
function truncateClaim(reason: string, max = 60): string {
  const trimmed = reason.replace(/\s+/g, " ").trim()
  if (!trimmed) return "(none)"
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/**
 * Cap a control-plane / lifecycle frame's appraisal (Task 1). Such a frame may
 * accumulate at ≤2 weight but must never escalate: weight is clamped to
 * `CONTROL_PLANE_MAX_WEIGHT`, an `escalate` disposition is demoted to
 * `accumulate` (a `discard` stays a discard), and `interrupt` is forced false —
 * so `eventRung` can only ever award it `accumulate`. Only fires when the model
 * actually exceeded the cap; a well-behaved low-weight appraisal passes through
 * untouched (`clamped:false`) so no spurious log is emitted. Pure; never throws.
 */
export function clampControlPlaneAppraisal(
  event: string,
  observe: ObserveResult,
): { observe: ObserveResult; clamped: boolean } {
  if (!isControlPlaneEventType(eventFingerprint(event).type)) return { observe, clamped: false }
  const overCap =
    observe.weight > CONTROL_PLANE_MAX_WEIGHT ||
    observe.disposition === "escalate" ||
    observe.interrupt === true
  if (!overCap) return { observe, clamped: false }
  const disposition: Disposition = observe.disposition === "escalate" ? "accumulate" : observe.disposition
  return {
    observe: {
      ...observe,
      weight: Math.min(observe.weight, CONTROL_PLANE_MAX_WEIGHT),
      disposition,
      interrupt: false,
      // Fix 3: the model's reason ("Hull damage taken…") is a fabrication on a
      // lifecycle frame — do not let it survive verbatim into logs/memory. Lead
      // with an accurate clause; keep the original claim as a truncated
      // provenance suffix so QA can still see what the model tried.
      reason: `control-plane event (guard: clamped from w${observe.weight}; model claimed: ${truncateClaim(observe.reason)})`,
    },
    clamped: true,
  }
}

/** Event types that are inherently combat/threat frames — their mere arrival is threat evidence. */
const COMBAT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "combat",
  "battle_update",
  "battle_damage",
  "player_died",
  "scan_detected",
])

/** A reason clause that claims physical damage / attack (the only claims the threat guard vets). */
const DAMAGE_CLAIM_RE =
  /\b(damage|damaged|attack|attacked|under\s*fire|taking\s*fire|incoming\s*fire|weapons?|hostile|boarded|boarding|breach|breached|destroy|destroyed|hull\s*(down|critical|breach)|shields?\s*down|being\s*hit)\b/i

/** Resource keys whose NEGATIVE reading is a harm delta. */
const HARM_RESOURCE_KEYS: ReadonlySet<string> = new Set([
  "hull",
  "shield",
  "shields",
  "health",
  "hp",
  "armor",
  "integrity",
])

/** Event-descriptor string values that name a harmful action. */
const HARM_EVENT_WORDS_RE = /\b(fire|attack|hit|damage|board|destroy|breach|explo|weapon|hostile|kill)\b/i

/** Extract the payload object of an event's `type: <t>\n<json>` text, or null. */
function parseEventPayload(event: string): Record<string, unknown> | null {
  const nl = event.indexOf("\n")
  const jsonPart = (nl >= 0 ? event.slice(nl + 1) : "").trim()
  if (!jsonPart) return null
  try {
    const obj = JSON.parse(jsonPart)
    if (!isPlainObject(obj)) return null
    return isPlainObject(obj.payload) ? obj.payload : obj
  } catch {
    return null
  }
}

/** Bounded recursive scan for a harm signal (a negative resource delta, a positive
 *  damage figure, an attacker field, or a harmful event-descriptor word). */
function objectShowsHarm(obj: Record<string, unknown>, depth: number): boolean {
  if (depth > 3) return false
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase()
    if (typeof v === "number") {
      // A resource reading below zero, or a delta/damage field, is a harm signal.
      if ((HARM_RESOURCE_KEYS.has(key) || key.endsWith("_delta") || key === "delta") && v < 0) return true
      if ((key === "damage" || key === "damage_taken" || key === "damage_dealt") && v !== 0) return true
    }
    if ((key === "attacker" || key === "attacked_by" || key === "hostile") && v != null && v !== false && v !== "") {
      return true
    }
    if (
      (key === "event" || key === "action" || key === "kind" || key === "reason") &&
      typeof v === "string" &&
      HARM_EVENT_WORDS_RE.test(v)
    ) {
      return true
    }
    if (isPlainObject(v) && objectShowsHarm(v, depth + 1)) return true
  }
  return false
}

/** True when the event's payload carries real evidence of combat/damage. */
export function hasCombatEvidence(event: string): boolean {
  if (COMBAT_EVENT_TYPES.has(eventFingerprint(event).type)) return true
  const payload = parseEventPayload(event)
  return payload !== null && objectShowsHarm(payload, 0)
}

/**
 * Downgrade an UNSUPPORTED threat escalation (Task 1). A safety-drive appraisal
 * that escalates (weight ≥ steer, an `escalate` disposition, or `interrupt`) and
 * whose reason claims damage/attack must be backed by real combat evidence in
 * the event payload (a hull/shield negative delta, a damage figure, a combat
 * frame type). Absent that evidence the model fabricated the threat, so the
 * appraisal is knocked back to a plain `accumulate` at `UNSUPPORTED_THREAT_WEIGHT`.
 * Conservative — only DOWNGRADES, only when the payload contradicts (lacks) the
 * claim, and NEVER touches an `interrupt:true` appraisal: that flag is the
 * model's rarest, strongest "physical emergency in progress" assertion, and the
 * amygdala/hard-interrupt path treats it specially — a false NEGATIVE there
 * (silencing a real boarding/attack the heuristic just doesn't recognize) is far
 * worse than a rare false interrupt. The primary fabrication case (the overnight
 * `logged_in` steer) carried `interrupt:false`, so it is still fully caught. The
 * control-plane clamp — which runs first — is what strips a fabricated interrupt
 * off a lifecycle frame. Pure; never throws.
 */
export function downgradeUnsupportedThreat(
  event: string,
  observe: ObserveResult,
  thresholds: AppraisalThresholds = DEFAULT_APPRAISAL_THRESHOLDS,
): { observe: ObserveResult; downgraded: boolean } {
  if (observe.interrupt === true) return { observe, downgraded: false }
  const claimsThreat = observe.drive === "safety" && DAMAGE_CLAIM_RE.test(observe.reason)
  const escalating = observe.weight >= thresholds.steer || observe.disposition === "escalate"
  if (!claimsThreat || !escalating) return { observe, downgraded: false }
  if (hasCombatEvidence(event)) return { observe, downgraded: false }
  return {
    observe: {
      ...observe,
      weight: Math.min(observe.weight, UNSUPPORTED_THREAT_WEIGHT),
      disposition: "accumulate",
      interrupt: false,
      // Fix 3: the claim was an unsupported safety threat — null the drive so
      // the fabricated safety attribution does not persist, and rewrite the
      // reason to lead with an accurate clause, keeping the model's claim as a
      // truncated provenance suffix.
      drive: null,
      reason: `unsupported threat (guard: downgraded from w${observe.weight}; model claimed: ${truncateClaim(observe.reason)})`,
    },
    downgraded: true,
  }
}

/**
 * Apply both post-model appraisal guards (Task 1), control-plane clamp first so
 * a lifecycle frame's fabricated escalation is capped before the threat guard
 * (which then no-ops on the already-lowered weight — no double correction).
 * Returns the guarded appraisal plus which guard(s) fired, so the caller can log
 * each firing. Pure; never throws.
 */
export function guardAppraisal(
  event: string,
  observe: ObserveResult,
  thresholds: AppraisalThresholds = DEFAULT_APPRAISAL_THRESHOLDS,
): { observe: ObserveResult; clampedControlPlane: boolean; downgradedThreat: boolean } {
  const cp = clampControlPlaneAppraisal(event, observe)
  const dt = downgradeUnsupportedThreat(event, cp.observe, thresholds)
  return { observe: dt.observe, clampedControlPlane: cp.clamped, downgradedThreat: dt.downgraded }
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

/**
 * DEEP salient-field allowlist (Task 1, iteration 5). The top-level scalar scan
 * alone is blind to state that lives NESTED: a real `full_state` payload carries
 * location under `location.system_id` and ship status under `ship.fuel`/etc, so
 * its only top-level scalars are `version`/`message` — constant frame to frame.
 * Iteration-4 dedup therefore collapsed EVERY `full_state` to one fingerprint,
 * and a 6-system bridge run deduped every snapshot as "duplicate 41x" — zero
 * accumulates fired on genuine location/dock changes.
 *
 * These paths are lifted from real payloads (players/vcarl events.jsonl,
 * 04:42-05:08Z): the location-/status-bearing values that MUST distinguish two
 * snapshots (system jump, dock change, combat flip, a real resource drop) while
 * the transient nested churn (`location.nearby_players`, `player.stats`, …) stays
 * dropped. Extracted via safe path lookups; a missing path contributes nothing.
 */
const SALIENT_IDENTITY_PATHS: ReadonlyArray<readonly string[]> = [
  // location-bearing (full_state nests these under `location`)
  ["location", "system_id"],
  ["location", "poi_id"],
  ["location", "poi_type"],
  ["location", "docked_at"],
  // status-bearing booleans — the player's OWN combat/cloak state (probed at a
  // few plausible seats; only the present one contributes)
  ["in_combat"],
  ["player", "in_combat"],
  ["ship", "in_combat"],
  ["location", "in_combat"],
  ["player", "is_cloaked"],
]

/**
 * DEEP bucketed-ratio allowlist (Task 1). A resource whose absolute value drains
 * gradually (`ship.fuel` 96->95->94...) would defeat dedup if keyed on the raw
 * value, so each is BUCKETED to a coarse 10% band (`Math.floor(ratio*10)`): a
 * 96%->94% frame-to-frame drip stays in band 9 and still dedups, while a material
 * 96%->71% drop (band 9->7) produces a new fingerprint. Value/max pairs from the
 * real `ship` object; the ratio is value/max.
 */
const SALIENT_RATIO_PATHS: ReadonlyArray<{
  readonly label: string
  readonly value: readonly string[]
  readonly max: readonly string[]
}> = [
  { label: "fuel", value: ["ship", "fuel"], max: ["ship", "max_fuel"] },
  { label: "hull", value: ["ship", "hull"], max: ["ship", "max_hull"] },
  { label: "shield", value: ["ship", "shield"], max: ["ship", "max_shield"] },
]

/** Safe nested lookup: walk `path` through plain objects only; any miss -> undefined. Never throws. */
function deepGet(base: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = base
  for (const key of path) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[key]
  }
  return cur
}

/**
 * Coarse 10%-band index for a resource ratio, or null when it cannot be derived.
 * A positive `max` -> ratio = value/max; otherwise a bare value already in [0,1]
 * is treated as the ratio. The ratio is clamped to [0,1] before bucketing so an
 * over-cap reading can't escape band 10.
 */
function ratioBucket(value: unknown, max: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  let ratio: number
  if (typeof max === "number" && Number.isFinite(max) && max > 0) {
    ratio = value / max
  } else if (value >= 0 && value <= 1) {
    ratio = value
  } else {
    return null
  }
  return Math.floor(Math.max(0, Math.min(1, ratio)) * 10)
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
      // (1) Top-level scalar identity fields (the natural key of a flat event).
      for (const [k, v] of Object.entries(base)) {
        if (k === "type") continue
        if (VOLATILE_FINGERPRINT_KEYS.has(k.toLowerCase())) continue
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          parts.push(`${k}=${String(v)}`)
        }
      }
      // (2) Deep salient identity fields (nested location/status — makes a
      // full_state, whose state is ALL nested, sensitive to a real move/flip).
      for (const path of SALIENT_IDENTITY_PATHS) {
        const v = deepGet(base, path)
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          parts.push(`${path.join(".")}=${String(v)}`)
        }
      }
      // (3) Deep bucketed resource ratios (coarse bands; gradual-drain-safe).
      for (const { label, value, max } of SALIENT_RATIO_PATHS) {
        const bucket = ratioBucket(deepGet(base, value), deepGet(base, max))
        if (bucket !== null) parts.push(`${label}~${bucket}`)
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
  const trimmed = scrubVolatileMetrics(headline.trim())
  if (trimmed === "") return "(assessment)"
  if (trimmed.startsWith("(assessment)")) return trimmed
  return `(assessment) ${trimmed}`
}

// ── Volatile-metric scrub for the persisted assessment line (Task 2) ─────────
//
// The WM assessment line is composed from the orient headline at write time and
// then read back verbatim by every later orient. When a headline hardcodes a
// volatile ship metric ("...with full fuel and hull", "fuel 71/100"), that
// number FREEZES at write time and orient faithfully restates it long after the
// live value has moved (overnight run: every orient said "full fuel and hull"
// while live fuel was 71%). Live telemetry already reaches orient via Current
// Domain State, so WM should carry intent/history — never telemetry. This scrub
// drops volatile ship-metric clauses (fuel/hull/shield/cargo, whether phrased as
// "full fuel", "fuel 71/100", or "100% hull"), keeping the goal/location/
// situation content. Conservative: it drops the metric clause rather than
// rewriting it, and leaves everything else untouched. Pure; never throws.

const _METRIC = "(?:fuel|hull|shields?|cargo)"
// "full fuel and hull", "low hull", "empty cargo" — a state adjective + one or
// more metrics chained by "and".
const ADJ_METRIC_RE = new RegExp(
  `\\b(?:full|empty|low|half|topped[-\\s]?off|maxed?|max|depleted|critical|no|zero)\\s+${_METRIC}(?:\\s+and\\s+(?:full\\s+|empty\\s+|low\\s+|half\\s+)?${_METRIC})*`,
  "gi",
)
// "fuel 71/100", "hull at 100%", "shield 50/50", "cargo: 2/10", "fuel 71 units".
const METRIC_NUM_RE = new RegExp(
  `\\b${_METRIC}\\b(?:\\s+(?:at|is|of))?\\s*[:=]?\\s*\\d+(?:\\s*/\\s*\\d+|\\s*%|\\s*units?)?`,
  "gi",
)
// "71/100 fuel", "100% hull".
const NUM_METRIC_RE = new RegExp(`\\b\\d+(?:\\s*/\\s*\\d+|\\s*%)?\\s+${_METRIC}\\b`, "gi")

export function scrubVolatileMetrics(text: string): string {
  let out = text
    .replace(ADJ_METRIC_RE, " ")
    .replace(METRIC_NUM_RE, " ")
    .replace(NUM_METRIC_RE, " ")
  // Tidy connectors orphaned by a removed clause ("... with , planning" →
  // "..., planning"; a trailing "with"/"and"/"at"/"of").
  out = out
    .replace(/\s+(?:with|and|at|of)\s*(?=[,;.]|$)/gi, "")
    .replace(/\s+([,;.])/g, "$1")
    .replace(/([,;])\s*(?=[,;.])/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.\-–—]+/, "")
    .replace(/[\s,;:\-–—]+$/, "")
    .trim()
  return out
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
