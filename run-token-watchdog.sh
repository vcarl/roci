#!/usr/bin/env bash
# run-token-watchdog.sh — Proactive Claude OAuth token refresh daemon
#
# Runs in WSL. Monitors ~/.claude/.credentials.json expiry.
# When < REFRESH_THRESHOLD_MIN remaining, calls refresh-token.py to silently
# refresh the access token via the OAuth API (no browser required).
#
# STANDALONE TERMINAL ONLY. Launched from launch-fleet.bat.

SIGNAL_DIR="/home/savolent/Signal"
CREDS_PATH="/home/savolent/.claude/.credentials.json"
REFRESH_SCRIPT="${SIGNAL_DIR}/refresh-token.py"
SYNC_SCRIPT="/mnt/c/Users/Roy D. Lewis Jr/NeonEcho/Scratch/sync-oauth.py"

CHECK_INTERVAL_S=300     # Check every 5 minutes
REFRESH_THRESHOLD_MIN=45 # Refresh when < 45min remaining

get_expiry_min() {
    python3 -c "
import json, time
try:
    d = json.load(open('/home/savolent/.claude/.credentials.json'))
    exp = d.get('claudeAiOauth', {}).get('expiresAt', 0)
    print(max(0, (exp - int(time.time() * 1000)) // 60000))
except Exception:
    print(0)
"
}

echo "[token-watchdog] Started at $(date -u '+%H:%M UTC')"
echo "[token-watchdog] Threshold: ${REFRESH_THRESHOLD_MIN}min | Check: every ${CHECK_INTERVAL_S}s"
echo "---"

do_refresh() {
    local label="$1"
    python3 "$REFRESH_SCRIPT" "$2"
    local rc=$?
    if [ $rc -ne 0 ]; then
        echo "[watchdog] API refresh failed (exit $rc) — falling back to Windows sync."
        python3 "$SYNC_SCRIPT" || echo "[watchdog] Windows sync also failed."
    fi
}

# Proactive check on startup
exp_min=$(get_expiry_min)
echo "[token-watchdog] Startup: WSL token ${exp_min}min remaining"
if [ "$exp_min" -lt "$REFRESH_THRESHOLD_MIN" ]; then
    echo "[token-watchdog] Low on startup — refreshing now."
    do_refresh "startup" ""
fi

while true; do
    sleep "$CHECK_INTERVAL_S"

    exp_min=$(get_expiry_min)
    ts=$(date -u '+%H:%M UTC')

    if [ "$exp_min" -eq 0 ]; then
        echo "[watchdog ${ts}] WARNING: credentials unreadable or expired. Attempting forced refresh."
        do_refresh "$ts" "--force"
        continue
    fi

    echo "[watchdog ${ts}] WSL token: ${exp_min}min remaining"

    if [ "$exp_min" -lt "$REFRESH_THRESHOLD_MIN" ]; then
        echo "[watchdog ${ts}] ALERT: < ${REFRESH_THRESHOLD_MIN}min — refreshing now."
        do_refresh "$ts" ""
    fi
done
