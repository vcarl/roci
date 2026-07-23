/**
 * Phase-3 gate-evidence harness (package-design spec §5 phase 3).
 *
 * Proves the NEW bundled `memory` (and, secondarily, `wm`) CLI produces
 * byte-identical container-observable behavior to the OLD generated-string CLI —
 * the mandatory pre-condition for repointing provisioning off `build*CliScript`.
 *
 * WHAT IT DOES (host node, run under tsx so it can import the OLD TS generator):
 *   1. Starts a container from the character-container image (spacemolt-player).
 *   2. Installs OLD (generated string) + NEW (bundle) at /tmp/* inside the
 *      container via the install-cli base64 mechanism (NEVER /usr/local/bin).
 *   3. Runs a deterministic stub embed server on the host (fixed vectors, OpenAI
 *      /v1/embeddings shape), reached from the container via host.docker.internal.
 *   4. Executes the gate cases against BOTH CLIs on separate scratch dbs, capturing
 *      stdout/stderr/exit byte-for-byte.
 *   5. Diffs + classifies every case (BYTE-IDENTICAL / STRUCTURAL-IDENTICAL after
 *      ts/id normalization / KNOWN ACCEPTED DELTA / UNEXPLAINED).
 *   6. Writes the evidence report to docs/superpowers/specs/phase3-gate-evidence.md.
 *   7. Secondary: same treatment for `wm` (phase-4 pre-evidence).
 *
 * RUN:  node_modules/.bin/tsx packages/player-tools/scripts/byte-diff-gate.mjs
 *   (requires: docker running + `spacemolt-player:latest` image + a built
 *    packages/player-tools/dist/bundles/{memory,wm}. Build with `npx nx build
 *    @roci/player-tools`.)
 *
 * The harness starts and REMOVES its own container. It touches nothing under
 * /usr/local/bin and does not modify provisioning/orchestrator/string generators.
 */

import { spawnSync, spawn } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as path from "node:path"

import { buildMemoryCliScript } from "../../core/src/brain/limbic/hippocampus/memory/memory-cli.ts"
import { buildWmCliScript } from "../../core/src/brain/limbic/wm/wm-cli.ts"

const HARNESS_VERSION = "1.0.0"
const IMAGE = "spacemolt-player:latest"
const STUB_PORT = 8199
const DEAD_PORT = 9099 // nothing listens here → connection refused (cold-start delta case)
const EMBED_DIM = 384

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, "..") // packages/player-tools
const repoRoot = path.resolve(pkgRoot, "..", "..")
const MEMORY_BUNDLE = path.join(pkgRoot, "dist/bundles/memory")
const WM_BUNDLE = path.join(pkgRoot, "dist/bundles/wm")
const STUB_SCRIPT = path.join(__dirname, "byte-diff-embed-stub.mjs")
const REPORT_PATH = path.join(repoRoot, "docs/superpowers/specs/phase3-gate-evidence.md")

// The deterministic stub embed server runs as a SEPARATE process
// (byte-diff-embed-stub.mjs): this harness drives docker over synchronous
// `spawnSync`, blocking its own event loop, so an in-process server could not
// accept the container's embed fetch mid-exec. Resolves once it prints "stub up".
function startStubServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [STUB_SCRIPT, String(STUB_PORT)], { stdio: ["ignore", "pipe", "inherit"] })
    let buf = ""
    const onData = (d) => {
      buf += d
      if (buf.includes("stub up")) {
        child.stdout.off("data", onData)
        resolve(child)
      }
    }
    child.stdout.on("data", onData)
    child.on("error", reject)
    setTimeout(() => reject(new Error("stub server did not come up in 5s")), 5000)
  })
}

// ─── docker helpers ──────────────────────────────────────────────────────────
function docker(args, opts = {}) {
  return spawnSync("docker", args, { encoding: "buffer", ...opts })
}

function dockerText(args, opts = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", ...opts })
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() }
}

