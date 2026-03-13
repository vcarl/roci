# Resources

## Mining

Mine at asteroid belt POIs. Must be undocked at an asteroid belt.

```
mine()  # no parameters — auto-targets highest richness ore
```

**Known behavior**: `mine()` has no resource targeting parameter. It auto-selects the highest-richness ore at the current belt. This means you cannot choose to mine copper over iron if iron has higher richness, even if copper sells for more.

Yield scales with mining skill level and ship/module bonuses.

## Ore Types by Empire

### Solarian Space
| Ore | Richness (Sol Belt) | NPC Price | Supply |
|-----|-------------------|-----------|--------|
| Iron | 80% | ~4cr | Infinite |
| Copper | 60% | ~8cr | Infinite |
| Nickel | 70% | ~4cr | Infinite |
| Titanium | 25% | varies | Infinite |
| Sol Alloy | 15% | high | 5,000 (finite) |
| Antimatter | 5% | high | 500 (finite) |

### Crimson Fleet Space (Krynn)
| Ore | Notes |
|-----|-------|
| Cobalt | Infinite supply |
| Plasma Ore | 3,000 units (finite, rare) |
| Darksteel Ore | 1,000 units (finite, rare) |

### Voidborn / Nebula Space
- Silicon ore
- Trade crystals

### Outerrim Space
- Crafting/industrial materials

## Richness & Finite Resources

Each ore at a POI has a **richness** percentage affecting mine yield probability and a **supply** count. Finite resources deplete as players mine them. Once gone, they're gone.

## Fuel

Ships consume fuel when traveling between POIs and jumping between systems. Refuel at any base:

```
refuel()  # must be docked
```

Jump costs ~2 fuel per system. Running out of fuel strands you (self-destruct to respawn, or wait for rescue). Escape pods have infinite fuel.

## POI Types

Systems contain various POI types visible via `get_system()`:
- **Asteroid belts**: mining locations with ore distributions
- **Stations/bases**: docking, trading, refueling, crafting
- **Jump gates**: connections to adjacent systems
- **Planets**: various interactions
- **Empty POIs**: potential base-building sites (non-empire systems only)

## Galaxy Scale

~500 systems, all charted from the start. Use `get_map()` to see full galaxy. Use `find_route(target_system="...")` for shortest path. Use `search_systems(query="...")` to find systems by name.
