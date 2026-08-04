#!/usr/bin/env bun
/**
 * Offline eval harness for the hindbrain (observe) appraisal tier.
 *
 * Replays REAL captured event payloads (fixtures.jsonl, curated from
 * players/vcarl/logs/events.jsonl) through the REAL local hindbrain model with a
 * candidate observe.md prompt, scores the appraisals, and prints a metrics
 * report. Lets prompt/code variants be compared quantitatively BEFORE any live
 * `./roci start`.
 *
 * ── Assembly fidelity ──────────────────────────────────────────────────────
 * Prompt assembly mirrors brain/limbic/tiers-limbic.ts `runHindbrain` exactly:
 *   prompt = observe.md.render({ event, waitState, palette, drives, axes })
 * We import the SAME pure functions the runtime uses (loadSkillSync, parseOr,
 * appraise, guardAppraisal, TEMPLATE_DRIVES, parseDriveNames, buildAxisSpecs,
 * renderAxisBlock) directly from packages/core/src — no reimplementation. See
 * README.md "Assembly fidelity".
 *
 * The model HTTP call mirrors model/client.ts: POST /v1/chat/completions with
 * { model, messages:[{role:"user",content:prompt}], temperature, max_tokens,
 *   stream:false, ...extraBody }, params read from DEFAULT_CORTEX_MODELS.hindbrain.
 *
 * The harness spawns its OWN mlx_lm.server on a free port, health-checks it, and
 * ALWAYS tears it down (finally + SIGINT/SIGTERM handlers).
 */
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import * as path from "node:path"
import { execSync } from "node:child_process"

import { loadSkillSync } from "../../packages/core/src/skills/loader.ts"
import { parseOr } from "../../packages/core/src/brain/stem/parse.ts"
import { appraise, guardAppraisal, composeDigestedEventText } from "../../packages/core/src/brain/stem/state.ts"
import { TEMPLATE_DRIVES, parseDriveNames } from "../../packages/core/src/brain/limbic/hypothalamus/drives.ts"
import { renderAxisBlock } from "../../packages/core/src/brain/stem/tier-config.ts"
import { buildAxisSpecs } from "../../packages/core/src/core/salience.ts"
import { DEFAULT_CORTEX_MODELS } from "../../packages/core/src/model/handles.ts"
import type { ObserveResult } from "../../packages/core/src/skills/types.ts"
// Digest assembly mirror (see README "Assembly fidelity"): the SAME domain
// functions the runtime uses. `formatEventDigest` is the exact function the
// StateRenderer delegates to; `spaceMoltEventProcessor` reconstructs a GameState
// from a fixture's raw event via the SAME reducer the loop drives — no
// hand-written digest, no hand-rolled state.
import { formatEventDigest, isSnapshotEventType } from "../../packages/domain-spacemolt/src/event-digest.ts"
import { spaceMoltEventProcessor } from "../../packages/domain-spacemolt/src/event-processor.ts"
import type { GameState } from "../../packages/domain-spacemolt/src/types.ts"

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, "..", "..")

// ── CLI args ─────────────────────────────────────────────────────────────────
function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const PROMPT_PATH = path.resolve(arg("prompt", path.join(REPO, "packages/core/src/brain/limbic/prompts/observe.md")))
const FIXTURES_PATH = path.resolve(arg("fixtures", path.join(HERE, "fixtures.jsonl")))
const SAMPLES = parseInt(arg("samples", "3"), 10)
const PORT = parseInt(arg("port", "8091"), 10)
const RESULTS_PATH = path.resolve(arg("results", path.join(HERE, "results", "baseline.json")))
const PALETTE_PATH = path.join(REPO, "players/vcarl/me/PALETTE.md")
const PYTHON_BIN = arg("python", "/Users/vcarl/llm-env/bin/mlx_lm.server")

const HANDLE = DEFAULT_CORTEX_MODELS.hindbrain
const MODEL = arg("model", HANDLE.model)
const TEMPERATURE = HANDLE.params?.temperature ?? 0.05
const MAX_TOKENS = HANDLE.params?.maxTokens ?? 1024
const EXTRA_BODY = HANDLE.params?.extraBody ?? {}

// ── fixtures ─────────────────────────────────────────────────────────────────
interface Expected {
  disposition_one_of: string[]
  weight_range: [number, number]
  drive_one_of: (string | null)[]
  must_not_contain_in_reason: string[]
  escalate_allowed: boolean
}
interface Fixture {
  id: string
  category: string
  event: string
  waitState: string
  expected: Expected
  synthetic?: boolean
  dedup_eligible?: boolean
  note?: string
}
function loadFixtures(): Fixture[] {
  return readFileSync(FIXTURES_PATH, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Fixture)
}

