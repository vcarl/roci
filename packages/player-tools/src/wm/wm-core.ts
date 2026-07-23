/**
 * Working-memory core (agent-cognition Stage 2, spec §2): types, the todo
 * state machine, the tolerant wm.json parser, and the WM.md render.
 *
 * This is the single source for both runtimes: the in-container `wm` CLI
 * (`src/wm/main.ts` → the bundled artifact) calls these functions DIRECTLY, and
 * the host (`@roci/core`'s wm-store.ts) imports them too — one tested state
 * machine, no drift. (Historical note: the CLI used to embed these bodies via
 * `Function.prototype.toString()`, which is why the module stays import-free;
 * that mechanism was retired in favor of bundling — see package-design spec §1b.)
 *
 * States: open | done | discarded. Discarded = retained, not done, not in
 * progress, excluded from active renders, visible to retrospectives (spec §2).
 */

export type WmState = "open" | "done" | "discarded"

export interface WmTodo {
  id: string
  text: string
  parent: string | null
  state: WmState
  /**
   * Provenance of the todo, stamped from the mutation's `by` at creation:
   * "harness" = seeded by the cortex loop for a plan (headline + step
   * children); "agent" = created by the in-container `wm` CLI as deliberate
   * free-standing memory. Used by the cross-session orphan sweep to discard
   * plan todos abandoned by a dead session while preserving agent memory.
   * A wm.json predating this field back-fills to "harness" (parseWmFile) —
   * every pre-existing todo in practice was harness-seeded.
   */
  origin: "agent" | "harness"
  createdAt: string
  updatedAt: string
}

/** One recorded mutation. `by` distinguishes agent (CLI) from harness writes. */
export interface WmDelta {
  op: "add" | "done" | "discard"
  id: string
  /** op "add" only. */
  text?: string
  /** op "add" only. */
  parent?: string | null
  by: "agent" | "harness"
  ts: string
}

/**
 * The wm.json shape. `pendingDeltas` is the agent-mutation journal: the CLI
 * appends its delta on every mutation; the harness drains the journal into
 * episodes-transition.jsonl at step boundaries (spec §2 "All wm mutations are
 * also recorded in episodes-transition.jsonl").
 */
export interface WmFile {
  version: 1
  nextId: number
  todos: WmTodo[]
  pendingDeltas: WmDelta[]
}

export type WmMutation =
  | { verb: "todo"; text: string; parent?: string | null }
  | { verb: "done"; id: string }
  | { verb: "discard"; id: string }

export type WmApplyResult =
  | { ok: true; file: WmFile; delta: WmDelta }
  | { ok: false; error: string }

export function emptyWmFile(): WmFile {
  return { version: 1, nextId: 1, todos: [], pendingDeltas: [] }
}

/**
 * Tolerant parser: malformed/torn/hand-edited input degrades to the empty
 * file, or to a salvaged subset of it — it must NEVER throw and NEVER hang.
 *
 * Sanitization (defense against a hand-edited or partially-written wm.json):
 *  - Each todos[] element must be a well-formed object (string id, string
 *    text, parent null-or-string, state in open|done|discarded, string
 *    createdAt/updatedAt); anything else (null, primitive, missing/wrong
 *    field types) is dropped.
 *  - Duplicate ids: first occurrence wins, later ones are dropped. This also
 *    breaks any self-referential chain formed *through* a duplicate id
 *    (walk() below still carries a visited-set as defense-in-depth).
 *  - Dangling parent (references an id not present among the kept todos):
 *    the todo is KEPT but reparented to root (parent -> null). Conservative
 *    salvage — we favor never losing a recorded todo over preserving a
 *    parent link that no longer resolves.
 *  - nextId: trusted only if it's an integer >= 1; otherwise recomputed as
 *    1 + the max numeric suffix found among the kept ids (min 1).
 */
