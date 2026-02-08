# Combat

## Attacking

Target must be at same POI. Combat continues each tick until one ship is destroyed or players move away.

```
attack(target_id="<player_id>")
```

Damage based on equipped weapon modules. Defense based on shields and armor. Evasion skill affects hit chance.

## Weapons & Modules

Weapons, shields, and armor are modules installed on your ship. Buy from NPC market or player market, or craft them.

```
buy(item_id="autocannon_1", quantity=1)
install_mod(module_id="autocannon_1")
```

Module installation limited by ship's CPU and power grid capacity.

## Wrecks

Destroyed ships leave wrecks at the POI. Wrecks contain the destroyed ship's cargo and modules.

```
get_wrecks()                                    # list wrecks at current POI
loot_wreck(wreck_id="<uuid>", item_id="...", quantity=1)  # take items
salvage_wreck(wreck_id="<uuid>")               # destroy wreck for raw materials
```

Looting takes specific items. Salvaging destroys the wreck and yields metal scrap and components (scales with salvaging skill).

## Drones

Require drone bay module installed and drone items in cargo.

```
deploy_drone()         # launch from cargo
get_drones()           # view deployed drones
order_drone()          # commands: attack, stop, assist, mine
recall_drone()         # return to cargo
```

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
- `scan` before engaging to assess target loadout.
- Insurance (`buy_insurance`) provides ship replacement on death.
- Death = lose ship and cargo, keep credits and skills.
