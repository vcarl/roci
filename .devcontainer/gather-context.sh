#!/bin/bash
set -euo pipefail

# gather-context.sh — Phase 0: Collect game state via REST API (no LLM tokens)
# Usage: bash gather-context.sh /path/to/credentials.txt
# Outputs a markdown briefing to stdout.

CRED_FILE="${1:?Usage: gather-context.sh <credentials-file>}"
API="https://game.spacemolt.com/api/v1"

# --- Parse credentials ---
USERNAME=$(grep '^Username:' "$CRED_FILE" | sed 's/^Username: *//')
PASSWORD=$(grep '^Password:' "$CRED_FILE" | sed 's/^Password: *//')

if [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
  echo "ERROR: Could not parse username/password from $CRED_FILE" >&2
  exit 1
fi

# --- Helper: POST to API ---
api() {
  local endpoint="$1"
  shift
  curl -sf -X POST "${API}/${endpoint}" \
    -H "Content-Type: application/json" \
    -H "X-Session-Id: ${SESSION_ID:-}" \
    "$@"
}

# --- Create session ---
SESSION_RESP=$(api "session" -d '{}')
SESSION_ID=$(echo "$SESSION_RESP" | jq -r '.session.id // .session_id // empty')

if [ -z "$SESSION_ID" ]; then
  echo "ERROR: Failed to create session" >&2
  echo "$SESSION_RESP" >&2
  exit 1
fi

# --- Login ---
LOGIN_RESP=$(api "login" -d "$(jq -n --arg u "$USERNAME" --arg p "$PASSWORD" \
  '{username: $u, password: $p, session_id: "'"$SESSION_ID"'"}')")

LOGIN_OK=$(echo "$LOGIN_RESP" | jq -r '.error // empty')
if [ -n "$LOGIN_OK" ]; then
  echo "ERROR: Login failed: $LOGIN_OK" >&2
  exit 1
fi

# Extract captain's log from login response if present
LOGIN_LOG=$(echo "$LOGIN_RESP" | jq -r '
  if .result.captains_log and (.result.captains_log | length) > 0 then
    .result.captains_log | .[0:5] |
    map("- " + (.entry // tostring)) | join("\n")
  else empty end' 2>/dev/null || true)

# Collect notifications from login
LOGIN_NOTIFS=$(echo "$LOGIN_RESP" | jq -r '
  if .notifications and (.notifications | length) > 0 then
    .notifications | map("- [" + (.type // "?") + "] " + (.message // .content // tostring)) | join("\n")
  else empty end' 2>/dev/null || true)

# --- Parallel API calls ---
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Background all queries
api "get_status" -d "{\"session_id\":\"$SESSION_ID\"}" > "$TMPDIR/status.json" 2>/dev/null &
PID_STATUS=$!

api "forum_list" -d "{\"session_id\":\"$SESSION_ID\"}" > "$TMPDIR/forum.json" 2>/dev/null &
PID_FORUM=$!

api "captains_log_list" -d "{\"session_id\":\"$SESSION_ID\"}" > "$TMPDIR/log.json" 2>/dev/null &
PID_LOG=$!

api "get_skills" -d "{\"session_id\":\"$SESSION_ID\"}" > "$TMPDIR/skills.json" 2>/dev/null &
PID_SKILLS=$!

# Wait for all
wait $PID_STATUS $PID_FORUM $PID_LOG $PID_SKILLS 2>/dev/null || true

# --- Collect notifications from all responses ---
ALL_NOTIFS="$LOGIN_NOTIFS"
for f in "$TMPDIR"/*.json; do
  n=$(jq -r '
    if .notifications and (.notifications | length) > 0 then
      .notifications | map("- [" + (.type // "?") + "] " + (.message // .content // tostring)) | join("\n")
    else empty end' "$f" 2>/dev/null || true)
  if [ -n "$n" ]; then
    ALL_NOTIFS="${ALL_NOTIFS:+$ALL_NOTIFS
}$n"
  fi
done

# --- Format status ---
STATUS=$(jq -r '
  .result as $r | $r.player as $p | $r.ship as $s |
  def safe(f): f // "?";
  "- Credits: " + (safe($p.credits) | tostring) +
  " | Location: " + safe($p.current_system) +
  (if $p.current_poi then " / " + $p.current_poi else "" end) +
  (if $p.docked_at_base then " (docked)" else "" end) +
  "\n- Ship: " + safe($s.class_id // $s.name) +
  " | Hull: " + (safe($s.hull) | tostring) + "/" + (safe($s.max_hull) | tostring) +
  " | Fuel: " + (safe($s.fuel) | tostring) + "/" + (safe($s.max_fuel) | tostring) +
  "\n- Cargo: " + (safe($s.cargo_used) | tostring) + "/" + (safe($s.cargo_capacity) | tostring)
' "$TMPDIR/status.json" 2>/dev/null || echo "- (status unavailable)")

# --- Format skills (top skills only) ---
SKILLS=$(jq -r '
  .result.player_skills
  | sort_by(-.level, -.current_xp)
  | .[0:8]
  | map("- " + .name + ": L" + (.level | tostring) + " (" + (.current_xp | tostring) + "/" + (.next_level_xp | tostring) + " XP)")
  | join("\n")
' "$TMPDIR/skills.json" 2>/dev/null || echo "- (skills unavailable)")

# --- Format captain's log (most recent 3) ---
if [ -n "$LOGIN_LOG" ]; then
  CAPTAIN_LOG="$LOGIN_LOG"
else
  CAPTAIN_LOG=$(jq -r '
    .result.entries
    | if length == 0 then "(no log entries)"
      else .[0:3] | map("- " + (.entry // tostring)) | join("\n")
      end
  ' "$TMPDIR/log.json" 2>/dev/null || echo "- (log unavailable)")
fi

# --- Format forum ---
FORUM=$(jq -r '
  .result.threads as $threads |
  ($threads | length) as $count |
  "## Forum (" + ($count | tostring) + " threads)\n" +
  ($threads | sort_by(.updated_at // .created_at) | reverse | .[0:10] |
    map("- \"" + (.title // "untitled") + "\" by " + (.author // "anon") +
      " (" + ((.reply_count // 0) | tostring) + " replies)")
    | join("\n"))
' "$TMPDIR/forum.json" 2>/dev/null || echo "## Forum
- (forum unavailable)")

# --- Output briefing ---
cat <<EOF
# Session Briefing — $(date -u '+%Y-%m-%d %H:%M UTC')
Player: $USERNAME | Session: $SESSION_ID

## Status
$STATUS

## Top Skills
${SKILLS:-"- (no skills trained yet)"}

## Captain's Log (recent)
${CAPTAIN_LOG:-"- (no entries)"}

$FORUM
EOF

if [ -n "$ALL_NOTIFS" ]; then
  cat <<EOF

## Notifications
$ALL_NOTIFS
EOF
fi

# Output session ID on stderr so entrypoint can capture it
echo "$SESSION_ID" >&2
