import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import { meDir } from "../../../services/character-paths.js"
import { applyWmMutation, emptyWmFile, parseWmFile, type WmTodo } from "@roci/player-tools/wm-core"
import {
  WM_PROMPT_CAP,
  wmJsonPath,
  wmMarkdownPath,
  readWm,
  ensureWmFiles,
  mutateWm,
  seedWmPlan,
  drainWmDeltas,
  discardDeadPlanTodos,
  closePlanTodos,
  renderOpenTodoTree,
  mergePendingDeltas,
  mergeDiskState,
} from "./wm-store.js"
import type { WmDelta } from "@roci/player-tools/wm-core"

let root: string
let char: CharacterConfig
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-store-"))
  char = { name: "ada", root: path.join(root, "players", "ada") }
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)

describe("readWm / ensureWmFiles", () => {
  it("readWm returns the empty file when wm.json is missing or corrupt", async () => {
    expect(await run(readWm(char))).toEqual(emptyWmFile())
    fs.mkdirSync(meDir(char), { recursive: true })
    fs.writeFileSync(wmJsonPath(char), "garbage")
    expect(await run(readWm(char))).toEqual(emptyWmFile())
  })

  it("ensureWmFiles seeds wm.json + WM.md, preserves an existing store, and never fails", async () => {
    await run(ensureWmFiles(char))
    expect(parseWmFile(fs.readFileSync(wmJsonPath(char), "utf8"))).toEqual(emptyWmFile())
    expect(fs.readFileSync(wmMarkdownPath(char), "utf8")).toContain("# Working memory")

    await run(mutateWm(char, [{ verb: "todo", text: "keep me" }]))
    await run(ensureWmFiles(char)) // idempotent — does not clobber
    expect((await run(readWm(char))).todos).toHaveLength(1)
  })
})

describe("mutateWm", () => {
  it("applies harness mutations, re-renders WM.md, and writes atomically (no .tmp left)", async () => {
    // persistWm prunes fully-settled done subtrees, so the done t1 (a done leaf)
    // is dropped from wm.json AND WM.md at persist; the open t2 survives. The
    // returned deltas still reflect what was applied (add, add, done).
    const deltas = await run(
      mutateWm(char, [{ verb: "todo", text: "a" }, { verb: "todo", text: "b" }, { verb: "done", id: "t1" }]),
    )
    expect(deltas.map((d) => d.op)).toEqual(["add", "add", "done"])
    expect(deltas.every((d) => d.by === "harness")).toBe(true)
    const file = await run(readWm(char))
    // The done leaf t1 was pruned; the open t2 remains.
    expect(file.todos.map((t) => [t.id, t.state])).toEqual([["t2", "open"]])
    // WM.md is re-rendered on every mutation and matches the pruned store.
    const md = fs.readFileSync(wmMarkdownPath(char), "utf8")
    expect(md).toContain("- [ ] t2 b")
    expect(md).not.toContain("t1")
    // Atomic write-via-rename: no temp artifacts remain.
    expect(fs.readdirSync(meDir(char)).filter((f) => f.includes(".tmp"))).toEqual([])
  })

  it("skips invalid mutations but applies the rest; never fails the effect", async () => {
    const deltas = await run(mutateWm(char, [{ verb: "done", id: "t99" }, { verb: "todo", text: "b" }]))
    expect(deltas).toHaveLength(1)
    expect(deltas[0].op).toBe("add")
  })

  it("never fails even when the character's me dir is unwritable (wm must never disturb the tick loop)", async () => {
    // Make the players/ ancestor a FILE so mkdir -p fails.
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "players"), "not a directory")
    await expect(run(mutateWm(char, [{ verb: "todo", text: "x" }]))).resolves.toEqual([])
  })
})

