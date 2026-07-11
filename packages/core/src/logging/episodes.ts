/**
 * Episode log substrate (agent-cognition Stage 1, spec §1).
 *
 * Two append-only JSONL streams per character under players/<name>/logs/:
 *   - episodes-tool.jsonl        high cadence, low fidelity (one record per OpenCode tool call)
 *   - episodes-transition.jsonl  low cadence, full fidelity (OODA tier calls + step boundaries)
 *
 * Episode writes are logging, not control flow: every writer is
 * Effect<void, never, never> — failures are swallowed after a console.error and
 * can never disturb the tick loop. Writers are a no-op until setEpisodeLogRoot
 * is called (apps/roci/src/cli.ts does this once at startup with PROJECT_ROOT).
 *
 * Module-level per-character context (tick/stepId) mirrors behavior-digest.ts:
 * the cortex loop stamps it; the transport and tier emitters read it.
 */
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import type { Judgment } from "../skills/types.js"

export const ARGS_SUMMARY_MAX = 200
/** Rotation: retain the last N reflection cycles (spec §1 "Rotation"). */
export const EPISODE_RETAIN_CYCLES = 5
export const TOOL_EPISODE_FILE = "episodes-tool.jsonl"
export const TRANSITION_EPISODE_FILE = "episodes-transition.jsonl"

/** One record per OpenCode tool call. Full tool responses are never stored. */
export interface ToolEpisode {
  ts: string
  tick: number | null
  stepId: string | null
  tool: string
  /** JSON of the tool input, truncated to ARGS_SUMMARY_MAX chars. */
  argsSummary: string
  /** Terminal tool state, e.g. "completed" | "error". */
  status: string
  durationMs: number | null
}

/** One record per OODA tier call: full rendered prompt + parsed output. */
export interface TierTransitionEpisode {
  type: "tier"
  ts: string
  tick: number | null
  stepId: string | null
  phase: "orient" | "decide" | "evaluate" | "diary"
  /**
   * Only meaningful for phase "orient": which orient this was. The idle/plan
   * path (produces a plan) and the in-session steer path (produces a directive,
   * not a plan) both run through the same forebrain tap, so without this
   * discriminator a consumer cannot tell them apart. Absent on decide/evaluate/
   * diary records and on older records written before this field existed.
   */
  orientKind?: "plan" | "steer"
  /**
   * The run epoch that produced this record (stamped by the emitTier tap once a
   * run has begun; absent on older records and on tier calls outside a cortex
   * run). This stamp is what makes the run-start epoch scan self-enforcing:
   * tier records are the only BULKY transition records (multi-KB prompts), so
   * any volume of traffic that could bury older stepId evidence beyond the scan
   * window is itself made of epoch-stamped records — the tail window always
   * contains the current epoch, regardless of the traffic mix.
   */
  epoch?: string
  prompt: string
  output: unknown
}

/**
 * Step boundary records. `skill` (worn skill, spec §3) and `wmDeltas`
 * (working-memory deltas, spec §2) exist NOW for schema stability; Stage 1
 * always writes them as null — Stages 2/3 populate them.
 */
export interface StepBoundaryEpisode {
  type: "step-start" | "step-end"
  ts: string
  tick: number
  stepId: string
  task: string
  goal: string
  /** step-end only: the evaluate verdict. */
  verdict?: Judgment
  /** step-end only: the evaluate transition. */
  transition?: "next_step" | "replan" | "wait" | "terminate"
  skill: string | null
  wmDeltas: unknown[] | null
}

/**
 * Working-memory mutation record (Stage 2, spec §2: "All wm mutations are also
 * recorded in episodes-transition.jsonl"). Carries harness mutations that
 * happen OUTSIDE an in-flight step window (decide-time plan seeding; orphan
 * discards with no open step). Mutations DURING a step ride the step-end
 * record's `wmDeltas` instead — drained from the CLI's pendingDeltas journal
 * plus the harness's own end-of-step mutations — so one boundary record tells
 * the whole step's wm story. `deltas` is `unknown[]` for the same reason
 * StepBoundaryEpisode.wmDeltas is: the logging substrate stays import-free of
 * conscious/ modules; the concrete shape is wm-core's WmDelta.
 */
export interface WmTransitionEpisode {
  type: "wm"
  ts: string
  tick: number | null
  stepId: string | null
  deltas: unknown[]
}

/** Marks the end of one reflection cycle in both streams (rotation unit). */
export interface CycleBoundaryEpisode {
  type: "cycle-boundary"
  ts: string
}

