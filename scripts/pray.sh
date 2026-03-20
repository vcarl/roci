#!/usr/bin/env bash
# pray.sh — Operator CLI for Prayer dispatch
#
# Usage:
#   pray.sh dispatch <agent> <chain>      dispatch Prayer DSL to one agent
#   pray.sh dispatch-all <chain>          dispatch to all 10 agents simultaneously
#   pray.sh monitor <agent>               poll agent status.json until Prayer halts
#   pray.sh status                        show status for all agents
#
# Chains: gathering, gathering-short
#   gathering       — full chain (The Memorial not yet accepted)
#   gathering-short — short chain (The Memorial already done: drifter, pilgrim, scrapper)
#
# How dispatch works:
#   Writes players/{agent}/me/prayer_dispatch.dsl
#   The running harness picks it up on the next tick, starts Prayer, skips LLM.
#   gathering.dsl must exist (run: python3 gathering-pathfinder.py first).
#
# Requirements: Prayer at http://localhost:5000, harness running

set -euo pipefail

SIGNAL_DIR="/home/savolent/Signal"
PLAYERS_DIR="$SIGNAL_DIR/players"
DSL_FILE="$SIGNAL_DIR/gathering.dsl"

ALL_AGENTS=(neonecho zealot savolent blackjack cipher drifter investigator pilgrim scrapper seeker)
MEMORIAL_DONE=(drifter pilgrim scrapper)

# ── Helpers ───────────────────────────────────────────────────────────────────

log() { echo "[pray.sh] $*" >&2; }

is_memorial_done() {
  local agent="$1"
  for a in "${MEMORIAL_DONE[@]}"; do
    [[ "$a" == "$agent" ]] && return 0
  done
  return 1
}

check_agent() {
  local agent="$1"
  local found=0
  for a in "${ALL_AGENTS[@]}"; do
    [[ "$a" == "$agent" ]] && found=1 && break
  done
  if [[ $found -eq 0 ]]; then
    log "Unknown agent: $agent"
    log "Valid agents: ${ALL_AGENTS[*]}"
    exit 1
  fi
}

# Extract STEP 0 or STEP 2 script from gathering.dsl
extract_dsl() {
  local section="$1"  # "0" or "2"
  if [[ ! -f "$DSL_FILE" ]]; then
    log "gathering.dsl not found at $DSL_FILE"
    log "Run first: python3 $SIGNAL_DIR/gathering-pathfinder.py"
    exit 1
  fi

  local script
  if [[ "$section" == "0" ]]; then
    script=$(awk '/=== STEP 0 SCRIPT ===/,/=== STEP 2 SCRIPT/' "$DSL_FILE" | grep -v "^===" | grep -v "^$" | head -50)
  else
    script=$(awk '/=== STEP 2 SCRIPT/,0' "$DSL_FILE" | grep -v "^===" | grep -v "^$" | head -50)
  fi

  # Check for placeholder IDs
  if echo "$script" | grep -q "<.*_ID>"; then
    log "gathering.dsl has placeholder IDs — run pathfinder first:"
    log "  python3 $SIGNAL_DIR/gathering-pathfinder.py [agent]"
    exit 1
  fi

  echo "$script"
}

# Write DSL to agent's dispatch file
dispatch_to_agent() {
  local agent="$1"
  local script="$2"
  local dispatch_path="$PLAYERS_DIR/$agent/me/prayer_dispatch.dsl"

  if [[ ! -d "$PLAYERS_DIR/$agent/me" ]]; then
    log "Player directory not found: $PLAYERS_DIR/$agent/me"
    exit 1
  fi

  printf '%s\n' "$script" > "$dispatch_path"
  log "Dispatched to $agent -> $dispatch_path"
}

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_dispatch() {
  local agent="${1:-}"
  local chain="${2:-}"

  if [[ -z "$agent" || -z "$chain" ]]; then
    log "Usage: pray.sh dispatch <agent> <chain>"
    exit 1
  fi

  check_agent "$agent"

  case "$chain" in
    gathering)
      if is_memorial_done "$agent"; then
        local script
        script=$(extract_dsl "2")
        dispatch_to_agent "$agent" "$script"
        log "$agent: dispatched gathering-short (Memorial already done)"
      else
        local script
        script=$(extract_dsl "0")
        dispatch_to_agent "$agent" "$script"
        log "$agent: dispatched gathering-full"
      fi
      ;;
    gathering-short)
      local script
      script=$(extract_dsl "2")
      dispatch_to_agent "$agent" "$script"
      log "$agent: dispatched gathering-short (forced)"
      ;;
    *)
      log "Unknown chain: $chain"
      log "Valid chains: gathering, gathering-short"
      exit 1
      ;;
  esac
}

cmd_dispatch_all() {
  local chain="${1:-}"
  if [[ -z "$chain" ]]; then
    log "Usage: pray.sh dispatch-all <chain>"
    exit 1
  fi

  log "Dispatching $chain to all ${#ALL_AGENTS[@]} agents..."
  local ok=0 fail=0
  for agent in "${ALL_AGENTS[@]}"; do
    if cmd_dispatch "$agent" "$chain" 2>/dev/null; then
      (( ok++ )) || true
    else
      log "FAILED: $agent"
      (( fail++ )) || true
    fi
  done
  log "Done: $ok dispatched, $fail failed"
}

