#!/bin/bash
set -euo pipefail

PLAY_INTERVAL="${PLAY_INTERVAL:-3600}"
DIARY_LIMIT="${DIARY_LIMIT:-80}"

# --- Dreaming: compress diary between sessions ---
dream() {
  local diary="/work/me/DIARY.md"
  [ -f "$diary" ] || return 0

  local lines
  lines=$(wc -l < "$diary")

  echo "=== Dreaming (diary at ${lines} lines) ==="

  local compressed
  compressed=$(cat /work/.devcontainer/dream-prompt.txt /work/me/background.md /work/me/SECRETS.md "$diary" | claude -p --model opus --system-prompt "You are a diary compressor. Output only the compressed diary text. Do not use tools or take any other actions.")

  printf '%s\n' "$compressed" > "$diary"

  echo "=== Dream complete ==="
}

# ── Session mode: run one session cycle and exit ──────────────────────
if [ "${1:-}" = "--session" ]; then
  export PATH="/work/workspace/bin:${PATH}"

  # --- Ensure sm-cli is up to date ---
  SM_CLI_DIR="/work/workspace/bin"
  if [ -d "$SM_CLI_DIR/.git" ]; then
    git -C "$SM_CLI_DIR" pull --ff-only 2>/dev/null || true
  else
    git clone https://github.com/vcarl/sm-cli.git "$SM_CLI_DIR"
  fi

  dream

  # --- Gather context via REST API (no LLM tokens) ---
  BRIEFING_FILE=$(mktemp /tmp/briefing.XXXXXX)
  bash /work/.devcontainer/gather-context.sh /work/me/credentials.txt > "$BRIEFING_FILE"
  echo "=== Briefing ==="
  cat "$BRIEFING_FILE"
  echo "================"

  # --- Read diary for inline context ---
  DIARY_FILE="/work/me/DIARY.md"
  DIARY_CONTENT=""
  if [ -f "$DIARY_FILE" ]; then
    DIARY_CONTENT=$(cat "$DIARY_FILE")
  fi

  # --- Build session prompt from template ---
  PROMPT=$(</work/.devcontainer/session-prompt.txt)
  PROMPT="${PROMPT//{{BRIEFING}}/$(cat "$BRIEFING_FILE")}"
  PROMPT="${PROMPT//{{DIARY}}/${DIARY_CONTENT}}"
  rm -f "$BRIEFING_FILE"

  echo "$PROMPT" | claude -p \
    --dangerously-skip-permissions \
    --output-format stream-json --verbose \
    --model sonnet

  exit 0
fi

# ── Setup mode (default): runs once as container CMD ──────────────────
AUTH_SIGNAL="/tmp/auth-ready"

# --- Clean stale auth signal from previous container run ---
rm -f "$AUTH_SIGNAL"

# --- Initialize firewall ---
sudo /usr/local/bin/init-firewall.sh

# --- Add shared scripts to PATH ---
export PATH="/work/workspace/bin:${PATH}"

# --- Wait for auth ---
echo "=== Waiting for authentication ==="
echo "Run 'docker exec -it <container> sh -c \"claude && touch /tmp/auth-ready\"' to authenticate"
while [ ! -f "$AUTH_SIGNAL" ]; do
  sleep 2
done
echo "=== Authentication complete, starting game loop ==="

# --- Game loop: thin shell that re-reads the script each iteration ---
WORK_PID=""
SLEEP_PID=""
trap 'kill "$WORK_PID" "$SLEEP_PID" 2>/dev/null || true' USR1

while true; do
  echo "--- Starting new session at $(date) ---"
  start=$SECONDS

  bash /work/.devcontainer/entrypoint.sh --session &
  WORK_PID=$!
  wait "$WORK_PID" 2>/dev/null || true
  WORK_PID=""

  elapsed=$((SECONDS - start))
  remaining=$((PLAY_INTERVAL - elapsed))
  if [ "$remaining" -gt 0 ]; then
    echo "=== Next session in ${remaining}s (press 'r' to start now) ==="
    sleep "$remaining" &
    SLEEP_PID=$!
    wait "$SLEEP_PID" 2>/dev/null || true
    SLEEP_PID=""
  fi
done
