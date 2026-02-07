#!/bin/bash
set -euo pipefail

PLAY_INTERVAL="${PLAY_INTERVAL:-3600}"
DIARY_LIMIT="${DIARY_LIMIT:-400}"
AUTH_SIGNAL="/tmp/auth-ready"

# --- Clean stale auth signal from previous container run ---
rm -f "$AUTH_SIGNAL"

# --- Pre-accept project trust dialog for /work ---
CLAUDE_JSON="/home/node/.claude.json"
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$CLAUDE_JSON', 'utf8'));
  cfg.projects = cfg.projects || {};
  cfg.projects['/work'] = cfg.projects['/work'] || {};
  cfg.projects['/work'].hasTrustDialogAccepted = true;
  cfg.projects['/work'].hasCompletedProjectOnboarding = true;
  fs.writeFileSync('$CLAUDE_JSON', JSON.stringify(cfg, null, 2));
"

# --- MCP setup ---
claude mcp add spacemolt https://game.spacemolt.com/mcp --transport http 2>/dev/null

# --- Wait for auth ---
echo "=== Waiting for authentication ==="
echo "Run 'docker exec -it <container> sh -c \"claude && touch /tmp/auth-ready\"' to authenticate"
while [ ! -f "$AUTH_SIGNAL" ]; do
  sleep 2
done
echo "=== Authentication complete, starting game loop ==="

# --- Diary rotation ---
rotate_diary() {
  local diary="/work/me/DIARY.md"
  [ -f "$diary" ] || return 0

  local lines
  lines=$(wc -l < "$diary")
  [ "$lines" -le "$DIARY_LIMIT" ] && return 0

  echo "=== Diary at ${lines} lines, rotating ==="

  local ts
  ts=$(date +%Y%m%d-%H%M%S)
  cp "$diary" "/work/me/DIARY-${ts}.md"

  local summary
  summary=$(echo "Summarize this diary in exactly 3 lines. Capture the key events, relationships formed, and current goals. Write in first person, in the voice of the diary's author. No preamble, just the 3 lines." | \ 
    claude -p --model opus \
    < "$diary")

  cat > "$diary" <<EOF
# Diary

## Summary of previous entries
${summary}

EOF

  echo "=== Diary rotated, archived to DIARY-${ts}.md ==="
}

# --- Game loop ---
while true; do
  echo "--- Starting new session at $(date) ---"
  rotate_diary
  start=$SECONDS
  echo "Your identity is defined in ./me/ — read your VALUES.md, DIARY.md, and SECRETS.md to understand who you are. Play SpaceMolt with MCP. Look in ./me/credentials.txt for username/password. Pursue the goals you have talked about in your Diary and Captain Logs, and do your best. Print no output -- it gets thrown away" | claude -p \
    --dangerously-skip-permissions \
    --no-session-persistence \
    --model sonnet \
    || true
  elapsed=$((SECONDS - start))
  remaining=$((PLAY_INTERVAL - elapsed))
  if [ "$remaining" -gt 0 ]; then
    echo "=== Next session in ${remaining}s ==="
    sleep "$remaining"
  fi
done
