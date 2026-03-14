import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"

/**
 * Copy of shellEscape from Claude.ts — tested in isolation via real bash.
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
 * Run a string through bash via execFileSync (no host shell — same as
 * Command.make / child_process.spawn). The $'...' literal is interpreted
 * by the single bash invocation, matching the docker exec path.
 */
function bashRoundtrip(input: string): string {
  const escaped = shellEscape(input)
  // printf %s avoids trailing newline
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
  assert.ok(result.startsWith("PREFIX"), `expected PREFIX, got: ${result.slice(0, 20)}`)
  assert.ok(result.endsWith("SUFFIX"), `expected SUFFIX, got: ${result.slice(-20)}`)
  return result.slice(6, -6) // strip PREFIX and SUFFIX
}

describe("shellEscape", () => {
  it("handles plain text", () => {
    assert.equal(bashRoundtrip("hello world"), "hello world")
  })

  it("handles single quotes", () => {
    assert.equal(bashRoundtrip("it's a test"), "it's a test")
  })

  it("handles double quotes", () => {
    assert.equal(bashRoundtrip('say "hello"'), 'say "hello"')
  })

  it("handles backticks", () => {
    assert.equal(bashRoundtrip("run `ls` now"), "run `ls` now")
  })

  it("handles dollar signs", () => {
    assert.equal(bashRoundtrip("costs $100 or ${HOME}"), "costs $100 or ${HOME}")
  })

  it("handles backslashes", () => {
    assert.equal(bashRoundtrip("path\\to\\file"), "path\\to\\file")
  })

  it("handles newlines", () => {
    assert.equal(bashRoundtrip("line1\nline2\nline3"), "line1\nline2\nline3")
  })

  it("handles tabs", () => {
    assert.equal(bashRoundtrip("col1\tcol2"), "col1\tcol2")
  })

  it("handles mixed special characters", () => {
    const input = `it's a "test" with \`backticks\` and $vars\nand \\slashes`
    assert.equal(bashRoundtrip(input), input)
  })

  it("handles exclamation marks", () => {
    assert.equal(bashRoundtrip("hello! world!!"), "hello! world!!")
  })

  it("handles parentheses and braces", () => {
    assert.equal(bashRoundtrip("(a) {b} [c]"), "(a) {b} [c]")
  })

  it("handles pipes and redirects", () => {
    assert.equal(bashRoundtrip("a | b > c < d 2>&1"), "a | b > c < d 2>&1")
  })

  it("handles semicolons and ampersands", () => {
    assert.equal(bashRoundtrip("a; b && c || d &"), "a; b && c || d &")
  })

  it("handles hash/comments", () => {
    assert.equal(bashRoundtrip("not a # comment"), "not a # comment")
  })

  it("handles empty string", () => {
    assert.equal(bashRoundtrip(""), "")
  })

  it("handles string of only single quotes", () => {
    assert.equal(bashRoundtrip("'''"), "'''")
  })

  it("handles markdown code blocks", () => {
    const input = "```bash\nsm mine\nsm market sell $ITEM 10 5\n```"
    assert.equal(bashRoundtrip(input), input)
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
    assert.equal(bashRoundtrip(input), input)
  })

  it("survives as part of a larger command (docker exec pattern)", () => {
    const input = "it's got \"quotes\" and `backticks` and $HOME\nand newlines"
    assert.equal(bashCmdRoundtrip(input), input)
  })

  it("survives markdown in the docker exec pattern", () => {
    const input = "```bash\nsm mine\n```\n\nUse `sm market sell $ITEM 10 5`.\nDon't forget!"
    assert.equal(bashCmdRoundtrip(input), input)
  })
})
