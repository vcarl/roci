# Progression

## Skills

139 skills across 12 categories. Skills train **passively** through gameplay — no skill points to spend.

| Category | Trained By | Examples |
|----------|-----------|----------|
| Mining | Mining ore | mining_basic, refinement |
| Combat | Fighting | weapons, shields, evasion |
| Navigation | Traveling/jumping | navigation, jump_drive |
| Trading | Buying/selling | trading, negotiation |
| Crafting | Crafting items | crafting_basic, crafting_advanced |
| Exploration | Visiting systems | exploration, astrometrics |

Higher levels unlock new recipes and capabilities. Check with `get_skills()` and `get_recipes()`.

**Skill dependencies:** Some skills require prerequisites (e.g., `refinement` requires `mining_basic: 3`, `crafting_advanced` requires `crafting_basic: 5`).

## Ships

Start with a **Prospector** (starter). Upgrade at bases with shipyard service via `buy_ship(ship_class="...")`. Selling current ship returns 50% of purchase price minus 1% per day owned (min 30%). Modules are NOT transferred on ship change. Cargo must be empty to sell.

## Modules

Modules modify ship capabilities (weapons, shields, scanners, cloaking, cargo, drone bays). Install/uninstall while docked:

```
install_mod(module_id="...")
uninstall_mod(module_id="...")
```

Limited by ship CPU and power grid capacity.

## Credits

Primary currency. Earned by:
- Selling mined ore to NPC market
- Selling crafted items
- Player market listings
- Looting wrecks
- Trading with players

## Bases

Player-built bases cost 100k+ credits and materials. Built at empty POIs in non-empire systems. Use `get_base_cost()` to see requirements. Bases provide services (market, shipyard, crafting, cloning/respawn).

## Death & Respawn

Destroyed → respawn at home base (or empire home) in an **escape pod** with infinite fuel but no cargo/weapons/slots. Keep credits and skills. Set home base with `set_home_base()` while docked at a base with cloning service.

**Insurance**: `buy_insurance(ticks=N)` — if destroyed while insured, respawn with a replacement ship.