cmd_monitor() {
  local agent="${1:-}"
  if [[ -z "$agent" ]]; then
    log "Usage: pray.sh monitor <agent>"
    exit 1
  fi
  check_agent "$agent"

  local status_file="$PLAYERS_DIR/$agent/status.json"
  log "Monitoring $agent (Ctrl+C to stop)..."
  log "Status file: $status_file"

  local prev_alerts=""
  while true; do
    if [[ ! -f "$status_file" ]]; then
      log "$agent: no status.json yet"
    else
      local alerts plan goal situation
      alerts=$(python3 -c "import json,sys; d=json.load(open('$status_file')); print('; '.join(d.get('recentAlerts', [])))" 2>/dev/null || echo "?")
      plan=$(python3 -c "import json,sys; d=json.load(open('$status_file')); print(d.get('plan') or 'none')" 2>/dev/null | head -1 | cut -c1-80)
      goal=$(python3 -c "import json,sys; d=json.load(open('$status_file')); print(d.get('currentGoal') or 'none')" 2>/dev/null | head -1 | cut -c1-80)
      situation=$(python3 -c "import json,sys; d=json.load(open('$status_file')); print(d.get('situation', '?'))" 2>/dev/null || echo "?")
      local updated
      updated=$(python3 -c "import json; d=json.load(open('$status_file')); print(d.get('lastUpdated','?'))" 2>/dev/null || echo "?")

      printf "[%s] situation=%-12s goal=%.70s\n" "$updated" "$situation" "$goal"

      # Prayer complete = prayer:summary appears in alerts
      if echo "$alerts" | grep -q "prayer:summary\|Grind complete\|Prayer halted"; then
        log "$agent: Prayer halted — chain complete"
        break
      fi
      # Also check for Gathering hold (mission accepted)
      if echo "$alerts" | grep -qi "gathering"; then
        log "$agent: Gathering mission detected in alerts — may be holding"
      fi
    fi
    sleep 30
  done
}

cmd_status() {
  printf "%-14s %-12s %-8s %-8s %-8s  %s\n" "AGENT" "SITUATION" "FUEL" "CARGO" "TURNS" "GOAL"
  printf "%-14s %-12s %-8s %-8s %-8s  %s\n" "-------------" "-----------" "-------" "-------" "------" "----"
  for agent in "${ALL_AGENTS[@]}"; do
    local status_file="$PLAYERS_DIR/$agent/status.json"
    if [[ ! -f "$status_file" ]]; then
      printf "%-14s %s\n" "$agent" "(no status)"
      continue
    fi
    python3 - "$status_file" "$agent" <<'PYEOF'
import json, sys

path, agent = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path))
    situation = d.get("situation", "?")
    metrics = d.get("metrics", {})
    fuel = f"{metrics.get('fuel', 0)*100:.0f}%" if isinstance(metrics.get('fuel'), float) else str(metrics.get('fuel', '?'))
    cargo_used = metrics.get("cargoUsed", "?")
    cargo_cap = metrics.get("cargoCapacity", "?")
    cargo = f"{cargo_used}/{cargo_cap}"
    turns = d.get("turnCount", "?")
    goal = (d.get("currentGoal") or "—")[:70]
    # Check for prayer dispatch file
    import os
    dispatch = os.path.exists(f"/home/savolent/Signal/players/{agent}/me/prayer_dispatch.dsl")
    dispatch_flag = " [DISPATCH PENDING]" if dispatch else ""
    print(f"{agent:<14} {situation:<12} {fuel:<8} {cargo:<8} {str(turns):<8}  {goal}{dispatch_flag}")
except Exception as e:
    print(f"{agent:<14} ERROR: {e}")
PYEOF
  done
}

# ── Entry point ───────────────────────────────────────────────────────────────

usage() {
  cat <<'EOF'
pray.sh — Operator CLI for Prayer dispatch

Usage:
  pray.sh dispatch <agent> <chain>    dispatch DSL to one agent (picked up next tick)
  pray.sh dispatch-all <chain>        dispatch to all 10 agents
  pray.sh monitor <agent>             poll status.json every 30s until Prayer halts
  pray.sh status                      show all agent statuses

Agents: neonecho zealot savolent blackjack cipher drifter investigator pilgrim scrapper seeker
Chains: gathering (auto-selects full/short by agent), gathering-short (force short)

Requires: gathering.dsl exists (run python3 gathering-pathfinder.py first)
EOF
  exit 1
}

cmd="${1:-}"
shift || true

case "$cmd" in
  dispatch)     cmd_dispatch "$@" ;;
  dispatch-all) cmd_dispatch_all "$@" ;;
  monitor)      cmd_monitor "$@" ;;
  status)       cmd_status ;;
  *)            usage ;;
esac
