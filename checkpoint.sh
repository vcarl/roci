#!/usr/bin/env bash
set -euo pipefail

GIT="/usr/bin/git"
REPO_DIR="/Users/carlvitullo/workspace/testbench/spacemolt"
LOG_FILE="$REPO_DIR/checkpoint.log"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

cd "$REPO_DIR"

$GIT add players/
if $GIT diff --cached --quiet; then
  log "No changes to commit"
  exit 0
fi

$GIT commit -m "Checkpoint"
$GIT push

log "Committed and pushed"