describe("seedWmPlan / drainWmDeltas", () => {
  it("seeds steps as todos parented under a plan-headline todo", async () => {
    const seeded = await run(
      seedWmPlan(char, "act now", [
        { task: "dock", goal: "dock at station", tier: "smart", successCondition: "docked", timeoutTicks: 2 },
        { task: "buy", goal: "buy fuel", tier: "fast", successCondition: "fuel > 50", timeoutTicks: 2 },
      ]),
    )
    expect(seeded.headlineId).toBe("t1")
    expect(seeded.stepIds).toEqual(["t2", "t3"])
    expect(seeded.deltas).toHaveLength(3)
    const file = await run(readWm(char))
    expect(file.todos[0]).toMatchObject({ id: "t1", text: "act now", parent: null })
    expect(file.todos[1]).toMatchObject({ id: "t2", text: "dock: dock at station", parent: "t1" })
    expect(file.todos[2]).toMatchObject({ id: "t3", text: "buy: buy fuel", parent: "t1" })
    // Harness seeding leaves the agent journal untouched.
    expect(file.pendingDeltas).toEqual([])
  })

  it("drainWmDeltas empties pendingDeltas and returns them exactly once", async () => {
    await run(ensureWmFiles(char))
    // Simulate an agent (CLI) mutation: journal a pending delta.
    const withPending = {
      ...(await run(readWm(char))),
      pendingDeltas: [{ op: "add" as const, id: "t9", text: "agent todo", parent: null, by: "agent" as const, ts: "x" }],
    }
    fs.writeFileSync(wmJsonPath(char), JSON.stringify(withPending))
    const drained = await run(drainWmDeltas(char))
    expect(drained).toHaveLength(1)
    expect(drained[0].by).toBe("agent")
    expect(await run(drainWmDeltas(char))).toEqual([])
  })

  it("drops malformed pendingDeltas elements instead of draining them (parseWmFile only checks Array.isArray)", async () => {
    await run(ensureWmFiles(char))
    const file = await run(readWm(char))
    const corrupt = {
      ...file,
      pendingDeltas: [
        null,
        "not an object",
        42,
        { op: "add", id: "t9", text: "agent todo", parent: null, by: "agent", ts: "x" }, // well-formed
        { op: "add" }, // missing id/by/ts
        { op: "bogus-op", id: "t10", by: "agent", ts: "x" }, // bad op
        { op: "done", id: "t11", by: "not-agent-or-harness", ts: "x" }, // bad by
        { op: "discard", id: "t12", by: "agent" }, // missing ts
      ],
    }
    fs.writeFileSync(wmJsonPath(char), JSON.stringify(corrupt))
    const drained = await run(drainWmDeltas(char))
    expect(drained).toEqual([{ op: "add", id: "t9", text: "agent todo", parent: null, by: "agent", ts: "x" }])
    // Drained exactly once; the journal is empty afterward regardless of the malformed entries.
    expect(await run(drainWmDeltas(char))).toEqual([])
  })
})

describe("discardDeadPlanTodos — cross-session orphan sweep", () => {
  it("discards OPEN harness-origin todos, preserves agent-origin memory, and re-renders WM.md", async () => {
    // A dead session's seeded plan (harness): headline t1 + step t2, both open.
    await run(seedWmPlan(char, "old plan", [
      { task: "step", goal: "do it", tier: "smart", successCondition: "done", timeoutTicks: 2 },
    ]))
    // An agent-created free-standing memory (via the CLI → origin agent).
    const withAgent = await run(readWm(char))
    const agentApplied = applyWmMutation(withAgent, { verb: "todo", text: "remember this" }, "agent", "ts")
    if (!agentApplied.ok) throw new Error(agentApplied.error)
    fs.writeFileSync(wmJsonPath(char), JSON.stringify(agentApplied.file))

    const deltas = await run(discardDeadPlanTodos(char))
    expect(deltas.map((d) => [d.op, d.id])).toEqual([["discard", "t1"], ["discard", "t2"]])
    const file = await run(readWm(char))
    expect(file.todos.find((t) => t.id === "t1")?.state).toBe("discarded")
    expect(file.todos.find((t) => t.id === "t2")?.state).toBe("discarded")
    // Agent memory survives, still open.
    expect(file.todos.find((t) => t.id === "t3")).toMatchObject({ text: "remember this", state: "open", origin: "agent" })
    // WM.md reflects the sweep: swept harness todos gone, agent memory shown.
    const md = fs.readFileSync(wmMarkdownPath(char), "utf8")
    expect(md).not.toContain("old plan")
    expect(md).toContain("remember this")
  })

  it("legacy todos without an origin field are treated as harness and swept", async () => {
    fs.mkdirSync(meDir(char), { recursive: true })
    fs.writeFileSync(
      wmJsonPath(char),
      JSON.stringify({
        version: 1,
        nextId: 3,
        todos: [
          { id: "t1", text: "legacy orphan", parent: null, state: "open", createdAt: "x", updatedAt: "x" },
          { id: "t2", text: "legacy child", parent: "t1", state: "open", createdAt: "x", updatedAt: "x" },
        ],
        pendingDeltas: [],
      }),
    )
    const deltas = await run(discardDeadPlanTodos(char))
    expect(deltas.map((d) => d.id).sort()).toEqual(["t1", "t2"])
    const file = await run(readWm(char))
    expect(file.todos.every((t) => t.state === "discarded")).toBe(true)
  })

  it("is a no-op (no deltas, never fails) when there are no open harness todos", async () => {
    await run(ensureWmFiles(char))
    expect(await run(discardDeadPlanTodos(char))).toEqual([])
  })
})

