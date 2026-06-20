import { Effect } from "effect"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import type { ModelHandle } from "../model/handles.js"
import { Docker } from "../services/Docker.js"

/** OpenCode provider id for the local host model server. */
export const CONSCIOUS_PROVIDER_ID = "local"
/** Model key inside the provider's `models` map. */
export const CONSCIOUS_MODEL_KEY = "conscious"
/** `-m` label: `<provider>/<model-key>`. */
export const CONSCIOUS_MODEL_LABEL = `${CONSCIOUS_PROVIDER_ID}/${CONSCIOUS_MODEL_KEY}`
/** Project-local agent name (file basename, `--agent` value). */
export const CONSCIOUS_AGENT_NAME = "conscious"
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
        models: { [CONSCIOUS_MODEL_KEY]: { name: handle.model } },
      },
    },
  }
  return JSON.stringify(config, null, 2)
}

/** Project-local agent markdown: frontmatter + system prompt body. */
export function buildCharacterAgentMarkdown(opts: {
  systemPrompt: string
  modelLabel?: string
}): string {
  const model = opts.modelLabel ?? CONSCIOUS_MODEL_LABEL
  const frontier = [
    "",
    "## Frontier (heavy-lifting) tool",
    "",
    "When a sub-task exceeds your local reach (hard reasoning, large code work),",
    "reach for the `frontier` bash command — a stronger Claude Code worker you drive:",
    "",
    "- `id=$(frontier start \"<scoped, self-contained task>\")` — launch it; prints a handle id.",
    "- `frontier poll \"$id\"` — print its partial output so far plus a `status:` line.",
    "- `frontier steer \"$id\" \"<nudge>\"` — push a course-correction mid-run.",
    "- `frontier wait \"$id\"` — block until done; prints the final output and `status:`.",
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
  modelLabel?: string
}): void {
  const dir = path.join(opts.playersDir, opts.playerName, ".opencode", "agent")
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${CONSCIOUS_AGENT_NAME}.md`)
  if (existsSync(file)) chmodSync(file, 0o644) // restore write to allow re-write
  writeFileSync(file, buildCharacterAgentMarkdown({ systemPrompt: opts.systemPrompt, modelLabel: opts.modelLabel }))
  chmodSync(file, 0o444)
}
