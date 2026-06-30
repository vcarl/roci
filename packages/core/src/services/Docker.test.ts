import { describe, it, expect } from "vitest"
import { buildExecArgs } from "./Docker.js"

describe("buildExecArgs", () => {
  it("builds a plain exec with no flags", () => {
    expect(buildExecArgs("cid", ["bash", "-lc", "echo hi"])).toEqual([
      "exec",
      "cid",
      "bash",
      "-lc",
      "echo hi",
    ])
  })

  it("inserts -u <user> BEFORE the containerId when user is set (run as root)", () => {
    const args = buildExecArgs("cid", ["bash", "-lc", "id"], { user: "root" })
    expect(args).toEqual(["exec", "-u", "root", "cid", "bash", "-lc", "id"])
    // -u and its value must precede the container id (docker options come first).
    expect(args.indexOf("-u")).toBeLessThan(args.indexOf("cid"))
    expect(args[args.indexOf("-u") + 1]).toBe("root")
  })

  it("omits -u entirely when no user is given", () => {
    expect(buildExecArgs("cid", ["x"])).not.toContain("-u")
    expect(buildExecArgs("cid", ["x"], { interactive: true })).not.toContain("-u")
  })

  it("still supports -it for interactive, alongside -u", () => {
    expect(buildExecArgs("cid", ["x"], { interactive: true, user: "root" })).toEqual([
      "exec",
      "-it",
      "-u",
      "root",
      "cid",
      "x",
    ])
  })
})