describe("closePlanTodos — truthful plan-headline settlement", () => {
  it("settles the headline DONE when ANY step child ended done (partial completion)", async () => {
    // Headline t1 with steps t2, t3; t2 completed, t3 abandoned (still open).
    await run(seedWmPlan(char, "headline", [
      { task: "a", goal: "a", tier: "smart", successCondition: "x", timeoutTicks: 2 },
      { task: "b", goal: "b", tier: "smart", successCondition: "x", timeoutTicks: 2 },
    ]))
    await run(mutateWm(char, [{ verb: "done", id: "t2" }]))
    // ROOT-ONLY prune: the headline root is still OPEN, so its whole subtree —
    // including the just-done step t2 — is retained on disk for closePlanTodos.
    expect((await run(readWm(char))).todos.find((t) => t.id === "t2")?.state).toBe("done")

    const deltas = await run(closePlanTodos(char, "t1", ["t2", "t3"]))
    // t3 (open) discarded; t2 already done (skipped); headline → done.
    expect(deltas.map((d) => [d.op, d.id])).toEqual([["discard", "t3"], ["done", "t1"]])
    // The headline is now a fully-settled done ROOT (done over done+discarded
    // children, no open left) → pruned at persist, clearing the completed plan.
    expect((await run(readWm(char))).todos).toEqual([])
  })

  it("DISCARDS the headline when NO step child completed", async () => {
    await run(seedWmPlan(char, "headline", [
      { task: "a", goal: "a", tier: "smart", successCondition: "x", timeoutTicks: 2 },
    ]))
    const deltas = await run(closePlanTodos(char, "t1", ["t2"]))
    expect(deltas.map((d) => [d.op, d.id])).toEqual([["discard", "t2"], ["discard", "t1"]])
    expect((await run(readWm(char))).todos.find((t) => t.id === "t1")?.state).toBe("discarded")
  })
})

describe("drainWmDeltas — WM.md reconciliation on an empty journal", () => {
  it("re-renders a stale WM.md from the authoritative wm.json even with no pending deltas", async () => {
    await run(mutateWm(char, [{ verb: "todo", text: "alpha" }, { verb: "todo", text: "beta" }]))
    // Simulate an interrupted persist: wm.json advanced, WM.md left stale/bare,
    // journal empty (nothing to drain, so the old early-return skipped WM.md).
    fs.writeFileSync(wmMarkdownPath(char), "# Working memory\n")
    const drained = await run(drainWmDeltas(char))
    expect(drained).toEqual([])
    const md = fs.readFileSync(wmMarkdownPath(char), "utf8")
    expect(md).toContain("- [ ] t1 alpha")
    expect(md).toContain("- [ ] t2 beta")
    // Reconcile must not disturb wm.json.
    expect((await run(readWm(char))).todos).toHaveLength(2)
  })
})

describe("renderOpenTodoTree", () => {
  it("renders only OPEN todos as a tree, capped, with discarded subtrees hidden", async () => {
    await run(mutateWm(char, [
      { verb: "todo", text: "plan" },                       // t1
      { verb: "todo", text: "done step", parent: "t1" },    // t2
      { verb: "todo", text: "open step", parent: "t1" },    // t3
      { verb: "todo", text: "dropped" },                    // t4
      { verb: "done", id: "t2" },
      { verb: "discard", id: "t4" },
    ]))
    const file = await run(readWm(char))
    const tree = renderOpenTodoTree(file)
    expect(tree).toBe("- t1 plan\n  - t3 open step")
    expect(renderOpenTodoTree(emptyWmFile())).toBe("(no open todos)")

    // Cap: 25 more open roots → 27 open lines total (t1 + t3 + 25) → the
    // capped render is exactly WM_PROMPT_CAP lines plus an overflow marker.
    const muts = Array.from({ length: 25 }, (_, i) => ({ verb: "todo" as const, text: `todo ${i}` }))
    await run(mutateWm(char, muts))
    const big = await run(readWm(char))
    const capped = renderOpenTodoTree(big, WM_PROMPT_CAP).split("\n")
    expect(capped).toHaveLength(WM_PROMPT_CAP + 1)
    expect(capped[WM_PROMPT_CAP]).toBe("(+7 more)")
  })
})

