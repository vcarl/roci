import type { LogLevel } from "./events.js"

/**
 * The inline run digest carried by a terminal `session_end` behavior. Mirrors
 * the analytic fields of the QA `RunDigest` (minus `env`, which the monitor adds
 * from CLI args), so the monitor can adopt it directly as the authoritative
 * digest. `sequence` holds behavior-type strings.
 */
export interface BehaviorDigest {
  counts: Record<string, number>
  sequence: string[]
  timings: { firstForebrainMs: number | null; firstPlanMs: number | null }
  startTs: string | null
  terminalCause: string | null
}

/**
 * A structured behavior — the source of truth for "what the bot did". Machinery
 * types ship in Wave 1; cognition types are emitted in Wave 2; `note` is the
 * no-drop escape hatch for anything that resists taxonomy.
 */
export type Behavior =
  // ── Machinery (Wave 1) ──────────────────────────────────────
  | { type: "session_start"; domain: string; character: string; gitSha: string; tickIntervalMs: number }
  | { type: "session_end"; reason: "clean" | "signal" | "error"; signal?: string; digest: BehaviorDigest }
  | {
      type: "provision"
      component: "container" | "embed_server" | "memory_cli" | "wm_cli" | "wm_files" | "conscious_provider"
      status: "ready" | "failed"
      detail?: string
    }
  | { type: "phase"; phase: string; transition: "enter" | "exit" }
  | { type: "reflection"; stage: "dream" | "promote" | "adjudicate" | "retrospect" | "synthesisBootstrap" | "macro"; status: "start" | "done"; counts?: Record<string, number> }
  // ── Cognition (Wave 2) ──────────────────────────────────────
  // Fired the instant a tier call is dispatched (before the model responds), so a
  // long in-flight generation is visible in real time rather than only surfacing on
  // the completion `tier_call` below. Carries the step so a wedged call is attributable.
  | { type: "tier_call_start"; tier: "hindbrain" | "forebrain" | "conscious"; step: "observe" | "orient" | "decide" | "evaluate" | "diary" | "adjudicate" }
  | { type: "tier_call"; tier: "hindbrain" | "forebrain" | "conscious"; latencyMs: number; outcome: "ok" | "error" | "timeout"; attempt?: number }
  | {
      type: "appraisal"
      disposition: string
      weight?: number
      escalated: boolean
      /** The dominant event's model reason — so distribution QA reads the "why"
       *  off the behavior stream without mining the raw observe exchanges. */
      reason?: string
      /** A compact `type: <first ~80 chars>` summary of the dominant event. */
      summary?: string
      /** True when at least one of this tick's reflexes degraded on a hindbrain
       *  endpoint failure (silently fell back to accumulate). */
      degraded?: boolean
    }
  | { type: "orient"; headline: string }
  | { type: "decision"; disposition: "plan" | "wait" | "terminate" }
  | { type: "step"; phase: "start" | "done" | "salvage"; turn?: number; task?: string }
  | { type: "action"; domain: string; name: string; input?: unknown; result?: unknown }
  // ── Escape hatch ────────────────────────────────────────────
  | { type: "note"; label: string; data?: unknown; severity?: Exclude<LogLevel, "debug"> }