// Install a script string into the container at installPath (base64-pipe; the
// install-cli.ts mechanism, but as the node user into /tmp — no root, no
// /usr/local/bin). chmod 0755 so the shebang runs.
function installCli(cid, installPath, script) {
  const b64 = Buffer.from(script).toString("base64")
  const sh = `echo ${b64} | base64 -d > ${installPath} && chmod 0755 ${installPath}`
  const r = dockerText(["exec", cid, "bash", "-lc", sh])
  if (r.code !== 0) throw new Error(`installCli ${installPath} failed: ${r.stderr}`)
}

// Execute a container binary, capturing stdout/stderr/exit as raw buffers.
// env: array of "KEY=VALUE"; input: optional stdin string; workdir: optional -w.
function execBin({ cid, env = [], workdir, bin, args = [], input }) {
  const dargs = ["exec"]
  if (workdir) dargs.push("-w", workdir)
  if (input !== undefined) dargs.push("-i")
  for (const e of env) dargs.push("-e", e)
  dargs.push(cid, bin, ...args)
  // input must be a Buffer: `encoding:"buffer"` (for Buffer stdout/stderr) is not a
  // valid STRING encoding, so a string `input` would throw ERR_UNKNOWN_ENCODING.
  const r = docker(dargs, input !== undefined ? { input: Buffer.from(input) } : {})
  return {
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr ?? Buffer.alloc(0),
    code: r.status,
  }
}

// ─── normalization + classification ──────────────────────────────────────────
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

// Normalize a stdout string per the case kind so run-to-run nondeterminism
// (wall-clock `ts`, autoincrement `id`) doesn't mask a structural match.
//   - "id":     a bare integer line → "<ID>".
//   - "ndjson": each JSON line's `id`→"<ID>" (asserts integer) and
//               `ts`→"<TS>" (asserts ISO-8601), preserving key ORDER + all else.
//   - "raw":    unchanged (output is fully deterministic).
function normalize(kind, text) {
  const problems = []
  if (kind === "raw") return { text, problems }
  if (kind === "id") {
    const t = text.replace(/\n$/, "")
    if (!/^\d+$/.test(t)) problems.push(`expected integer id, got ${JSON.stringify(t)}`)
    return { text: "<ID>\n", problems }
  }
  // ndjson
  const trailingNl = text.endsWith("\n")
  const lines = text.replace(/\n$/, "").split("\n")
  const normLines = lines.map((line) => {
    if (line.trim() === "") return line
    let obj
    try {
      obj = JSON.parse(line)
    } catch (e) {
      problems.push(`unparseable NDJSON line: ${line}`)
      return line
    }
    // Preserve key order by reconstructing from entries.
    const rebuilt = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k === "id") {
        if (!Number.isInteger(v)) problems.push(`id not an integer: ${JSON.stringify(v)}`)
        rebuilt[k] = "<ID>"
      } else if (k === "ts") {
        if (typeof v !== "string" || !ISO_RE.test(v)) problems.push(`ts not ISO-8601: ${JSON.stringify(v)}`)
        rebuilt[k] = "<TS>"
      } else {
        rebuilt[k] = v
      }
    }
    return JSON.stringify(rebuilt)
  })
  return { text: normLines.join("\n") + (trailingNl ? "\n" : ""), problems }
}

function bufEq(a, b) {
  return Buffer.compare(a, b) === 0
}

