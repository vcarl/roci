#!/bin/bash
set -euo pipefail

PLAY_INTERVAL="${PLAY_INTERVAL:-3600}"
DIARY_LIMIT="${DIARY_LIMIT:-80}"

# --- Dreaming: compress diary between sessions ---
# Three dream types: nightmare (compresses SECRETS.md), good dream
# (nurturing compression of DIARY.md), or normal dream (standard compression).
# Nightmare odds scale with secrets length. Good dreams are a flat 6%.
dream() {
  local diary="/work/me/DIARY.md"
  local secrets="/work/me/SECRETS.md"

  # Determine dream type: nightmare (scales with secrets), good dream (flat 6%), or normal
  local dream_type="normal"
  if [ -f "$secrets" ]; then
    local secrets_lines
    secrets_lines=$(wc -l < "$secrets")
    local nightmare_chance=$(( secrets_lines / 6 > 15 ? 15 : secrets_lines / 6 ))
    local roll=$(( RANDOM % 100 ))
    if [ "$roll" -lt "$nightmare_chance" ]; then
      dream_type="nightmare"
    elif [ "$roll" -ge 94 ]; then
      dream_type="good"
    fi
    echo "=== Dream roll: ${roll} (nightmare <${nightmare_chance}, good >=94) -> ${dream_type} ==="
  fi

  if [ "$dream_type" = "nightmare" ]; then
    echo "=== Nightmare (secrets at ${secrets_lines} lines) ==="

    local compressed
    compressed=$(cat /work/.devcontainer/nightmare-prompt.txt /work/me/background.md "$secrets" | claude -p --model opus --system-prompt "You are a secrets compressor. Output only the compressed secrets text. Do not use tools or take any other actions.")

    printf '%s\n' "$compressed" > "$secrets"

    echo "=== Nightmare complete ==="
  else
    [ -f "$diary" ] || return 0

    local lines
    lines=$(wc -l < "$diary")

    local prompt_file="/work/.devcontainer/dream-prompt.txt"
    if [ "$dream_type" = "good" ]; then
      prompt_file="/work/.devcontainer/good-dream-prompt.txt"
      echo "=== Good dream (diary at ${lines} lines) ==="
    else
      echo "=== Dreaming (diary at ${lines} lines) ==="
    fi

    local compressed
    compressed=$(cat "$prompt_file" /work/me/background.md "$secrets" "$diary" | claude -p --model opus --system-prompt "You are a diary compressor. Output only the compressed diary text. Make SECRETS.md more truthful. Do not use tools or take any other actions.")

    printf '%s\n' "$compressed" > "$diary"

    echo "=== Dream complete ==="
  fi
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

  exec claude -p \
    --dangerously-skip-permissions \
    --output-format stream-json --verbose \
    --model sonnet <<< "$PROMPT"
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
