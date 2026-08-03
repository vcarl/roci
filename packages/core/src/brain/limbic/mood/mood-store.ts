/**
 * The character's smoothed EMOTIONAL-STATE vector (design 2026-07-31 §5, job 2).
 *
 * players/<name>/me/mood.json — plain JSON on the shared mount, beside wm.json,
 * whose store this module is the structural sibling of. One number per salience
 * axis saying WHERE THE CHARACTER IS SITTING right now, updated every tick as an
 * exponential moving average over the observe tier's own axis vector:
 *
 *     state[axis] = α · observe_C[axis] + (1 − α) · state[axis]
 *
 * `α` is per character, authored in SALIENCE.md as the dash-less `Volatility:`
 * line (design §2) and read once per run by `buildRunnerConfig`.
 *
 * SMOOTHED, DELIBERATELY. The raw per-tick vector would make recall swing with
 * each appraisal and let one odd observe reshape what the character remembers.
 * Averaged across ticks, recall tracks MOOD rather than STIMULUS — which is what
 * "where the character is sitting emotionally right now" actually means. The
 * cross-tick averaging IS the mechanism, not an optimization of it.
 *
 * EVERY TICK PULLS, including a `discard` tick and a tick with no events at all:
 * an absent reading is a ZERO, not a skip. Skipping quiet ticks would break the
 * mechanism exactly where it matters — a character who had a frightening moment
 * followed by fifty uneventful ones would stay frightened indefinitely, because
 * nothing would ever relax the state back toward neutral. Decay toward baseline
 * is a FEATURE of the moving average, and it only works if the uneventful ticks
 * are allowed to pull.
 *
 * ── Why a file of its own, and specifically not wm.json ──────────────────────
 *
 * wm.json has TWO writers — this host process and the in-container `wm` CLI —
 * and the CLI persists the ENTIRE file on every mutation, reconstructed by
 * `parseWmFile`, which returns a fresh object literal of exactly four fields and
 * carries no unknown top-level key through (`wm-core.ts`). A `mood` field there
 * would be silently erased by the agent's next `wm todo`, every time, with no
 * error and no log. mood.json is HOST-ONLY: no race, no merge protocol, no
 * schema coupling. A `meta` row in longterm.db was the other candidate; it costs
 * a docker exec per tick and a CLI grammar change, so it was rejected too.
 *
 * ── Discipline (same as wm-store.ts / logging/episodes.ts) ───────────────────
 *
 * Mood access must never disturb the tick loop or a recall. Every public effect
 * here is Effect<..., never, never>: failures are swallowed after a
 * console.error and degrade to an empty vector, which makes the situational term
 * inert rather than wrong. Writes are ATOMIC (write-tmp-then-rename) so a reader
 * never sees a torn file.
 *
 * ── Honest caveat ────────────────────────────────────────────────────────────
 *
 * Whether this vector is ever non-empty in a live run is UNPROVEN. Measured at
 * the hindbrain tier, the observe C vector was `{}` on the large majority of
 * samples and non-empty only as a verbatim echo of the prompt's worked examples.
 * An EMA over mostly-`{}` sits at zero, `‖state‖ = 0`, and the situational term
 * is inert by construction. That path is made explicitly correct and explicitly
 * cheap; the file is persisted partly so a QA run can answer the question by
 * reading it rather than by inference.
 */
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import { meDir } from "../../../services/character-paths.js"
import { DEFAULT_VOLATILITY, VOLATILITY_MIN, type AxisSpec } from "../../../core/salience.js"

export const MOOD_JSON_FILE = "mood.json"

/**
 * Components smaller than this are dropped rather than stored.
 *
 * Storage hygiene, not a ranking knob — it lives here rather than at
 * `memory-rank.ts`'s knob site for that reason. Two jobs: it bounds the file
 * (an axis that stops being observed leaves entirely instead of decaying
 * asymptotically forever), and it makes a long-quiet mood decay to exactly `{}`,
 * which is the zero-norm short-circuit `moodMatch` is fastest on. At α = 0.3 a
 * component reaches this floor about 23 ticks (~11 min at the default cadence)
 * after its last observation.
 */
export const MOOD_EPSILON = 1e-4

/** The mood.json shape. `updatedAt` is when the vector last MOVED, not last read. */
export interface MoodFile {
  readonly version: 1
  readonly updatedAt: string
  readonly state: Record<string, number>
}

export function moodJsonPath(char: CharacterConfig): string {
  return path.join(meDir(char), MOOD_JSON_FILE)
}