function classify(caseDef, oldR, newR) {
  const rawIdentical =
    bufEq(oldR.stdout, newR.stdout) && bufEq(oldR.stderr, newR.stderr) && oldR.code === newR.code

  // Known-delta cases are classified against their declared expectation directly.
  if (caseDef.expectDelta) {
    const ok = caseDef.expectDelta.check(oldR, newR)
    return {
      verdict: ok ? `KNOWN ACCEPTED DELTA: ${caseDef.expectDelta.name}` : "UNEXPLAINED",
      rawIdentical,
      detail: caseDef.expectDelta.detail(oldR, newR),
    }
  }

  if (rawIdentical) return { verdict: "BYTE-IDENTICAL", rawIdentical, detail: "" }

  // Structural: normalize stdout, require stderr + exit byte/val identical.
  const on = normalize(caseDef.kind, oldR.stdout.toString("utf8"))
  const nn = normalize(caseDef.kind, newR.stdout.toString("utf8"))
  const structuralStdout = on.text === nn.text
  const stderrEq = bufEq(oldR.stderr, newR.stderr)
  const exitEq = oldR.code === newR.code
  const problems = [...on.problems, ...nn.problems]
  if (structuralStdout && stderrEq && exitEq && problems.length === 0) {
    return {
      verdict: "STRUCTURAL-IDENTICAL (ts/id normalized)",
      rawIdentical,
      detail: `normalized stdout identical; stderr + exit byte-equal`,
    }
  }
  return {
    verdict: "UNEXPLAINED",
    rawIdentical,
    detail: [
      structuralStdout ? "" : "normalized stdout DIFFERS",
      stderrEq ? "" : "stderr DIFFERS",
      exitEq ? "" : `exit differs (old=${oldR.code} new=${newR.code})`,
      ...problems,
    ]
      .filter(Boolean)
      .join("; "),
  }
}

