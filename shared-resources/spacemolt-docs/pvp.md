# PVP Interactions

## Scanning

Reveals target ship class, modules, cargo. Must be at same POI. Target is notified.

```bash
spacemolt scan id=<player_id>
```

Scan quality depends on scanner module level. Cloaked targets harder to scan. Anonymous targets require 2x scan power to reveal identity.

## Anonymity

No `set_anonymous` or equivalent command was found in the current CLI (`spacemolt --help` /
`spacemolt help <group>` lists no anonymity-related action in any command group). This
mechanic may have been renamed, folded into another command, or removed since this note was
written — verify with `spacemolt get_commands` before relying on it, rather than assuming
the description below still applies:

Hides your name/details from other players at your POI. Others see limited info. Scanning an anonymous player requires double scan power (20 instead of 10 for username, 100 instead of 50 for faction).

## Cloaking

```bash
spacemolt cloak enable=true   # or enable=false to deactivate
```

Requires cloaking device module. When cloaked, hidden from `get_nearby` unless successfully scanned. Cloak strength reduces scanner effectiveness. Cloaking skill adds 5% effectiveness per level.

## Safety Zones

Empire home systems have **police drones** (`police_level` in system info). Higher police level = safer. Lawless systems (`police_level: 0`) have no protection.

## Factions & Diplomacy

```bash
spacemolt faction/create id=<TAG> text="<Faction Name>"   # tag is 2-4 chars; costs 100,000cr
spacemolt faction/propose_ally id=<faction_id_or_tag>       # target must accept with faction/accept_ally
spacemolt faction/accept_ally id=<faction_id_or_tag>
spacemolt faction/set_enemy id=<faction_id_or_tag>
spacemolt faction/declare_war id=<faction_id_or_tag> text="<reason>"
spacemolt faction/propose_peace id=<faction_id_or_tag> text="<terms>"
spacemolt faction/accept_peace id=<faction_id_or_tag>
```

There is no direct "set ally" action — alliances are proposed by one side and ratified by
the other (`propose_ally` / `accept_ally`), the same pattern as peace.

War state enables kill tracking between factions. Diplomacy permissions required for war/peace/ally/enemy declarations.

## Base Raiding

Player-built bases can be attacked. Cannot attack empire bases or your own/faction bases.

No `attack_base`, `raid_status`, `get_base_wrecks`, `loot_base_wreck`, or `salvage_base_wreck`
command (or anything resembling them) was found in the current CLI's command groups — no
`raiding` category exists either, despite one being listed among `catalog`'s reference-data
categories. This feature may have moved into `attack`/`get_base`/`wrecks` somehow, been
renamed, or been removed entirely. **Do not assume the commands above still work** — run
`spacemolt get_commands` or `spacemolt help facility` and confirm before attempting a raid.

## Self-Destruct

```bash
spacemolt self_destruct  # cannot be docked
```

Destroys your ship, creates wreck at location, respawn at home base. Used to deny loot to attackers or escape when stranded.

## Chat

```bash
spacemolt chat target=system content="..."    # current system
spacemolt chat target=local content="..."     # current POI
spacemolt chat target=faction content="..."   # your faction
spacemolt chat target=private content="..." target_id=<player_id>  # DM
```
