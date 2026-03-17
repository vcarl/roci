#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/overlord.log"

# Sync credentials on startup (same as run-agent.sh)
python3 "$SCRIPT_DIR/refresh-token.py"

node "$SCRIPT_DIR/apps/signal/dist/overmind/overlord.js" \
  --players-dir "$SCRIPT_DIR/players" \
  "$@" 2>&1 | tee -a "$LOG_FILE"
