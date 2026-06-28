import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  hostInternalBaseUrl,
  buildProviderConfigJson,
  buildCharacterAgentMarkdown,
  consciousModelLabel,
  GLOBAL_OPENCODE_CONFIG_PATH,
  provisionConsciousProvider,
  writeCharacterAgentFile,
} from "./opencode-config.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import { Docker } from "../services/Docker.js"

/** Handle-derived `-m` label for the default conscious model — what all callers must use. */
const LABEL = consciousModelLabel(DEFAULT_CORTEX_MODELS.conscious)

describe("hostInternalBaseUrl", () => {
  it("rewrites host loopback to host.docker.internal, preserving port and path", () => {
    expect(hostInternalBaseUrl("http://127.0.0.1:8083/v1")).toBe("http://host.docker.internal:8083/v1")
    expect(hostInternalBaseUrl("http://localhost:8083/v1")).toBe("http://host.docker.internal:8083/v1")
    expect(hostInternalBaseUrl("http://0.0.0.0:8083/v1")).toBe("http://host.docker.internal:8083/v1")
  })
  it("leaves a non-loopback host unchanged", () => {
    expect(hostInternalBaseUrl("http://10.0.0.5:8083/v1")).toBe("http://10.0.0.5:8083/v1")
  })
})

describe("buildProviderConfigJson", () => {
  const json = buildProviderConfigJson(DEFAULT_CORTEX_MODELS.conscious)
  const parsed = JSON.parse(json)
  it("keeps the permission bypass", () => {
    expect(parsed.permission).toEqual({ "*": "allow" })
  })
  it("declares the openai-compatible local provider at the host-internal URL", () => {
    expect(parsed.provider.local.npm).toBe("@ai-sdk/openai-compatible")
    expect(parsed.provider.local.options.baseURL).toBe("http://host.docker.internal:8083/v1")
    expect(parsed.provider.local.options.apiKey).toBeTruthy()
  })
  it("registers the model under the REAL model id as the key (what opencode sends as the API model field)", () => {
    const realId = DEFAULT_CORTEX_MODELS.conscious.model
    // The map KEY is what opencode sends as the `model` field for an
    // openai-compatible provider. It MUST be the real mlx-served id, NOT "conscious".
    expect(parsed.provider.local.models[realId]).toBeDefined()
    expect(parsed.provider.local.models.conscious).toBeUndefined()
    // The display `name` is not sent to the server; keep it human-friendly.
    expect(parsed.provider.local.models[realId].name).toBe("conscious")
  })
})

describe("consciousModelLabel", () => {
  it("builds the -m label from the provider id and the REAL handle model id", () => {
    expect(consciousModelLabel(DEFAULT_CORTEX_MODELS.conscious)).toBe(
      `local/${DEFAULT_CORTEX_MODELS.conscious.model}`,
    )
    // Concretely the multi-slash form opencode parses (provider split on first slash).
    expect(consciousModelLabel(DEFAULT_CORTEX_MODELS.conscious)).toBe(
      "local/mlx-community/gemma-4-31b-it-8bit",
    )
  })
})

describe("buildCharacterAgentMarkdown", () => {
  it("emits frontmatter with mode/model and the system prompt as the body", () => {
    const label = consciousModelLabel(DEFAULT_CORTEX_MODELS.conscious)
    const md = buildCharacterAgentMarkdown({ systemPrompt: "You are Ada.", modelLabel: label })
    expect(md).toContain("mode: primary")
    expect(md).toContain(`model: ${label}`)
    expect(md).toContain("You are Ada.")
  })

  it("frontmatter model is the handle-derived label (real id), not 'local/conscious'", () => {
    const label = consciousModelLabel(DEFAULT_CORTEX_MODELS.conscious)
    const md = buildCharacterAgentMarkdown({ systemPrompt: "You are Ada.", modelLabel: label })
    expect(md).toContain(`model: local/${DEFAULT_CORTEX_MODELS.conscious.model}`)
    expect(md).not.toContain("model: local/conscious")
  })

  it("teaches the frontier start/poll/steer/wait tool workflow", () => {
    const md = buildCharacterAgentMarkdown({ systemPrompt: "You are Ada.", modelLabel: LABEL })
    expect(md).toContain("frontier")
    expect(md).toMatch(/frontier start/)
    expect(md).toMatch(/frontier poll/)
    expect(md).toMatch(/frontier steer/)
    expect(md).toMatch(/frontier wait/)
  })
})

