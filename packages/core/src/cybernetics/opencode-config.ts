import type { ModelHandle } from "../model/handles.js"

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
  return `---\nmode: primary\nmodel: ${model}\n---\n\n${opts.systemPrompt}\n`
}