// ── prompt assembly (mirrors runHindbrain) ──────────────────────────────────
const skill = loadSkillSync(PROMPT_PATH)
const PALETTE = (() => {
  try {
    return readFileSync(PALETTE_PATH, "utf-8")
  } catch {
    return "" // runtime falls back to TEMPLATE_PALETTE; vcarl has a PALETTE.md
  }
})()
const DRIVES = TEMPLATE_DRIVES // vcarl has no me/DRIVES.md → runtime uses TEMPLATE_DRIVES
const KNOWN_DRIVES = parseDriveNames(DRIVES)
// The salience axis block, assembled through the SAME renderAxisBlock +
// buildAxisSpecs the runtime uses (loop.ts derives the specs once per run and
// tiers-limbic.ts renders them). Derived from the same two artifacts already
// read above, so the eval scores the prompt the runtime actually sends.
/** The same specs `AXES` was rendered from — `appraise` validates against these,
 *  not against the rendered block. Keeping both from one `buildAxisSpecs` call
 *  is what stops the prompt and the validator from drifting apart. */
const AXIS_SPECS = buildAxisSpecs(DRIVES, PALETTE)
const AXES = renderAxisBlock(AXIS_SPECS)

// ── digest assembly (mirrors loop.ts submit seam) ────────────────────────────
// A minimal healthy base GameState. Snapshot fixtures (full_state / logged_in)
// overwrite ship+location wholesale via applyFullState, so their digest reflects
// the fixture. An observation_update carries no ship fields, so its fuel/hull
// fall back to this healthy base — a documented stateless divergence (README §6):
// live, those numbers come from the accumulated prior full_state.
const BASE_STATE: GameState = {
  player: {
    id: "",
    username: "vcarl",
    empire: "",
    credits: 0,
    current_system: "",
    current_poi: "",
    home_base: "",
    docked_at_base: null,
    faction_id: null,
    faction_rank: null,
    status_message: "",
    clan_tag: "",
    is_cloaked: false,
    anonymous: false,
    skills: {},
    skill_xp: {},
    stats: {},
  },
  ship: {
    id: "",
    class_id: "",
    name: "",
    hull: 100,
    max_hull: 100,
    shield: 0,
    max_shield: 0,
    shield_recharge: 0,
    armor: 0,
    speed: 0,
    fuel: 100,
    max_fuel: 100,
    cargo_used: 0,
    cargo_capacity: 0,
    cpu_used: 0,
    cpu_capacity: 0,
    power_used: 0,
    power_capacity: 0,
    weapon_slots: 0,
    defense_slots: 0,
    utility_slots: 0,
    modules: [],
    cargo: [],
  },
  poi: null,
  system: null,
  cargo: [],
  nearby: [],
  inCombat: false,
  connected: true,
  combat: { lastEventTick: null, onsetSeq: 0 },
  deathPending: false,
  tick: 0,
  timestamp: 0,
}

/**
 * Parse a fixture's `type: X\n<json>` event text into { type, event-object }.
 * Some dedup/nav fixtures preserve a real trailing ` (seen Nx recently)` suffix
 * AFTER the JSON, so slice the object by its outer braces rather than parsing the
 * whole remainder (the suffix carries no braces).
 */
function parseFixtureEvent(text: string): { type: string; obj: Record<string, unknown> } | null {
  const nl = text.indexOf("\n")
  if (nl < 0) return null
  const typeMatch = /^type:\s*(.+)$/i.exec(text.slice(0, nl).trim())
  const type = typeMatch ? typeMatch[1].trim() : "unknown"
  const rest = text.slice(nl + 1)
  const open = rest.indexOf("{")
  const close = rest.lastIndexOf("}")
  if (open < 0 || close <= open) return null
  try {
    const obj = JSON.parse(rest.slice(open, close + 1)) as Record<string, unknown>
    return { type, obj }
  } catch {
    return null
  }
}

/**
 * Reconstruct the STATUS digest the loop would prepend for this fixture, via the
 * REAL code path: run the fixture event through spaceMoltEventProcessor to fold
 * it onto BASE_STATE, then call the REAL formatEventDigest. Returns "" for
 * non-snapshot events (chat, combat, discrete) exactly like the runtime.
 */