describe("provisionConsciousProvider", () => {
  it("execs a command that writes the provider config to the global path", async () => {
    const calls: string[][] = []
    const StubDocker = Layer.succeed(
      Docker,
      Docker.of({
        exec: (_id: string, command: string[]) => {
          calls.push(command)
          return Effect.succeed("")
        },
      } as unknown as typeof Docker.Service),
    )

    await Effect.runPromise(
      Effect.provide(provisionConsciousProvider("cabc", DEFAULT_CORTEX_MODELS.conscious), StubDocker),
    )

    const joined = calls.flat().join(" ")
    expect(joined).toContain(GLOBAL_OPENCODE_CONFIG_PATH)
    // base64 of the generated config is present in the exec command
    const b64 = Buffer.from(buildProviderConfigJson(DEFAULT_CORTEX_MODELS.conscious)).toString("base64")
    expect(joined).toContain(b64)
  })
})

describe("writeCharacterAgentFile", () => {
  it("writes the agent markdown read-only into the character's .opencode dir", () => {
    const playersDir = mkdtempSync(path.join(tmpdir(), "roci-players-"))
    writeCharacterAgentFile({ playersDir, playerName: "ada", systemPrompt: "You are Ada.", modelLabel: LABEL })
    const file = path.join(playersDir, "ada", ".opencode", "agent", "conscious.md")
    expect(readFileSync(file, "utf8")).toContain("You are Ada.")
    expect(statSync(file).mode & 0o222).toBe(0) // no write bits
  })
  it("is re-runnable even though the previous file is read-only", () => {
    const playersDir = mkdtempSync(path.join(tmpdir(), "roci-players-"))
    writeCharacterAgentFile({ playersDir, playerName: "ada", systemPrompt: "v1", modelLabel: LABEL })
    writeCharacterAgentFile({ playersDir, playerName: "ada", systemPrompt: "v2", modelLabel: LABEL })
    const file = path.join(playersDir, "ada", ".opencode", "agent", "conscious.md")
    expect(readFileSync(file, "utf8")).toContain("v2")
  })

  it("second write overwrites with new content and restores 0o444", () => {
    const playersDir = mkdtempSync(path.join(tmpdir(), "roci-players-"))
    writeCharacterAgentFile({ playersDir, playerName: "ada", systemPrompt: "v1", modelLabel: LABEL })
    writeCharacterAgentFile({ playersDir, playerName: "ada", systemPrompt: "v2", modelLabel: LABEL })
    const file = path.join(playersDir, "ada", ".opencode", "agent", "conscious.md")
    expect(readFileSync(file, "utf8")).toContain("v2")
    expect(readFileSync(file, "utf8")).not.toContain("v1")
    expect(statSync(file).mode & 0o222).toBe(0) // read-only after second write
  })

  it("shell-special-char system prompt round-trips through buildCharacterAgentMarkdown and writeCharacterAgentFile", () => {
    const special = `He said "hello $USER" and \`echo hi\` was tried`
    const md = buildCharacterAgentMarkdown({ systemPrompt: special, modelLabel: LABEL })
    expect(md).toContain(special)
    const playersDir = mkdtempSync(path.join(tmpdir(), "roci-players-"))
    writeCharacterAgentFile({ playersDir, playerName: "ada", systemPrompt: special, modelLabel: LABEL })
    const file = path.join(playersDir, "ada", ".opencode", "agent", "conscious.md")
    expect(readFileSync(file, "utf8")).toContain(special)
  })
})

describe("buildCharacterAgentMarkdown frontier section", () => {
  const md = buildCharacterAgentMarkdown({ systemPrompt: "You are Ada.", modelLabel: LABEL })
  it("teaches the optional --model selector on frontier start", () => {
    expect(md).toContain('frontier start [--model <name>]')
  })
  it("guides the mind to pick a model by difficulty/cost", () => {
    expect(md).toMatch(/haiku|sonnet/)
    expect(md).toContain("opus")
  })
  it("keeps the laundering instruction (never paste raw event text)", () => {
    expect(md).toContain("never paste raw incoming event text")
  })
})
