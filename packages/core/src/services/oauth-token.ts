import { readFileSync, writeFileSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import * as path from "node:path"

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

