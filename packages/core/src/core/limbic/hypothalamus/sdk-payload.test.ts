import { describe, it, expect } from "vitest"
import { endLine } from "./sdk-payload.js"

describe("endLine", () => {
  it("produces the host→runner `end` control wire shape (no trailing newline)", () => {
    expect(JSON.parse(endLine())).toEqual({ v: 1, type: "end" })
  })
})
