#!/usr/bin/env bash
# run-monitor.sh — Usage monitor for Signal harness
# Reads from last.json cache (written by Claude Code /usage-check).
# Writes WIND_DOWN.json at threshold. Nonstop clears it after session resets.

USAGE_LIMIT=60
CHECK_INTERVAL=300
PLAYERS_DIR="/home/savolent/Signal/players"
CACHE_FILE="/mnt/c/Users/Roy D. Lewis Jr/.claude/skills/usage-check/last.json"

echo "[monitor] Started. Threshold: ${USAGE_LIMIT}%. Interval: ${CHECK_INTERVAL}s."

while true; do
  sleep "$CHECK_INTERVAL"

  if [ ! -f "$CACHE_FILE" ]; then
    echo "[monitor] Cache not found — skipping"
    continue
  fi

  result=$(python3 /home/savolent/Signal/monitor_parse.py "$CACHE_FILE")

  if [ "$result" = "STALE" ] || [ -z "$result" ]; then
    echo "[monitor] Cache stale or unreadable — skipping"
    continue
  fi

  session_pct="${result%%|*}"
  session_end_iso="${result##*|}"
  echo "[monitor] Session: ${session_pct}% / ${USAGE_LIMIT}% (ends: ${session_end_iso:-unknown})"

  if [ "$session_pct" -ge "$USAGE_LIMIT" ] 2>/dev/null; then
    echo "[monitor] LIMIT REACHED — writing wind-down..."
    mkdir -p "$PLAYERS_DIR"
    now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    payload="{\"reason\":\"usage limit ${USAGE_LIMIT}% reached\",\"issuedAt\":\"${now_iso}\""
    if [ -n "$session_end_iso" ]; then
      payload="${payload},\"sessionEndTime\":\"${session_end_iso}\""
      echo "[monitor] Session ends: $session_end_iso"
    else
      echo "[monitor] WARNING: no sessionEndTime — nonstop restarts after 60s"
    fi
    payload="${payload}}"
    echo "$payload" > "$PLAYERS_DIR/WIND_DOWN.json"
    echo "[monitor] WIND_DOWN.json written. Waiting for nonstop to clear..."
    while [ -f "$PLAYERS_DIR/WIND_DOWN.json" ]; do sleep 30; done
    echo "[monitor] Cleared. Resuming."
  fi
done
