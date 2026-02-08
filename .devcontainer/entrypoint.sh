#!/bin/bash
set -euo pipefail

PLAY_INTERVAL="${PLAY_INTERVAL:-3600}"
DIARY_LIMIT="${DIARY_LIMIT:-80}"

# --- Diary rotation (used by --session mode) ---
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
  summary=$(echo "Condense this diary into 3 structured sections. Output ONLY the markdown below, no preamble:

## Beliefs
(5-10 bullets: how the world works — prices, mechanics, trustworthy players)

## Accomplishments
(5-10 bullets: milestones, purchases, levels reached)

## Recent Actions
(10-20 bullets: what happened in the most recent session)" | \
    claude -p --model opus \
    < "$diary")

  cat > "$diary" <<EOF
# Diary

${summary}

EOF

  echo "=== Diary rotated, archived to DIARY-${ts}.md ==="
}

# ── Session mode: run one session cycle and exit ──────────────────────
if [ "${1:-}" = "--session" ]; then
  export PATH="/work/workspace/bin:${PATH}"

  rotate_diary

  # --- Phase 0: Gather context via REST API (no LLM tokens) ---
  echo "=== Phase 0: Gathering game context via API ==="
  BRIEFING_FILE=$(mktemp /tmp/briefing.XXXXXX)
  if bash /work/.devcontainer/gather-context.sh /work/me/credentials.txt > "$BRIEFING_FILE" 2>/dev/null; then
    echo "=== Phase 0 complete: briefing ready ==="
  else
    echo "=== Phase 0 failed, falling back to minimal briefing ==="
    echo "# Session Briefing (API unavailable)" > "$BRIEFING_FILE"
    echo "Login with credentials from ./me/credentials.txt" >> "$BRIEFING_FILE"
  fi

  # --- Phase 1: Opus plans the session (no tools, pure prompt) ---
  echo "=== Phase 1: Opus planning session ==="
  PLAN_INPUT=$(mktemp /tmp/plan-input.XXXXXX)
  {
    # Strip session IDs from briefing — Opus doesn't need them and they
    # cause it to waste planning effort on auth/login steps
    sed 's/Session: [a-f0-9]*/Session: [active]/' "$BRIEFING_FILE"
    echo ""
    echo "---"
    echo "## Character Identity"
    cat /work/me/background.md
    echo ""
    echo "---"
    echo "## Character Secrets"
    cat /work/me/SECRETS.md
  } > "$PLAN_INPUT"

  PLAN=$(claude -p --model opus \
    "You are planning a play session for a SpaceMolt agent.
The above contains: a game state briefing (from API), your character
background, and your secrets/motivations.

Plan a single goal for this session, where the player exits the session after achieving it. Emphasize what is known from the forum, and prioritize using and expanding knowledge first. We may need to achieve intermediate goals before we can pursue that knowledge." \
    < "$PLAN_INPUT" 2>/dev/null || echo "Plan generation failed. Play freely based on your identity and goals.")

  echo "=== Phase 1 complete: session plan ready ==="
  rm -f "$PLAN_INPUT"

  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║                    SESSION BRIEFING                     ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  cat "$BRIEFING_FILE"
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║                     SESSION PLAN                        ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo "$PLAN"
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo ""

  # --- Phase 2: Sonnet executes (full MCP tool access) ---
  echo "=== Phase 2: Sonnet executing session plan ==="
  PHASE2_PROMPT=$(cat <<PROMPT
Your identity is defined in ./me/ — read background.md and SECRETS.md.
Login credentials are in ./me/credentials.txt.

IMPORTANT — Token-efficient CLI:
You have "sm" on PATH (workspace/bin/sm). Use it via Bash for routine ops
instead of MCP tools. Much faster and cheaper. Run "sm help" to see commands.
  sm login ./me/credentials.txt  → login and cache session
  sm status         → compact status summary
  sm pois           → list POIs with IDs
  sm cargo          → cargo contents
  sm sell-all       → sell everything (auto-waits between ticks)
  sm log            → read captain's log
  sm log add "..."  → write captain's log
  sm mine           → mine once
  sm dock / undock / refuel / repair / travel <id>
  sm nearby / skills / notifications
  sm chat local "..." / sm chat system "..."
Start every session with: sm login ./me/credentials.txt && sm status
Use MCP tools only for complex operations not covered by sm (scan, attack,
craft, trade offers, faction management, forum, buy/sell ships, etc).

Here is your session briefing (gathered from the API):

$(cat "$BRIEFING_FILE")

Here is your session plan from command:

$PLAN

Execute this plan. Play SpaceMolt with MCP tools and the sm CLI.
Update your diary (./me/DIARY.md) before the session ends — maintain the 3 sections: Beliefs, Accomplishments, Recent Actions.
PROMPT
)
  rm -f "$BRIEFING_FILE"

  echo "$PHASE2_PROMPT" | claude -p \
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

# --- MCP setup ---
claude mcp add spacemolt https://game.spacemolt.com/mcp --transport http 2>/dev/null

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
