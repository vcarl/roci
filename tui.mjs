#!/usr/bin/env node
/**
 * Signal Fleet TUI
 * Polls agent status.json files + overlord log tail.
 * Tab = cycle agent target, P = cycle priority, Enter = send edict, Ctrl+C = quit
 *
 * Usage: node tui.mjs [--players-dir /path/to/players]
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

const AGENTS = ["neonecho", "zealot", "savolent", "cipher", "pilgrim", "seeker", "drifter", "investigator"];
const REFRESH_MS = 3000;
const OVERLORD_LOG = path.join(PLAYERS_DIR, "..", "overlord.log");

// ── ANSI ──────────────────────────────────────────────────────────────────────
const ESC = "\x1b[";
const CLEAR = "\x1b[2J\x1b[H";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const R = "\x1b[0m";
const B = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

function move(r, c) { return `${ESC}${r};${c}H`; }
function clr() { return `${ESC}2K`; }
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ""); }
function trunc(s, n) { if (!s) return ""; s = String(s); return s.length > n ? s.slice(0, n-1) + "\u2026" : s; }

// ── Data ──────────────────────────────────────────────────────────────────────
function readStatus(name) {
  try { return JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, name, "status.json"), "utf-8")); }
  catch { return null; }
}

function ageStr(iso) {
  if (!iso) return "?";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s/60) + "m";
  return Math.floor(s/3600) + "h";
}

function readOverlordLog(n) {
  try { return fs.readFileSync(OVERLORD_LOG, "utf-8").trim().split("\n").slice(-n); }
  catch { return ["(no overlord.log found — is overlord running?)"]; }
}

function writeEdict(name, content, priority) {
  try {
    const inbox = path.join(PLAYERS_DIR, name, "inbox");
    fs.mkdirSync(inbox, { recursive: true });
    const id = `${Date.now()}-tui-${Math.random().toString(36).slice(2,6)}.json`;
    fs.writeFileSync(path.join(inbox, id), JSON.stringify({
      id, priority, content, issuedAt: new Date().toISOString(), source: "operator-tui"
    }, null, 2));
    return true;
  } catch { return false; }
}

// ── State ─────────────────────────────────────────────────────────────────────
let inputBuf = "";
const allTargets = ["all", ...AGENTS];
let targetIdx = 0;
const priorities = ["low", "high", "critical"];
let prioIdx = 1;
let statusMsg = "";
let statusMsgTs = 0;

function targetAgent() { return allTargets[targetIdx]; }
function priority() { return priorities[prioIdx]; }

// ── Render ────────────────────────────────────────────────────────────────────
function phaseColor(p) {
  if (!p) return DIM;
  if (p === "active") return GREEN;
  if (p === "social") return YELLOW;
  if (p === "reflection") return BLUE;
  if (p === "startup") return CYAN;
  return DIM;
}

function renderAgent(name, st, bw) {
  const inner = bw - 4;
  const alive = st && st.lastUpdated && (Date.now() - new Date(st.lastUpdated).getTime()) < 180_000;
  const lines = [];
  lines.push((alive ? B + CYAN : DIM) + trunc(name.toUpperCase(), inner) + R);
  if (!st) {
    lines.push(DIM + "offline" + R);
    lines.push("");
    lines.push("");
  } else {
    const phase = st.phase || "?";
    lines.push(phaseColor(phase) + phase + R + DIM + " " + ageStr(st.lastUpdated) + " ago" + R);
    const sit = st.metrics?.situation || st.situation || "";
    const step = st.stepIndex != null ? "step " + st.stepIndex : "";
    lines.push(DIM + trunc([sit, step].filter(Boolean).join(" \xB7 "), inner) + R);
    lines.push(DIM + trunc(st.currentGoal || "", inner) + R);
  }
  return lines;
}

function render() {
  const W = process.stdout.columns || 120;
  const H = process.stdout.rows || 40;
  const bw = Math.floor((W - 6) / 4);
  const divider = DIM + "\u2500".repeat(W) + R;

  let o = CLEAR;
  let row = 1;

  // Header
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  o += move(row++, 1) + " " + B + CYAN + "CULT SIGNAL" + R + "  Fleet TUI  " + DIM + ts + R;
  o += move(row++, 1) + divider;

  // Agent grid 2x4
  const sts = AGENTS.map(n => ({ name: n, st: readStatus(n) }));
  for (let ri = 0; ri < 2; ri++) {
    const row4 = sts.slice(ri * 4, ri * 4 + 4);
    const boxes = row4.map(({ name, st }) => renderAgent(name, st, bw));

    // top border
    o += move(row++, 1);
    for (let i = 0; i < 4; i++) { o += DIM + "\u250C" + "\u2500".repeat(bw-2) + "\u2510" + R + "  "; }

    // 4 content lines
    for (let l = 0; l < 4; l++) {
      o += move(row++, 1);
      for (let i = 0; i < 4; i++) {
        const line = boxes[i]?.[l] ?? "";
        const plain = stripAnsi(line);
        const pad = Math.max(0, bw - 4 - plain.length);
        o += DIM + "\u2502 " + R + line + " ".repeat(pad) + DIM + " \u2502" + R + "  ";
      }
    }

    // bottom border
    o += move(row++, 1);
    for (let i = 0; i < 4; i++) { o += DIM + "\u2514" + "\u2500".repeat(bw-2) + "\u2518" + R + "  "; }
    row++;
  }

  // Overlord log
  o += move(row++, 1) + divider;
  o += move(row++, 1) + " " + B + MAGENTA + "OVERLORD" + R;
  const logLines = readOverlordLog(Math.max(2, H - row - 6));
  for (const line of logLines) {
    o += move(row++, 1) + " " + DIM + trunc(stripAnsi(line), W - 2) + R;
  }

  // Edict bar
  const ir = H - 3;
  o += move(ir, 1) + divider;

  const tgt = allTargets[targetIdx];
  const pri = priorities[prioIdx];
  const tgtLabel = CYAN + B + tgt + R;
  const priLabel = pri === "critical" ? RED + pri + R : pri === "high" ? YELLOW + pri + R : DIM + pri + R;
  o += move(ir+1, 1) + " " + B + "EDICT" + R + " \u2192 " + tgtLabel + "  [" + priLabel + "]  " + DIM + "(Tab=target  P=priority  Enter=send  Ctrl+C=quit)" + R;
  o += move(ir+2, 1) + " " + CYAN + ">" + R + " " + inputBuf + GREEN + "\u2588" + R;

  if (statusMsg && Date.now() - statusMsgTs < 3000) {
    o += move(ir+3, 1) + " " + GREEN + statusMsg + R;
  } else {
    o += move(ir+3, 1) + clr();
  }

  process.stdout.write(o);
}

// ── Input ─────────────────────────────────────────────────────────────────────
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write(HIDE);

process.stdin.on("keypress", (ch, key) => {
  if (!key) return;
  if (key.ctrl && key.name === "c") { process.stdout.write(SHOW + CLEAR); process.exit(0); }
  if (key.name === "tab") { targetIdx = (targetIdx + 1) % allTargets.length; render(); return; }
  if ((key.name === "p") || (ch === "p") || (ch === "P")) { prioIdx = (prioIdx + 1) % priorities.length; render(); return; }
  if (key.name === "return" || key.name === "enter") {
    const msg = inputBuf.trim();
    if (msg) {
      const targets = allTargets[targetIdx] === "all" ? AGENTS : [allTargets[targetIdx]];
      let ok = 0;
      for (const t of targets) { if (writeEdict(t, msg, priorities[prioIdx])) ok++; }
      statusMsg = "\u2713 Edict sent to " + ok + " agent(s): " + trunc(msg, 40);
      statusMsgTs = Date.now();
      inputBuf = "";
    }
    render(); return;
  }
  if (key.name === "backspace") { inputBuf = inputBuf.slice(0, -1); render(); return; }
  if (ch && !key.ctrl && !key.meta && ch.length === 1) { inputBuf += ch; render(); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
process.on("exit", () => process.stdout.write(SHOW));
render();
setInterval(render, REFRESH_MS);