export type TransitionEpisode =
  | TierTransitionEpisode
  | StepBoundaryEpisode
  | WmTransitionEpisode
  | CycleBoundaryEpisode

// ── Root config ──────────────────────────────────────────────
let episodeRoot: string | null = null

/** Enable episode writes rooted at `root` (the harness project root); null disables. */
export function setEpisodeLogRoot(root: string | null): void {
  episodeRoot = root
}

function logsDir(root: string, character: string): string {
  return path.resolve(root, "players", character, "logs")
}

// ── Per-character tick/step context ──────────────────────────
export interface EpisodeContext {
  tick: number | null
  stepId: string | null
}

const contexts = new Map<string, EpisodeContext>()

/**
 * Per-character RUN epoch (data-integrity fix). `tick` restarts at 0 on every
 * runCortex invocation, so a stepId of `s<tick>-<step>` collided unrelated
 * steps ACROSS SESSIONS within the retained multi-cycle window (`s1-0` seen
 * 23× in one day's episodes-transition.jsonl): the streams are append-mode
 * across process restarts and rotation is by CYCLE count, not by session, so
 * the retained window routinely spans restarts. The epoch prefixes the stepId
 * (`c<epoch>-s<tick>-<step>`) and must therefore be unique across restarts
 * too — an in-memory counter alone would restart at 1 in every new process
 * and re-collide exactly like the old ids.
 *
 * beginEpisodeEpoch derives the next epoch FROM THE DATA ITSELF: a bounded
 * tail-scan of both episode streams for the max numeric epoch already recorded
 * — cited in a `"stepId":"c<n>-s..."` field OR stamped as the `"epoch"` field
 * every tier record carries (see TierTransitionEpisode.epoch) — continued at
 * n+1. Deriving from the file (rather than a side-car counter) is self-healing:
 * the counter can never disagree with the retained records — if the logs are
 * deleted, the old ids are gone with them and restarting at 1 is CORRECT,
 * where a surviving/lost counter file would silently collide. If the scan
 * itself errors, fail to a TIMESTAMP epoch (`t<ms-base36>`, disjoint from
 * every numeric epoch) — never to a low counter, which would reintroduce
 * silent collisions.
 *
 * `lastEpochs` is a small in-process monotonic guard on top of the scan: it
 * keeps same-process runs strictly increasing even if a run minted ids whose
 * appends were all swallowed (so the scan can't see them).
 */
const lastEpochs = new Map<string, number>()

/** The epoch each character's current run was issued (for record stamping). */
const issuedEpochs = new Map<string, string>()

/** Tail-scan I/O budget per stream — a read-size bound, NOT a correctness
 * assumption. Correctness does not depend on where in the file the max-epoch
 * record sits: every tier record carries an `epoch` stamp, and tier records
 * (multi-KB prompts) are the only records bulky enough to push anything beyond
 * this window — so whatever fills the tail carries the current epoch itself.
 * The files are rotation-bounded anyway; this just caps a pathological
 * unrotated file. */
export const EPOCH_SCAN_MAX_BYTES = 512 * 1024

/** What a stream's tail window says about prior epochs. */
interface EpochEvidence {
  /** Max numeric epoch cited in a stepId or stamped in an epoch field; 0 if none. */
  max: number
  /** A timestamp (`t…`) epoch was stamped/cited — numeric history may lie beneath it. */
  sawTimestamp: boolean
}

/**
 * Scan the file's tail for epoch evidence: `"stepId":"c<n>-s..."` cites and
 * `"epoch":"<n>"` stamps (numeric), plus whether any timestamp (`t…`) epoch
 * appears. Returns zero-evidence when the file does not exist; THROWS on any
 * other I/O error (the caller falls back to a timestamp epoch).
 *
 * False-positive notes: both fields quoted inside a tier record's `prompt`
 * string are JSON-escaped (`\"stepId\":...`) and cannot match. A tier record's
 * `output` is a nested (unescaped) object, so a model output containing a
 * numeric `"epoch"` field COULD match — that only ever bumps the counter
 * upward, which preserves uniqueness (monotonic); it can never cause a re-mint.
 */
