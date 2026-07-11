import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import type { PlanStep } from "../../../core/types.js"
import { readWm } from "./wm-store.js"
import { makePlanTodoTracker } from "./plan-todos.js"

let root: string
let char: CharacterConfig
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-todos-"))
  char = { name: "ada", dir: path.join(root, "players", "ada", "me") }
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)

const step = (task: string, goal: string): PlanStep =>
  ({ task, goal, successCondition: "", timeoutTicks: 5 }) as PlanStep

const ops = (deltas: { op: string; id: string }[]) => deltas.map((d) => [d.op, d.id])

describe("makePlanTodoTracker", () => {
  it("seed creates a headline + one child per step and returns the add deltas", async () => {
    const t = makePlanTodoTracker(char)
    const deltas = await run(t.seed("do the thing", [step("a", "ga"), step("b", "gb")]))
    // headline t1, step children t2/t3.
    expect(ops(deltas)).toEqual([
      ["add", "t1"],
      ["add", "t2"],
      ["add", "t3"],
    ])
    const wm = await run(readWm(char))
    expect(wm.todos.map((x) => [x.id, x.parent ?? null, x.state])).toEqual([
      ["t1", null, "open"],
      ["t2", "t1", "open"],
      ["t3", "t1", "open"],
    ])
  })

  it("settleStep next_step (non-final) marks only the finished step's todo done", async () => {
    const t = makePlanTodoTracker(char)
    await run(t.seed("h", [step("a", "ga"), step("b", "gb")]))
    const deltas = await run(t.settleStep(0, "next_step", 2))
    // No agent journal, no plan close → just the done on the step-0 child.
    expect(ops(deltas)).toEqual([["done", "t2"]])
    const wm = await run(readWm(char))
    // Headline + remaining step still open (plan continues); t2 done retained
    // under the still-open root.
    expect(wm.todos.find((x) => x.id === "t1")?.state).toBe("open")
    expect(wm.todos.find((x) => x.id === "t2")?.state).toBe("done")
    expect(wm.todos.find((x) => x.id === "t3")?.state).toBe("open")
  })

  it("settleStep next_step on the final step closes the headline done", async () => {
    const t = makePlanTodoTracker(char)
    await run(t.seed("h", [step("a", "ga"), step("b", "gb")]))
    await run(t.settleStep(0, "next_step", 2))
    const deltas = await run(t.settleStep(1, "next_step", 2))
    // done t3 first, then headline settles done (a child is done). Order:
    // [...agentDeltas, ...doneDeltas, ...planCloseDeltas].
    expect(ops(deltas)).toEqual([
      ["done", "t3"],
      ["done", "t1"],
    ])
  })

  it("settleStep replan discards the remaining open steps and settles the headline", async () => {
    const t = makePlanTodoTracker(char)
    await run(t.seed("h", [step("a", "ga"), step("b", "gb")]))
    const deltas = await run(t.settleStep(0, "replan", 2))
    // done t2 first; then t3 (still open) discarded; headline done (t2 done).
    expect(ops(deltas)).toEqual([
      ["done", "t2"],
      ["discard", "t3"],
      ["done", "t1"],
    ])
  })

  it("discardOrphans discards the headline + open step children (no child done)", async () => {
    const t = makePlanTodoTracker(char)
    await run(t.seed("h", [step("a", "ga"), step("b", "gb")]))
    const deltas = await run(t.discardOrphans())
    // Both step children still open → discarded; headline discarded (none done).
    expect(ops(deltas)).toEqual([
      ["discard", "t2"],
      ["discard", "t3"],
      ["discard", "t1"],
    ])
  })

  it("discardOrphans is a no-op when nothing was seeded", async () => {
    const t = makePlanTodoTracker(char)
    expect(await run(t.discardOrphans())).toEqual([])
  })

  it("clears its tracked ids after a plan-ending settle so a later discard is a no-op", async () => {
    const t = makePlanTodoTracker(char)
    await run(t.seed("h", [step("a", "ga")]))
    await run(t.settleStep(0, "terminate", 1))
    // The ids were consumed by the terminate settle; nothing left to discard.
    expect(await run(t.discardOrphans())).toEqual([])
  })
})
