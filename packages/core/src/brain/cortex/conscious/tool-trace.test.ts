import { describe, it, expect } from "vitest"
import { renderToolTrace, MAX_TRACE_LINES, EMPTY_TRACE } from "./tool-trace.js"
import type { ToolEpisode } from "../../../logging/episodes.js"

const rec = (over: Partial<ToolEpisode> = {}): ToolEpisode => ({
  ts: "2026-07-21T00:00:00.000Z",
  tick: 1,
  stepId: "c1-s1-0",
  tool: "bash",
  argsSummary: '{"command":"ls"}',
  status: "completed",
  durationMs: 1200,
  ...over,
})

describe("renderToolTrace", () => {
  it("returns the empty placeholder for no calls", () => {
    expect(renderToolTrace([])).toBe(EMPTY_TRACE)
  })

  it("leads with the description and names the tool + command when a description exists", () => {
    const line = renderToolTrace([
      rec({ description: "market view", tool: "bash", command: "spacemolt view_market --station frontier", outputChars: 3400 }),
    ])
    expect(line).toBe('market view (bash: "spacemolt view_market --station frontier") — ok, 1.2s, 3.3KB out')
  })

  it("leads with the tool + command when there is no description", () => {
    const line = renderToolTrace([rec({ command: "spacemolt storage/view", durationMs: 2, outputChars: 210 })])
    expect(line).toBe('bash: "spacemolt storage/view" — ok, 2ms, 210B out')
  })

  it("renders a failed call with its exit code", () => {
    const line = renderToolTrace([
      rec({ description: "install module", command: "spacemolt install_mod cpu", status: "error", exitCode: 1, durationMs: 800, outputChars: 210 }),
    ])
    expect(line).toBe('install module (bash: "spacemolt install_mod cpu") — FAILED exit 1, 800ms, 210B out')
  })

  it("renders a bare FAILED when no exit code was captured", () => {
    const line = renderToolTrace([rec({ command: "boom", status: "error", durationMs: 50, outputChars: 12 })])
    expect(line).toBe('bash: "boom" — FAILED, 50ms, 12B out')
  })

  it("omits duration and output size when unknown", () => {
    const line = renderToolTrace([rec({ command: "ls", durationMs: null, outputChars: undefined })])
    expect(line).toBe('bash: "ls" — ok')
  })

  it("falls back to argsSummary when no command field is present", () => {
    const line = renderToolTrace([rec({ command: undefined, argsSummary: '{"file":"x.ts"}', tool: "read", durationMs: null })])
    expect(line).toBe('read: "{"file":"x.ts"}" — ok')
  })

  it("formats MB-scale output", () => {
    const line = renderToolTrace([rec({ command: "dump", durationMs: null, outputChars: 2 * 1024 * 1024 })])
    expect(line).toContain("2.0MB out")
  })

  it("renders every line when at or under the cap", () => {
    const eps = Array.from({ length: MAX_TRACE_LINES }, (_, i) => rec({ command: `cmd${i}`, durationMs: null, outputChars: undefined }))
    const out = renderToolTrace(eps).split("\n")
    expect(out).toHaveLength(MAX_TRACE_LINES)
    expect(out).not.toContain(expect.stringContaining("more calls"))
  })

  it("elides the middle past the cap, keeping head and tail (chronological)", () => {
    const total = MAX_TRACE_LINES + 20
    const eps = Array.from({ length: total }, (_, i) => rec({ command: `cmd${i}`, durationMs: null, outputChars: undefined }))
    const out = renderToolTrace(eps).split("\n")
    expect(out).toHaveLength(MAX_TRACE_LINES)
    // First and last calls survive; the elision marker names the dropped count.
    expect(out[0]).toContain('"cmd0"')
    expect(out[out.length - 1]).toContain(`"cmd${total - 1}"`)
    const elision = out.find((l) => l.includes("more calls"))
    expect(elision).toBe(`… ${total - (MAX_TRACE_LINES - 1)} more calls …`)
  })
})
