#!/usr/bin/env bash
# STANDALONE TERMINAL ONLY — do not run from inside Claude Code.
# Overlord polls agent status every 5 minutes, issues edicts, writes wind-down on usage threshold.
# Run alongside signal.sh in a separate terminal.
#
# Usage:
#   bash run-overlord.sh                  # production (5 min interval)
#   bash run-overlord.sh --interval 60    # testing (1 min interval)
#   bash run-overlord.sh --no-usage-check # skip API usage threshold check

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec node "$SCRIPT_DIR/apps/signal/dist/overmind/overlord.js"   --players-dir "$SCRIPT_DIR/players"   "$@"