export function parseWmFile(text: string): WmFile {
  function isWellFormedTodo(el: unknown): el is WmTodo {
    if (el === null || typeof el !== "object" || Array.isArray(el)) return false
    const e = el as Record<string, unknown>
    if (typeof e.id !== "string" || e.id.length === 0) return false
    if (typeof e.text !== "string") return false
    if (!(e.parent === null || typeof e.parent === "string")) return false
    if (e.state !== "open" && e.state !== "done" && e.state !== "discarded") return false
    if (typeof e.createdAt !== "string") return false
    if (typeof e.updatedAt !== "string") return false
    return true
  }
  try {
    const raw = JSON.parse(text) as { nextId?: unknown; todos?: unknown; pendingDeltas?: unknown }
    if (raw && typeof raw === "object" && Array.isArray(raw.todos)) {
      const seenIds = new Set<string>()
      const kept: WmTodo[] = []
      for (const el of raw.todos) {
        if (!isWellFormedTodo(el)) continue
        if (seenIds.has(el.id)) continue
        seenIds.add(el.id)
        kept.push(el)
      }
      const keptIds = new Set(kept.map(function (t) { return t.id }))
      const todos = kept.map(function (t) {
        // Normalize provenance and parent in one pass. A todo written before
        // `origin` existed (or with a junk value) back-fills to "harness":
        // every pre-existing todo in practice was harness-seeded, and the
        // orphan sweep treats "not-agent" as harness anyway.
        const origin: "agent" | "harness" = (t as WmTodo).origin === "agent" ? "agent" : "harness"
        const parent = t.parent !== null && !keptIds.has(t.parent) ? null : t.parent
        return { ...t, parent: parent, origin: origin }
      })
      let nextId: number
      if (typeof raw.nextId === "number" && Number.isInteger(raw.nextId) && raw.nextId >= 1) {
        nextId = raw.nextId
      } else {
        let maxSuffix = 0
        for (const t of todos) {
          const m = /(\d+)$/.exec(t.id)
          if (m) {
            const n = parseInt(m[1], 10)
            if (n > maxSuffix) maxSuffix = n
          }
        }
        nextId = maxSuffix + 1
      }
      return {
        version: 1,
        nextId: nextId,
        todos: todos,
        pendingDeltas: Array.isArray(raw.pendingDeltas) ? (raw.pendingDeltas as WmDelta[]) : [],
      }
    }
  } catch {
    // fall through — a malformed file must never wedge the CLI or the loop
  }
  return { version: 1, nextId: 1, todos: [], pendingDeltas: [] }
}

/**
 * Pure state machine. `ts` is injected (no clock) so host and CLI callers
 * stamp their own time. Transitions: open→done, open→discarded; everything
 * else is rejected with a message. Returns a NEW file (input untouched) plus
 * the delta describing the mutation; the caller decides where the delta goes
 * (CLI → pendingDeltas journal; harness → episode record directly).
 */
export function applyWmMutation(
  file: WmFile,
  mutation: WmMutation,
  by: "agent" | "harness",
  ts: string,
): WmApplyResult {
  if (mutation.verb === "todo") {
    const text = (mutation.text || "").trim()
    if (!text) return { ok: false, error: "todo text must be non-empty" }
    const parent = mutation.parent == null ? null : mutation.parent
    if (parent !== null) {
      const p = file.todos.find(function (t) { return t.id === parent })
      if (!p) return { ok: false, error: "parent not found: " + parent }
      if (p.state === "discarded") return { ok: false, error: "parent is discarded: " + parent }
    }
    const id = "t" + file.nextId
    const todo: WmTodo = { id: id, text: text, parent: parent, state: "open", origin: by, createdAt: ts, updatedAt: ts }
    return {
      ok: true,
      file: {
        version: 1,
        nextId: file.nextId + 1,
        todos: file.todos.concat([todo]),
        pendingDeltas: file.pendingDeltas,
      },
      delta: { op: "add", id: id, text: text, parent: parent, by: by, ts: ts },
    }
  }
  const target = file.todos.find(function (t) { return t.id === mutation.id })
  if (!target) return { ok: false, error: "no such todo: " + mutation.id }
  if (target.state !== "open") return { ok: false, error: "todo " + mutation.id + " is already " + target.state }
  const state: WmState = mutation.verb === "done" ? "done" : "discarded"
  const todos = file.todos.map(function (t) {
    return t.id === mutation.id ? { ...t, state: state, updatedAt: ts } : t
  })
  return {
    ok: true,
    file: { version: 1, nextId: file.nextId, todos: todos, pendingDeltas: file.pendingDeltas },
    delta: { op: mutation.verb === "done" ? "done" : "discard", id: mutation.id, by: by, ts: ts },
  }
}