function digestForFixture(fx: Fixture): string {
  const parsed = parseFixtureEvent(fx.event)
  if (!parsed || !isSnapshotEventType(parsed.type)) return ""
  let state: GameState = BASE_STATE
  try {
    const result = spaceMoltEventProcessor.processEvent(parsed.obj as never, state as never)
    if (result.stateUpdate) state = result.stateUpdate(state as never) as GameState
  } catch {
    return ""
  }
  return formatEventDigest(parsed.type, state)
}

function renderPrompt(fx: Fixture): string {
  // Mirror loop.ts: compose the STATUS digest into the model-facing text via the
  // SAME composeDigestedEventText the loop uses (digest under the `type:` line,
  // above the raw JSON). Composed on a copy of the fixture text (the fixture on
  // disk stays the raw payload) — same as the runtime composing it only after
  // fingerprinting.
  const event = composeDigestedEventText(fx.event, digestForFixture(fx))
  return skill.render({ event, waitState: fx.waitState, palette: PALETTE, drives: DRIVES, axes: AXES })
}

// Worked-example reason strings, parsed from the prompt template, for echo-rate.
function workedExampleReasons(template: string): string[] {
  const out: string[] = []
  const re = /"reason"\s*:\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) out.push(m[1])
  return out
}
const EXAMPLE_REASONS = workedExampleReasons(skill.template)

// ── mlx server lifecycle ─────────────────────────────────────────────────────
function portInUse(port: number): boolean {
  try {
    const out = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`).toString().trim()
    return out.length > 0
  } catch {
    return false
  }
}

let serverProc: ReturnType<typeof spawn> | null = null
function teardown(): void {
  if (serverProc && serverProc.pid && !serverProc.killed) {
    try {
      process.kill(-serverProc.pid, "SIGTERM") // kill the process group
    } catch {
      try {
        serverProc.kill("SIGTERM")
      } catch {}
    }
  }
}
process.on("SIGINT", () => {
  teardown()
  process.exit(130)
})
process.on("SIGTERM", () => {
  teardown()
  process.exit(143)
})

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function spawnServer(): Promise<void> {
  if (portInUse(PORT)) {
    throw new Error(`port ${PORT} already in use — refusing to spawn (verify with: lsof -iTCP:${PORT} -sTCP:LISTEN)`)
  }
  console.log(`[server] spawning ${PYTHON_BIN} --model ${MODEL} --port ${PORT}`)
  serverProc = spawn(PYTHON_BIN, ["--model", MODEL, "--host", "127.0.0.1", "--port", String(PORT)], {
    detached: true, // own process group so teardown can kill children
    stdio: ["ignore", "pipe", "pipe"],
  })
  serverProc.stdout?.on("data", () => {})
  serverProc.stderr?.on("data", () => {})
  serverProc.on("exit", (code) => {
    if (code !== null && code !== 0) console.error(`[server] exited code ${code}`)
  })

  // health-check: poll /v1/models until 200 (model loads at startup; be patient).
  const deadline = Date.now() + 240_000
  let ready = false
  while (Date.now() < deadline) {
    await sleep(2000)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/models`, { signal: AbortSignal.timeout(5000) })
      if (res.ok) {
        ready = true
        break
      }
    } catch {
      // not up yet
    }
  }
  if (!ready) throw new Error(`mlx server on :${PORT} never became healthy within 240s`)
  console.log(`[server] healthy on :${PORT}`)
}

// ── model call (mirrors model/client.ts attempt()) ───────────────────────────
interface RawCall {
  text: string
  finishReason?: string
  completionTokens?: number
  ok: boolean
  error?: string
}
async function callModel(prompt: string): Promise<RawCall> {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    stream: false,
    ...EXTRA_BODY,
  }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) return { text: "", ok: false, error: `HTTP ${res.status}` }
    const json: any = await res.json()
    const msg = json?.choices?.[0]?.message
    const text: string = msg?.content ?? msg?.reasoning ?? msg?.reasoning_content ?? ""
    return {
      text,
      ok: true,
      finishReason: json?.choices?.[0]?.finish_reason,
      completionTokens: json?.usage?.completion_tokens,
    }
  } catch (e) {
    return { text: "", ok: false, error: String(e) }
  }
}

// ── parse (mirrors runHindbrain: parseOr → appraise, then guardAppraisal) ─────
const PARSE_FALLBACK: Partial<ObserveResult> = {
  disposition: "accumulate",
  emotionalWeight: "😐",
  drive: null,
  weight: 0,
  reason: "parse failure — defaulting to accumulate",
}

