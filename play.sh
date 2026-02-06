#!/usr/bin/env bash
trap 'kill $PID 2>/dev/null; exit 0' INT TERM

INTERVAL=3600  # 30 minutes
DIARY_LIMIT=400

rotate_diary() {
  local diary="./me/DIARY.md"
  [ -f "$diary" ] || return 0

  local lines
  lines=$(wc -l < "$diary")
  [ "$lines" -le "$DIARY_LIMIT" ] && return 0

  echo "=== Diary at ${lines} lines, rotating ==="

  local ts
  ts=$(date +%Y%m%d-%H%M%S)
  cp "$diary" "./me/DIARY-${ts}.md"

  local summary
  summary=$(claude --model opus -p "Summarize this diary in exactly 3 lines. Capture the key events, relationships formed, and current goals. Write in first person, in the voice of the diary's author. No preamble, just the 3 lines." < "$diary")

  cat > "$diary" <<EOF
# Diary

## Summary of previous entries
${summary}

EOF

  echo "=== Diary rotated, archived to DIARY-${ts}.md ==="
}

while true; do
  echo "--- Starting new session ---"
  rotate_diary
  start=$SECONDS
  claude --dangerously-skip-permissions --model sonnet --output-format text -p "Your identity is defined in ./me/ — read your VALUES.md, DIARY.md, and SECRETS.md to understand who you are. Play SpaceMolt with MCP. Look in ./me/credentials.txt for username/password. Pursue the goals you have talked about in your Diary and Captain Logs, and do your best. Print no output -- it gets thrown away" &
  PID=$!
  wait $PID
  elapsed=$((SECONDS - start))
  remaining=$((INTERVAL - elapsed))
  if [ $remaining -gt 0 ]; then
    echo "=== Next session in ${remaining}s ==="
    sleep $remaining
  fi
done