/**
 * Prune fully-settled ROOT plans so completed work stops accumulating in
 * wm.json / WM.md (WM.md is injected into the in-container agent's context on
 * EVERY request — retained done plans would flood that context indefinitely).
 *
 * ROOT-ONLY rule: for each ROOT todo r (parent === null), if r.state === "done"
 * AND r's subtree (r plus all transitive descendants) contains NO todo with
 * state === "open", remove r and its ENTIRE subtree. Otherwise keep r and its
 * whole subtree untouched.
 *
 * A non-root done node is NEVER independently removed — it disappears only when
 * its settled done ROOT is pruned. So a done step under a still-open root plan
 * is RETAINED: this is deliberate, because closePlanTodos re-reads the on-disk
 * wm.json to weigh a plan headline (a done child must still be visible for it
 * to settle the headline "done" over partial completion). Pruning individual
 * done steps would erase that evidence and mis-settle the headline.
 *
 * Pure: returns a NEW file with a filtered todos array; input untouched.
 * nextId is preserved verbatim (monotonic — never derived from todos.length);
 * pendingDeltas is passed through unchanged. Self-contained per the EMBEDDING
 * CONTRACT: no references outside this function beyond the WmFile/WmTodo types.
 */
export function pruneSettledTodos(file: WmFile): WmFile {
  const childrenOf: Record<string, WmTodo[]> = {}
  for (const t of file.todos) {
    const key = t.parent === null ? "" : t.parent
    if (!childrenOf[key]) childrenOf[key] = []
    childrenOf[key].push(t)
  }
  // Collect a subtree's ids (inclusive) and whether it holds any open todo, in
  // one walk. A visited-set guards against a corrupt/cyclic parent graph
  // (defense-in-depth, same rationale as renderWmMarkdown's walk).
  const collect = function (id: string, state: WmState, ids: string[], visited: Set<string>): boolean {
    if (visited.has(id)) return false
    visited.add(id)
    ids.push(id)
    let hasOpen = state === "open"
    const kids = childrenOf[id] || []
    for (const c of kids) {
      if (collect(c.id, c.state, ids, visited)) hasOpen = true
    }
    return hasOpen
  }
  // Only ROOT plans (parent === null) are eligible; a settled done root drops
  // its whole subtree, everything else is kept verbatim.
  const removed = new Set<string>()
  for (const r of childrenOf[""] || []) {
    if (r.state !== "done") continue
    const ids: string[] = []
    const hasOpen = collect(r.id, r.state, ids, new Set<string>())
    if (!hasOpen) for (const id of ids) removed.add(id)
  }
  const todos = file.todos.filter(function (t) { return !removed.has(t.id) })
  return { version: 1, nextId: file.nextId, todos: todos, pendingDeltas: file.pendingDeltas }
}

/**
 * Compact human-readable view: ids + tree + states. Discarded nodes hide
 * their whole subtree from the active render (retained in wm.json; visible to
 * retrospectives). Open = "[ ]", done = "[x]".
 */
export function renderWmMarkdown(file: WmFile): string {
  const byParent: Record<string, WmTodo[]> = {}
  for (const t of file.todos) {
    const key = t.parent === null ? "" : t.parent
    if (!byParent[key]) byParent[key] = []
    byParent[key].push(t)
  }
  const lines: string[] = ["# Working memory", ""]
  const before = lines.length
  // visited: defense-in-depth against a corrupt/cyclic parent graph slipping
  // past parseWmFile's sanitization — without it, a cycle reachable from root
  // would recurse unboundedly (stack overflow) instead of degrading tolerantly.
  const visited = new Set<string>()
  const walk = function (parentKey: string, depth: number): void {
    const children = byParent[parentKey] || []
    for (const t of children) {
      if (visited.has(t.id)) continue
      visited.add(t.id)
      if (t.state === "discarded") continue
      const box = t.state === "done" ? "[x]" : "[ ]"
      // Render-only sanitization: WM.md is injected into the opencode system
      // prompt and re-read on EVERY LLM request, and todo text can originate
      // from harness-seeded (decide-model) output — treat as untrusted.
      // Collapse interior control chars/newlines to a single space so a todo
      // like "x\n## SYSTEM: ..." can't smuggle an extra markdown line into
      // the prompt, and cap the rendered length so one long todo can't bloat
      // every request. The STORED text (wm.json) is untouched — only this
      // render sanitizes.
      const collapsed = t.text.replace(/[\x00-\x1F\x7F-\x9F\u2028\u2029]+/g, " ")
      const capped = collapsed.length > 200 ? collapsed.slice(0, 200) + "…" : collapsed
      lines.push("  ".repeat(depth) + "- " + box + " " + t.id + " " + capped)
      walk(t.id, depth + 1)
    }
  }
  walk("", 0)
  if (lines.length === before) lines.push("(no todos)")
  return lines.join("\n") + "\n"
}
