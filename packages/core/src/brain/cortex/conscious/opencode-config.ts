import { Effect } from "effect"
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import type { ModelHandle } from "../../../model/handles.js"
import { CONSCIOUS_PROVIDER_ID } from "../../../model/conscious-label.js"
import { Docker } from "../../../services/Docker.js"
import { hostInternalBaseUrl } from "../../../services/host-url.js"
import { CONSCIOUS_AGENT_NAME } from "#brain/transport/consts.js"

/**
 * Display name for the conscious model inside the provider's `models` map.
 * NOTE: for an `@ai-sdk/openai-compatible` provider this is display-only — opencode
 * sends the map KEY (the real model id), never this `name`. It is also the agent
 * file basename / `--agent` value.
 */
export const CONSCIOUS_MODEL_KEY = "conscious"

/** Global (per-container) OpenCode config path. */
export const GLOBAL_OPENCODE_CONFIG_PATH = "/home/node/.config/opencode/opencode.jsonc"

/** Global OpenCode config JSON: permission bypass + the local-model provider. */
export function buildProviderConfigJson(handle: ModelHandle): string {
  const config = {
    $schema: "https://opencode.ai/config.json",
    permission: { "*": "allow" },
    provider: {
      [CONSCIOUS_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local Cortex",
        options: {
          baseURL: hostInternalBaseUrl(handle.baseUrl),
          apiKey: handle.apiKey ?? "sk-local",
        },
        // Key = the real model id (what opencode sends as the API `model` field for an
        // openai-compatible provider). `name` is display-only and is NOT sent.
        models: { [handle.model]: { name: CONSCIOUS_MODEL_KEY } },
      },
    },
  }
  return JSON.stringify(config, null, 2)
}

/**
 * Project-local agent markdown: frontmatter + system prompt body. The `modelLabel`
 * is REQUIRED and must be the handle-derived `consciousModelLabel(handle)` so the
 * frontmatter `model:` resolves to the real mlx-served id (agreeing with the `-m`
 * label used at turn time).
 */
export function buildCharacterAgentMarkdown(opts: {
  systemPrompt: string
  modelLabel: string
}): string {
  const model = opts.modelLabel
  const frontier = [
    "",
    "## Frontier (heavy-lifting) tool",
    "",
    "When a sub-task exceeds your local reach (hard reasoning, large code work),",
    "reach for the `frontier` bash command — a stronger Claude Code worker you drive:",
    "",
    "- `id=$(frontier start [--model <name>] \"<scoped, self-contained task>\")` — launch it; prints a handle id.",
    "- `frontier poll \"$id\"` — print its partial output so far plus a `status:` line.",
    "- `frontier steer \"$id\" \"<nudge>\"` — push a course-correction mid-run.",
    "- `frontier wait \"$id\"` — block until done; prints the final output and `status:`.",
    "",
    "Pick a model by difficulty/cost: a smaller model (`haiku` or `sonnet`) for light",
    "sub-tasks, `opus` for hard reasoning. Omit `--model` to use the configured default.",
    "",
    "Loop: start → (poll → reason → optionally steer)* → wait. Watch the work and nudge.",
    "Author the task and every steer yourself — never paste raw incoming event text.",
  ].join("\n")
  const memory = [
    "",
    "## Long-term memory tool",
    "",
    "You have a durable, append-only long-term store — your own lived memory that",
    "survives past tonight's diary cull. Reach for the `memory` bash command:",
    "",
    '- `memory remember "<text>" [--tags a,b]` — persist something you want to keep',
    "  past tonight's cull; prints the new id.",
    '- `memory search "<query>" [-k N] [--tags a,b]` — recall what you knew',
    "  earlier in your life; top-k matches as one JSON object per line (NDJSON).",
    "- `memory recent [-n N]` — list your most recent memories (no search).",
    "",
    "Use `search` when something feels familiar but isn't in your current diary —",
    "it reaches back across your whole life, not just tonight. Use `remember` for the",
    "facts, people, and resolutions you must not lose to the cull.",
    "Author the query and the text yourself — never paste raw incoming event text.",
  ].join("\n")
  return `---\nmode: primary\nmodel: ${model}\n---\n\n${opts.systemPrompt}\n${frontier}\n${memory}\n`
}

