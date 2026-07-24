import { describe, it, expect } from "vitest"
import * as path from "node:path"
import {
  buildLlamaArgs,
  resolveLlamaServerCommand,
  resolveGgufPath,
  LLAMA_SERVER_BIN,
  LLAMA_SERVER_FALLBACK,
  GGUF_MODEL_DIR,
  GGUF_QUANT_FILE,
} from "./llamacpp-backend.js"
import { resolveTierSpec } from "./model-tier-spec.js"

// buildLlamaArgs is a PURE arg builder: given the resolved TierSpec and the
// absolute .gguf path, it emits the exact llama-server argv. The CRITICAL
// invariant is `--alias === spec.model`: the shared readiness probe requires the
// server to echo response.model === spec.model, and llama-server reports its
// `--alias` there. A mismatch means the resident conscious never goes ready and
// hard-fails the whole model layer at boot.
describe("buildLlamaArgs", () => {
  const spec = resolveTierSpec("conscious")
  const gguf = "/models/gpt-oss-20b-Q8_0.gguf"

  it("emits the exact llama-server argv for the conscious tier", () => {
    expect(buildLlamaArgs(spec, gguf)).toEqual([
      "-m", gguf,
      "--host", "127.0.0.1",
      "--port", "8083",
      "--alias", spec.model,
      "-c", "32768",
      "-ngl", "99",
      "--jinja",
      "--reasoning-format", "deepseek",
    ])
  })

  it("sets --alias to EXACTLY spec.model (the readiness-probe model-match contract)", () => {
    const args = buildLlamaArgs(spec, gguf)
    const aliasIdx = args.indexOf("--alias")
    expect(aliasIdx).toBeGreaterThanOrEqual(0)
    expect(args[aliasIdx + 1]).toBe(spec.model)
  })

  it("threads the resolved port and gguf path through", () => {
    const args = buildLlamaArgs(spec, gguf)
    expect(args[args.indexOf("-m") + 1]).toBe(gguf)
    expect(args[args.indexOf("--port") + 1]).toBe(String(spec.port))
  })

  it("routes reasoning to the final channel via --reasoning-format deepseek and a 32768 context", () => {
    const args = buildLlamaArgs(spec, gguf)
    expect(args[args.indexOf("--reasoning-format") + 1]).toBe("deepseek")
    expect(args[args.indexOf("-c") + 1]).toBe("32768")
  })
})

// resolveLlamaServerCommand decides WHICH llama-server binary to spawn from an
// injected env + existence check, so it is unit-testable without spawning.
describe("resolveLlamaServerCommand", () => {
  it("honors the ROCI_LLAMA_SERVER override when set", () => {
    const custom = "/opt/custom/llama-server"
    const res = resolveLlamaServerCommand(
      { ROCI_LLAMA_SERVER: custom, PATH: "/usr/bin" },
      () => true,
    )
    expect(res.found).toBe(true)
    if (res.found) expect(res.command).toBe(custom)
  })

  it("falls back to the bare command when it is resolvable on PATH", () => {
    const onPath = path.join("/usr/local/bin", LLAMA_SERVER_BIN)
    const res = resolveLlamaServerCommand({ PATH: "/usr/local/bin" }, (p) => p === onPath)
    expect(res.found).toBe(true)
    if (res.found) expect(res.command).toBe(LLAMA_SERVER_BIN)
  })

  it("falls back to the homebrew path when not on PATH but present there", () => {
    const res = resolveLlamaServerCommand({ PATH: "/usr/bin" }, (p) => p === LLAMA_SERVER_FALLBACK)
    expect(res.found).toBe(true)
    if (res.found) expect(res.command).toBe(LLAMA_SERVER_FALLBACK)
  })

  it("reports not-found when no override, no PATH match, and no homebrew binary", () => {
    const res = resolveLlamaServerCommand({ PATH: "/usr/bin" }, () => false)
    expect(res.found).toBe(false)
  })
})

// resolveGgufPath globs the HF snapshots dir for the Q8_0 .gguf. It injects the
// env, homedir, and the glob-match seam so it never touches the real 22GB file.
describe("resolveGgufPath", () => {
  const home = "/home/tester"
  const snapshotsGlob = path.join(
    home,
    ".cache/huggingface/hub",
    GGUF_MODEL_DIR,
    "snapshots",
    "*",
    GGUF_QUANT_FILE,
  )

  it("honors the ROCI_CONSCIOUS_GGUF override when set", () => {
    const custom = "/models/my-gpt-oss.gguf"
    const res = resolveGgufPath({ ROCI_CONSCIOUS_GGUF: custom }, home, () => [])
    expect(res.found).toBe(true)
    if (res.found) expect(res.path).toBe(custom)
  })

  it("resolves the sole match under snapshots/*", () => {
    const match = path.join(
      home,
      ".cache/huggingface/hub",
      GGUF_MODEL_DIR,
      "snapshots",
      "abc123",
      GGUF_QUANT_FILE,
    )
    const res = resolveGgufPath({}, home, (pattern) =>
      pattern === snapshotsGlob ? [match] : [],
    )
    expect(res.found).toBe(true)
    if (res.found) expect(res.path).toBe(match)
  })

  it("picks the first (newest-first) match when several snapshots exist", () => {
    const newer = path.join(home, ".cache/huggingface/hub", GGUF_MODEL_DIR, "snapshots", "newer", GGUF_QUANT_FILE)
    const older = path.join(home, ".cache/huggingface/hub", GGUF_MODEL_DIR, "snapshots", "older", GGUF_QUANT_FILE)
    const res = resolveGgufPath({}, home, () => [newer, older])
    expect(res.found).toBe(true)
    if (res.found) expect(res.path).toBe(newer)
  })

  it("reports not-found (naming the searched glob) when no snapshot has the gguf", () => {
    const res = resolveGgufPath({}, home, () => [])
    expect(res.found).toBe(false)
    if (!res.found) expect(res.searchedGlob).toBe(snapshotsGlob)
  })
})
