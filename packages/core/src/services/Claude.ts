import { Context, Effect, Layer, Stream, Chunk } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs"
import * as process from "node:process"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { OAuthToken } from "./OAuthToken.js"

export type ClaudeModel = "opus" | "sonnet" | "haiku"

/** Any model string — Anthropic models or OpenRouter model IDs (e.g. "nvidia/nemotron-3-nano-30b-a3b:free"). */
export type AnyModel = ClaudeModel | (string & Record<never, never>)

export const ANTHROPIC_MODELS = new Set(["opus", "sonnet", "haiku"])
const OPENROUTER_BASE = "https://openrouter.ai/api/v1"
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? ""

export class ClaudeError {
  readonly _tag = "ClaudeError"
  constructor(readonly message: string, readonly cause?: unknown) {}
  toString() { return this.message }
}

/**
 * Call OpenRouter API directly (no claude CLI needed).
 * Returns the assistant content string.
 * Exported for use by process-runner (brain turns with non-Anthropic models).
 */
export async function callOpenRouter(opts: {
  prompt: string
  model: string
  systemPrompt?: string
  timeoutMs?: number
  maxTokens?: number
}): Promise<string> {
  const messages: Array<{ role: string; content: string }> = []
  if (opts.systemPrompt) {
    messages.push({ role: "system", content: opts.systemPrompt })
  }
  messages.push({ role: "user", content: opts.prompt })

  const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: opts.model, messages, max_tokens: opts.maxTokens ?? 4096 }),
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`OpenRouter ${resp.status}: ${body.slice(0, 300)}`)
  }

  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string | null } }>
    error?: { message?: string }
  }

  if (data.error) {
    throw new Error(`OpenRouter error: ${data.error.message ?? JSON.stringify(data.error)}`)
  }

  const content = data.choices?.[0]?.message?.content
  if (content == null) {
    throw new Error(`OpenRouter returned no content: ${JSON.stringify(data).slice(0, 200)}`)
  }

  return content
}

export class Claude extends Context.Tag("Claude")<
  Claude,
  {
    /**
     * Invoke a model on the **host** machine (not inside a Docker container).
     *
     * Anthropic models ("opus" | "sonnet" | "haiku") use claude -p.
     * Any other model string routes to OpenRouter via HTTP (requires OPENROUTER_API_KEY env var).
     *
     * This is intended **only for orchestrator-internal tasks** that don't need
     * tool access or container context:
     *   - Memory consolidation (dream/diary compression)
     *   - Timeout summarization
     *   - End-of-session reflection
     *
     * **Domain logic (planning, evaluation, execution) should NOT use this.**
     * Use runTurn from process-runner.ts instead.
     */
    readonly invoke: (opts: {
      prompt: string
      model: AnyModel
      systemPrompt?: string
      outputFormat?: "text" | "json" | "stream-json"
      maxTurns?: number
    }) => Effect.Effect<string, ClaudeError>
  }
>() {}

/**
 * Write content to a temp file, returning its path.
 * Caller is responsible for cleanup.
 */
function writeTempFile(prefix: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "roci-"))
  const filePath = path.join(dir, `${prefix}.txt`)
  writeFileSync(filePath, content)
  return filePath
}

function cleanupTempFile(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch {
    // ignore
  }
}

/**
 * Return a shell-safe literal using $'...' ANSI-C quoting.
 * Escapes backslashes, single quotes, and control characters so the
 * result can be embedded directly in a bash command string.
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

export const ClaudeLive = Layer.effect(
  Claude,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor
    const oauthToken = yield* OAuthToken

    return Claude.of({
      invoke: (opts) => {
        // Route to OpenRouter for non-Anthropic models
        if (!ANTHROPIC_MODELS.has(opts.model)) {
          if (!OPENROUTER_API_KEY) {
            return Effect.fail(new ClaudeError(
              `OpenRouter model "${opts.model}" requested but OPENROUTER_API_KEY is not set`
            ))
          }
          return Effect.promise(() => callOpenRouter({
            prompt: opts.prompt,
            model: opts.model,
            systemPrompt: opts.systemPrompt,
          })).pipe(
            Effect.mapError((e) => new ClaudeError(`OpenRouter invocation failed: ${e}`, e)),
          )
        }

        // Anthropic model — use claude -p
        return Effect.scoped(
          Effect.gen(function* () {
            const promptFile = writeTempFile("prompt", opts.prompt)

            const { token } = yield* oauthToken.getToken

            const args: string[] = [
              "--model", opts.model,
              "--output-format", opts.outputFormat ?? "text",
              "--dangerously-skip-permissions",
              "--no-session-persistence",
            ]

            // Disable thinking for non-opus models
            if (opts.model !== "opus") {
              args.push("--effort", "low")
            }

            if (opts.maxTurns) {
              args.push("--max-turns", String(opts.maxTurns))
            }

            // Build the shell command: pipe prompt via stdin
            // Unset CLAUDECODE to allow running from within a Claude Code session
            // System prompt goes via temp file too if present
            const envPrefix = `CLAUDE_CODE_OAUTH_TOKEN=${shellEscape(token)} `
            let shellCmd: string
            if (opts.systemPrompt) {
              const sysFile = writeTempFile("system", opts.systemPrompt)
              shellCmd = `unset CLAUDECODE; ${envPrefix}cat ${shellEscape(promptFile)} | claude -p ${args.join(" ")} --system-prompt "$(cat ${shellEscape(sysFile)})" ; r=$?; rm -rf ${shellEscape(path.dirname(sysFile))}; exit $r`
            } else {
              shellCmd = `unset CLAUDECODE; ${envPrefix}cat ${shellEscape(promptFile)} | claude -p ${args.join(" ")}`
            }

            const cmd = Command.make("bash", "-c", shellCmd)
            const process = yield* executor.start(cmd)

            const stdout = yield* process.stdout.pipe(
              Stream.decodeText(),
              Stream.runCollect,
              Effect.map(Chunk.join("")),
            )

            const stderr = yield* process.stderr.pipe(
              Stream.decodeText(),
              Stream.runCollect,
              Effect.map(Chunk.join("")),
            )

            const exitCode = yield* process.exitCode

            cleanupTempFile(promptFile)

            if (exitCode !== 0) {
              return yield* Effect.fail(
                new ClaudeError(
                  `claude exited with code ${exitCode}: ${stderr.trim().slice(0, 500)}`,
                ),
              )
            }

            if (!stdout.trim()) {
              return yield* Effect.fail(
                new ClaudeError(
                  `claude returned empty output. stderr: ${stderr.trim().slice(0, 500)}`,
                ),
              )
            }

            return stdout
          }),
        ).pipe(
          Effect.mapError((e) =>
            e instanceof ClaudeError ? e : new ClaudeError("Claude invocation failed", e),
          ),
        )
      },
    })
  }),
)