/**
 * One EMA step, per axis. Pure.
 *
 * Iterates the AXIS LIST rather than the union of the two vectors' keys, and
 * that is what gives three properties at once:
 *  - an absent observation is a ZERO, so quiet ticks decay (see the module doc);
 *  - a key outside the vocabulary can never enter the mood, in either argument;
 *  - an axis retired from PALETTE.md is dropped on the very next tick instead of
 *    decaying for twenty while still diluting `‖state‖`.
 *
 * Clamping is per polarity (design §6): a bipolar palette axis KEEPS ITS SIGN
 * within [-1, +1]; a unipolar drive axis clamps to [0, 1], because a negative
 * "how much did this bear on safety" is meaningless.
 *
 * `alpha` accepts undefined / non-finite and falls back to DEFAULT_VOLATILITY,
 * matching parseVolatility's own fall-through discipline. It is clamped to
 * [VOLATILITY_MIN, 1]: an α of exactly 0 would freeze the vector permanently.
 */
export function updateMood(
  prev: Record<string, number>,
  observed: Record<string, number> | undefined,
  alpha: number | undefined,
  axes: ReadonlyArray<AxisSpec>,
): Record<string, number> {
  const a =
    typeof alpha === "number" && Number.isFinite(alpha)
      ? Math.min(1, Math.max(VOLATILITY_MIN, alpha))
      : DEFAULT_VOLATILITY
  const next: Record<string, number> = {}
  for (const spec of axes) {
    const p = prev[spec.name]
    const prior = typeof p === "number" && Number.isFinite(p) ? p : 0
    const o = observed?.[spec.name]
    const obs = typeof o === "number" && Number.isFinite(o) ? o : 0
    const raw = a * obs + (1 - a) * prior
    const clamped =
      spec.polarity === "bipolar" ? Math.min(1, Math.max(-1, raw)) : Math.min(1, Math.max(0, raw))
    if (Math.abs(clamped) >= MOOD_EPSILON) next[spec.name] = clamped
  }
  return next
}

/** True when two mood vectors differ in any key or value. Pure. */
export function moodChanged(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return true
  for (const k of ka) {
    if (b[k] !== a[k]) return true
  }
  return false
}

// ── Raw IO (private) ─────────────────────────────────────────
/**
 * Atomic write-via-rename, same scheme as wm-store's. The tmp suffix is
 * pid+random even though this file has a single writer: the cost is nil and the
 * invariant ("a reader never sees a torn mood.json") should not depend on
 * remembering that nothing else writes here.
 */
const writeAtomic = async (file: string, text: string): Promise<void> => {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`
  await fsp.writeFile(tmp, text, "utf8")
  await fsp.rename(tmp, file)
}

/**
 * Tolerant parse. Anything that is not a finite number is DROPPED (not coerced),
 * and survivors are clamped to [-1, +1] — the widest legal range, since polarity
 * is not knowable here and was already enforced by `updateMood` at write time.
 */
function parseMoodFile(text: string): Record<string, number> {
  try {
    const raw = JSON.parse(text) as { state?: unknown }
    const state = raw?.state
    if (!state || typeof state !== "object" || Array.isArray(state)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue
      out[k] = Math.min(1, Math.max(-1, v))
    }
    return out
  } catch {
    return {}
  }
}

// ── Public surface (never fails) ─────────────────────────────
/** Read the mood; a missing, torn or wrong-shaped file degrades to `{}`. */
export const readMood = (char: CharacterConfig): Effect.Effect<Record<string, number>> =>
  Effect.promise(async () => {
    try {
      return parseMoodFile(await fsp.readFile(moodJsonPath(char), "utf8"))
    } catch {
      // A missing file is the NORMAL cold-start case, not an incident: no log.
      return {}
    }
  })

/** Persist the mood atomically. Best-effort; never fails. */
export const writeMood = (
  char: CharacterConfig,
  state: Record<string, number>,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    try {
      await fsp.mkdir(meDir(char), { recursive: true })
      const file: MoodFile = { version: 1, updatedAt: new Date().toISOString(), state }
      await writeAtomic(moodJsonPath(char), JSON.stringify(file, null, 2))
    } catch (e) {
      console.error(`[mood] write failed for ${char.name}: ${e}`)
    }
  })

/**
 * One tick of the mood: advance the EMA, persist ONLY if it moved, return the new
 * vector for the caller to carry to the next tick.
 *
 * The write guard is not micro-optimization. In the expected steady state — no
 * producing tier emitting a vector — `updateMood` returns `{}` unchanged forever,
 * so a quiet character never touches disk at all, and `updatedAt` keeps meaning
 * "when the mood last MOVED" instead of "when the loop last ticked".
 */
export const advanceMood = (opts: {
  char: CharacterConfig
  prev: Record<string, number>
  observed: Record<string, number> | undefined
  alpha: number | undefined
  axes: ReadonlyArray<AxisSpec>
}): Effect.Effect<Record<string, number>> =>
  Effect.gen(function* () {
    const next = updateMood(opts.prev, opts.observed, opts.alpha, opts.axes)
    if (moodChanged(opts.prev, next)) yield* writeMood(opts.char, next)
    return next
  })
