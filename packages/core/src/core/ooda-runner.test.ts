import { describe, it, expect } from "vitest"
import { extractJson, formatExecutionReport } from "./ooda-runner.js"

describe("extractJson", () => {
  it("handles raw JSON", () => {
    const raw = '{"disposition":"discard","emotionalWeight":"😐","reason":"nothing"}'
    expect(JSON.parse(extractJson(raw))).toEqual({
      disposition: "discard",
      emotionalWeight: "😐",
      reason: "nothing",
    })
  })

  it("handles ```json code fence", () => {
    const raw = '```json\n{"disposition":"escalate","emotionalWeight":"🫠","reason":"alarm"}\n```'
    expect(JSON.parse(extractJson(raw))).toEqual({
      disposition: "escalate",
      emotionalWeight: "🫠",
      reason: "alarm",
    })
  })

  it("handles ``` code fence without json label", () => {
    const raw = '```\n{"decision":"continue","reasoning":"all good"}\n```'
    expect(JSON.parse(extractJson(raw))).toEqual({
      decision: "continue",
      reasoning: "all good",
    })
  })

  it("handles code fence with surrounding text", () => {
    const raw = 'Here is my response:\n\n```json\n{"disposition":"accumulate","emotionalWeight":"👌","reason":"minor"}\n```\n\nThat is my analysis.'
    expect(JSON.parse(extractJson(raw))).toEqual({
      disposition: "accumulate",
      emotionalWeight: "👌",
      reason: "minor",
    })
  })

  it("handles extra whitespace", () => {
    const raw = '  \n  {"disposition":"discard","emotionalWeight":"😐","reason":"empty"}  \n  '
    expect(JSON.parse(extractJson(raw))).toEqual({
      disposition: "discard",
      emotionalWeight: "😐",
      reason: "empty",
    })
  })

  it("handles multiline JSON in code fence", () => {
    const raw = '```json\n{\n  "decision": "plan",\n  "reasoning": "need to act",\n  "steps": []\n}\n```'
    const parsed = JSON.parse(extractJson(raw))
    expect(parsed.decision).toBe("plan")
    expect(parsed.steps).toEqual([])
  })
})

describe("formatExecutionReport", () => {
  it("returns placeholder for empty events", () => {
    expect(formatExecutionReport([])).toBe("No tool activity observed.")
  })

  it("formats tool_use events", () => {
    const result = formatExecutionReport([
      { kind: "tool_use", tool: "Bash", input: "git status" },
    ])
    expect(result).toContain("Bash: git status")
  })

  it("formats tool_result events", () => {
    const result = formatExecutionReport([
      { kind: "tool_use", tool: "Bash", input: "npm test" },
      { kind: "tool_result", output: "All tests passed" },
    ])
    expect(result).toContain("Bash: npm test")
    expect(result).toContain("→ All tests passed")
  })

  it("truncates long inputs", () => {
    const longInput = "a".repeat(300)
    const result = formatExecutionReport([
      { kind: "tool_use", tool: "Edit", input: longInput },
    ])
    expect(result.length).toBeLessThan(300)
  })
})
