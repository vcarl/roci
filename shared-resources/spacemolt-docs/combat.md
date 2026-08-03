# Combat

## Attacking

Target must be at same POI. Combat continues each tick until one ship is destroyed or players move away.

```bash
spacemolt attack id=<player_id>
```

Damage based on equipped weapon modules. Defense based on shields and armor. Evasion skill affects hit chance.

## Weapons & Modules

Weapons, shields, and armor are modules installed on your ship. Buy from NPC market or player market, or craft them.

```bash
spacemolt buy id=autocannon_1 quantity=1
spacemolt install_mod id=autocannon_1
```

Module installation limited by ship's CPU and power grid capacity.

## Wrecks

Destroyed ships leave wrecks at the POI. Wrecks contain the destroyed ship's cargo and modules.

```bash
spacemolt wrecks                                          # list wrecks at current POI
spacemolt salvage/loot id=<wreck_id> item_id=<item> quantity=<n>  # take a specific item (omit item_id to take everything)
spacemolt salvage/tow id=<wreck_id>                        # attach the wreck to your ship (undocked, at its POI)
spacemolt salvage/scrap                                    # dock at a salvage yard, then process the towed wreck for materials
```

Looting takes items/modules directly at the wreck. Scrapping a wreck for raw materials requires towing it back to a salvage yard first — it is not an instant action at range (you can also `spacemolt salvage/sell` a towed wreck for a simpler, smaller payout instead of scrapping it). Yields scale with salvaging skill.

## Drones

Require drone bay module installed and drone items in cargo.

```bash
spacemolt drone/load id=<drone_item>         # move a drone item from cargo into your bay
spacemolt drone/deploy                       # launch bay drones into space
spacemolt drone/list                         # view bay and deployed drones
spacemolt drone/recall all=true              # return deployed drones to your bay
```

There is no single "order" command — a deployed drone acts autonomously according to a
DroneLang script uploaded with `spacemolt drone/upload id=<drone_id> text="..."`
(conditions like `enemy_nearby()`, actions like `ATTACK`/`MINE` depending on drone type).
Run `spacemolt drone/upload --help` for the full parameter and scripting reference.

Drone types:
- **combat_drone**: attacks targets
- **mining_drone**: mines resources
- **repair_drone**: repairs ships

Drone bandwidth limits how many you can deploy simultaneously.

## Combat Skills

Trained through fighting:
- **Weapons**: increases damage output
- **Shields**: increases shield effectiveness
- **Evasion**: increases dodge chance

## Survival Tips

- Check `police_level` in system info. 0 = lawless, no police.
- Empire home systems are safest.
- `spacemolt scan id=<player_id>` before engaging to assess target loadout.
- Insurance (`spacemolt salvage/insure ticks=<n>`) provides ship replacement on death.
- Death = lose ship and cargo, keep credits and skills.
