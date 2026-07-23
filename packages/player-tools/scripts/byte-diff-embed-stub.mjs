/**
 * Deterministic stub embed server for the phase-3 byte-diff gate
 * (byte-diff-gate.mjs). Run as a SEPARATE process — the gate harness drives
 * docker over synchronous `spawnSync`, which blocks its event loop, so an
 * in-process server could not accept the container's embed fetch mid-exec.
 *
 * Serves an OpenAI-shape `POST /v1/embeddings` returning a FIXED function of the
 * input text (FNV-1a seed → mulberry32 → 384 floats in [-1,1]). Both CLIs POST
 * the identical `{input:text}`, so both get the identical vector → identical
 * distances → identical KNN ordering + score formatting.
 *
 *   node byte-diff-embed-stub.mjs <port>
 *
 * Prints "stub up on 0.0.0.0:<port>" to stdout once listening. Binds IPv4 so the
 * container reaches it via `--add-host=host.docker.internal:host-gateway`.
 */

import { createServer } from "node:http"

const EMBED_DIM = 384
const PORT = Number(process.argv[2] || 8199)

function embedVector(text) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  let a = h >>> 0
  const out = new Array(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    out[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
  return out
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/v1/embeddings")) {
    res.writeHead(404).end()
    return
  }
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    let input = ""
    try {
      const j = JSON.parse(body || "{}")
      input = Array.isArray(j.input) ? j.input[0] : (j.input ?? j.text ?? "")
    } catch {
      input = ""
    }
    const payload = JSON.stringify({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: embedVector(String(input)) }],
      model: "stub-deterministic",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    })
    res.writeHead(200, { "Content-Type": "application/json" }).end(payload)
  })
})

server.listen(PORT, "0.0.0.0", () => console.log(`stub up on 0.0.0.0:${PORT}`))
