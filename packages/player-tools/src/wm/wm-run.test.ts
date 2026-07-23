import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { runWm, WM_JSON_REL, WM_MD_REL, WM_USAGE } from "./wm-run.js"
import { parseWmFile, renderWmMarkdown } from "./wm-core.js"

let cwd: string

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wm-run-"))
  fs.mkdirSync(path.join(cwd, "me"))
})

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

const NOW = "2026-07-22T12:00:00.000Z"

function run(argv: string[]) {
  const out = vi.fn()
  const err = vi.fn()
  const code = runWm(argv, { cwd, nowIso: NOW, out, err })
  return { code, out, err }
}

const readJson = () => parseWmFile(fs.readFileSync(path.join(cwd, WM_JSON_REL), "utf8"))
const readMd = () => fs.readFileSync(path.join(cwd, WM_MD_REL), "utf8")

describe("runWm / todo", () => {
  it("creates an agent-origin todo, writes both files, journals the delta, prints the id", () => {
    const { code, out } = run(["todo", "buy milk"])
    expect(code).toBe(0)
    const file = readJson()
    expect(file.todos).toHaveLength(1)
    expect(file.todos[0]).toMatchObject({ id: "t1", text: "buy milk", state: "open", origin: "agent" })
    // The mutation is journaled for the harness to drain at the step boundary.
    expect(file.pendingDeltas).toHaveLength(1)
    expect(file.pendingDeltas[0]).toMatchObject({ op: "add", id: "t1", by: "agent", ts: NOW })
    // WM.md is the render of the persisted file (byte-identical to wm-core).
    expect(readMd()).toBe(renderWmMarkdown(file))
    expect(out).toHaveBeenCalledWith("t1")
  })

  it("supports --parent and rejects a missing parent with exit 1", () => {
    run(["todo", "root"])
    const ok = run(["todo", "child", "--parent", "t1"])
    expect(ok.code).toBe(0)
    expect(readJson().todos.find((t) => t.id === "t2")?.parent).toBe("t1")

    const bad = run(["todo", "orphan", "--parent", "t99"])
    expect(bad.code).toBe(1)
    expect(bad.err).toHaveBeenCalledWith(expect.stringContaining("parent not found"))
  })
})

describe("runWm / done + discard", () => {
  it("marks an open todo done", () => {
    run(["todo", "task"])
    const { code } = run(["done", "t1"])
    expect(code).toBe(0)
    expect(readJson().todos[0].state).toBe("done")
  })

  it("rejects done on an already-settled todo with exit 1", () => {
    run(["todo", "task"])
    run(["done", "t1"])
    const { code, err } = run(["done", "t1"])
    expect(code).toBe(1)
    expect(err).toHaveBeenCalledWith(expect.stringContaining("already done"))
  })

  it("discards an open todo (retained, hidden from the active render)", () => {
    run(["todo", "task"])
    const { code } = run(["discard", "t1"])
    expect(code).toBe(0)
    expect(readJson().todos[0].state).toBe("discarded")
    expect(readMd()).not.toContain("task")
  })
})

describe("runWm / usage", () => {
  it("prints usage and exits 2 on an unknown verb", () => {
    const { code, err } = run(["bogus"])
    expect(code).toBe(2)
    expect(err).toHaveBeenCalledWith(WM_USAGE)
  })

  it("prints usage and exits 2 when todo has the wrong arg count", () => {
    const { code } = run(["todo"])
    expect(code).toBe(2)
  })

  it("tolerates a missing/torn wm.json by degrading to the empty file", () => {
    // No prior wm.json exists yet; the first mutation must still succeed.
    const { code } = run(["todo", "first ever"])
    expect(code).toBe(0)
    expect(readJson().todos[0].id).toBe("t1")
  })
})