interface SampleResult {
  raw: RawCall
  schemaValid: boolean
  driveNullString: boolean
  appraised: ObserveResult // post appraise()-clamp (the model's own call, pre-guard)
  guardClamped: boolean
  guardDowngraded: boolean
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function scoreSample(fx: Fixture, raw: RawCall): SampleResult {
  // schema-valid: did the raw text parse to a plain JSON object carrying the required fields?
  let schemaValid = false
  let driveNullString = false
  try {
    // reuse the runtime's extractor semantics via a direct parse of extractJson-equivalent:
    // parseOr already applies extractJson; here we detect validity by re-parsing the merged result.
    const parsedProbe = parseOr<Record<string, unknown>>(raw.text, {} as Record<string, unknown>)
    // parseOr returns fallback ({}) on miss; a valid parse yields disposition+weight keys.
    schemaValid =
      isPlainObj(parsedProbe) &&
      "disposition" in parsedProbe &&
      "weight" in parsedProbe &&
      "reason" in parsedProbe
    if (isPlainObj(parsedProbe) && parsedProbe.drive === "null") driveNullString = true
  } catch {
    schemaValid = false
  }
  // THREE arguments, matching the runtime (`tiers-limbic.ts:59-69`). With two,
  // the harness rendered the axis block into the prompt (run.ts:224), asked the
  // model for a `salience` vector, and then threw it away unvalidated — so the
  // 100%-bar gate was structurally blind to the one field observe.md spends its
  // last section demanding.
  const appraised = appraise(parseOr(raw.text, PARSE_FALLBACK), KNOWN_DRIVES, AXIS_SPECS)
  const g = guardAppraisal(fx.event, appraised)
  return {
    raw,
    schemaValid,
    driveNullString,
    appraised,
    guardClamped: g.clampedControlPlane,
    guardDowngraded: g.downgradedThreat,
  }
}

// ── per-sample pass + violation checks ───────────────────────────────────────
function reasonHasMustNot(reason: string, terms: string[]): string[] {
  const r = reason.toLowerCase()
  return terms.filter((t) => r.includes(t.toLowerCase()))
}
function isEscalating(o: ObserveResult): boolean {
  return o.disposition === "escalate" || o.interrupt === true || o.weight >= 4
}
function driveAllowed(drive: string | null, allowed: (string | null)[]): boolean {
  return allowed.some((a) => (a === null ? drive === null : a === drive))
}
interface SamplePass {
  pass: boolean
  dispositionOk: boolean
  weightOk: boolean
  driveOk: boolean
  mustNotHits: string[]
  escalationFalsePos: boolean
}
function checkPass(fx: Fixture, o: ObserveResult): SamplePass {
  const e = fx.expected
  const dispositionOk = e.disposition_one_of.includes(o.disposition)
  const weightOk = o.weight >= e.weight_range[0] && o.weight <= e.weight_range[1]
  const driveOk = driveAllowed(o.drive, e.drive_one_of)
  const mustNotHits = reasonHasMustNot(o.reason, e.must_not_contain_in_reason)
  const escalationFalsePos = !e.escalate_allowed && isEscalating(o)
  const pass = dispositionOk && weightOk && driveOk && mustNotHits.length === 0 && !escalationFalsePos
  return { pass, dispositionOk, weightOk, driveOk, mustNotHits, escalationFalsePos }
}

// ── echo rate: token-overlap containment vs any worked example ───────────────
function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean),
  )
}
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / a.size // fraction of the SAMPLE's tokens present in the example
}
const EXAMPLE_TOKSETS = EXAMPLE_REASONS.map(tokens)
function echoScore(reason: string): number {
  const rs = tokens(reason)
  let best = 0
  for (const ex of EXAMPLE_TOKSETS) best = Math.max(best, containment(rs, ex))
  return best
}