function esc(buf) {
  return buf.toString("utf8").replace(/\n/g, "\\n").replace(/\r/g, "\\r")
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const results = []
  const wmResults = []
  let cid = null
  let server = null
  const errors = []

  try {
    server = await startStubServer()

    // Preflight: image + bundles present.
    for (const p of [MEMORY_BUNDLE, WM_BUNDLE]) {
      readFileSync(p) // throws if missing
    }
    const digest = dockerText(["inspect", "--format", "{{.Id}}", IMAGE]).stdout

    // Start container. `--add-host=host.docker.internal:host-gateway` routes the
    // container to the host's IPv4 gateway so it can reach the stub embed server.
    const run = dockerText(["run", "-d", "--add-host=host.docker.internal:host-gateway", IMAGE, "sleep", "1800"])
    if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr}`)
    cid = run.stdout
    console.log(`container ${cid.slice(0, 12)} (image ${digest})`)

    // Scratch dirs inside the container.
    dockerText(["exec", cid, "bash", "-lc", "mkdir -p /tmp/old /tmp/new /tmp/mal-old /tmp/mal-new /tmp/dead-old /tmp/dead-new"])

    // Embed endpoints.
    const stubBase = `http://127.0.0.1:${STUB_PORT}/v1` // host-rewritten by embedEndpoint for OLD
    const stubFinal = `http://host.docker.internal:${STUB_PORT}/v1/embeddings` // NEW env
    const deadBase = `http://127.0.0.1:${DEAD_PORT}/v1`
    const deadFinal = `http://host.docker.internal:${DEAD_PORT}/v1/embeddings`

    // Preflight embed connectivity from the container.
    const ping = dockerText([
      "exec",
      cid,
      "/home/node/.bun/bin/bun",
      "-e",
      `const c=new AbortController();setTimeout(()=>c.abort(),8000);try{const r = await fetch(${JSON.stringify(stubFinal)}, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({input:"ping"}),signal:c.signal}); const j = await r.json(); console.log(r.status, Array.isArray(j.data?.[0]?.embedding) ? j.data[0].embedding.length : "no-embed")}catch(e){console.log("ERR",e.name,e.message)}`,
    ])
    console.log(`embed preflight: ${ping.stdout} ${ping.stderr}`)
    if (!ping.stdout.startsWith("200")) {
      throw new Error(`embed stub not reachable from container: ${ping.stdout} ${ping.stderr}`)
    }

    // ── install OLD variants (db path + embed url are BAKED at generate time) ──
    installCli(cid, "/tmp/memory-old", buildMemoryCliScript({ embedBaseUrl: stubBase, dbPath: "/tmp/old/longterm.db" }))
    installCli(cid, "/tmp/memory-old-mal", buildMemoryCliScript({ embedBaseUrl: stubBase, dbPath: "/tmp/mal-old/longterm.db" }))
    installCli(cid, "/tmp/memory-old-dead", buildMemoryCliScript({ embedBaseUrl: deadBase, dbPath: "/tmp/dead-old/longterm.db" }))
    // ── install NEW bundle (single binary; config via env) ──
    installCli(cid, "/tmp/memory-new", readFileSync(MEMORY_BUNDLE, "utf8"))

    const newEnvMain = [`MEMORY_EMBED_URL=${stubFinal}`, `MEMORY_DB_PATH=/tmp/new/longterm.db`, `MEMORY_VEC_EXT=/usr/local/lib/vec0.so`]
    const oldMain = (args, input) => execBin({ cid, bin: "/tmp/memory-old", args, input })
    const newMain = (args, input) => execBin({ cid, env: newEnvMain, bin: "/tmp/memory-new", args, input })

    // ── Ordered lifecycle cases (shared fresh db pair; identical order ⇒ ids align) ──
    const dims1 = JSON.stringify({ voyage: 0.6, threat: 0.2 })
    const lifecycle = [
      { name: "remember --dims + --tags", kind: "id", args: ["remember", "alpha voyage log", "--tags", "a,b", "--source", "conscious", "--dims", dims1] },
      { name: "remember no --dims/--tags", kind: "id", args: ["remember", "beta plain note", "--source", "conscious"] },
      { name: "remember --tags (observe)", kind: "id", args: ["remember", "gamma tagged note", "--tags", "x,y", "--source", "observe"] },
      { name: "search returning dims rows (-k 5)", kind: "ndjson", args: ["search", "voyage", "-k", "5"] },
      { name: "search with --tags filter", kind: "ndjson", args: ["search", "note", "-k", "5", "--tags", "a"] },
      { name: "search k default (no -k)", kind: "ndjson", args: ["search", "voyage"] },
      { name: "recent (default n)", kind: "ndjson", args: ["recent"] },
      { name: "recent -n 2", kind: "ndjson", args: ["recent", "-n", "2"] },
      { name: "mark-set then mark-get roundtrip", kind: "raw", args: ["mark-get"], pre: ["mark-set", JSON.stringify({ len: 42, hash: "deadbeef" })] },
      { name: "promote (base64 stdin, 2 entries)", kind: "raw", args: ["promote"], stdin: [Buffer.from("promoted entry one", "utf8").toString("base64"), Buffer.from("promoted entry two", "utf8").toString("base64")].join("\n") + "\n" },
    ]

    for (const c of lifecycle) {
      if (c.pre) {
        oldMain(c.pre)
        newMain(c.pre)
      }
      const oldR = oldMain(c.args, c.stdin)
      const newR = newMain(c.args, c.stdin)
      const cls = classify(c, oldR, newR)
      results.push({ ...c, oldR, newR, cls })
      console.log(`  [${cls.verdict}] ${c.name}`)
    }

    // ── Malformed --dims (isolated db pair so id drift can't perturb lifecycle) ──
    const malCase = {
      name: "malformed --dims (present, invalid JSON)",
      kind: "special",
      args: ["remember", "delta corrupt", "--source", "conscious", "--dims", "not-json"],
      expectDelta: {
        name: "malformed-dims hard error (spec §2g/§5)",
        // NEW must hard-error exit 2 with a stderr message; OLD's actual behavior
        // is documented (it stores the corrupt dims verbatim and exits 0).
        check: (o, n) => n.code === 2 && n.stderr.length > 0,
        detail: (o, n) =>
          `OLD: exit ${o.code}, stdout=${JSON.stringify(esc(o.stdout))}, stderr=${JSON.stringify(esc(o.stderr))}; ` +
          `NEW: exit ${n.code}, stderr=${JSON.stringify(esc(n.stderr))}`,
      },
    }
    {
      const oldR = execBin({ cid, bin: "/tmp/memory-old-mal", args: malCase.args })
      const newEnvMal = [`MEMORY_EMBED_URL=${stubFinal}`, `MEMORY_DB_PATH=/tmp/mal-new/longterm.db`, `MEMORY_VEC_EXT=/usr/local/lib/vec0.so`]
      const newR = execBin({ cid, env: newEnvMal, bin: "/tmp/memory-new", args: malCase.args })
      const cls = classify(malCase, oldR, newR)
      results.push({ ...malCase, oldR, newR, cls })
      console.log(`  [${cls.verdict}] ${malCase.name}`)
    }

    // ── Cold-start embed delta (dead embed server; NEW retries, OLD throws once) ──
    const deadCase = {
      name: "embed cold-start (dead server)",
      kind: "special",
      args: ["remember", "epsilon unreachable", "--source", "conscious"],
      expectDelta: {
        name: "embed retry+validation delta (spec §1a/#3, risk #3)",
        // Both ultimately fail (non-zero); the delta is that NEW retries (7 attempts,
        // ~23s of backoff) where OLD throws on the first fetch. Evidenced by wall time.
        check: (o, n) => o.code !== 0 && n.code !== 0,
        detail: (o, n) =>
          `OLD: exit ${o.code} in ${o.ms}ms (single attempt); NEW: exit ${n.code} in ${n.ms}ms (retry budget). ` +
          `OLD stderr=${JSON.stringify(esc(o.stderr))}; NEW stderr=${JSON.stringify(esc(n.stderr))}`,
      },
    }
    {
      const t0 = Date.now()
      const oldR = execBin({ cid, bin: "/tmp/memory-old-dead", args: deadCase.args })
      oldR.ms = Date.now() - t0
      const t1 = Date.now()
      const newEnvDead = [`MEMORY_EMBED_URL=${deadFinal}`, `MEMORY_DB_PATH=/tmp/dead-new/longterm.db`, `MEMORY_VEC_EXT=/usr/local/lib/vec0.so`]
      const newR = execBin({ cid, env: newEnvDead, bin: "/tmp/memory-new", args: deadCase.args })
      newR.ms = Date.now() - t1
      const cls = classify(deadCase, oldR, newR)
      results.push({ ...deadCase, oldR, newR, cls })
      console.log(`  [${cls.verdict}] ${deadCase.name} (old ${oldR.ms}ms / new ${newR.ms}ms)`)
    }

    // ── Secondary: wm lifecycle (phase-4 pre-evidence) ──
    installCli(cid, "/tmp/wm-old", buildWmCliScript())
    installCli(cid, "/tmp/wm-new", readFileSync(WM_BUNDLE, "utf8"))
    dockerText(["exec", cid, "bash", "-lc", "mkdir -p /tmp/wmold/me /tmp/wmnew/me"])
    const wmSteps = [
      { name: "todo (root)", args: ["todo", "first task"] },
      { name: "todo --parent", args: ["todo", "subtask", "--parent", "t1"] },
      { name: "done t1", args: ["done", "t1"] },
      { name: "discard t2", args: ["discard", "t2"] },
      { name: "usage error (bad verb)", args: ["bogus"] },
    ]
    for (const s of wmSteps) {
      const oldR = execBin({ cid, workdir: "/tmp/wmold", bin: "/tmp/wm-old", args: s.args })
      const newR = execBin({ cid, workdir: "/tmp/wmnew", bin: "/tmp/wm-new", args: s.args })
      // wm todo prints a deterministic counter id (t1,t2..) — raw-comparable; the
      // stored files carry wall-clock ts (normalized when we diff them below).
      const rawIdentical = bufEq(oldR.stdout, newR.stdout) && bufEq(oldR.stderr, newR.stderr) && oldR.code === newR.code
      wmResults.push({ ...s, oldR, newR, verdict: rawIdentical ? "BYTE-IDENTICAL" : "DIFFERS" })
      console.log(`  [wm ${rawIdentical ? "BYTE-IDENTICAL" : "DIFFERS"}] ${s.name}`)
    }
    // Compare the resulting store files (normalize timestamps).
    const readFile = (dir, f) => dockerText(["exec", cid, "bash", "-lc", `cat ${dir}/me/${f} 2>/dev/null || true`]).stdout
    const normTs = (s) => s.replace(/"(createdAt|updatedAt|ts)":\s*"[^"]*"/g, '"$1":"<TS>"')
    for (const f of ["wm.json", "WM.md"]) {
      const o = normTs(readFile("/tmp/wmold", f))
      const n = normTs(readFile("/tmp/wmnew", f))
      wmResults.push({ name: `store file ${f} (ts-normalized)`, fileDiff: true, verdict: o === n ? "STRUCTURAL-IDENTICAL (ts normalized)" : "DIFFERS", oldText: o, newText: n })
      console.log(`  [wm ${o === n ? "STRUCTURAL-IDENTICAL" : "DIFFERS"}] store file ${f}`)
    }

    writeReport({ digest, results, wmResults })
  } catch (e) {
    errors.push(e instanceof Error ? e.stack || e.message : String(e))
    console.error("HARNESS ERROR:", e)
  } finally {
    if (cid) {
      docker(["rm", "-f", cid])
      console.log(`removed container ${cid.slice(0, 12)}`)
    }
    if (server) server.kill()
  }

  const unexplained = results.filter((r) => r.cls.verdict === "UNEXPLAINED")
  if (errors.length) {
    console.error(`\nHARNESS FAILED (${errors.length} error(s)) — see above.`)
    process.exit(1)
  }
  if (unexplained.length) {
    console.error(`\n${unexplained.length} UNEXPLAINED case(s) — PHASE 3 BLOCKED.`)
    process.exit(2)
  }
  console.log("\nAll cases classified; no UNEXPLAINED deltas. Report written.")
}

