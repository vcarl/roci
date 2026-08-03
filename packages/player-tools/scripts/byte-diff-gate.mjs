/**
 * Provision-path re-validation harness (package-design spec §2f/§5).
 *
 * Its ancestor proved the NEW bundled CLIs byte-identical to the OLD
 * generated-string CLIs (phase-3 gate; evidence in
 * docs/superpowers/specs/phase3-gate-evidence.md). With the string path deleted in
 * phase 5 there is no OLD path left to diff — the enduring check is that what core
 * PROVISIONS is exactly the bundle the package's tests exercise, and that it runs
 * in a real container through the exact env-prefixed exec `longterm-store` issues.
 *
 * WHAT IT DOES (host node, run under tsx so it can import core's TS resolver):
 *   1. Calls the REAL provision resolver (`readPlayerToolBundle`, the bytes
 *      `provision{Memory,Wm}Cli` install) and asserts they are byte-identical to
 *      the committed bundle artifacts (dist/bundles/{memory,wm}).
 *   2. Starts a scratch container + a deterministic stub embed server, installs
 *      those bytes at /tmp (the install-cli base64+chmod mechanism; NEVER
 *      /usr/local/bin), and round-trips `remember --dims-c + --tags` → `search`
 *      through the exact `export MEMORY_EMBED_URL=… && cd … && <cli>` string, plus
 *      a `wm todo` smoke.
 *   2b. Repeats a bare `remember` (NO producer vector) at a SECOND db that has a
 *      real PALETTE.md + DRIVES.md beside it, so the mechanical (A) stage the CLI
 *      runs at insert is exercised end-to-end rather than only its degraded path.
 *   3. APPENDS a re-validation section to phase3-gate-evidence.md (never overwrites).
 *
 * RUN:  node_modules/.bin/tsx packages/player-tools/scripts/byte-diff-gate.mjs
 *   (requires: docker running + `spacemolt-player:latest` image + a built
 *    packages/player-tools/dist/bundles/{memory,wm}. Build with `npx nx build
 *    @roci/player-tools`.)
 *
 * The harness starts and REMOVES its own container. It touches nothing under
 * /usr/local/bin and does not modify provisioning/orchestrator.
 */

