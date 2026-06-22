import { describe, it, expect, beforeEach } from "vitest"
import {
  registerResidentServer,
  unregisterResidentServer,
  reapResidentServers,
  _residentServerPids,
} from "./mlx-backend.js"

// These tests cover the SYNCHRONOUS orphan-reaper backstop that runs inside the
// ~30ms window between tsx forwarding SIGTERM to the worker and SIGKILLing it.
// Effect's async kill finalizer cannot complete in that window; this synchronous
// reaper can. The registry tracks the RESIDENT mlx server pids (the 122B that
// orphans on shutdown); the reaper group-SIGKILLs each tracked pid.
//
// We never touch a real process or real signals: registration is a plain map
// add/remove, and the reaper takes an injected kill spy.

// Reset module-level registry between tests so state doesn't leak across cases.
beforeEach(() => {
  for (const pid of [..._residentServerPids()]) unregisterResidentServer(pid)
})

const makeKillSpy = (goneTargets: ReadonlyArray<number> = []) => {
  const calls: Array<{ target: number; signal: NodeJS.Signals | number }> = []
  const kill = (target: number, signal: NodeJS.Signals | number): void => {
    calls.push({ target, signal })
    if (goneTargets.includes(target)) {
      const err = new Error("no such process") as NodeJS.ErrnoException
      err.code = "ESRCH"
      throw err
    }
  }
  return { kill, calls }
}

describe("resident server registry", () => {
  it("registers a resident pid (with its pgid) and lists it", () => {
    registerResidentServer(1234, 1234)
    expect([..._residentServerPids()]).toEqual([1234])
  })

  it("removes a pid on unregister", () => {
    registerResidentServer(1234, 1234)
    registerResidentServer(5678, 5678)
    unregisterResidentServer(1234)
    expect([..._residentServerPids()]).toEqual([5678])
  })

  it("unregistering an unknown pid is a no-op", () => {
    registerResidentServer(1234, 1234)
    unregisterResidentServer(9999)
    expect([..._residentServerPids()]).toEqual([1234])
  })

  it("re-registering the same pid does not duplicate it", () => {
    registerResidentServer(1234, 1234)
    registerResidentServer(1234, 1234)
    expect([..._residentServerPids()]).toEqual([1234])
  })
})

describe("reapResidentServers — synchronous group-SIGKILL backstop", () => {
  it("group-SIGKILLs each tracked pid (negative pgid)", () => {
    registerResidentServer(111, 111)
    registerResidentServer(222, 222)
    const { kill, calls } = makeKillSpy()

    reapResidentServers(kill)

    expect(calls).toEqual([
      { target: -111, signal: "SIGKILL" },
      { target: -222, signal: "SIGKILL" },
    ])
  })

  it("targets the recorded pgid, not the pid, when they differ", () => {
    registerResidentServer(111, 999)
    const { kill, calls } = makeKillSpy()

    reapResidentServers(kill)

    expect(calls).toEqual([{ target: -999, signal: "SIGKILL" }])
  })

  it("swallows ESRCH (target already gone) and continues reaping the rest", () => {
    registerResidentServer(111, 111)
    registerResidentServer(222, 222)
    const { kill, calls } = makeKillSpy([-111])

    expect(() => reapResidentServers(kill)).not.toThrow()
    // Both were attempted even though the first threw ESRCH.
    expect(calls).toEqual([
      { target: -111, signal: "SIGKILL" },
      { target: -222, signal: "SIGKILL" },
    ])
  })

  it("clears the registry so a second reap is idempotent (no double-kill)", () => {
    registerResidentServer(111, 111)
    const { kill, calls } = makeKillSpy()

    reapResidentServers(kill)
    reapResidentServers(kill)

    // Only the first reap signalled; the registry was emptied so the second is a no-op.
    expect(calls).toEqual([{ target: -111, signal: "SIGKILL" }])
    expect([..._residentServerPids()]).toEqual([])
  })

  it("is a no-op with no tracked servers", () => {
    const { kill, calls } = makeKillSpy()
    expect(() => reapResidentServers(kill)).not.toThrow()
    expect(calls).toEqual([])
  })
})