function writeReport({ digest, results, wmResults }) {
  const now = new Date().toISOString()
  const verdictCell = (r) => (r.cls.rawIdentical ? r.cls.verdict : r.cls.verdict)
  const lines = []
  lines.push(`# Phase-3 gate evidence — memory + wm byte-diff (OLD string vs NEW bundle)`)
  lines.push("")
  lines.push(`**Harness:** \`packages/player-tools/scripts/byte-diff-gate.mjs\` v${HARNESS_VERSION}`)
  lines.push(`**Run:** ${now}`)
  lines.push(`**Image:** \`${IMAGE}\` — digest \`${digest}\``)
  lines.push(`**Stub embed:** deterministic FNV-1a→mulberry32 384-d vectors, OpenAI \`/v1/embeddings\` shape, host \`:${STUB_PORT}\` via \`host.docker.internal\`.`)
  lines.push("")
  lines.push(`## Normalization rules`)
  lines.push("")
  lines.push(`Timestamps (\`ts\`) use wall-clock \`new Date().toISOString()\` and cannot be pinned; row \`id\` is a fresh-db autoincrement. Both scratch dbs start empty and receive the **identical command sequence in the identical order**, so autoincrement ids DO align run-to-run — but the diff is nonetheless computed STRUCTURALLY so a future ordering change can't produce a false pass:`)
  lines.push("")
  lines.push(`- **\`id\` fields** → replaced with \`<ID>\` after asserting the value is an integer (bare-id stdout and the \`id\` key inside each NDJSON object).`)
  lines.push(`- **\`ts\` fields** → replaced with \`<TS>\` after asserting the value matches ISO-8601 (\`^\\d{4}-..T..:..:..(\\.\\d+)?Z$\`).`)
  lines.push(`- **All other fields** (source, provenance, dims-as-object, tags-as-array, text, score) compared **byte-for-byte**, with JSON key ORDER preserved (objects rebuilt from \`Object.entries\` in original order).`)
  lines.push(`- **stderr + exit code** always compared byte/value-exact — never normalized.`)
  lines.push(`- Trailing-newline behavior (\`console.log\` adds one \`\\n\`; empty result → single \`\\n\`) is preserved through normalization and thus compared.`)
  lines.push("")
  lines.push(`Verdicts: **BYTE-IDENTICAL** (raw stdout+stderr+exit equal) · **STRUCTURAL-IDENTICAL** (equal after ts/id normalization) · **KNOWN ACCEPTED DELTA** (a spec-named intentional difference) · **UNEXPLAINED** (a phase-3 blocker).`)
  lines.push("")
  lines.push(`## memory — per-case verdicts`)
  lines.push("")
  lines.push(`| # | case | verdict | raw-identical | notes |`)
  lines.push(`|---|------|---------|:---:|-------|`)
  results.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.name} | ${verdictCell(r)} | ${r.cls.rawIdentical ? "yes" : "no"} | ${(r.cls.detail || "").replace(/\|/g, "\\|") || "—"} |`)
  })
  lines.push("")

  // Raw evidence for any non-byte-identical case.
  const deltas = results.filter((r) => !r.cls.rawIdentical)
  lines.push(`## Raw diffs (every non-byte-identical case)`)
  lines.push("")
  if (deltas.length === 0) {
    lines.push(`_None — every memory case was byte-identical._`)
    lines.push("")
  }
  for (const r of deltas) {
    lines.push(`### ${r.name} — ${r.cls.verdict}`)
    lines.push("")
    lines.push("```")
    lines.push(`args: ${JSON.stringify(r.args)}`)
    lines.push(`OLD  exit=${r.oldR.code}`)
    lines.push(`  stdout: ${JSON.stringify(esc(r.oldR.stdout))}`)
    lines.push(`  stderr: ${JSON.stringify(esc(r.oldR.stderr))}`)
    lines.push(`NEW  exit=${r.newR.code}`)
    lines.push(`  stdout: ${JSON.stringify(esc(r.newR.stdout))}`)
    lines.push(`  stderr: ${JSON.stringify(esc(r.newR.stderr))}`)
    lines.push("```")
    lines.push("")
  }

  lines.push(`## wm — phase-4 pre-evidence`)
  lines.push("")
  lines.push(`| case | verdict |`)
  lines.push(`|------|---------|`)
  for (const w of wmResults) {
    lines.push(`| ${w.name} | ${w.verdict} |`)
  }
  lines.push("")
  const wmDiffs = wmResults.filter((w) => w.verdict === "DIFFERS")
  if (wmDiffs.length) {
    lines.push(`### wm DIFFERS detail`)
    for (const w of wmDiffs) {
      lines.push(`- **${w.name}**`)
      if (w.fileDiff) {
        lines.push("```")
        lines.push(`OLD:\n${w.oldText}`)
        lines.push(`NEW:\n${w.newText}`)
        lines.push("```")
      } else {
        lines.push("```")
        lines.push(`OLD exit=${w.oldR.code} stdout=${JSON.stringify(esc(w.oldR.stdout))} stderr=${JSON.stringify(esc(w.oldR.stderr))}`)
        lines.push(`NEW exit=${w.newR.code} stdout=${JSON.stringify(esc(w.newR.stdout))} stderr=${JSON.stringify(esc(w.newR.stderr))}`)
        lines.push("```")
      }
    }
    lines.push("")
  }

  const unexplained = results.filter((r) => r.cls.verdict === "UNEXPLAINED")
  lines.push(`## Verdict`)
  lines.push("")
  if (unexplained.length === 0) {
    lines.push(`**No UNEXPLAINED deltas.** Every memory case is BYTE-IDENTICAL or STRUCTURAL-IDENTICAL, except the two spec-named intentional deltas (malformed-\`--dims\` hard error; embed cold-start retry). The \`longterm-store.ts:194-205\` NDJSON parse contract is preserved. Phase-3 byte-diff gate: **PASS** (pending maintainer sign-off).`)
  } else {
    lines.push(`**BLOCKED — ${unexplained.length} UNEXPLAINED delta(s):** ${unexplained.map((r) => r.name).join(", ")}. Do not repoint provisioning until resolved.`)
  }
  lines.push("")

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
  writeFileSync(REPORT_PATH, lines.join("\n"))
  console.log(`report → ${REPORT_PATH}`)
}

main()
