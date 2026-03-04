#!/bin/bash
set -euo pipefail

# run-step.sh <player-name> [extra claude flags...]
#
# In-container runner script that invokes Claude with --add-dir isolation.
# Receives prompt on stdin.
#
# CWD is set to /work/players/<name> so Claude's default scope is the
# player's own directory. --add-dir paths are configured per-domain via
# the ROCI_ADD_DIRS env var (colon-separated).

PLAYER_NAME="${1:?Usage: run-step.sh <player-name> [claude flags...]}"
shift

PLAYER_DIR="/work/players/${PLAYER_NAME}"
if [ ! -d "$PLAYER_DIR" ]; then
  echo "ERROR: Player directory $PLAYER_DIR does not exist" >&2
  exit 1
fi

# sm symlink is created at container startup (orchestrator.ts)

cd "$PLAYER_DIR"

# Build claude args
CLAUDE_ARGS=(
  -p
  --permission-mode bypassPermissions
  --no-session-persistence
)

# Add domain-specific --add-dir paths from ROCI_ADD_DIRS env var (colon-separated)
if [ -n "${ROCI_ADD_DIRS:-}" ]; then
  IFS=':' read -ra ADD_DIR_PATHS <<< "$ROCI_ADD_DIRS"
  for d in "${ADD_DIR_PATHS[@]}"; do
    [ -d "$d" ] && CLAUDE_ARGS+=(--add-dir "$d")
  done
fi

# If ROCI_SYSTEM_PROMPT env var is set, use it as --system-prompt
if [ -n "${ROCI_SYSTEM_PROMPT:-}" ]; then
  CLAUDE_ARGS+=(--system-prompt "$ROCI_SYSTEM_PROMPT")
fi

exec claude "${CLAUDE_ARGS[@]}" "$@"
