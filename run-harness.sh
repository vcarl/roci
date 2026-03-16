#!/usr/bin/env bash
# run-harness.sh — Signal harness launcher w/ usage-based wind-down
#
# STANDALONE TERMINAL ONLY.
# Claude Code API contention starves subprocess claude -p calls.
#
# Usage:
#   bash ~/Signal/run-harness.sh                          # neonecho only
#   bash ~/Signal/run-harness.sh neonecho zealot savolent # officers
#   bash ~/Signal/run-harness.sh neonecho zealot savolent cipher pilgrim seeker drifter investigator

USAGE_LIMIT=70      # % session usage that triggers wind-down
CHECK_INTERVAL=300  # seconds between usage checks (5 min)

SIGNAL_DIR="/home/savolent/Signal"
PLAYERS_DIR="$SIGNAL_DIR/players"

AGENTS="${*:-neonecho}"

echo "[harness] ═══════════════════════════════════════════════"
echo "[harness] Signal harness — nonstop mode"
echo "[harness] Agents: $AGENTS"
echo "[harness] Wind-down at: ${USAGE_LIMIT}% session usage"
echo "[harness] ═══════════════════════════════════════════════"

# ── Environment ────────────────────────────────────────────────────────
export SKIP_FIREWALL=1
export EMBED_BASE_URL=http://localhost:11435
export EMBED_MODEL=BAAI/bge-small-en-v1.5
export OPENROUTER_API_KEY=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
export PRAYER_BASE_URL=http://host.docker.internal:5000

# ── Usage monitor sidecar ──────────────────────────────────────────────
usage_monitor() {
  echo "[monitor] Started. Threshold: ${USAGE_LIMIT}%. Interval: ${CHECK_INTERVAL}s."
  while true; do
    sleep "$CHECK_INTERVAL"

    # Get usage from claude /usage built-in command
    local usage_output
    usage_output=$(printf '/usage' | claude --output-format text 2>/dev/null || true)

    if [ -z "$usage_output" ]; then
      echo "[monitor] Usage unavailable — skipping"
      continue
    fi

    # Extract session % — matches "Session: 45%" or "session usage: 45%"
    local session_pct
    session_pct=$(echo "$usage_output" | grep -iE 'session' | grep -oE '[0-9]+%' | head -1 | tr -d '%')
    session_pct="${session_pct:-0}"

    # Extract "resets in Xh Ym Zs" → compute session_end_time ISO
    local session_end_iso=""
    local resets_line
    resets_line=$(echo "$usage_output" | grep -iE 'resets? in' || true)
    if [ -n "$resets_line" ]; then
      session_end_iso=$(python3 -c "
import re, datetime
line = '''$resets_line'''
h = int(m.group(1)) if (m := re.search(r'(\d+)\s*h', line)) else 0
mins = int(m.group(1)) if (m := re.search(r'(\d+)\s*m', line)) else 0
s = int(m.group(1)) if (m := re.search(r'(\d+)\s*s', line)) else 0
total_s = h*3600 + mins*60 + s
if total_s > 0:
  dt = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=total_s)
  print(dt.isoformat())
" 2>/dev/null || true)
    fi

    echo "[monitor] Session: ${session_pct}% / ${USAGE_LIMIT}% limit"

    if [ "$session_pct" -ge "$USAGE_LIMIT" ] 2>/dev/null; then
      echo "[monitor] LIMIT REACHED. Writing WIND_DOWN.json..."
      mkdir -p "$PLAYERS_DIR"

      # Write wind-down JSON
      local now_iso
      now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      local payload="{\"reason\":\"usage limit ${USAGE_LIMIT}% reached\",\"issuedAt\":\"${now_iso}\""
      if [ -n "$session_end_iso" ]; then
        payload="${payload},\"sessionEndTime\":\"${session_end_iso}\""
        echo "[monitor] Session end: $session_end_iso"
      fi
      payload="${payload}}"
      echo "$payload" > "$PLAYERS_DIR/WIND_DOWN.json"
      echo "[monitor] WIND_DOWN.json written. Harness will halt gracefully."

      # Wait for nonstop to clear it and restart
      echo "[monitor] Waiting for harness to clear wind-down and restart..."
      while [ -f "$PLAYERS_DIR/WIND_DOWN.json" ]; do
        sleep 30
      done
      echo "[monitor] Wind-down cleared. Resuming usage monitoring."
    fi
  done
}

# ── Cleanup on exit ────────────────────────────────────────────────────
MONITOR_PID=""
cleanup() {
  echo "[harness] Interrupt received — stopping..."
  [ -n "$MONITOR_PID" ] && kill "$MONITOR_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# ── Start embed server ─────────────────────────────────────────────────
bash "$SIGNAL_DIR/start-embed.sh"

# ── Start usage monitor in background ─────────────────────────────────
usage_monitor &
MONITOR_PID=$!

# ── Launch harness (nonstop) ───────────────────────────────────────────
echo "[harness] Launching: signal start --nonstop --domain spacemolt $AGENTS"
node "$SIGNAL_DIR/apps/signal/bin/roci.js" start --nonstop --domain spacemolt $AGENTS

# Harness exited — clean up monitor
[ -n "$MONITOR_PID" ] && kill "$MONITOR_PID" 2>/dev/null || true
echo "[harness] Done."