import { spawnSync, spawn } from "node:child_process"
import { readFileSync, appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as path from "node:path"

// The REAL host-side bundle resolver core provisioning uses (spec §2f). Importing
// it here means the re-validation proves the exact bytes `provision*Cli` install.
import { readPlayerToolBundle, playerToolBundlePath } from "../../core/src/services/player-tools-bundle.ts"

const HARNESS_VERSION = "2.1.0"
const IMAGE = "spacemolt-player:latest"
const STUB_PORT = 8199

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

/**
 * Write a UTF-8 text file into the container, through the SAME base64 pipe
 * `installCli` uses (minus the chmod). Deliberately not `printf '%b'`: bash's
 * `%b` implements echo-style escapes only, so `\uXXXX` is emitted LITERALLY
 * (verified against the image's bash 5.2.15). The axis artifacts below hinge on
 * exact characters — `→` (U+2192) gates `parsePaletteAxes`' pole match and `—`
 * (U+2014) gates `parseDriveLines`' row match — and a literal `→` would
 * derive ZERO axes while looking like a broken A stage. base64 moves the bytes
 * with no shell dialect in the path.
 */
function writeContainerFile(cid, filePath, content) {
  const b64 = Buffer.from(content, "utf8").toString("base64")
  const r = dockerText(["exec", cid, "bash", "-lc", `echo ${b64} | base64 -d > ${filePath}`])
  if (r.code !== 0) throw new Error(`writeContainerFile ${filePath} failed: ${r.stderr}`)
}

// ─── phase 3+4 provision-path re-validation ──────────────────────────────────
// Proves two things a direct file-read could not, because it exercises the REAL
// provision resolver (`readPlayerToolBundle`, spec §2f):
//   1. The bytes `provision{Memory,Wm}Cli` install are byte-identical to the
//      committed bundle artifacts (resolution via the package boundary lands on
//      the same file `installContainerCli` would base64-pipe in).
//   2. Installing THOSE bytes into a scratch container at /tmp (never
//      /usr/local/bin) and running `remember --dims + --tags` → `search` through
//      the exact env-prefixed exec `longterm-store` issues yields a stored dims
//      signature that round-trips as dims-as-object NDJSON. wm gets a `todo` smoke.
//      APPENDS a section to the evidence file (never overwrites the gate).
async function revalidateProvisionPath() {
  let cid = null
  let server = null
  const log = (s) => console.log(s)
  try {
    // (1) byte-identity of the resolved-provision content vs the bundle artifact.
    const memProvision = readPlayerToolBundle("memory")
    const wmProvision = readPlayerToolBundle("wm")
    const memPath = playerToolBundlePath("memory")
    const wmPath = playerToolBundlePath("wm")
    const memBundle = readFileSync(MEMORY_BUNDLE, "utf8")
    const wmBundle = readFileSync(WM_BUNDLE, "utf8")
    const memResolvesToBundle = path.resolve(memPath) === path.resolve(MEMORY_BUNDLE)
    const wmResolvesToBundle = path.resolve(wmPath) === path.resolve(WM_BUNDLE)
    const memBytesEq = memProvision === memBundle
    const wmBytesEq = wmProvision === wmBundle
    log(`memory: provision resolver → ${memPath}`)
    log(`  resolves to dist/bundles/memory: ${memResolvesToBundle}; bytes identical: ${memBytesEq}`)
    log(`wm: provision resolver → ${wmPath}`)
    log(`  resolves to dist/bundles/wm: ${wmResolvesToBundle}; bytes identical: ${wmBytesEq}`)
    if (!(memResolvesToBundle && wmResolvesToBundle && memBytesEq && wmBytesEq)) {
      throw new Error("provision-resolved bytes are NOT byte-identical to the bundle artifacts")
    }

    server = await startStubServer()
    const digest = dockerText(["inspect", "--format", "{{.Id}}", IMAGE]).stdout
    const run = dockerText(["run", "-d", "--add-host=host.docker.internal:host-gateway", IMAGE, "sleep", "600"])
    if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr}`)
    cid = run.stdout
    log(`container ${cid.slice(0, 12)} (image ${digest})`)
    dockerText(["exec", cid, "bash", "-lc", "mkdir -p /tmp/prov/me /tmp/provwm/me"])

    const stubFinal = `http://host.docker.internal:${STUB_PORT}/v1/embeddings`
    // Install EXACTLY the provision-resolved bytes at /tmp (the install-cli
    // base64+chmod mechanism `installContainerCli` uses), never /usr/local/bin.
    installCli(cid, "/tmp/memory-prov", memProvision)
    installCli(cid, "/tmp/wm-prov", wmProvision)

    // (2) remember --dims + --tags, then search — through the EXACT env delivery
    // longterm-store now issues (`export MEMORY_EMBED_URL=… && cd … && <cli>`).
    const dims = JSON.stringify({ voyage: 0.6, threat: 0.2 })
    const envPrefix = `export MEMORY_EMBED_URL='${stubFinal}' MEMORY_DB_PATH=/tmp/prov/longterm.db`
    const memExec = (argv) =>
      dockerText(["exec", cid, "bash", "-lc", `${envPrefix} && cd /tmp/prov && /tmp/memory-prov ${argv}`])

    // `--dims` was renamed `--dims-c` in phase 2 (it carries the PRODUCER vector,
    // which the CLI merges with the mechanical one it computes at insert). The old
    // spelling is now a hard parse error, so this line MUST move with the codec.
    const rem = memExec(`remember 'alpha voyage log' --tags a,b --source conscious --dims-c '${dims}'`)
    log(`remember --dims-c: exit=${rem.code} stdout=${JSON.stringify(rem.stdout)} stderr=${JSON.stringify(rem.stderr)}`)
    const rememberOk = rem.code === 0 && /^\d+$/.test(rem.stdout)

    const search = memExec(`search 'voyage' -k 5`)
    log(`search: exit=${search.code}`)
    let searchOk = false
    let searchLine = ""
    try {
      searchLine = search.stdout.split("\n").filter(Boolean)[0] ?? ""
      const obj = JSON.parse(searchLine)
      searchOk =
        search.code === 0 &&
        obj.dims &&
        typeof obj.dims === "object" &&
        obj.dims.voyage === 0.6 &&
        typeof obj.score === "number" &&
        Array.isArray(obj.tags)
      log(`  first hit: ${searchLine}`)
    } catch (e) {
      log(`  search parse error: ${e.message}`)
    }

    // (2b) PHASE 2 — the mechanical (A) stage fires inside the CLI with NO
    // producer vector at all. This is pathway 6: the agent's own `memory remember`, a
    // write the host never observes and therefore never scores. Before Phase 2
    // such a row stored NULL dims and fell back to neutral salience forever.
    //
    // The checks above run in /tmp/prov, which has no PALETTE.md — so they
    // exercise the degraded path (A = {}, base = C) and would stay GREEN with the
    // entire A stage broken. This block writes real axis artifacts beside a
    // SECOND db and proves A actually fires.
    const axisDir = "/tmp/prova"
    dockerText(["exec", cid, "bash", "-lc", `mkdir -p ${axisDir}`])
    // The REAL characters, literal in this (UTF-8) source and carried into the
    // container as bytes by writeContainerFile — no shell escape dialect in the
    // path. One bipolar palette row and two unipolar drives ⇒ three derived axes.
    const paletteMd =
      "# Palette\n\n😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated\n"
    const drivesMd =
      "# Drives\n\n- safety — your physical integrity\n- voyage — progress toward your destination\n"
    writeContainerFile(cid, `${axisDir}/PALETTE.md`, paletteMd)
    writeContainerFile(cid, `${axisDir}/DRIVES.md`, drivesMd)
    const axisEnv = `export MEMORY_EMBED_URL='${stubFinal}' MEMORY_DB_PATH=${axisDir}/longterm.db`
    const axisExec = (argv) =>
      dockerText(["exec", cid, "bash", "-lc", `${axisEnv} && cd ${axisDir} && /tmp/memory-prov ${argv}`])

    const bare = axisExec(`remember 'the hull scraped the debris ring'`)
    log(`remember (no producer vector): exit=${bare.code} stdout=${JSON.stringify(bare.stdout)} stderr=${JSON.stringify(bare.stderr)}`)
    const bareOk = bare.code === 0 && /^\d+$/.test(bare.stdout)

    const axisSearch = axisExec(`search 'hull' -k 5`)
    let mechanicalOk = false
    let axisLine = ""
    try {
      axisLine = axisSearch.stdout.split("\n").filter(Boolean)[0] ?? ""
      const obj = JSON.parse(axisLine)
      const dims = obj.dims ?? {}
      mechanicalOk =
        axisSearch.code === 0 &&
        obj.stage === "base" &&
        // Every derived axis is present: two drives + one bipolar palette axis.
        typeof dims.safety === "number" &&
        typeof dims.voyage === "number" &&
        typeof dims["burdened-exhilarated"] === "number" &&
        // Drives are unipolar [0,1]; the palette axis is bipolar [-1,+1].
        dims.safety >= 0 && dims.safety <= 1 &&
        dims["burdened-exhilarated"] >= -1 && dims["burdened-exhilarated"] <= 1
      log(`  first hit: ${axisLine}`)
    } catch (e) {
      log(`  axis search parse error: ${e.message}`)
    }

    const wmExec = (argv) =>
      dockerText(["exec", cid, "bash", "-lc", `cd /tmp/provwm && /tmp/wm-prov ${argv}`])
    const todo = wmExec(`todo 'first task'`)
    const wmOk = todo.code === 0 && todo.stdout === "t1"
    log(`wm todo: exit=${todo.code} stdout=${JSON.stringify(todo.stdout)} → ok=${wmOk}`)

    const allOk = rememberOk && searchOk && wmOk && bareOk && mechanicalOk
    // Append (never overwrite) a re-validation section to the evidence file.
    const now = new Date().toISOString()
    const section = [
      "",
      "---",
      "",
      "## Phase 3+4 provision-path re-validation",
      "",
      `**Run:** ${now} · **Harness mode:** \`byte-diff-gate.mjs\` v${HARNESS_VERSION} (provision-path)`,
      `**Image:** \`${IMAGE}\` — digest \`${digest}\``,
      "",
      "Exercises the REAL provision resolver (`readPlayerToolBundle`, spec §2f) — the",
      "bytes `provisionMemoryCli`/`provisionWmCli` install — not a direct file read.",
      "",
      "| check | result |",
      "|-------|:------:|",
      `| \`playerToolBundlePath("memory")\` resolves to \`dist/bundles/memory\` | ${memResolvesToBundle ? "PASS" : "FAIL"} |`,
      `| provision-resolved memory bytes === bundle artifact | ${memBytesEq ? "PASS" : "FAIL"} |`,
      `| \`playerToolBundlePath("wm")\` resolves to \`dist/bundles/wm\` | ${wmResolvesToBundle ? "PASS" : "FAIL"} |`,
      `| provision-resolved wm bytes === bundle artifact | ${wmBytesEq ? "PASS" : "FAIL"} |`,
      `| \`remember --dims-c + --tags\` via env-prefixed exec (prints integer id) | ${rememberOk ? "PASS" : "FAIL"} |`,
      `| \`search\` returns dims-as-object NDJSON with score+tags | ${searchOk ? "PASS" : "FAIL"} |`,
      `| \`remember\` with NO \`--dims-c\`, beside a real PALETTE.md (prints integer id) | ${bareOk ? "PASS" : "FAIL"} |`,
      `| the mechanical (A) stage scored every derived axis, stage=\`base\` | ${mechanicalOk ? "PASS" : "FAIL"} |`,
      `| \`wm todo\` via provisioned bundle (prints \`t1\`) | ${wmOk ? "PASS" : "FAIL"} |`,
      "",
      "Env delivery under test is the exact string `longterm-store` now issues:",
      "`export MEMORY_EMBED_URL='…/v1/embeddings' MEMORY_DB_PATH=… && cd … && /tmp/memory-prov …`.",
      "Install path is `/tmp/*` (the install-cli base64+chmod mechanism), never `/usr/local/bin`.",
      "",
      `search first hit: \`${searchLine.replace(/`/g, "'")}\``,
      "",
      "Phase 2: the second db at `/tmp/prova` carries a real `PALETTE.md` + `DRIVES.md`, so a",
      "`remember` with NO producer vector must still store a full axis vector — the pathway-6",
      "proof (the agent's own write, which the host never observes). The `/tmp/prov` checks above",
      "deliberately have no axis artifacts, exercising the degraded path where `base = C`.",
      "",
      `axis-scored first hit: \`${axisLine.replace(/`/g, "'")}\``,
      "",
      `**Provision-path re-validation: ${allOk ? "PASS" : "FAIL"}.**`,
      "",
    ].join("\n")
    appendFileSync(REPORT_PATH, section)
    log(`\nappended re-validation section → ${REPORT_PATH}`)
    if (!allOk) {
      console.error("PROVISION-PATH RE-VALIDATION FAILED")
      process.exitCode = 3
    }
  } catch (e) {
    console.error("RE-VALIDATION ERROR:", e)
    process.exitCode = 1
  } finally {
    if (cid) {
      docker(["rm", "-f", cid])
      console.log(`removed container ${cid.slice(0, 12)}`)
    }
    if (server) server.kill()
  }
}

revalidateProvisionPath()
