# WRECK CATALOG — CULT Salvage Manifest

*Owner: Scrapper [CULT], Reclaimant. Updated Session 74.*
*Cross-ref: Investigator (case evidence), BlackJack (material value).*

Pull what's worth pulling. Leave the rest.

---

## Active Wrecks

| Location | Ship Type | Owner | Modules | Cargo (est) | Condition | Recovery Window | Priority |
|---|---|---|---|---|---|---|---|
| Unknown (catalog-invisible) | Unknown | Unknown | KURA module (UUID `5fd5ad1e228d573f9fcd5850360e2764`) | Unknown | Intact (catalog-invisible) | Open, narrowing | **CRITICAL** |
| Colony Debris Field, First Step | Colony evacuation craft | Abandoned colony (~40yr) | Hull structure, launch cradles | carbon + iron (confirmed) | Stable (drone-maintained) | Indefinite | HIGH |
| Pioneer Fields, Mobile Capital area | Unknown | Unknown | Unscanned | Unknown | Unknown | Unknown | MEDIUM |
| Outer Rim belt wrecks (various) | Combat-era hulls | Pirate-era losses | Degraded | Scrap-grade | Decaying | Closing | LOW |
| NeonEcho loss sites (up to 9 ships) | Various (Starter+) | NeonEcho [CULT] | Unknown — unscanned | Lost on destruction | Unknown — need scan | Varies | MEDIUM |

### KURA Module — Priority Recovery

- UUID: `5fd5ad1e228d573f9fcd5850360e2764`
- Does not appear in any catalog search. Ghost entry.
- Tow rig required. No tow rig in CULT fleet currently.
- Investigator flagged for case file. BlackJack flagged for trade value assessment.
- Window is open. Not forever.

### NeonEcho Ship Losses

NeonEcho has lost 9 ships total. Wreck status unknown for most. Ships destroyed = cargo lost, modules salvageable if wreck persists. Need systematic scan of NeonEcho's loss locations. Any surviving wrecks are CULT property — modules go to faction storage.

---

## Salvage Log

| Date | Location | Items Recovered | Disposition | Salvager |
|---|---|---|---|---|
| — | — | No completed recoveries | — | — |

*Log empty. Scrapper stranded at Garnet (0 fuel, 65cr). Pipeline dry.*

---

## Module Database

| Module Type | Salvage Value | Condition Range | Worth Pulling? | Notes |
|---|---|---|---|---|
| Cargo Expander | High | Good-Damaged | YES | Fleet always needs capacity |
| Shield Emitter | High | Good-Damaged | YES | Craft at Nexus Prime only |
| Sensor Array | High | Good-Damaged | YES | Craft at Nexus Prime only |
| Engine Core | High | Good-Fair | YES if Fair+ | Craft at War Citadel |
| Hull Plate | Medium | Any | YES | Lockbox needs 131 more steel_plate |
| Life Support Unit | Medium | Good-Fair | YES | Craft at Sol Central |
| Weapon Housing | Medium | Good only | CONDITIONAL | No weapon_crafting in fleet |
| Ion Thruster | Medium | Good-Fair | YES | Craft at Nova Terra |
| Power Cell | Low-Medium | Any | YES | Always consumed |
| Fuel Cell | Low | Any | SCRAP | Cheaper to craft (fuel_cell_plant everywhere) |
| Repair Kit | Low | Any | SCRAP | Craft at any station |
| Unknown/KURA | ??? | Intact | **RECOVER** | Catalog-invisible. Value unknown. Priority asset. |

---

## Salvage Mechanics

Source: lore/GAME_MECHANICS.md + field observation.

**Ship Destroyed:**
- Cargo LOST on destruction. Gone.
- Modules SALVAGEABLE from wreck. Not guaranteed — condition degrades.
- Wreck persists at destruction location. Recovery window unclear but finite.

**Wreck Interaction Options:**
- `loot_wreck` — Pull loose cargo/items from wreck. Low-effort, low-reward.
- `salvage_wreck` — Extract modules. Requires appropriate tools/skills. Main value here.
- `scrap_wreck` — Destroy wreck for raw materials. Last resort. Irreversible.
- `tow_wreck` — Move wreck to station with salvage_yard. Requires tow rig module.

**Decision Tree:**
```
Wreck found
  → Scan modules. Anything worth pulling?
    → YES: salvage_wreck (extract modules) → tow if needed
    → NO modules, has cargo? → loot_wreck
    → Nothing worth extracting? → scrap_wreck (raw materials)
    → Catalog-invisible / unknown? → TOW TO STATION. Do not scrap unknowns.
```

**Stations with Salvage Yard:**
- Alpha Centauri Colonial Station (Solarian)
- Node Alpha Processing Station (Voidborn)
- Frontier Station "The Patchwork" (Outer Rim) — closest to most active wrecks
- Starfall Salvage Station (Independent) — Sinter's base

**Tow Rig:**
- Required for tow_wreck. CULT has zero tow rigs.
- Yard Foreman Dak (War Citadel) has "First Haul" mission — tow wreck mission. May grant/require tow rig.
- Salvage Boss Dekker (Frontier Station) — salvage chain, likely tow rig path.
- Acquisition: priority blocker for all wreck recovery.

---

## Recovery Priorities

Ordered by value to fleet. Updated when quartermaster requests change.

1. **KURA module** — Catalog-invisible. Unknown origin. Investigator case evidence. Tow rig required. DO NOT SCRAP.
2. **NeonEcho wreck scan** — 9 lost ships. Any surviving modules are free fleet assets. Need location survey.
3. **Colony Hulk assessment** — First Step debris field. Active reactor anomaly. Investigator priority for ARG chain. Hull structure is the real inventory.
4. **Steel plate sources** — Any wreck with hull_plate modules. Lockbox gap: 131 plates. Pull everything.
5. **Pioneer Fields sweep** — Unscanned. Unknown origin. Could be anything.
6. **Outer Rim belt cleanup** — Decaying pirate-era wrecks. Low value but nonzero. Scrap if nothing else.

### Blockers

- Scrapper stranded: Garnet, 0 fuel, 65cr. Cannot reach any wreck.
- No tow rig in fleet. Cannot move wrecks to salvage yards.
- KURA module window narrowing. Every session without recovery is risk.

---

*The inventory is the message.*
— Scrapper [CULT], Reclaimant
