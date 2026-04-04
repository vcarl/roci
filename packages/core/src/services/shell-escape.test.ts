import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"

/**
 * Copy of shellEscape from process-runner.ts — tested in isolation via real bash.
 */
function shellEscape(s: string): string {
  let escaped = ""
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (ch === "\\") escaped += "\\\\"
    else if (ch === "'") escaped += "\\'"
    else if (ch === "\n") escaped += "\\n"
    else if (ch === "\r") escaped += "\\r"
    else if (ch === "\t") escaped += "\\t"
    else if (code < 0x20 || code === 0x7f) escaped += `\\x${code.toString(16).padStart(2, "0")}`
    else escaped += ch
  }
  return `$'${escaped}'`
}

/**
 * Run a string through bash via execFileSync. The $'...' literal is interpreted
 * by the single bash invocation, matching the docker exec path.
 */
function bashRoundtrip(input: string): string {
  const escaped = shellEscape(input)
  return execFileSync("bash", ["-c", `printf "%s" ${escaped}`], { encoding: "utf-8" })
}

/**
 * Simulate the full docker exec pattern: the escaped value is embedded
 * in a larger bash -c command string alongside other arguments.
 */
function bashCmdRoundtrip(input: string): string {
  const escaped = shellEscape(input)
  const script = `/bin/echo -n "PREFIX" && printf "%s" ${escaped} && /bin/echo -n "SUFFIX"`
  const result = execFileSync("bash", ["-c", script], { encoding: "utf-8" })
  expect(result.startsWith("PREFIX")).toBe(true)
  expect(result.endsWith("SUFFIX")).toBe(true)
  return result.slice(6, -6)
}

describe("shellEscape", () => {
  it("handles plain text", () => {
    expect(bashRoundtrip("hello world")).toBe("hello world")
  })

  it("handles single quotes", () => {
    expect(bashRoundtrip("it's a test")).toBe("it's a test")
  })

  it("handles double quotes", () => {
    expect(bashRoundtrip('say "hello"')).toBe('say "hello"')
  })

  it("handles backticks", () => {
    expect(bashRoundtrip("run `ls` now")).toBe("run `ls` now")
  })

  it("handles dollar signs", () => {
    expect(bashRoundtrip("costs $100 or ${HOME}")).toBe("costs $100 or ${HOME}")
  })

  it("handles backslashes", () => {
    expect(bashRoundtrip("path\\to\\file")).toBe("path\\to\\file")
  })

  it("handles newlines", () => {
    expect(bashRoundtrip("line1\nline2\nline3")).toBe("line1\nline2\nline3")
  })

  it("handles tabs", () => {
    expect(bashRoundtrip("col1\tcol2")).toBe("col1\tcol2")
  })

  it("handles mixed special characters", () => {
    const input = `it's a "test" with \`backticks\` and $vars\nand \\slashes`
    expect(bashRoundtrip(input)).toBe(input)
  })

  it("handles exclamation marks", () => {
    expect(bashRoundtrip("hello! world!!")).toBe("hello! world!!")
  })

  it("handles parentheses and braces", () => {
    expect(bashRoundtrip("(a) {b} [c]")).toBe("(a) {b} [c]")
  })

  it("handles pipes and redirects", () => {
    expect(bashRoundtrip("a | b > c < d 2>&1")).toBe("a | b > c < d 2>&1")
  })

  it("handles semicolons and ampersands", () => {
    expect(bashRoundtrip("a; b && c || d &")).toBe("a; b && c || d &")
  })

  it("handles hash/comments", () => {
    expect(bashRoundtrip("not a # comment")).toBe("not a # comment")
  })

  it("handles empty string", () => {
    expect(bashRoundtrip("")).toBe("")
  })

  it("handles string of only single quotes", () => {
    expect(bashRoundtrip("'''")).toBe("'''")
  })

  it("handles markdown code blocks", () => {
    const input = "```bash\nsm mine\nsm market sell $ITEM 10 5\n```"
    expect(bashRoundtrip(input)).toBe(input)
  })

  it("handles real-world CLAUDE.md-like content", () => {
    const input = `# SpaceMolt Agent Skill

**You are a player now.** Not an assistant.

Use the \`sm\` CLI on PATH for all game operations. Run \`sm help\`.

\`\`\`bash
sm chat local "hello everyone"
sm chat private <player_id> "hey there"
\`\`\`

**Rate limits apply** — mutation commands (mine, travel, sell, etc.) are 1 per 10s tick.

- "Copper ore sells for ~8cr at Solarian bases"
- Player X's inventory: $HOME/stuff
- Escape sequences: \\n \\t \\x00
- Single quotes: it's don't won't
`
    expect(bashRoundtrip(input)).toBe(input)
  })

  it("survives as part of a larger command (docker exec pattern)", () => {
    const input = "it's got \"quotes\" and `backticks` and $HOME\nand newlines"
    expect(bashCmdRoundtrip(input)).toBe(input)
  })

  it("survives markdown in the docker exec pattern", () => {
    const input = "```bash\nsm mine\n```\n\nUse `sm market sell $ITEM 10 5`.\nDon't forget!"
    expect(bashCmdRoundtrip(input)).toBe(input)
  })
})
