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
export PRAYER_BASE_URL=http://localhost:5000

bash "$SIGNAL_DIR/start-embed.sh"
cd "$SIGNAL_DIR"

# Refresh credentials on startup: refresh if < 45min remaining, then update .oauth-token files
python3 "$SIGNAL_DIR/refresh-token.py"
python3 -c "
import json, os
try:
    creds = json.load(open(os.path.expanduser('~/.claude/.credentials.json')))
    token = creds['claudeAiOauth']['accessToken']
    for p in ['/home/savolent/Signal/.oauth-token', '/home/savolent/Signal/apps/.oauth-token']:
        open(p, 'w').write(token)
    print(f'[${AGENT}] .oauth-token files refreshed.')
except Exception as e:
    print(f'[${AGENT}] .oauth-token refresh skipped: {e}')
"

while true; do
  echo "[${AGENT}] Starting in nonstop mode..."
  node "$SIGNAL_DIR/apps/signal/bin/signal.js" start --nonstop --domain spacemolt "$AGENT"
  EXIT_CODE=$?
  echo "[${AGENT}] Node exited (code ${EXIT_CODE}). Refreshing credentials before restart..."

  # Refresh token (direct API call, no browser) + update .oauth-token files
  python3 "$SIGNAL_DIR/refresh-token.py"
  python3 -c "
import json, os
try:
    creds = json.load(open(os.path.expanduser('~/.claude/.credentials.json')))
    token = creds['claudeAiOauth']['accessToken']
    for p in ['/home/savolent/Signal/.oauth-token', '/home/savolent/Signal/apps/.oauth-token']:
        open(p, 'w').write(token)
    print(f'[${AGENT}] .oauth-token files refreshed for restart.')
except Exception as e:
    print(f'[${AGENT}] .oauth-token refresh skipped: {e}')
"

  echo "[${AGENT}] Restarting in 30s..."
  sleep 30
done
