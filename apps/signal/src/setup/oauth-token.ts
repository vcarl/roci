import { Effect } from "effect"
import { Prompt } from "@effect/cli"
import { logToConsole } from "@signal/core/logging/console-renderer.js"
import {
  loadSavedToken,
  saveToken,
  extractTokenFromOutput,
  runSetupToken,
  isClaudeCliAvailable,
} from "@signal/core/services/oauth-token.js"

export {
  loadSavedToken,
  saveToken,
  extractTokenFromOutput,
  runSetupToken,
  isClaudeCliAvailable,
} from "@signal/core/services/oauth-token.js"

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
