import { describe, it, expect } from "vitest"
import {
  hostInternalBaseUrl,
  buildProviderConfigJson,
  buildCharacterAgentMarkdown,
  CONSCIOUS_MODEL_LABEL,
} from "./opencode-config.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"

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
  it("registers the conscious model key", () => {
    expect(parsed.provider.local.models.conscious).toBeDefined()
  })
})

describe("buildCharacterAgentMarkdown", () => {
  it("emits frontmatter with mode/model and the system prompt as the body", () => {
    const md = buildCharacterAgentMarkdown({ systemPrompt: "You are Ada." })
    expect(md).toContain("mode: primary")
    expect(md).toContain(`model: ${CONSCIOUS_MODEL_LABEL}`)
    expect(md.trimEnd().endsWith("You are Ada.")).toBe(true)
  })
})
