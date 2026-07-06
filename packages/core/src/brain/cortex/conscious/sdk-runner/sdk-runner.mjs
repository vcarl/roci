// In-container frontier-worker entry. Reads NDJSON commands on stdin, drives the
// Agent SDK's streaming-input query(), writes NDJSON events/result on stdout.
// Pure protocol logic lives in ./sdk-runner-protocol.mjs (unit-tested on the host).
import { query } from "@anthropic-ai/claude-agent-sdk"
import * as readline from "node:readline"
import {
  parseCommand,
  toSdkUserMessage,
  formatEventLine,
  formatResultLine,
} from "./sdk-runner-protocol.mjs"

// Async generator of SDKUserMessages, driven by stdin. Completes on `end`.
async function* inputMessages() {
  const rl = readline.createInterface({ input: process.stdin })
  for await (const line of rl) {
    const cmd = parseCommand(line)
    if (!cmd) continue
    if (cmd.type === "end") {
      rl.close()
      return
    }
    // task and steer are structurally identical: each becomes one user turn.
    yield toSdkUserMessage(cmd.text)
  }
}

async function main() {
  const options = {
    model: process.env.ROCI_SDK_MODEL,
    systemPrompt: process.env.ROCI_SDK_SYSTEM_PROMPT,
    maxTurns: Number(process.env.ROCI_SDK_MAX_TURNS ?? "40"),
    permissionMode: "bypassPermissions",
    cwd: process.cwd(),
  }
  try {
    for await (const message of query({ prompt: inputMessages(), options })) {
      process.stdout.write(`${formatEventLine(message)}\n`)
      if (message.type === "result") {
        process.stdout.write(`${formatResultLine(message)}\n`)
      }
    }
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({ v: 1, type: "result", status: "failed", output: String(err?.message ?? err) })}\n`,
    )
    process.exitCode = 1
  }
}

main()