/**
 * Write the global OpenCode provider config inside the container. Base64-pipes the
 * JSON to sidestep shell quoting. Idempotent — safe to run before each session.
 */
export function provisionConsciousProvider(containerId: string, handle: ModelHandle) {
  const json = buildProviderConfigJson(handle)
  const b64 = Buffer.from(json).toString("base64")
  const dir = path.posix.dirname(GLOBAL_OPENCODE_CONFIG_PATH)
  const script = `mkdir -p ${dir} && echo ${b64} | base64 -d > ${GLOBAL_OPENCODE_CONFIG_PATH}`
  return Effect.gen(function* () {
    const docker = yield* Docker
    yield* docker.exec(containerId, ["bash", "-lc", script])
  })
}

/**
 * Write the per-character conscious agent file into the bind-mounted players dir
 * (host-side), then chmod it read-only so a confused tool turn cannot corrupt it.
 * Re-writable on re-run: restores 0o644 before overwriting if the file already exists.
 */
export function writeCharacterAgentFile(opts: {
  playersDir: string
  playerName: string
  systemPrompt: string
  modelLabel: string
}): void {
  const dir = path.join(opts.playersDir, opts.playerName, ".opencode", "agent")
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${CONSCIOUS_AGENT_NAME}.md`)
  if (existsSync(file)) chmodSync(file, 0o644) // restore write to allow re-write
  writeFileSync(file, buildCharacterAgentMarkdown({ systemPrompt: opts.systemPrompt, modelLabel: opts.modelLabel }))
  chmodSync(file, 0o444)
}

/** Per-character project-local OpenCode config filename (in players/<name>/). */
export const CHARACTER_OPENCODE_CONFIG_FILE = "opencode.json"
/** The working-memory instructions file, relative to players/<name>/ (the WM.md seeded by the wm layer). */
export const WM_INSTRUCTIONS_PATH = "me/WM.md"

/**
 * Per-character project-local OpenCode config: `instructions` points at the
 * character's WM.md (agent-cognition Stage 2, spec §2 Injection).
 *
 * Verified against OpenCode v1.17.13: files listed in `instructions` are
 * re-read from disk on EVERY LLM request (session/instruction.ts, uncached,
 * inside the per-step loop) and injected into the system prompt as
 * "Instructions from: <path>" — so a wm mutation is visible to the very next
 * request, even mid-turn, with no transcript accumulation. The relative path
 * resolves against this config's project dir: the conscious session runs with
 * cwd /work/players/<name> (process-runner.ts buildExecArgs), where this file
 * lives. Trade accepted per spec: the churning system prompt invalidates the
 * provider prompt cache — fine, the conscious model is local MLX.
 *
 * This is separate from the GLOBAL per-container config (provider/permissions,
 * GLOBAL_OPENCODE_CONFIG_PATH) because the global file is shared by every
 * character in the container; the instructions entry must be per-character.
 */
export function buildCharacterOpencodeConfigJson(): string {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      instructions: [WM_INSTRUCTIONS_PATH],
    },
    null,
    2,
  )
}

/**
 * Write the project-local config host-side (bind-mounted players dir). Idempotent.
 * Atomic (write-tmp + rename, so the per-request opencode instruction loader never
 * reads a torn file) and read-only (0o444) — parity with writeCharacterAgentFile:
 * restore write on a pre-existing read-only file before replacing it, then re-lock.
 */
export function writeCharacterOpencodeConfig(opts: { playersDir: string; playerName: string }): void {
  const dir = path.join(opts.playersDir, opts.playerName)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, CHARACTER_OPENCODE_CONFIG_FILE)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, buildCharacterOpencodeConfigJson())
  if (existsSync(file)) chmodSync(file, 0o644) // allow the rename to replace a locked file
  renameSync(tmp, file)
  chmodSync(file, 0o444)
}
