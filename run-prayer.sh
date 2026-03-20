#!/usr/bin/env bash
# run-prayer.sh — Launch Prayer DSL server in WSL (accessible by Docker containers at 172.17.0.1:5000)

PRAYER_DIR="/home/savolent/Signal/Prayer/publish"

# If Prayer is already running, tail its output instead of starting a second instance
if curl -s http://localhost:5000/health > /dev/null 2>&1; then
  echo "[prayer] Already running on :5000 — attaching to existing process."
  PRAYER_PID=$(ss -tlnp 2>/dev/null | grep ':5000' | grep -oP 'pid=\K[0-9]+' | head -1)
  if [ -n "$PRAYER_PID" ]; then
    echo "[prayer] PID $PRAYER_PID. Waiting..."
    tail --pid="$PRAYER_PID" -f /dev/null
  else
    echo "[prayer] PID unknown. Sleeping to keep tab alive."
    sleep infinity
  fi
  exit 0
fi

echo "[prayer] Starting Prayer server on 0.0.0.0:5000..."
cd "$PRAYER_DIR"
exec /home/savolent/.dotnet/dotnet Prayer.dll --urls http://0.0.0.0:5000
