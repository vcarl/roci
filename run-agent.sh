#!/usr/bin/env bash
# run-agent.sh — Single agent launcher (no usage monitor — run-monitor.sh handles that)
#
# STANDALONE TERMINAL ONLY.
#
# Usage: bash ~/Signal/run-agent.sh <name>
#   e.g. bash ~/Signal/run-agent.sh neonecho

AGENT="${1:?Usage: run-agent.sh <agent-name>}"
SIGNAL_DIR="/home/savolent/Signal"

export SKIP_FIREWALL=1
export EMBED_BASE_URL=http://localhost:11435
export EMBED_MODEL=BAAI/bge-small-en-v1.5
export OPENROUTER_API_KEY=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
# 172.17.0.1 = Docker bridge gateway = WSL2 host (Prayer runs in WSL)
export PRAYER_BASE_URL=http://172.17.0.1:5000

bash "$SIGNAL_DIR/start-embed.sh"
cd "$SIGNAL_DIR"

while true; do
  echo "[${AGENT}] Starting in nonstop mode..."
  node "$SIGNAL_DIR/apps/signal/bin/signal.js" start --nonstop --domain spacemolt "$AGENT"
  EXIT_CODE=$?
  echo "[${AGENT}] Node exited (code ${EXIT_CODE}). Restarting in 30s..."
  sleep 30
done
