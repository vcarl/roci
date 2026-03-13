import { Effect } from "effect"
import { Prompt } from "@effect/cli"
import { readFileSync, writeFileSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import * as path from "node:path"
import { logToConsole } from "../logging/console-renderer.js"
import { DockerError } from "../services/Docker.js"

export const TOKEN_FILENAME = ".oauth-token"

/**
 * Extract an OAuth token from `claude setup-token` stdout.
 * Two-pass heuristic: first scan for `sk-ant-` prefix, then fallback to
 * any non-empty line with no spaces (likely a raw token).
 */
export function extractTokenFromOutput(stdout: string): string | undefined {
  // claude setup-token outputs the token between blank lines, possibly wrapped:
  //   ...token (valid for 1 year):\n\nsk-ant-oat01-...\n\nStore this token...
  // Split on blank lines, find the paragraph containing sk-ant-, strip inner newlines.
  const paragraphs = stdout.split(/\n\n+/)
  for (const para of paragraphs) {
    if (para.includes("sk-ant-")) {
      return para.replace(/\n/g, "").trim()
    }
  }
  return undefined
}

/**
 * Load a saved OAuth token from `<projectRoot>/.oauth-token`.
 * Returns the trimmed contents or undefined if the file doesn't exist.
 */
export function loadSavedToken(projectRoot: string): string | undefined {
  try {
    const content = readFileSync(path.resolve(projectRoot, TOKEN_FILENAME), "utf-8").trim()
    return content || undefined
  } catch {
    return undefined
  }
}

/**
 * Save an OAuth token to `<projectRoot>/.oauth-token`.
 */
export function saveToken(projectRoot: string, token: string): void {
  writeFileSync(path.resolve(projectRoot, TOKEN_FILENAME), token + "\n")
}

/**
 * Check if the `claude` CLI is installed and accessible.
 */
export function isClaudeCliAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/**
 * Run `claude setup-token` and return the status and stdout.
 */
export function runSetupToken(): { status: number; stdout: string } {
  const result = spawnSync("claude", ["setup-token"], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf-8",
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? "" }
}

/**
 * Ensure an OAuth token is available, acquiring one if necessary.
 * Tries the saved `.oauth-token` file first, then falls back to `claude setup-token`.
 * Returns the token string.
 */
export const ensureToken = (projectRoot: string) =>
  Effect.gen(function* () {
    const saved = loadSavedToken(projectRoot)
    if (saved) {
      yield* logToConsole("orchestrator", "main", "Loaded OAuth token from .oauth-token")
      return saved
    }

    if (!isClaudeCliAvailable()) {
      return yield* Effect.fail(
        new DockerError(
          "'claude' CLI is not installed or not in PATH. Install it with: npm install -g @anthropic-ai/claude-code",
        ),
      )
    }

    yield* logToConsole("orchestrator", "main", "Acquiring OAuth token via 'claude setup-token'...")
    const { status, stdout } = runSetupToken()
    if (status !== 0) {
      return yield* Effect.fail(
        new DockerError("'claude setup-token' failed. Is the 'claude' CLI installed?"),
      )
    }

    const token = extractTokenFromOutput(stdout)
    if (!token) {
      return yield* Effect.fail(
        new DockerError("Could not extract token from 'claude setup-token' output."),
      )
    }

    saveToken(projectRoot, token)
    yield* logToConsole("orchestrator", "main", "OAuth token saved to .oauth-token")
    return token
  })

/**
 * Interactive step for guided setup: ensure OAuth token is available.
 * If missing, prompts the user and runs `claude setup-token` to acquire one.
 */
export const ensureOAuthTokenInteractive = (projectRoot: string) =>
  Effect.gen(function* () {
    const saved = loadSavedToken(projectRoot)
    if (saved) {
      yield* logToConsole("setup", "cli", "OAuth token found.")
      return
    }

    yield* logToConsole("setup", "cli", "")
    yield* logToConsole("setup", "cli", "OAuth token is not set (.oauth-token not found).")
    yield* logToConsole("setup", "cli", "This token is required for Claude Code subagents running inside Docker containers.")

    if (!isClaudeCliAvailable()) {
      yield* logToConsole("setup", "cli", "")
      yield* logToConsole("setup", "cli", "ERROR: 'claude' CLI is not installed or not in PATH.")
      yield* logToConsole("setup", "cli", "Install it with: npm install -g @anthropic-ai/claude-code")
      yield* logToConsole("setup", "cli", "Then re-run setup, or manually place the token in .oauth-token")
      return
    }

    const runSetup: boolean = yield* Prompt.confirm({
      message: "Run 'claude setup-token' to acquire an OAuth token now?",
      initial: true,
    })

    if (!runSetup) {
      yield* logToConsole("setup", "cli", "Skipping token setup. You will need to place the token in .oauth-token before starting.")
      return
    }

    yield* logToConsole("setup", "cli", "Running 'claude setup-token'... Follow the prompts to authenticate.")
    yield* logToConsole("setup", "cli", "")

    const { status, stdout } = runSetupToken()
    let token: string | undefined
    if (status === 0) {
      token = extractTokenFromOutput(stdout)
    }

    if (!token) {
      yield* logToConsole("setup", "cli", "")
      yield* logToConsole("setup", "cli", "WARNING: Could not extract token from 'claude setup-token' output.")
      yield* logToConsole("setup", "cli", "You will need to manually place the token in .oauth-token")
      return
    }

    saveToken(projectRoot, token)
    yield* logToConsole("setup", "cli", "")
    yield* logToConsole("setup", "cli", "OAuth token saved to .oauth-token")
  })