function scanEpochEvidence(file: string): EpochEvidence {
  let fd: number
  try {
    fd = fs.openSync(file, "r")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { max: 0, sawTimestamp: false }
    throw e
  }
  try {
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, EPOCH_SCAN_MAX_BYTES)
    if (len === 0) return { max: 0, sawTimestamp: false }
    const buf = Buffer.alloc(len)
    // Guard the short read: only decode what was actually read.
    const bytesRead = fs.readSync(fd, buf, 0, len, size - len)
    const text = buf.toString("utf8", 0, bytesRead)
    let max = 0
    for (const m of text.matchAll(/"stepId":"c(\d+)-s|"epoch":"(\d+)"/g)) {
      const n = Number(m[1] ?? m[2])
      if (Number.isSafeInteger(n) && n > max) max = n
    }
    const sawTimestamp = /"stepId":"ct[0-9a-z]+-s|"epoch":"t[0-9a-z]+"/.test(text)
    return { max, sawTimestamp }
  } finally {
    fs.closeSync(fd)
  }
}

export function episodeContext(character: string): EpisodeContext {
  return contexts.get(character) ?? { tick: null, stepId: null }
}

export function setEpisodeTick(character: string, tick: number): void {
  contexts.set(character, { ...episodeContext(character), tick })
}

export function setEpisodeStep(character: string, stepId: string | null): void {
  contexts.set(character, { ...episodeContext(character), stepId })
}

/**
 * Start a new cortex-run epoch: clear the (tick/stepId) context so a prior
 * run's dangling stepId can't bleed into this run's first records (subsumes
 * the old resetEpisodeContext call at loop entry), then issue an epoch that is
 * unique across the whole retained window INCLUDING process restarts — see the
 * module comment above for the derivation (disk tail-scan, in-process guard,
 * timestamp fallback). Sync by design: one bounded read per run start, before
 * the tick loop begins. With no episode root configured nothing is ever
 * persisted, so the in-process counter alone suffices.
 */
export function beginEpisodeEpoch(character: string): string {
  contexts.set(character, { tick: null, stepId: null })
  const issue = (epoch: string): string => {
    issuedEpochs.set(character, epoch)
    return epoch
  }
  const timestampEpoch = () => `t${Date.now().toString(36)}`
  const root = episodeRoot
  let onDisk = 0
  let sawTimestamp = false
  if (root !== null) {
    try {
      const dir = logsDir(root, character)
      const transition = scanEpochEvidence(path.join(dir, TRANSITION_EPISODE_FILE))
      const tool = scanEpochEvidence(path.join(dir, TOOL_EPISODE_FILE))
      onDisk = Math.max(transition.max, tool.max)
      sawTimestamp = transition.sawTimestamp || tool.sawTimestamp
    } catch (e) {
      // Fail to a TIMESTAMP epoch, never to a low counter: ms-since-epoch in
      // base36, `t`-prefixed so it is disjoint from every numeric epoch. Loud —
      // a scan failure is diagnosable, and the ids stay collision-free.
      const fallback = timestampEpoch()
      console.error(
        `[episodes] epoch scan failed for ${character}: ${e}; using timestamp epoch ${fallback}`,
      )
      return issue(fallback)
    }
    if (onDisk === 0 && sawTimestamp && !lastEpochs.has(character)) {
      // Fail closed: the window shows a prior timestamp-epoch run but NO
      // numeric evidence and this process has no numeric baseline — numeric
      // history may be buried beneath the t-run's records, so restarting the
      // counter at 1 could silently collide. Issue another t-epoch instead
      // (ids stay unique; the counter resumes once numeric evidence is back
      // in the window or the t-records rotate out).
      return issue(timestampEpoch())
    }
  }
  const next = Math.max(onDisk, lastEpochs.get(character) ?? 0) + 1
  lastEpochs.set(character, next)
  return issue(String(next))
}

/**
 * The epoch the character's current run was issued (null before any run, or
 * after a reset). Record emitters read this to stamp `epoch` on tier records —
 * the stamp that keeps the run-start scan self-enforcing (see
 * TierTransitionEpisode.epoch).
 */
export function currentEpisodeEpoch(character: string): string | null {
  return issuedEpochs.get(character) ?? null
}

/** A fork-time snapshot of the episode attribution, so a deliberation forked at
 *  tick N stamps its tier records with N's attribution even if it completes at N+k. */
export interface EpisodeAttribution {
  tick: number | null
  stepId: string | null
  epoch: string | null
}

/** Capture the current (tick/stepId/epoch) attribution at fork time. */
export function captureEpisodeAttribution(character: string): EpisodeAttribution {
  const ctx = episodeContext(character)
  return { tick: ctx.tick, stepId: ctx.stepId, epoch: currentEpisodeEpoch(character) }
}

/**
 * Compose a stepId unique across the retained window: `c<epoch>-s<tick>-<step>`.
 * The run epoch guards against `tick` restarting at 0 each run (the collision
 * source). Human-readable + citable, so models can anchor evidence on it.
 */
