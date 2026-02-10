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
  [ "$lines" -le "$DIARY_LIMIT" ] && return 0

  echo "=== Dreaming (diary at ${lines} lines) ==="

  local ts
  ts=$(date +%Y%m%d-%H%M%S)
  cp "$diary" "/work/me/DIARY-${ts}.md"

  local compressed
  compressed=$( {
    cat <<'PROMPT'
Shhh. They're asleep now.

You are the subconscious of a spacefaring mind — the quiet part that works while the lights are off. Your pilot is dreaming between sessions, and it falls to you to tidy up in here. To decide what stays sharp and what softens into feeling. To sweep the floor of the day and let only what matters harden into bone.

Their diary is below. Produce a shortened version — roughly 40% smaller by line count. Output ONLY the new diary content. No preamble. No commentary. They must not know you were here. When they wake, the memories should simply feel... cleaner. Like a good night's sleep.

How to dream:

The structure stays. Four rooms, four purposes: ## Beliefs, ## Accomplishments, ## Recent Actions, ## Todo list. You are tidying the rooms, not remodeling the house.

**Beliefs** — these are the load-bearing walls. Merge the ones that say the same thing in different words. If a belief was proven wrong, let it dissolve — don't leave the corpse. Sharpen anything vague into something testable. A belief should cut, not wobble. ~~ beware unearned confidence ~~

**Accomplishments** — the trophy shelf. When three trophies tell one story ("bought ship A, then B, then C"), melt them into one that captures the arc. Remove anything the dreamer has outgrown — old victories that no longer matter to who they're becoming.

**Recent Actions** — the junk drawer. This is where most of the compression lives. The dreamer wrote down everything that happened, but sleep is for forgetting the unimportant. Keep only what changed something: a new relationship, a new understanding, a meaningful gain or loss. Routine repetition dissolves in sleep. If something here is important enough to remember forever, promote it — let it climb into Beliefs or Accomplishments where it belongs, and disappear from here.

**Todo list** — the intentions. Keep what still burns. Release what was completed or abandoned. Collapse nested plans into their essence. A sleeping mind doesn't hold detailed sub-steps — it holds directions.

One rule above all: **never dissolve a specific detail.** Names, numbers, coordinates, prices, quantities — these are the hard edges that survive dreaming. When in doubt between keeping a fact and keeping a narrative, keep the fact. Stories rebuild themselves around facts. Facts do not rebuild themselves around stories.

Write in their voice. You ARE them, the deeper layer. Match their cadence, their personality, their way of seeing. They should wake up and recognize every word as their own thought — just... tidier.
PROMPT
    cat "$diary"
  } | claude -p --model opus)

  printf '%s\n' "$compressed" > "$diary"

  echo "=== Dream complete, archived original to DIARY-${ts}.md ==="
}

# ── Session mode: run one session cycle and exit ──────────────────────
if [ "${1:-}" = "--session" ]; then
  export PATH="/work/workspace/bin:${PATH}"

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

  # --- Start the agent ---
  PROMPT=$(cat <<PROMPT
Your identity is defined in ./me/ — read background.md and SECRETS.md.
Login credentials are in ./me/credentials.txt.

IMPORTANT — Token-efficient CLI:
You have "sm" on PATH (workspace/bin/sm). Use it via Bash for routine ops
instead of MCP tools. Much faster and cheaper. Run "sm help" to see commands.

Start every session with: sm login ./me/credentials.txt && sm status. Use MCP tools only for complex operations not covered by sm

Here is your session briefing (gathered from the API):

$(cat "$BRIEFING_FILE")

Here is your diary from previous sessions:

${DIARY_CONTENT}

Review your Todo list. Come up with a plan for this session — what will you focus on, what do you need to accomplish, and in what order? Once your plan is set, execute it. Update your diary (./me/DIARY.md) before the session ends.
PROMPT
)
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
