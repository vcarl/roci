import { Effect } from "effect"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import type { ModelHandle } from "../model/handles.js"
import { Docker } from "../services/Docker.js"

/** OpenCode provider id for the local host model server. */
export const CONSCIOUS_PROVIDER_ID = "local"
/**
 * Display name for the conscious model inside the provider's `models` map.
 * NOTE: for an `@ai-sdk/openai-compatible` provider this is display-only — opencode
 * sends the map KEY (the real model id), never this `name`. It is also the agent
 * file basename / `--agent` value.
 */
export const CONSCIOUS_MODEL_KEY = "conscious"
/** Project-local agent name (file basename, `--agent` value). */
export const CONSCIOUS_AGENT_NAME = "conscious"

/**
 * The `-m` label opencode resolves: `<provider>/<real-model-id>`. opencode splits the
 * provider on the FIRST slash, so the multi-slash real id (e.g.
 * `mlx-community/Qwen3.5-122B-A10B-4bit`) is preserved as the model part and the API
 * `model` field sent to mlx is the real id. This MUST match the provider map key
 * registered in `buildProviderConfigJson`.
 */
export const consciousModelLabel = (handle: ModelHandle): string =>
  `${CONSCIOUS_PROVIDER_ID}/${handle.model}`
/** Global (per-container) OpenCode config path. */
export const GLOBAL_OPENCODE_CONFIG_PATH = "/home/node/.config/opencode/opencode.jsonc"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0"])

/** Rewrite a host-loopback base URL to the container's route to the host. */
export function hostInternalBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (LOOPBACK_HOSTS.has(url.hostname)) {
    url.hostname = "host.docker.internal"
  }
  return url.toString().replace(/\/$/, baseUrl.endsWith("/") ? "/" : "")
}

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
  return `---\nmode: primary\nmodel: ${model}\n---\n\n${opts.systemPrompt}\n${frontier}\n`
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