export function mintStepId(epoch: string, tick: number, stepIndex: number): string {
  return `c${epoch}-s${tick}-${stepIndex}`
}

/** Test/lifecycle full reset — clears the context AND the in-process epoch
 * state (models a process restart in tests; the on-disk scan still provides
 * cross-restart uniqueness). */
export function resetEpisodeContext(character: string): void {
  contexts.delete(character)
  lastEpochs.delete(character)
  issuedEpochs.delete(character)
}

// ── Record helpers ───────────────────────────────────────────
/** Compact-JSON a tool input, truncated to ARGS_SUMMARY_MAX chars. Never throws. */
export function summarizeArgs(input: unknown): string {
  let s: string
  try {
    s = JSON.stringify(input) ?? String(input)
  } catch {
    s = "[unserializable args]"
  }
  return s.length <= ARGS_SUMMARY_MAX ? s : `${s.slice(0, ARGS_SUMMARY_MAX)}…`
}

// ── Append writers (swallow-and-log; never fail) ─────────────
const append = (character: string, file: string, record: unknown): Effect.Effect<void> => {
  const root = episodeRoot
  if (root === null) return Effect.void
  return Effect.tryPromise({
    try: async () => {
      const line = `${JSON.stringify(record)}\n`
      const dir = logsDir(root, character)
      await fsp.mkdir(dir, { recursive: true })
      await fsp.appendFile(path.join(dir, file), line, "utf8")
    },
    catch: (e) => e,
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => console.error(`[episodes] append to ${file} failed for ${character}: ${e}`)),
    ),
  )
}

export const appendToolEpisode = (character: string, record: ToolEpisode): Effect.Effect<void> =>
  append(character, TOOL_EPISODE_FILE, record)

export const appendTransitionEpisode = (
  character: string,
  record: TransitionEpisode,
): Effect.Effect<void> => append(character, TRANSITION_EPISODE_FILE, record)

// ── Named transition-record writers (composite assembly) ─────
// The cortex loop used to hand-assemble these three transition records inline
// (the `type`/`ts`/`stepId` framing plus the `wmDeltas` empty→null guard). They
// live here with the substrate that owns their shape, so the loop calls a named
// writer instead of building the object literal. Same swallow-and-log discipline
// as appendTransitionEpisode — never fails.

/**
 * A `type:"wm"` transition record for harness deltas that occur OUTSIDE an
 * in-flight step window (decide-time seeding; orphan discards with no open
 * step). Empty deltas are a no-op. `stepId` is read from the current episode
 * context. (Was the loop's inline `emitWmRecord`.)
 */
export const appendWmDeltas = (
  character: string,
  tick: number,
  deltas: readonly unknown[],
): Effect.Effect<void> =>
  deltas.length === 0
    ? Effect.void
    : appendTransitionEpisode(character, {
        type: "wm",
        ts: new Date().toISOString(),
        tick,
        stepId: episodeContext(character).stepId,
        deltas: [...deltas],
      })

/** A `type:"step-start"` boundary record (turn-1 open; wmDeltas always null). */
export const appendStepStart = (
  character: string,
  r: { tick: number; stepId: string; task: string; goal: string; skill: string | null },
): Effect.Effect<void> =>
  appendTransitionEpisode(character, {
    type: "step-start",
    ts: new Date().toISOString(),
    tick: r.tick,
    stepId: r.stepId,
    task: r.task,
    goal: r.goal,
    skill: r.skill,
    wmDeltas: null,
  })

/**
 * A `type:"step-end"` boundary record. `verdict` is omitted on the reorient/
 * interrupt replan close (nothing was evaluated); present on the 6a evaluate
 * path. Owns the `wmDeltas` empty→null guard the loop applied at both sites.
 */
export const appendStepEnd = (
  character: string,
  r: {
    tick: number
    stepId: string
    task: string
    goal: string
    verdict?: Judgment
    transition: "next_step" | "replan" | "wait" | "terminate"
    skill: string | null
    wmDeltas: unknown[] | null
  },
): Effect.Effect<void> =>
  appendTransitionEpisode(character, {
    type: "step-end",
    ts: new Date().toISOString(),
    tick: r.tick,
    stepId: r.stepId,
    task: r.task,
    goal: r.goal,
    verdict: r.verdict,
    transition: r.transition,
    skill: r.skill,
    wmDeltas: r.wmDeltas && r.wmDeltas.length > 0 ? r.wmDeltas : null,
  })

// ── Rotation: retain the last N reflection cycles ────────────
function lineType(line: string): string | undefined {
  try {
    const rec = JSON.parse(line) as { type?: unknown }
    return typeof rec?.type === "string" ? rec.type : undefined
  } catch {
    return undefined
  }
}

