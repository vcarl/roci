/**
 * Host-side working-memory store (agent-cognition Stage 2, spec §2).
 *
 * players/<name>/me/wm.json — plain JSON on the shared mount — plus the
 * compact human-readable WM.md next to it, re-rendered on EVERY mutation
 * (WM.md is the character's opencode `instructions` file, re-read and
 * injected on every LLM request).
 *
 * Discipline (same as logging/episodes.ts): wm writes must never disturb the
 * tick loop. Every reader/writer here is Effect<..., never, never> —
 * failures are swallowed after a console.error and degrade to empty results.
 * All writes are ATOMIC (write-tmp-then-rename), so a reader never sees a
 * torn file; the in-container CLI does the same on its side.
 *
 * Read surface for later stages: Stage 4's retrospect reads wm.json via
 * `readWm`; Stage 3 shares `mutateWm` and `renderOpenTodoTree`. Discarded and
 * done todos stay retained AS LONG AS their ROOT plan is still open —
 * `persistWm` prunes only fully-settled ROOT plan subtrees (a done root whose
 * subtree holds no open todo, together with its descendants), so in-progress
 * plans keep their full ancestry (done steps included) while completed root
 * plans stop accumulating in wm.json / the injected WM.md.
 */
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import type { PlanStep } from "../core/types.js"
import {
  applyWmMutation,
  emptyWmFile,
  parseWmFile,
  pruneSettledTodos,
  renderWmMarkdown,
  type WmDelta,
  type WmFile,
  type WmMutation,
  type WmTodo,
} from "./wm-core.js"

export const WM_JSON_FILE = "wm.json"
export const WM_MD_FILE = "WM.md"
/** Cap on open-todo lines rendered into the orient/decide prompts (spec §2). */
export const WM_PROMPT_CAP = 20

export function wmJsonPath(char: CharacterConfig): string {
  return path.join(char.dir, WM_JSON_FILE)
}

export function wmMarkdownPath(char: CharacterConfig): string {
  return path.join(char.dir, WM_MD_FILE)
}

// ── Raw IO (private) ─────────────────────────────────────────
/**
 * Atomic write-via-rename. The tmp suffix is pid+random (not pid-only): this
 * file has TWO writers sharing the mount — this host process and the
 * in-container `wm` CLI (wm-cli.ts, same suffix scheme) — and a pid-only
 * suffix is not guaranteed unique across processes/hosts sharing a pid
 * namespace (e.g. a containerized pid 1) or across rapid re-invocations that
 * reuse a pid.
 */
