#!/usr/bin/env node
/**
 * Signal Fleet TUI v2
 * 3x4 agent grid + per-agent thought stream panel + overlord log tail.
 *
 * Keys:
 *   Tab       -- cycle edict target
 *   [ / ]     -- cycle focused agent (thought panel)
 *   P         -- cycle edict priority
 *   Enter     -- send edict
 *   Ctrl+C    -- quit
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";

const PLAYERS_DIR = (() => {
  const i = process.argv.indexOf("--players-dir");
  if (i >= 0) return process.argv[i + 1];
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "players");
})();

const AGENTS = ["neonecho", "zealot", "savolent", "cipher", "pilgrim", "seeker", "drifter", "investigator", "blackjack", "scrapper"];
const REFRESH_MS = 2000;
const OVERLORD_LOG = path.join(PLAYERS_DIR, "..", "overlord.log");

// -- ANSI ---------------------------------------------------------------------
const ALT_ON  = "\x1b[?1049h"; // enter alternate screen
const ALT_OFF = "\x1b[?1049l"; // exit alternate screen
const HIDE    = "\x1b[?25l";
const SHOW    = "\x1b[?25h";
const EOL     = "\x1b[K";      // clear to end of line (no flicker)
const R      = "\x1b[0m";
const B      = "\x1b[1m";
const DIM    = "\x1b[2m";
const ITALIC = "\x1b[3m";
const CYAN   = "\x1b[36m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const MAGENTA= "\x1b[35m";
const BLUE   = "\x1b[34m";

function at(r, c) { return `\x1b[${r};${c}H\x1b[K`; } // move + clear to EOL
function clrLine() { return `\x1b[2K`; }
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ""); }
function trunc(s, n) { if (!s) return ""; s = String(s); return s.length > n ? s.slice(0, n - 1) + "\u2026" : s; }

// -- Data ---------------------------------------------------------------------
function readStatus(name) {
  try { return JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, name, "status.json"), "utf-8")); }
  catch { return null; }
}

function readThoughts(name, n) {
  try {
    const raw = fs.readFileSync(path.join(PLAYERS_DIR, name, "logs", "thoughts.jsonl"), "utf-8");
    return raw.trim().split("\n").filter(Boolean).slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function readActions(name, n) {
  try {
    const raw = fs.readFileSync(path.join(PLAYERS_DIR, name, "logs", "actions.jsonl"), "utf-8");
    return raw.trim().split("\n").filter(Boolean).slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function readOverlordLog(n) {
  try { return fs.readFileSync(OVERLORD_LOG, "utf-8").trim().split("\n").slice(-n); }
  catch { return ["(no overlord.log)"]; }
}

function writeEdict(name, content, priority) {
  try {
    const inbox = path.join(PLAYERS_DIR, name, "inbox");
    fs.mkdirSync(inbox, { recursive: true });
    const id = `${Date.now()}-tui-${Math.random().toString(36).slice(2, 6)}.json`;
    fs.writeFileSync(path.join(inbox, id), JSON.stringify({ id, priority, content, issuedAt: new Date().toISOString(), source: "tui" }, null, 2));
    return true;
  } catch { return false; }
}

function ageStr(iso) {
  if (!iso) return "?";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

function isAlive(st) {
  return !!(st?.lastUpdated && (Date.now() - new Date(st.lastUpdated).getTime()) < 180_000);
}

function phaseColor(p) {
  if (!p) return DIM;
  if (p === "active") return GREEN;
  if (p === "social") return YELLOW;
  if (p === "reflection") return BLUE;
  if (p === "startup") return CYAN;
  if (p === "dinner" || p === "dream") return MAGENTA;
  return DIM;
}

// -- State --------------------------------------------------------------------
let inputBuf = "";
const allTargets = ["all", ...AGENTS];
let targetIdx = 0;
const priorities = ["low", "high", "critical"];
let prioIdx = 1;
let focusIdx = 0;
let showOvermind = false;  // O key toggles overmind log panel
let statusMsg = "";
let statusMsgTs = 0;

// -- Agent card (returns array of content strings, no borders) ----------------
function agentCardLines(name, st, inner, focused) {
  const alive = isAlive(st);
  const mark = focused ? YELLOW + "\u25B8" + R : " ";

  if (!st) return [
    mark + " " + (focused ? B + YELLOW : DIM) + trunc(name.toUpperCase(), inner - 2) + R,
    "  " + DIM + "offline" + R,
    "",
  ];

  const phase = st.phase || "?";
  const sit = st.metrics?.situation || st.situation || "";
  const goal = st.currentGoal || "";
  return [
    mark + " " + (alive ? B + CYAN : DIM) + trunc(name.toUpperCase(), inner - 2) + R,
    "  " + phaseColor(phase) + phase + R + "  " + DIM + ageStr(st.lastUpdated) + R,
    "  " + DIM + trunc(sit || goal, inner - 2) + R,
  ];
}

// -- Word wrap ----------------------------------------------------------------
function wrap(text, maxW) {
  const words = text.split(" ");
  const out = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + w.length + 1 > maxW) { if (cur) out.push(cur); cur = w; }
    else { cur = cur ? cur + " " + w : w; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

// -- Thought panel: fills entire budget, all types, wrapped -------------------
function thoughtLines(name, W, budget) {
  if (budget < 2) return [];

  const st = readStatus(name);
  const alive = isAlive(st);
  const phase = st?.phase || "offline";
  const inner = W - 6;  // indent + right margin

  // Thoughts and plans only — no tool calls
  const thoughts = readThoughts(name, 200);
  const events = [];
  for (const t of thoughts) {
    const ts = t.timestamp || "";
    if (t.type === "text" && t.text) {
      events.push({ ts, kind: "thought", source: t.source || "?", text: String(t.text) });
    } else if (t.type === "plan" && t.plan) {
      const p = typeof t.plan === "string" ? t.plan : JSON.stringify(t.plan);
      events.push({ ts, kind: "plan", text: p });
    }
  }
  events.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);

  // Render into wrapped lines
  const raw = [];
  for (const ev of events) {
    if (ev.kind === "thought") {
      const prefix = DIM + "[" + ev.source.slice(0, 8) + "]" + R + " ";
      const prefixLen = stripAnsi(prefix).length;
      const wrapped = wrap(ev.text.replace(/\n/g, " "), inner - prefixLen);
      raw.push("  " + prefix + ITALIC + wrapped[0] + R);
      for (let i = 1; i < wrapped.length; i++) {
        raw.push("  " + " ".repeat(prefixLen) + ITALIC + wrapped[i] + R);
      }
    } else if (ev.kind === "plan") {
      const wrapped = wrap(ev.text, inner - 6);
      raw.push("  " + CYAN + "PLAN" + R + "  " + DIM + wrapped[0] + R);
      for (let i = 1; i < wrapped.length; i++) {
        raw.push("  " + "      " + DIM + wrapped[i] + R);
      }
    }
  }

  // Header takes 2 rows; content budget = budget - 2
  const contentBudget = budget - 2;
  // Take the most recent lines that fit
  const visible = raw.slice(-contentBudget);
  // Pad top if short
  while (visible.length < contentBudget) visible.unshift("");

  const bar = DIM + "\u2500".repeat(W) + R;
  const header =
    " " + B + YELLOW + name.toUpperCase() + R +
    "  " + phaseColor(phase) + phase + R +
    "  " + (alive ? GREEN + "\u25CF live" : DIM + "\u25CB stale") + R +
    "  " + DIM + (events.length ? events.length + " events" : "idle") + R;

  return [bar, header, ...visible];
}

// -- Main render (strict row budget) ------------------------------------------
function render() {
  const W = process.stdout.columns || 140;
  const H = process.stdout.rows || 40;

  // Fixed layout constants
  const EDICT_ROWS = 4;          // divider + target line + input + status
  const HEADER_ROWS = 2;         // title + divider
  const COLS = 4;
  const CARD_LINES = 3;          // content lines per card (no borders)
  const CARD_HEIGHT = CARD_LINES + 2; // +top +bottom border
  const GRID_ROWS = 3;
  const GRID_HEIGHT = GRID_ROWS * CARD_HEIGHT; // no spacers between rows

  const BODY_START = HEADER_ROWS + 1;  // row index after header
  const EDICT_START = H - EDICT_ROWS + 1;
  const BODY_END = EDICT_START - 1;
  const BODY_HEIGHT = BODY_END - BODY_START + 1;

  const GRID_END = BODY_START + GRID_HEIGHT - 1;
  // Thought panel gets ALL remaining space between grid and edict bar
  const THOUGHT_BUDGET = Math.max(0, EDICT_START - GRID_END - 1);

  const bw = Math.floor((W - (COLS - 1) * 2) / COLS);
  const inner = bw - 4;
  const divider = DIM + "\u2500".repeat(W) + R;

  // Build frame into array of lines, then write each to its absolute position.
  // No full-screen clear = no flicker. EOL wipes leftover chars from prior frame.
  let o = "";

  // ── Header ────────────────────────────────────────────────────────────────
  const allSts = AGENTS.map(n => readStatus(n));
  const online = allSts.filter(s => isAlive(s)).length;
  const active = allSts.filter(s => s?.phase === "active").length;
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });

  const modeLabel = showOvermind
    ? MAGENTA + B + "OVERMIND" + R
    : YELLOW + B + "STREAM:" + R + " " + YELLOW + AGENTS[focusIdx].toUpperCase() + R;

  o += at(1, 1) + " " + B + CYAN + "CULT SIGNAL" + R +
    "  " + modeLabel +
    "  " + GREEN + online + "/" + AGENTS.length + " live" + R +
    "  " + YELLOW + active + " active" + R +
    "  " + DIM + ts + R +
    "  " + DIM + "[ / ] focus \u00B7 O overmind \u00B7 Tab target \u00B7 P priority" + R;
  o += at(2, 1) + divider;

  // ── Agent grid ────────────────────────────────────────────────────────────
  const sts = AGENTS.map((n, i) => ({ name: n, st: allSts[i], focused: i === focusIdx }));
  let gridRow = BODY_START;

  for (let ri = 0; ri < GRID_ROWS; ri++) {
    const rowAgents = sts.slice(ri * COLS, ri * COLS + COLS);
    const boxes = rowAgents.map(({ name, st, focused }) => agentCardLines(name, st, inner, focused));

    // top border
    o += at(gridRow++, 1);
    for (let i = 0; i < COLS; i++) {
      const foc = rowAgents[i]?.focused;
      o += (foc ? YELLOW : DIM) + "\u250C" + "\u2500".repeat(bw - 2) + "\u2510" + R + "  ";
    }

    // content
    for (let l = 0; l < CARD_LINES; l++) {
      o += at(gridRow++, 1);
      for (let i = 0; i < COLS; i++) {
        const ag = rowAgents[i];
        if (!ag) { o += " ".repeat(bw + 2); continue; }
        const line = boxes[i]?.[l] ?? "";
        const padding = Math.max(0, bw - 4 - stripAnsi(line).length);
        o += (ag.focused ? YELLOW : DIM) + "\u2502" + R + " " + line + " ".repeat(padding) + (ag.focused ? YELLOW : DIM) + " \u2502" + R + "  ";
      }
    }

    // bottom border
    o += at(gridRow++, 1);
    for (let i = 0; i < COLS; i++) {
      const foc = rowAgents[i]?.focused;
      o += (foc ? YELLOW : DIM) + "\u2514" + "\u2500".repeat(bw - 2) + "\u2518" + R + "  ";
    }
  }

  // ── Lower panel (thought stream or overmind log) ──────────────────────────
  if (THOUGHT_BUDGET > 0) {
    let tr = GRID_END + 1;
    if (showOvermind) {
      const bar = DIM + "\u2500".repeat(W) + R;
      const logLines = readOverlordLog(THOUGHT_BUDGET - 2);
      o += at(tr++, 1) + bar;
      o += at(tr++, 1) + " " + B + MAGENTA + "OVERMIND LOG" + R + "  " + DIM + OVERLORD_LOG + R;
      for (const l of logLines) {
        if (tr >= EDICT_START) break;
        o += at(tr++, 1) + " " + DIM + trunc(stripAnsi(l), W - 2) + R;
      }
      // pad remaining rows blank
      while (tr < EDICT_START) o += at(tr++, 1);
    } else {
      const tLines = thoughtLines(AGENTS[focusIdx], W, THOUGHT_BUDGET);
      for (const l of tLines) {
        if (tr >= EDICT_START) break;
        o += at(tr++, 1) + l;
      }
    }
  }

  // ── Edict bar (absolute bottom) ───────────────────────────────────────────
  const tgt = allTargets[targetIdx];
  const pri = priorities[prioIdx];
  const tgtLabel = CYAN + B + tgt + R;
  const priLabel = pri === "critical" ? RED + pri + R : pri === "high" ? YELLOW + pri + R : DIM + pri + R;

  o += at(EDICT_START, 1) + divider;
  o += at(EDICT_START + 1, 1) +
    " " + B + "EDICT" + R + " \u2192 " + tgtLabel +
    "  [" + priLabel + "]" +
    "  " + DIM + "(Tab=target  [/]=focus  P=priority  Enter=send  ^C=quit)" + R;
  o += at(EDICT_START + 2, 1) + " " + CYAN + ">" + R + " " + inputBuf + GREEN + "\u2588" + R;

  if (statusMsg && Date.now() - statusMsgTs < 3000) {
    o += at(EDICT_START + 3, 1) + " " + GREEN + statusMsg + R;
  } else {
    o += at(EDICT_START + 3, 1) + clrLine();
  }

  process.stdout.write(o);
}

// -- Input --------------------------------------------------------------------
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
// ALT_ON + HIDE written at boot

process.stdin.on("keypress", (ch, key) => {
  if (!key) return;
  if (key.ctrl && key.name === "c") { process.stdout.write(SHOW + ALT_OFF); process.exit(0); }
  if (key.name === "tab")           { targetIdx = (targetIdx + 1) % allTargets.length; render(); return; }
  if (ch === "[")                   { focusIdx = (focusIdx - 1 + AGENTS.length) % AGENTS.length; render(); return; }
  if (ch === "]")                   { focusIdx = (focusIdx + 1) % AGENTS.length; render(); return; }
  if (ch === "p" || ch === "P")     { prioIdx = (prioIdx + 1) % priorities.length; render(); return; }
  if (ch === "o" || ch === "O")     { showOvermind = !showOvermind; render(); return; }
  if (key.name === "return" || key.name === "enter") {
    const msg = inputBuf.trim();
    if (msg) {
      const targets = allTargets[targetIdx] === "all" ? AGENTS : [allTargets[targetIdx]];
      let ok = 0;
      for (const t of targets) { if (writeEdict(t, msg, priorities[prioIdx])) ok++; }
      statusMsg = "\u2713 Edict sent to " + ok + " agent(s): " + trunc(msg, 50);
      statusMsgTs = Date.now();
      inputBuf = "";
    }
    render(); return;
  }
  if (key.name === "backspace") { inputBuf = inputBuf.slice(0, -1); render(); return; }
  if (ch && !key.ctrl && !key.meta && ch.length === 1) { inputBuf += ch; render(); }
});

// -- Boot ---------------------------------------------------------------------
process.on("exit", () => process.stdout.write(SHOW + ALT_OFF));
process.stdout.write(ALT_ON + HIDE);
render();
setInterval(render, REFRESH_MS);