/**
 * Pure. A cycle is the lines up to and including its `cycle-boundary` marker.
 * Keeps the last `retain` completed cycles (boundaries included) plus the
 * in-progress tail — drops only whole cycles, never a partial one.
 */
export function retainLastCycles(lines: readonly string[], retain: number): string[] {
  const boundaries: number[] = []
  lines.forEach((line, i) => {
    if (lineType(line) === "cycle-boundary") boundaries.push(i)
  })
  if (boundaries.length <= retain) return [...lines]
  const cut = boundaries[boundaries.length - retain - 1]
  return lines.slice(cut + 1)
}

/**
 * Pure. The lines of the current (not-yet-closed) reflection cycle: everything
 * AFTER the last `cycle-boundary` marker, or all lines if none. The meso
 * retrospect runs BEFORE finishEpisodeCycle appends this cycle's boundary, so
 * this is exactly the just-ended cycle's records.
 */
export function sliceCurrentCycle(lines: readonly string[]): string[] {
  let last = -1
  lines.forEach((line, i) => {
    if (lineType(line) === "cycle-boundary") last = i
  })
  return lines.slice(last + 1)
}

async function readCurrentStream<T>(root: string, character: string, file: string): Promise<T[]> {
  try {
    const text = await fsp.readFile(path.join(logsDir(root, character), file), "utf8")
    const lines = text.split("\n").filter((l) => l.trim().length > 0)
    const out: T[] = []
    for (const line of sliceCurrentCycle(lines)) {
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        // drop a torn/garbled line, keep the rest
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Read the just-ended cycle's records from both streams (for the meso
 * retrospect, spec §4). Never fails: an unset root or a missing file degrades to
 * empty arrays. Reads only the current cycle (past the last boundary), so it is
 * safe to call right before finishEpisodeCycle's rotation.
 */
export const readCurrentCycleEpisodes = (
  character: string,
): Effect.Effect<{ tool: ToolEpisode[]; transition: TransitionEpisode[] }> => {
  const root = episodeRoot
  if (root === null) return Effect.succeed({ tool: [], transition: [] })
  return Effect.promise(async () => ({
    tool: await readCurrentStream<ToolEpisode>(root, character, TOOL_EPISODE_FILE),
    transition: await readCurrentStream<TransitionEpisode>(root, character, TRANSITION_EPISODE_FILE),
  }))
}

/**
 * Close the current reflection cycle: append a cycle-boundary marker to both
 * episode streams, then rotate each to the last EPISODE_RETAIN_CYCLES cycles
 * (write-to-tmp + rename, so a concurrent reader never sees a torn file).
 * Swallow-and-log: a rotation failure must never disturb reflection.
 *
 * Per-file isolation (deferred Stage-1 fix): each stream gets its own
 * try/catch so one stream's I/O failure cannot skip the other's boundary or
 * rotation. Stale `.tmp` files from a previously crashed rotation are removed
 * up front, and a failed rotation cleans up its own `.tmp`.
 */
export const finishEpisodeCycle = (character: string): Effect.Effect<void> => {
  const root = episodeRoot
  if (root === null) return Effect.void
  return Effect.promise(async () => {
    const boundary: CycleBoundaryEpisode = { type: "cycle-boundary", ts: new Date().toISOString() }
    const line = `${JSON.stringify(boundary)}\n`
    const dir = logsDir(root, character)
    try {
      await fsp.mkdir(dir, { recursive: true })
    } catch (e) {
      console.error(`[episodes] cycle rotation failed for ${character}: ${e}`)
      return
    }
    for (const file of [TOOL_EPISODE_FILE, TRANSITION_EPISODE_FILE]) {
      const filePath = path.join(dir, file)
      const tmp = `${filePath}.tmp`
      try {
        await fsp.rm(tmp, { force: true }) // stale orphan from a crashed rotation
        await fsp.appendFile(filePath, line, "utf8")
        const text = await fsp.readFile(filePath, "utf8")
        const lines = text.split("\n").filter((l) => l.trim().length > 0)
        const kept = retainLastCycles(lines, EPISODE_RETAIN_CYCLES)
        if (kept.length < lines.length) {
          await fsp.writeFile(tmp, kept.map((l) => `${l}\n`).join(""), "utf8")
          await fsp.rename(tmp, filePath)
        }
      } catch (e) {
        console.error(`[episodes] cycle rotation failed for ${character} (${file}): ${e}`)
        await fsp.rm(tmp, { force: true }).catch(() => {})
      }
    }
  })
}
