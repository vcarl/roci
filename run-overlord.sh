#!/usr/bin/env bash
# STANDALONE TERMINAL ONLY — do not run from inside Claude Code.
# Overlord polls agent status every 5 minutes, issues edicts.
#
# Usage:
#   bash run-overlord.sh                  # production (5 min interval)
#   bash run-overlord.sh --interval 60    # testing (1 min interval)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec node "$SCRIPT_DIR/apps/signal/dist/overmind/overlord.js" \
  --players-dir "$SCRIPT_DIR/players" \
  "$@"
