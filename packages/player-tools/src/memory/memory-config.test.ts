import { describe, it, expect } from "vitest"
import {
  resolveMemoryConfig,
  DEFAULT_MEMORY_DB_PATH,
  DEFAULT_MEMORY_VEC_EXT,
} from "./memory-config.js"

describe("resolveMemoryConfig", () => {
  it("throws (loud) when MEMORY_EMBED_URL is unset", () => {
    expect(() => resolveMemoryConfig({})).toThrow(/MEMORY_EMBED_URL is required/)
  })

  it("uses the required embed URL verbatim and defaults db/ext", () => {
    const cfg = resolveMemoryConfig({
      MEMORY_EMBED_URL: "http://host.docker.internal:8084/v1/embeddings",
    })
    expect(cfg.embedUrl).toBe("http://host.docker.internal:8084/v1/embeddings")
    expect(cfg.dbPath).toBe(DEFAULT_MEMORY_DB_PATH)
    expect(cfg.vecExt).toBe(DEFAULT_MEMORY_VEC_EXT)
  })

  it("honors overrides for db path and extension path", () => {
    const cfg = resolveMemoryConfig({
      MEMORY_EMBED_URL: "http://x/embeddings",
      MEMORY_DB_PATH: "custom/longterm.db",
      MEMORY_VEC_EXT: "/opt/vec0.so",
    })
    expect(cfg.dbPath).toBe("custom/longterm.db")
    expect(cfg.vecExt).toBe("/opt/vec0.so")
  })
})
