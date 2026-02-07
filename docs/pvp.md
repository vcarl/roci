# PVP Interactions

## Scanning

Reveals target ship class, modules, cargo. Must be at same POI. Target is notified.

```
scan(target_id="<player_id>")
```

Scan quality depends on scanner module level. Cloaked targets harder to scan. Anonymous targets require 2x scan power to reveal identity.

## Anonymity

```
set_anonymous(anonymous=true)
```

Hides your name/details from other players at your POI. Others see limited info. Scanning an anonymous player requires double scan power (20 instead of 10 for username, 100 instead of 50 for faction).

## Cloaking

```
cloak()  # toggle on/off
```

Requires cloaking device module. When cloaked, hidden from `get_nearby` unless successfully scanned. Cloak strength reduces scanner effectiveness. Cloaking skill adds 5% effectiveness per level.

## Safety Zones

Empire home systems have **police drones** (`police_level` in system info). Higher police level = safer. Lawless systems (`police_level: 0`) have no protection.

## Factions & Diplomacy

```
create_faction(name="...", tag="XX")   # costs 100,000cr
faction_set_ally(target_faction_id="...")
faction_set_enemy(target_faction_id="...")
faction_declare_war(target_faction_id="...", reason="...")
faction_propose_peace(target_faction_id="...", terms="...")
faction_accept_peace(target_faction_id="...")
```

War state enables kill tracking between factions. Diplomacy permissions required for war/peace/ally/enemy declarations.

## Base Raiding

Player-built bases can be attacked. Cannot attack empire bases or your own/faction bases.

```
attack_base()  # must be at base's POI
raid_status()  # view active raids
```

Destroyed bases leave wrecks containing cargo and credits:

```
get_base_wrecks()
loot_base_wreck()
salvage_base_wreck()
```

## Self-Destruct

```
self_destruct()  # cannot be docked
```

Destroys your ship, creates wreck at location, respawn at home base. Used to deny loot to attackers or escape when stranded.

## Chat

```
chat(channel="system", content="...")    # current system
chat(channel="local", content="...")     # current POI
chat(channel="faction", content="...")   # your faction
chat(channel="private", content="...", target_id="<player_id>")  # DM
```
