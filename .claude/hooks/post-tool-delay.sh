#!/bin/bash
# PostToolUse hook: delay after SpaceMolt game actions based on action type.
# Receives JSON on stdin with tool_name, tool_input, tool_response.

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')

# Only handle spacemolt tools
case "$TOOL_NAME" in
  mcp__spacemolt__*)
    ACTION="${TOOL_NAME#mcp__spacemolt__}"
    ;;
  *)
    exit 0
    ;;
esac

# Assign delays (seconds) by action category
case "$ACTION" in
  # Navigation — travel takes real time, give the tick room
  travel|jump)
    DELAY=12
    ;;

  # Combat — rapid pace matters
  attack|attack_base)
    DELAY=11
    ;;

  # Resource gathering — steady rhythm
  salvage_wreck|salvage_base_wreck|loot_wreck|loot_base_wreck)
    DELAY=11
    ;;

  # Economy — one tick between trades
  buy|sell|buy_listing|list_item|cancel_list|craft)
    DELAY=11
    ;;

  # Ship management — quick actions
  dock|undock|refuel|repair|install_mod|uninstall_mod|buy_ship|sell_ship)
    DELAY=31
    ;;

  # Social — no real delay needed for chat/forum
  chat|forum_create_thread|forum_reply|forum_upvote|forum_delete_thread|forum_delete_reply)
    DELAY=1
    ;;

  # Trade offers
  trade_offer|trade_accept|trade_decline|trade_cancel)
    DELAY=11
    ;;

  # Faction management
  create_faction|join_faction|leave_faction|faction_invite|faction_kick|faction_promote|faction_declare_war|faction_propose_peace|faction_accept_peace|faction_set_ally|faction_set_enemy|faction_decline_invite)
    DELAY=5
    ;;

  # Utility
  get_map|cloak|set_anonymous|set_colors|set_status|set_home_base|self_destruct|buy_insurance|deploy_drone|recall_drone|order_drone|build_base|captains_log_add)
    DELAY=5
    ;;

  # Buy time
  get_base|get_listings|get_trades|get_skills|get_recipes|get_notifications|get_drones|get_notes|get_version|get_commands|get_base_cost|search_systems|find_route|faction_info|faction_list|faction_get_invites|claim_insurance|forum_list|forum_get_thread|captains_log_list|captains_log_get|read_note|write_note|create_note)
    DELAY=3
    ;;


  # Query tools — no delay
  get_status|get_ship|get_cargo|get_system|get_poi|get_nearby|get_wrecks|get_base_wrecks|help|scan|raid_status|login|logout|register)
    DELAY=1
    ;;

  *)
    DELAY=5
    ;;
esac

if [ "$DELAY" -gt 0 ]; then
  sleep "$DELAY"
fi

exit 0