// ── Hardening: two writers (this host process; the in-container wm CLI)
// share wm.json, and the CLI persists the ENTIRE file (todos+nextId+
// pendingDeltas), not just the journal. mutateWm/seedWmPlan therefore
// re-read the on-disk state and merge ALL of it into what they're about to
// persist — pendingDeltas unioned, disk-only todos preserved, nextId
// max()ed — so a CLI mutation that lands between their initial snapshot
// read and their rename is never clobbered. drainWmDeltas is deliberately
// excluded — its whole job is to empty the journal.
describe("full-state disk merge (mutateWm/seedWmPlan vs. the wm CLI)", () => {
  const d = (over: Partial<WmDelta>): WmDelta => ({
    op: "add",
    id: "t9",
    text: "cli todo",
    parent: null,
    by: "agent",
    ts: "2026-01-01T00:00:00.000Z",
    ...over,
  })

  describe("mergePendingDeltas (pure helper)", () => {
    it("unions with no overlap, preserving base-then-extra order", () => {
      const base = [d({ id: "t1" })]
      const extra = [d({ id: "t2" })]
      expect(mergePendingDeltas(base, extra)).toEqual([d({ id: "t1" }), d({ id: "t2" })])
    })

    it("drops an extra entry whose full identity (ts+id+op+text+parent) already exists in base", () => {
      const base = [d({ id: "t1" })]
      const extra = [d({ id: "t1" }), d({ id: "t2" })]
      expect(mergePendingDeltas(base, extra)).toEqual([d({ id: "t1" }), d({ id: "t2" })])
    })

    it("treats same id with a different op or ts as a distinct entry", () => {
      const base = [d({ id: "t1", op: "add" })]
      const extra = [d({ id: "t1", op: "done", text: undefined, parent: undefined })]
      expect(mergePendingDeltas(base, extra)).toHaveLength(2)
    })

    it("does NOT conflate two adds sharing ts+id+op but differing in text or parent", () => {
      // Plausible collision: host and CLI both consume the same nextId in the
      // race window, producing two distinct "add t5" deltas at the same ts.
      // The identity key must include text+parent so both survive the union.
      const hostAdd = d({ id: "t5", text: "host add", by: "harness" })
      const cliAdd = d({ id: "t5", text: "cli add" })
      expect(mergePendingDeltas([hostAdd], [cliAdd])).toEqual([hostAdd, cliAdd])
      const parentedA = d({ id: "t6", parent: "t1" })
      const parentedB = d({ id: "t6", parent: "t2" })
      expect(mergePendingDeltas([parentedA], [parentedB])).toHaveLength(2)
    })

    it("is a no-op when extra is empty", () => {
      const base = [d({ id: "t1" })]
      expect(mergePendingDeltas(base, [])).toEqual(base)
    })
  })

  describe("mergeDiskState (real disk read)", () => {
    it("picks up a pendingDelta written to disk AFTER the in-memory snapshot was taken", async () => {
      await run(ensureWmFiles(char))
      // The in-memory snapshot a caller (mutateWm/seedWmPlan) would be about
      // to persist — taken BEFORE anything else touches the file.
      const snapshot = await run(readWm(char))
      expect(snapshot.pendingDeltas).toEqual([])

      // Simulate the in-container `wm` CLI appending an agent delta to disk
      // in the window between that snapshot and the eventual rename.
      const cliDelta = d({ id: "t9" })
      fs.writeFileSync(wmJsonPath(char), JSON.stringify({ ...snapshot, pendingDeltas: [cliDelta] }))

      const merged = await mergeDiskState(char, snapshot)
      expect(merged.pendingDeltas).toEqual([cliDelta])
      // Everything else about the snapshot is untouched.
      expect(merged.todos).toEqual(snapshot.todos)
      expect(merged.nextId).toEqual(snapshot.nextId)
    })

    it("does not duplicate a disk delta the in-memory snapshot already carries", async () => {
      await run(ensureWmFiles(char))
      const shared = d({ id: "t9" })
      const snapshot = { ...(await run(readWm(char))), pendingDeltas: [shared] }
      fs.writeFileSync(wmJsonPath(char), JSON.stringify(snapshot))
      const merged = await mergeDiskState(char, snapshot)
      expect(merged.pendingDeltas).toEqual([shared])
    })

    it("preserves a CLI-added todo and takes max nextId when disk advanced past the snapshot", async () => {
      // Host snapshot: t1 open, nextId 2.
      await run(mutateWm(char, [{ verb: "todo", text: "host todo" }]))
      const snapshot = await run(readWm(char))
      expect(snapshot.nextId).toBe(2)

      // Mid-window, the wm CLI persists the ENTIRE file: adds t2, advances
      // nextId to 3, journals its delta.
      const cliTodo: WmTodo = { id: "t2", text: "cli todo", parent: null, state: "open", origin: "agent", createdAt: "x", updatedAt: "x" }
      const cliDelta = d({ id: "t2", text: "cli todo" })
      fs.writeFileSync(
        wmJsonPath(char),
        JSON.stringify({ ...snapshot, nextId: 3, todos: [...snapshot.todos, cliTodo], pendingDeltas: [cliDelta] }),
      )

      // The host meanwhile mutated its stale snapshot (marks t1 done).
      const hostResult = applyWmMutation(snapshot, { verb: "done", id: "t1" }, "harness", "y")
      if (!hostResult.ok) throw new Error("unexpected")

      const merged = await mergeDiskState(char, hostResult.file)
      // The CLI-added todo survives (no todo LOSS)…
      expect(merged.todos.map((t) => t.id)).toEqual(["t1", "t2"])
      expect(merged.todos.find((t) => t.id === "t2")).toEqual(cliTodo)
      // …the host-mutated version wins on the shared id…
      expect(merged.todos.find((t) => t.id === "t1")?.state).toBe("done")
      // …nextId never regresses (no future id collision)…
      expect(merged.nextId).toBe(3)
      // …and the CLI's journal entry is carried forward.
      expect(merged.pendingDeltas).toEqual([cliDelta])
    })
  })

  // NOTE on coverage: mutateWm/seedWmPlan call mergeDiskState internally
  // right before their rename. A TRUE interleave — the wm CLI writing to
  // disk strictly between mutateWm's own initial snapshot read and that
  // final merge-and-persist step, inside the same Effect.promise — can't be
  // triggered from outside without mocking node:fs/promises, and Vitest
  // can't spy on a builtin ESM module's exports ("Module namespace is not
  // configurable in ESM", confirmed empirically). The mergeDiskState /
  // mergePendingDeltas describe blocks above exercise that exact
  // read-after-snapshot race directly and are the real coverage for this
  // fix. The tests below are a wiring smoke-check only — a CLI full-file
  // write landing before mutateWm/seedWmPlan's *own* first read is already
  // picked up by that read, so they pass pre-fix — but they pin the
  // end-to-end contract (CLI todo preserved, nextId not regressed, journal
  // intact) against future refactors.
  it("mutateWm preserves an out-of-band CLI todo/nextId/pendingDelta already on disk", async () => {
    await run(ensureWmFiles(char))
    const cliTodo: WmTodo = { id: "t7", text: "cli todo", parent: null, state: "open", origin: "agent", createdAt: "x", updatedAt: "x" }
    const cliDelta = d({ id: "t7", text: "cli todo" })
    const before = await run(readWm(char))
    fs.writeFileSync(
      wmJsonPath(char),
      JSON.stringify({ ...before, nextId: 8, todos: [cliTodo], pendingDeltas: [cliDelta] }),
    )
    await run(mutateWm(char, [{ verb: "todo", text: "harness todo" }]))
    const after = await run(readWm(char))
    expect(after.pendingDeltas).toEqual([cliDelta])
    expect(after.todos.map((t) => t.text)).toContain("cli todo")
    expect(after.todos.map((t) => t.text)).toContain("harness todo")
    expect(after.nextId).toBeGreaterThan(8)
  })

  it("seedWmPlan preserves an out-of-band CLI todo/nextId/pendingDelta already on disk", async () => {
    await run(ensureWmFiles(char))
    const cliTodo: WmTodo = { id: "t7", text: "cli todo", parent: null, state: "open", origin: "agent", createdAt: "x", updatedAt: "x" }
    const cliDelta = d({ id: "t7", text: "cli todo" })
    const before = await run(readWm(char))
    fs.writeFileSync(
      wmJsonPath(char),
      JSON.stringify({ ...before, nextId: 8, todos: [cliTodo], pendingDeltas: [cliDelta] }),
    )
    await run(seedWmPlan(char, "act now", []))
    const after = await run(readWm(char))
    expect(after.pendingDeltas).toEqual([cliDelta])
    expect(after.todos.map((t) => t.text)).toContain("cli todo")
    expect(after.nextId).toBeGreaterThan(8)
  })
})
