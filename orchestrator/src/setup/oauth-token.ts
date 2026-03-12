import { Effect } from "effect"
import { Prompt } from "@effect/cli"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import * as path from "node:path"
import { logToConsole } from "../logging/console-renderer.js"

/**
 * Validate an OAuth token by making a lightweight API call.
 * Returns true if the token is accepted, false if it gets a 401.
 */
function validateTokenWithApi(token: string): boolean {
  try {
    const result = spawnSync("claude", ["-p", "--output-format", "text", "--max-turns", "1", "--model", "haiku", "respond with ok"], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
      timeout: 30_000,
    })
    // 401 auth errors cause a non-zero exit with "Failed to authenticate" in output
    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
      if (output.includes("401") || output.includes("authentication_error") || output.includes("Failed to authenticate")) {
        return false
      }
    }
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * Run `claude setup-token` to acquire a fresh OAuth token.
 * Returns the new token string, or undefined if it fails.
 */
function runSetupToken(): string | undefined {
  const result = spawnSync("claude", ["setup-token"], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf-8",
  })
  if (result.status !== 0) return undefined

  const lines = result.stdout.trim().split("\n")
  for (const line of [...lines].reverse()) {
    const trimmed = line.trim()
    if (trimmed.startsWith("sk-ant-")) return trimmed
  }
  // Fallback: last non-empty line with no spaces
  for (const line of [...lines].reverse()) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.includes(" ")) return trimmed
  }
  return undefined
}

/** Read a specific key from a .env file at projectRoot. */
function readDotenvKey(projectRoot: string, key: string): string | undefined {
  const envPath = path.resolve(projectRoot, ".env")
  try {
    const content = readFileSync(envPath, "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      const k = trimmed.slice(0, eq).trim()
      if (k !== key) continue
      let val = trimmed.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      return val
    }
  } catch {
    // File doesn't exist or can't be read
  }
  return undefined
}

/** Write or update a key=value pair in the .env file at projectRoot. */
function writeDotenvKey(projectRoot: string, key: string, value: string): void {
  const envPath = path.resolve(projectRoot, ".env")
  let lines: string[] = []
  let found = false

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8")
    lines = content.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      const k = trimmed.slice(0, eq).trim()
      if (k === key) {
        lines[i] = `${key}=${value}`
        found = true
        break
      }
    }
  }

  if (!found) {
    // Append, ensuring there's a newline before the new entry
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("")
    }
    lines.push(`${key}=${value}`)
  }

  writeFileSync(envPath, lines.join("\n") + "\n")
}

/**
 * Check if CLAUDE_CODE_OAUTH_TOKEN is available in the environment or .env file.
 * Returns the token if found, undefined otherwise.
 */
export function getOAuthToken(projectRoot: string): string | undefined {
  return readDotenvKey(projectRoot, "CLAUDE_CODE_OAUTH_TOKEN") ?? process.env.CLAUDE_CODE_OAUTH_TOKEN
}

/**
 * Check if the `claude` CLI is installed and accessible.
 */
function isClaudeCliAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/**
 * Interactive step for guided setup: ensure CLAUDE_CODE_OAUTH_TOKEN is available.
 * If missing, prompts the user and runs `claude setup-token` to acquire one.
 */
export const ensureOAuthToken = (projectRoot: string) =>
  Effect.gen(function* () {
    const existing = getOAuthToken(projectRoot)
    if (existing) {
      yield* logToConsole("setup", "cli", "OAuth token found.")
      return
    }

    yield* logToConsole("setup", "cli", "")
    yield* logToConsole("setup", "cli", "CLAUDE_CODE_OAUTH_TOKEN is not set.")
    yield* logToConsole("setup", "cli", "This token is required for Claude Code subagents running inside Docker containers.")

    if (!isClaudeCliAvailable()) {
      yield* logToConsole("setup", "cli", "")
      yield* logToConsole("setup", "cli", "ERROR: 'claude' CLI is not installed or not in PATH.")
      yield* logToConsole("setup", "cli", "Install it with: npm install -g @anthropic-ai/claude-code")
      yield* logToConsole("setup", "cli", "Then re-run setup, or manually set CLAUDE_CODE_OAUTH_TOKEN in .env")
      return
    }

    const runSetup: boolean = yield* Prompt.confirm({
      message: "Run 'claude setup-token' to acquire an OAuth token now?",
      initial: true,
    })

    if (!runSetup) {
      yield* logToConsole("setup", "cli", "Skipping token setup. You will need to set CLAUDE_CODE_OAUTH_TOKEN in .env before starting.")
      return
    }

    yield* logToConsole("setup", "cli", "Running 'claude setup-token'... Follow the prompts to authenticate.")
    yield* logToConsole("setup", "cli", "")

    const token = runSetupToken()
    if (!token) {
      yield* logToConsole("setup", "cli", "")
      yield* logToConsole("setup", "cli", "WARNING: Could not extract token from 'claude setup-token' output.")
      yield* logToConsole("setup", "cli", "You will need to manually set CLAUDE_CODE_OAUTH_TOKEN in .env")
      return
    }

    writeDotenvKey(projectRoot, "CLAUDE_CODE_OAUTH_TOKEN", token)
    yield* logToConsole("setup", "cli", "")
    yield* logToConsole("setup", "cli", "OAuth token saved to .env")
  })

/**
 * Validation check for validate-and-start: verify the token exists and is valid.
 * If the token is expired/invalid, attempts to refresh via `claude setup-token`.
 * Returns true if a valid token is available, false otherwise.
 */
export const checkOAuthToken = (projectRoot: string) =>
  Effect.gen(function* () {
    let token = getOAuthToken(projectRoot)
    if (!token) {
      yield* logToConsole("roci", "cli", "ERROR: CLAUDE_CODE_OAUTH_TOKEN not found in .env or environment.")
      yield* logToConsole("roci", "cli", "Run 'roci setup' to acquire a token, or set it manually in .env")
      return false
    }

    yield* logToConsole("roci", "cli", "Validating OAuth token...")
    if (validateTokenWithApi(token)) {
      yield* logToConsole("roci", "cli", "OAuth token is valid.")
      return true
    }

    yield* logToConsole("roci", "cli", "OAuth token is expired or invalid. Running 'claude setup-token' to refresh...")
    const newToken = runSetupToken()
    if (!newToken) {
      yield* logToConsole("roci", "cli", "ERROR: Failed to acquire a new token via 'claude setup-token'.")
      yield* logToConsole("roci", "cli", "Set CLAUDE_CODE_OAUTH_TOKEN manually in .env and retry.")
      return false
    }

    writeDotenvKey(projectRoot, "CLAUDE_CODE_OAUTH_TOKEN", newToken)
    yield* logToConsole("roci", "cli", "New OAuth token saved to .env")
    return true
  })