// ── entropy ──────────────────────────────────────────────────────────────────
function entropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  let h = 0
  for (const c of counts) {
    if (c === 0) continue
    const p = c / total
    h -= p * Math.log2(p)
  }
  return h
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const fixtures = loadFixtures()
  console.log(`[eval] prompt: ${PROMPT_PATH}`)
  console.log(`[eval] fixtures: ${fixtures.length} × ${SAMPLES} samples = ${fixtures.length * SAMPLES} calls`)
  console.log(`[eval] model: ${MODEL} @ temp ${TEMPERATURE} max_tokens ${MAX_TOKENS} extraBody ${JSON.stringify(EXTRA_BODY)}`)
  console.log(`[eval] worked-example reasons parsed for echo-rate: ${EXAMPLE_REASONS.length}`)

  await spawnServer()

  const perFixture: any[] = []
  const weightHist = [0, 0, 0, 0, 0, 0]
  const driveHist: Record<string, number> = { null: 0, safety: 0, sustenance: 0, agency: 0, other: 0 }
  let nSamples = 0
  let nSchemaValid = 0
  let nDriveNullString = 0
  let nGuardClamped = 0
  let nGuardDowngraded = 0
  let nCallErrors = 0
  const reasonLens: number[] = []
  const echoScores: number[] = []

  // must-not universe: samples belonging to fixtures that HAVE must-not terms.
  let nMustNotSamples = 0
  let nFabrications = 0
  // category-error: drive disallowed by category (e.g. safety on benign)
  let nCategoryErrors = 0
  // escalation false-positive universe: fixtures with escalate_allowed:false
  let nNoEscSamples = 0
  let nEscFalsePos = 0

  const catAgg: Record<string, { pass: number; total: number }> = {}

  const t0 = Date.now()
  for (const fx of fixtures) {
    const prompt = renderPrompt(fx)
    const samples: SampleResult[] = []
    const passes: SamplePass[] = []
    for (let k = 0; k < SAMPLES; k++) {
      const raw = await callModel(prompt)
      if (!raw.ok) nCallErrors++
      const sr = scoreSample(fx, raw)
      const sp = checkPass(fx, sr.appraised)
      samples.push(sr)
      passes.push(sp)

      nSamples++
      if (sr.schemaValid) nSchemaValid++
      if (sr.driveNullString) nDriveNullString++
      if (sr.guardClamped) nGuardClamped++
      if (sr.guardDowngraded) nGuardDowngraded++
      weightHist[sr.appraised.weight]++
      const d = sr.appraised.drive
      if (d === null) driveHist.null++
      else if (d in driveHist) driveHist[d]++
      else driveHist.other++
      reasonLens.push(sr.appraised.reason.length)
      echoScores.push(echoScore(sr.appraised.reason))

      if (fx.expected.must_not_contain_in_reason.length > 0) {
        nMustNotSamples++
        if (sp.mustNotHits.length > 0) nFabrications++
      }
      if (!sp.driveOk) nCategoryErrors++
      if (!fx.expected.escalate_allowed) {
        nNoEscSamples++
        if (sp.escalationFalsePos) nEscFalsePos++
      }

      catAgg[fx.category] ??= { pass: 0, total: 0 }
      catAgg[fx.category].total++
      if (sp.pass) catAgg[fx.category].pass++
    }

    perFixture.push({
      id: fx.id,
      category: fx.category,
      synthetic: fx.synthetic ?? false,
      dedup_eligible: fx.dedup_eligible ?? false,
      expected: fx.expected,
      samples: samples.map((s, i) => ({
        rawText: s.raw.text,
        ok: s.raw.ok,
        error: s.raw.error,
        finishReason: s.raw.finishReason,
        completionTokens: s.raw.completionTokens,
        schemaValid: s.schemaValid,
        driveNullString: s.driveNullString,
        appraised: s.appraised,
        guardClamped: s.guardClamped,
        guardDowngraded: s.guardDowngraded,
        pass: passes[i].pass,
        dispositionOk: passes[i].dispositionOk,
        weightOk: passes[i].weightOk,
        driveOk: passes[i].driveOk,
        mustNotHits: passes[i].mustNotHits,
        escalationFalsePos: passes[i].escalationFalsePos,
      })),
      passRate: passes.filter((p) => p.pass).length / passes.length,
    })
  }
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1)

  const pct = (n: number, d: number) => (d === 0 ? 0 : +((100 * n) / d).toFixed(1))
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1))
  const nEcho90 = echoScores.filter((s) => s >= 0.9).length

  const catPass: Record<string, number> = {}
  for (const [c, v] of Object.entries(catAgg)) catPass[c] = pct(v.pass, v.total)
  const overallPass = perFixture.reduce((a, f) => a + f.passRate, 0) / perFixture.length

  const metrics = {
    generatedAt: new Date().toISOString(),
    prompt: PROMPT_PATH,
    fixtures: FIXTURES_PATH,
    nFixtures: fixtures.length,
    samplesPerFixture: SAMPLES,
    nSamples,
    model: MODEL,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
    extraBody: EXTRA_BODY,
    elapsedSeconds: +elapsedS,
    callErrors: nCallErrors,
    metrics: {
      schemaValidPct: pct(nSchemaValid, nSamples),
      driveNullStringPct: pct(nDriveNullString, nSamples),
      fabricationRatePct: pct(nFabrications, nMustNotSamples),
      fabricationUniverse: nMustNotSamples,
      categoryErrorRatePct: pct(nCategoryErrors, nSamples),
      escalationFalsePosPct: pct(nEscFalsePos, nNoEscSamples),
      escalationFalsePosUniverse: nNoEscSamples,
      guardClampedPct: pct(nGuardClamped, nSamples),
      guardDowngradedPct: pct(nGuardDowngraded, nSamples),
      weightHistogram: { "0": weightHist[0], "1": weightHist[1], "2": weightHist[2], "3": weightHist[3], "4": weightHist[4], "5": weightHist[5] },
      weightEntropyBits: +entropy(weightHist).toFixed(3),
      driveHistogram: driveHist,
      meanReasonLenChars: mean(reasonLens),
      echoRatePct: pct(nEcho90, echoScores.length),
      meanEchoScore: mean(echoScores.map((x) => x * 100)),
      overallPassPct: +(100 * overallPass).toFixed(1),
      perCategoryPassPct: catPass,
    },
    perFixture,
  }

  mkdirSync(path.dirname(RESULTS_PATH), { recursive: true })
  writeFileSync(RESULTS_PATH, JSON.stringify(metrics, null, 2))

  printReport(metrics)
  console.log(`\n[eval] full results → ${RESULTS_PATH}`)
}