const writeAtomic = async (file: string, text: string): Promise<void> => {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`
  await fsp.writeFile(tmp, text, "utf8")
  await fsp.rename(tmp, file)
}

const loadWm = async (char: CharacterConfig): Promise<WmFile> => {
  try {
    return parseWmFile(await fsp.readFile(wmJsonPath(char), "utf8"))
  } catch {
    return emptyWmFile()
  }
}

/**
 * Full identity for de-duplicating a WmDelta across the in-memory/on-disk
 * union below. Includes text+parent (not just ts+id+op): in the race window,
 * host and CLI can each consume the same nextId and journal two DISTINCT
 * "add tN" deltas at the same second — a narrower key would silently
 * conflate them and drop one from the episode stream.
 */
function deltaKey(d: WmDelta): string {
  return JSON.stringify([d.ts, d.id, d.op, d.text ?? null, d.parent ?? null])
}

/**
 * Union two pendingDeltas arrays by full identity (ts+id+op+text+parent):
 * every delta in `base`, plus any delta in `extra` whose identity isn't
 * already in `base`, appended in `extra`'s order. Exported for direct unit
 * testing (see the "merge helper" tests in wm-store.test.ts).
 */
export function mergePendingDeltas(base: readonly WmDelta[], extra: readonly WmDelta[]): WmDelta[] {
  const seen = new Set(base.map(deltaKey))
  const merged = base.slice()
  for (const d of extra) {
    const key = deltaKey(d)
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(d)
    }
  }
  return merged
}

/**
 * Close the write-time race between this host process's read-modify-write
 * and the in-container `wm` CLI: re-read the on-disk wm.json right before
 * persisting and merge its FULL state into `file`. The CLI persists the
 * ENTIRE file on every mutation (todos+nextId+pendingDeltas, not just the
 * journal — see wm-cli.ts `persist`), so a pendingDeltas-only union would
 * keep the CLI's delta while spreading the host's stale todos/nextId over
 * its todo — leaving an add-delta referencing a nonexistent id and a
 * regressed nextId (future id collision).
 *
 * Merge rules:
 *  - pendingDeltas: union by full identity (ts+id+op+text+parent).
 *  - todos: union by id — ids present only on disk (CLI-added mid-window)
 *    are PRESERVED, appended after the in-memory list; ids present in both
 *    → the in-memory (host-mutated) version wins.
 *  - nextId: max(disk, memory) — never regresses.
 *
 * KNOWN GAP (accepted v1, same spirit as drainWmDeltas's race note): same-id
 * conflicts resolve host-wins, so a CLI `done`/`discard` on a todo the host
 * is concurrently mutating can be overwritten by the host's stale copy, and
 * a CLI discard can be resurrected by a stale host write. No locking is used
 * to close this; the merge guarantees no todo LOSS and no id regression, not
 * last-writer-wins field accuracy — EXCEPT the same-nextId both-mint race:
 * if host and CLI each independently mint a new todo off the same stale
 * nextId, both land under the same id; the union-by-id above keeps only the
 * in-memory (host) todo, so the CLI's twin todo is dropped even though its
 * "add" delta survives (merged into pendingDeltas by full identity) — an
 * orphaned add-delta with no corresponding todo. Exported for direct unit
 * testing.
 */
export async function mergeDiskState(char: CharacterConfig, file: WmFile): Promise<WmFile> {
  const disk = await loadWm(char)
  const memIds = new Set(file.todos.map((t: WmTodo) => t.id))
  return {
    ...file,
    nextId: Math.max(file.nextId, disk.nextId),
    todos: file.todos.concat(disk.todos.filter((t) => !memIds.has(t.id))),
    pendingDeltas: mergePendingDeltas(file.pendingDeltas, disk.pendingDeltas),
  }
}

/**
 * Sanitize `pendingDeltas` at the drain boundary. `parseWmFile` (Task 4)
 * only checks `Array.isArray(raw.pendingDeltas)` before blind-casting its
 * elements to `WmDelta[]` — a hand-edited or torn wm.json can therefore put
 * anything in that array. Drop anything that isn't a well-formed WmDelta
 * rather than passing it into episode records downstream.
 */
function isWellFormedDelta(el: unknown): el is WmDelta {
  if (el === null || typeof el !== "object" || Array.isArray(el)) return false
  const e = el as Record<string, unknown>
  if (e.op !== "add" && e.op !== "done" && e.op !== "discard") return false
  if (typeof e.id !== "string" || e.id.length === 0) return false
  if (e.by !== "agent" && e.by !== "harness") return false
  if (typeof e.ts !== "string") return false
  if (e.op === "add") {
    if (typeof e.text !== "string") return false
    if (!(e.parent === undefined || e.parent === null || typeof e.parent === "string")) return false
  }
  return true
}

/**
 * Persist wm.json AND the WM.md render, both atomically (spec §2 Injection).
 *
 * Fully-settled ROOT plan subtrees are pruned here (pruneSettledTodos) before
 * both writes — this is the single choke-point all write paths funnel through,
 * so a completed root plan is dropped from wm.json AND the injected WM.md the
 * moment its last step settles, instead of accumulating in the agent's every-
 * request context. Only ROOT plans are pruned: a done step under a still-open
 * root is retained, so closePlanTodos's disk re-read still sees it and settles
 * the headline truthfully. wm.json and WM.md render the SAME pruned file.
 */
const persistWm = async (char: CharacterConfig, file: WmFile): Promise<void> => {
  await fsp.mkdir(char.dir, { recursive: true })
  const pruned = pruneSettledTodos(file)
  await writeAtomic(wmJsonPath(char), JSON.stringify(pruned, null, 2))
  await writeAtomic(wmMarkdownPath(char), renderWmMarkdown(pruned))
}

// ── Public surface (never fails) ─────────────────────────────
/** Read the store; a missing or corrupt wm.json degrades to the empty file. */
export const readWm = (char: CharacterConfig): Effect.Effect<WmFile> =>
  Effect.promise(() => loadWm(char))

/**
 * Provision seam: seed wm.json/WM.md if missing, re-render WM.md if present
 * (idempotent — never clobbers existing todos). Called once from
 * provisionImpl before the first tick, so the opencode `instructions` file
 * exists from the very first request.
 */
export const ensureWmFiles = (char: CharacterConfig): Effect.Effect<void> =>
  Effect.promise(async () => {
    try {
      await persistWm(char, await loadWm(char))
    } catch (e) {
      console.error(`[wm] ensure failed for ${char.name}: ${e}`)
    }
  })

/**
 * Apply harness mutations (by:"harness"). Invalid mutations (unknown id,
 * non-open state, bad parent) are skipped with a console.error — e.g. a
 * replan discarding a todo the agent already closed. Returns the deltas that
 * actually applied; the caller records them in the episode stream.
 */
export const mutateWm = (
  char: CharacterConfig,
  mutations: readonly WmMutation[],
): Effect.Effect<WmDelta[]> =>
  Effect.promise(async () => {
    try {
      let file = await loadWm(char)
      const deltas: WmDelta[] = []
      for (const m of mutations) {
        const r = applyWmMutation(file, m, "harness", new Date().toISOString())
        if (r.ok) {
          file = r.file
          deltas.push(r.delta)
        } else {
          console.error(`[wm] harness mutation skipped for ${char.name}: ${r.error}`)
        }
      }
      if (deltas.length > 0) await persistWm(char, await mergeDiskState(char, file))
      return deltas
    } catch (e) {
      console.error(`[wm] mutate failed for ${char.name}: ${e}`)
      return []
    }
  })

export interface WmSeedResult {
  headlineId: string | null
  /**
   * Parallel to the input `steps`. An entry is "" (positional sentinel) when
   * that step's todo-creation failed (applyWmMutation rejected it) — the step
   * still exists in the plan, it just has no wm todo to done/discard against;
   * callers must filter "" out before treating an id as a real todo (see
   * loop.ts's discardPlanOrphans: `planStepTodoIds.filter((id) => id !== "")`).
   */
  stepIds: string[]
  deltas: WmDelta[]
}

/**
 * Decide-time seeding (spec §2): the plan's steps become todos parented under
 * a plan-headline todo, so intent survives replans. Returns the created ids
 * (parallel to `steps`, "" where a step's todo-creation failed — see
 * `WmSeedResult.stepIds`) for the loop's done/discard bookkeeping. On
 * failure: empty result — the plan proceeds regardless.
 */
export const seedWmPlan = (
  char: CharacterConfig,
  headline: string,
  steps: readonly PlanStep[],
): Effect.Effect<WmSeedResult> =>
  Effect.promise(async () => {
    try {
      let file = await loadWm(char)
      const ts = new Date().toISOString()
      const head = applyWmMutation(file, { verb: "todo", text: headline }, "harness", ts)
      if (!head.ok) {
        console.error(`[wm] plan seed failed for ${char.name}: ${head.error}`)
        return { headlineId: null, stepIds: [], deltas: [] }
      }
      file = head.file
      const deltas: WmDelta[] = [head.delta]
      const stepIds: string[] = []
      for (const step of steps) {
        const r = applyWmMutation(
          file,
          { verb: "todo", text: `${step.task}: ${step.goal}`, parent: head.delta.id },
          "harness",
          ts,
        )
        if (r.ok) {
          file = r.file
          stepIds.push(r.delta.id)
          deltas.push(r.delta)
        } else {
          console.error(`[wm] plan step seed skipped for ${char.name}: ${r.error}`)
          stepIds.push("")
        }
      }
      await persistWm(char, await mergeDiskState(char, file))
      return { headlineId: head.delta.id, stepIds, deltas }
    } catch (e) {
      console.error(`[wm] plan seed failed for ${char.name}: ${e}`)
      return { headlineId: null, stepIds: [], deltas: [] }
    }
  })

/**
 * Cross-session orphan sweep (called once at loop entry, before any plan is
 * seeded). At that moment no plan is active, so every OPEN, harness-origin
 * todo is necessarily an orphan seeded by a prior/dead session — the existing
 * in-loop orphan discard (loop.ts discardPlanOrphans) only knows the CURRENT
 * run's plan ids (loop-local lets, reset each run), so a plan seeded by a
 * session that then died leaks its todos open forever, rendered into every
 * orient/decide prompt.
 *
 * Agent-origin todos (created via the `wm` CLI) are deliberate free-standing
 * memory and are NEVER swept — the `origin` field is exactly this harness-vs-
 * agent distinction (a legacy wm.json without the field back-fills to
 * "harness"; no agent-authored todos predate the field in practice).
 *
 * Returns the discard deltas (for the episode stream); best-effort — a wm
 * failure yields [] and the loop proceeds. Never fails.
 */
export const discardDeadPlanTodos = (char: CharacterConfig): Effect.Effect<WmDelta[]> =>
  Effect.promise(async () => {
    try {
      let file = await loadWm(char)
      const ts = new Date().toISOString()
      const deltas: WmDelta[] = []
      const stale = file.todos.filter((t) => t.state === "open" && t.origin === "harness")
      for (const t of stale) {
        const r = applyWmMutation(file, { verb: "discard", id: t.id }, "harness", ts)
        if (r.ok) {
          file = r.file
          deltas.push(r.delta)
        }
      }
      if (deltas.length > 0) await persistWm(char, await mergeDiskState(char, file))
      return deltas
    } catch (e) {
      console.error(`[wm] dead-plan sweep failed for ${char.name}: ${e}`)
      return []
    }
  })

/**
 * Close a plan's todos truthfully when the plan ends (evaluate transition, or
 * a dropped plan at reorient/interrupt/critical). Two-part rule:
 *  - Any still-OPEN step child is discarded (abandoned, not done).
 *  - The headline is settled DONE if ANY of its children ended done — partial
 *    completion still reads as real progress — and DISCARDED only when NONE
 *    did. (Prior behavior keyed off "were there remaining step ids", which
 *    discarded a headline whose every child had actually completed — e.g. a
 *    plan that finished via terminate showed a discarded parent over done
 *    children.) With three states this renders truthfully: a done headline
 *    over a mix of done [x] children and hidden discarded ones.
 *
 * Inspects the on-disk state (so it sees the current step's done, already
 * persisted by the caller's mutateWm). Best-effort; never fails.
 */
export const closePlanTodos = (
  char: CharacterConfig,
  headlineId: string | null,
  stepTodoIds: readonly string[],
): Effect.Effect<WmDelta[]> =>
  Effect.promise(async () => {
    try {
      let file = await loadWm(char)
      const ts = new Date().toISOString()
      const deltas: WmDelta[] = []
      for (const id of stepTodoIds) {
        const t = file.todos.find((x) => x.id === id)
        if (t && t.state === "open") {
          const r = applyWmMutation(file, { verb: "discard", id }, "harness", ts)
          if (r.ok) {
            file = r.file
            deltas.push(r.delta)
          }
        }
      }
      if (headlineId) {
        const head = file.todos.find((x) => x.id === headlineId)
        if (head && head.state === "open") {
          const anyChildDone = file.todos.some((x) => x.parent === headlineId && x.state === "done")
          const r = applyWmMutation(
            file,
            { verb: anyChildDone ? "done" : "discard", id: headlineId },
            "harness",
            ts,
          )
          if (r.ok) {
            file = r.file
            deltas.push(r.delta)
          }
        }
      }
      if (deltas.length > 0) await persistWm(char, await mergeDiskState(char, file))
      return deltas
    } catch (e) {
      console.error(`[wm] plan-close failed for ${char.name}: ${e}`)
      return []
    }
  })

/**
 * Drain the agent-mutation journal (pendingDeltas, appended by the wm CLI)
 * exactly once. The loop attaches the drained deltas to the step-end record's
 * wmDeltas — how CLI mutations reach episodes-transition.jsonl (spec §2).
 *
 * `parseWmFile` only verifies `pendingDeltas` is an array before casting its
 * elements to WmDelta — a hand-edited or torn wm.json can smuggle malformed
 * entries through that cast. Filter with `isWellFormedDelta` here so a
 * corrupt journal degrades by dropping bad entries rather than handing them
 * to the episode log.
 *
 * ACCEPTED RACE WINDOW (v1, not fixed): unlike `mutateWm`/`seedWmPlan`, this
 * function does NOT re-read-and-merge before its rename — draining is
 * defined as emptying the journal, so merging would be self-defeating. If
 * the in-container `wm` CLI appends a delta between this function's read of
 * `file.pendingDeltas` and its `persistWm` rename, that delta is dropped
 * (lost from the episode stream) rather than drained on a later call. No
 * locking is used to close this window; it's accepted as a v1 limitation.
 */
export const drainWmDeltas = (char: CharacterConfig): Effect.Effect<WmDelta[]> =>
  Effect.promise(async () => {
    try {
      let exists = true
      try {
        await fsp.access(wmJsonPath(char))
      } catch {
        exists = false
      }
      if (!exists) return []
      const file = await loadWm(char)
      if (file.pendingDeltas.length === 0) {
        // Reconcile WM.md ⇔ wm.json even with an empty journal. WM.md and
        // wm.json are two SEPARATE non-atomic writes (persistWm / the CLI's
        // persist, wm.json first); if the second (WM.md) write is ever skipped
        // — process killed between the two renames, or an error on the render/
        // rename — wm.json advances while WM.md stays stale, and nothing heals
        // it until the next successful host MUTATION. This drain runs at every
        // step boundary (evaluate + resetPlanState), so re-rendering WM.md from
        // the authoritative wm.json here bounds that staleness to one step.
        // wm.json is untouched (no torn-file risk for a concurrent reader).
        await writeAtomic(wmMarkdownPath(char), renderWmMarkdown(file))
        return []
      }
      const drained = file.pendingDeltas.filter(isWellFormedDelta)
      await persistWm(char, { ...file, pendingDeltas: [] })
      return drained
    } catch (e) {
      console.error(`[wm] drain failed for ${char.name}: ${e}`)
      return []
    }
  })

/**
 * The capped, tree-rendered OPEN list for the orient/decide prompt variables
 * (spec §2). Done todos are omitted (their open descendants still show, un-
 * indented past them); discarded subtrees are hidden entirely.
 */
export function renderOpenTodoTree(file: WmFile, cap: number = WM_PROMPT_CAP): string {
  const byParent = new Map<string | null, WmTodo[]>()
  for (const t of file.todos) {
    const list = byParent.get(t.parent) ?? []
    list.push(t)
    byParent.set(t.parent, list)
  }
  const lines: string[] = []
  const walk = (parent: string | null, depth: number): void => {
    for (const t of byParent.get(parent) ?? []) {
      if (t.state === "discarded") continue
      if (t.state === "open") lines.push(`${"  ".repeat(depth)}- ${t.id} ${t.text}`)
      walk(t.id, t.state === "open" ? depth + 1 : depth)
    }
  }
  walk(null, 0)
  if (lines.length === 0) return "(no open todos)"
  if (lines.length > cap) return [...lines.slice(0, cap), `(+${lines.length - cap} more)`].join("\n")
  return lines.join("\n")
}