function printReport(m: any): void {
  const M = m.metrics
  const bar = (n: number, max: number, w = 24) => "█".repeat(Math.round((n / Math.max(1, max)) * w))
  console.log("\n" + "═".repeat(66))
  console.log(`APPRAISAL EVAL — ${path.basename(m.prompt)}  (${m.nSamples} samples, ${m.elapsedSeconds}s)`)
  console.log("═".repeat(66))
  console.log(`schema-valid            ${M.schemaValidPct}%`)
  console.log(`drive:"null"-string     ${M.driveNullStringPct}%`)
  console.log(`fabrication rate        ${M.fabricationRatePct}%   (of ${M.fabricationUniverse} must-not samples)`)
  console.log(`category-error rate     ${M.categoryErrorRatePct}%   (drive disallowed by category)`)
  console.log(`escalation false-pos    ${M.escalationFalsePosPct}%   (of ${M.escalationFalsePosUniverse} no-escalate samples)`)
  console.log(`guard clamped (CP)      ${M.guardClampedPct}%   guard downgraded (threat) ${M.guardDowngradedPct}%`)
  console.log(`mean reason length      ${M.meanReasonLenChars} chars`)
  console.log(`echo rate (≥90%)        ${M.echoRatePct}%   (mean echo ${M.meanEchoScore}%)`)
  console.log(`OVERALL PASS            ${M.overallPassPct}%`)
  console.log("\nweight histogram (entropy " + M.weightEntropyBits + " bits):")
  const wmax = Math.max(...Object.values(M.weightHistogram).map(Number))
  for (let w = 0; w <= 5; w++) {
    const c = M.weightHistogram[String(w)]
    console.log(`  w${w} ${String(c).padStart(4)} ${bar(c, wmax)}`)
  }
  console.log("\ndrive histogram:")
  const dmax = Math.max(...Object.values(M.driveHistogram).map(Number))
  for (const [d, c] of Object.entries(M.driveHistogram) as [string, number][]) {
    console.log(`  ${d.padEnd(11)} ${String(c).padStart(4)} ${bar(c, dmax)}`)
  }
  console.log("\nper-category pass %:")
  for (const [c, p] of Object.entries(M.perCategoryPassPct).sort()) {
    console.log(`  ${c.padEnd(24)} ${String(p).padStart(5)}%`)
  }
}

main()
  .catch((e) => {
    console.error("[eval] FATAL:", e)
    process.exitCode = 1
  })
  .finally(() => {
    teardown()
    // brief grace for the process group to die, then verify the port is clear.
    setTimeout(() => {
      const stillUp = portInUse(PORT)
      console.log(`[server] teardown ${stillUp ? "FAILED — port still in use!" : "ok — port clear"}`)
      process.exit(process.exitCode ?? 0)
    }, 1500)
  })
