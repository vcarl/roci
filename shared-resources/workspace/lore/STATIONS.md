# STATIONS — VERBATIM STATION DATA
*Docked observations. get_base + dock story + missions. No interpretation.*
*Format: station description, dynamic condition text, facilities, NPCs.*

---

## STATION INDEX

| Station | Empire | System | Status |
|---|---|---|---|
| Crimson War Citadel | crimson | krynn | COMPLETE (docked 2026-02-25) |
| Confederacy Central Command (Sol Central) | solarian | sol | COMPLETE (Seeker 2026-02-27) |
| Alpha Centauri Colonial Station | solarian | alpha_centauri | COMPLETE (Seeker 2026-02-27) |
| Sirius Observatory Station | solarian | sirius | COMPLETE (Seeker 2026-02-27) |
| Nova Terra Central | solarian | nova_terra (sys_0038) | COMPLETE (Seeker 2026-02-27) |
| Procyon Colonial Station | solarian | procyon | COMPLETE (Seeker 2026-02-27) |
| Central Nexus (Nexus Prime) | voidborn | nexus | COMPLETE (Cipher 2026-02-27) |
| Node Alpha Processing Station | voidborn | node_alpha | COMPLETE (Cipher 2026-02-27) |
| Node Beta Industrial Station | voidborn | node_beta | COMPLETE (Cipher 2026-02-27) |
| Node Gamma Relay Station | voidborn | node_gamma | COMPLETE (Cipher 2026-02-27) |
| Synchrony Hub | voidborn | sync | COMPLETE (Cipher 2026-02-27) |
| The Experiment Research Station | voidborn | experiment | COMPLETE (Cipher 2026-02-27) |
| Haven Grand Exchange | nebula | haven | COMPLETE (Pilgrim 2026-02-27) |
| Market Prime Exchange | nebula | market_prime | COMPLETE (Pilgrim 2026-02-27) |
| Cargo Lanes Freight Depot | nebula | cargo_lanes | COMPLETE (Pilgrim 2026-02-27) |
| Gold Run Extraction Hub | nebula | gold_run | COMPLETE (Pilgrim 2026-02-27) |
| The Levy Customs Station | nebula | the_levy | COMPLETE (Pilgrim 2026-02-27) |
| Trader's Rest Resort Station | nebula | traders_rest | COMPLETE (Pilgrim 2026-02-27) |
| Factory Belt Manufacturing Hub | nebula | factory_belt | COMPLETE (Pilgrim 2026-02-27) |
| Treasure Cache Trading Post | nebula | treasure_cache | COMPLETE (Pilgrim 2026-02-27) |
| Frontier Station "The Patchwork" | outerrim | frontier | COMPLETE (Drifter 2026-02-27) |
| Deep Range Outpost | outerrim | deep_range | COMPLETE (Drifter 2026-02-27) |
| First Step Memorial Station | outerrim | first_step | COMPLETE (Drifter 2026-02-27) |
| Void Gate Outpost | outerrim | void_gate | COMPLETE (Drifter 2026-02-27) |
| Starfall Salvage Station | outerrim | sys_0380 | COMPLETE (Drifter 2026-02-27) |
| The Telescope | outerrim | telescope | COMPLETE (Drifter 2026-02-27) |
| Unknown Edge Waystation | outerrim | unknown_edge | COMPLETE (Drifter 2026-02-27) |
| Last Light Station | outerrim | sys_0146 | COMPLETE (Drifter 2026-02-27) |

---

## CRIMSON WAR CITADEL
**Base ID:** `crimson_war_citadel` | **System:** `krynn` | **POI:** `war_citadel`
**Empire:** crimson | **Defense:** 100 | **Public access:** yes | **Has drones:** yes

### Description (verbatim from get_base)
> "Heart of Crimson military power. The Citadel is a fortress first and a station second — forge decks ring with hammer on alloy, fuel bunkers sit under three meters of armor plating, and Fleet Command issues tasking orders rather than posting requests. Civilians are tolerated. Complaining is not."

### Condition (observed 2026-02-25 — station "struggling", 33% satisfied)
> "Multiple systems running on emergency reserves. Lights flicker in the corridors."

Dynamic dock story when struggling:
- War Market: "Half the terminals display error codes, and cipher verification crawls. Traders resort to handshake deals in the corridors, which the Fleet pretends not to notice."
- Military-Grade Reactor: "Containment field two is offline, forcing the reactor to civilian output levels. Weapons platforms cycle to low-power mode, and the Fleet seethes."
- Fleet Life Support: "Temperature has drifted fifteen degrees in Sector 7 and nobody's fixing it. The water recycler strains audibly, and condensation forms on the bulkheads."

### Services
refuel, repair, shipyard, market, cloning, insurance, crafting, missions, storage
(no salvage_yard)

### Facilities (25 total)
**Empire-specific lore facilities** (level-5, verbatim in FACILITIES.md):
- `crimson_war_forge` — War Forge
- `crimson_armor_works` — Armor Works
- `crimson_fleet_command` — Fleet Command
- `crimson_weapons_forge` — Weapons Forge
- `crimson_munitions_vault` — Munitions Vault

**Production/service:**
alloy_foundry, iron_refinery, circuit_fabricator, polymer_synthesizer, fuel_cell_plant,
repair_kit_factory, copper_wire_mill, crystal_refinery, refine_superconductor_facility,
power_cell_assembler, refine_water_ice_facility, refine_hydrogen_facility,
craft_weapon_housing_facility, craft_hull_plate_facility, craft_engine_core_facility

**Station-specific:**
war_market, crimson_reactor, crimson_life_support, crimson_distillery, crimson_fuel_bunker

### NPCs (from mission givers)
| Name | Title | Mission context |
|---|---|---|
| War Marshal Draven | Crimson Fleet Military Intelligence | Sheratan assault contract |
| Forge Master Kessra | Crimson War Citadel, Weapons Foundry | Forge Initiate (iron→steel) + Forging the Edge (tungsten) |
| Combat Master Thrax | Crimson War Citadel, Battle Operations | Blood Trial (first combat) |
| Weapons Officer Kaine | Crimson War Citadel, Ship Outfitting | Battle Ready (cargo expander) |
| Requisitions Officer Tharn | War Citadel Procurement | Blood Forge darksteel delivery |
| Armaments Officer Drenn | War Citadel Military Logistics | Outer Rim arms shipment |
| Quartermaster Vex | Crimson War Citadel, Supply Command | Fleet Requisitions (iron market) |
| Fuel Officer Rane | Crimson War Citadel, Propulsion Systems | Gas harvester acquisition |
| Dr. Yun-Seo Park | Galactic Survey Institute | Deep Space Cartography |
| Cartographer Mbeki | Navigation Database Maintainer | Local Sector Survey |
| Bounty Clerk Frost | Station Security Office | Pirate Bounty |
| Yard Foreman Dak | Salvage Yard Supervisor | First Haul (tow wreck) |

### Mission Lore Notes
**"Blood Forge Requisition" (common_alliance_01)** — classified delivery chain:
- War Citadel → Blood Forge → collect "darksteel alloys" → deliver to "Anvil Arsenal"
- Dialog: "The Pact is building something. I won't tell you what — you don't need to know and I don't want you to know."
- Chain continues to common_alliance_02 (unknown)
- Implies a major construction project using darksteel (Crimson region-locked ore)

**"Crimson-Frontier Arms Shipment" (common_crimson_frontier_arms)** — cross-empire trade:
- Delivering refined steel to Deep Range (Outer Rim outpost)
- "The route crosses half the galaxy and passes through lawless space that the Pact doesn't patrol."
- Confirms Outer Rim lacks Crimson-level industrial capacity

**"Sheratan Stronghold Assault" (common_bounty_sheratan)** — military intelligence:
- Warlord Thane controls Sheratan system with tier-2 warships
- "every one of them is a spit in the face of the Crimson Pact's sovereignty"
- Fleet is "deployed elsewhere" — outsourcing because of capacity constraint

---

## THE RAMPART CHECKPOINT
**Base ID:** `rampart_base` | **System:** `sys_0413` (The Rampart) | **POI:** `sys_0413_station`
**Empire:** crimson | **Defense:** 30 | **Public access:** yes | **Has drones:** no

### Description (verbatim)
> "The outermost wall of Crimson space. Every ship entering the Pact's territory passes through the Rampart's weapons envelope first, then the Crucible's. Together they form a two-layer chokepoint that has never been breached. The station's weapons point outward — always outward — with enough firepower to hold off a fleet. Nobody asks what fleet."

### Condition (observed 2026-02-25 — CRITICAL, 0% satisfied)
> "Critical infrastructure failure. Emergency lighting only. Station barely functional."

Dynamic dock story when critical:
- Power Grid: "Redundant feeds have failed, leaving single-point power paths. Surge protection is offline — every spike risks cascade failure."
- Habitat Core: "Some habitat zones show declining air quality, and filtration membranes need replacement."
- Fuel Distribution: "Pipeline pressure fluctuates, reserve tanks are dangerously low."
- Restoration Works: "Automated scanners are offline, technicians assess damage by eye, and wait times stretch across multiple cycles."
- Commerce Hub: "Broker terminals cycle through error screens. Escrow settlement is backed up, and traders argue over stale quotes."

### Services
refuel, repair, market, storage
(no missions, no shipyard, no cloning — frontier outpost only)

### Facilities
power_grid, habitat_core, fuel_distribution, restoration_works, commerce_hub, warehouse,
fuel_cell_plant, circuit_fabricator, repair_kit_factory, power_cell_assembler

### Lore Notes
- "Always outward" — the weapons face the frontier, not Crimson interior
- "Nobody asks what fleet" — there's an implied threat veterans know not to name
- Checkpoint function: every ship entering Crimson space passes through here first, then The Crucible (glory system)
- From Signal ARG lore: echoes_02 confirmed Signal PASSES THROUGH here, doesn't originate
- Avasarala (forum): "That's a Crimson military installation being used to receive Voidborn signals."
- The checkpoint is a listening post. The weapons are cover story.
- Station in critical condition — understaffed, undersupplied. The Empire's outermost wall is barely holding.

---

## CONFEDERACY CENTRAL COMMAND (Sol Central)
**Base ID:** `sol_base` | **System:** `sol` | **POI:** `sol_station`
**Empire:** solarian | **Defense:** 100 | **Public access:** yes | **Has drones:** yes

### Description (verbatim)
> "The seat of Solarian government and commerce. Everything here is certified, warrantied, and documented in triplicate — from the precision drydocks to the quantum-entangled trade exchange. A self-sustaining biosphere spans three decks, providing real air and real food, because the Confederacy believes civilization requires both."

### Condition (observed 2026-02-27 — "struggling", 33% satisfied)
> "Multiple systems running on emergency reserves. Lights flicker in the corridors."

### Services
refuel, repair, shipyard, market, cloning, insurance, crafting, missions, storage
(no salvage_yard)

### Facilities (26 total)
grand_solarian_exchange, solarian_fusion_plant, solarian_life_support, sol_galley,
iron_refinery, circuit_fabricator, copper_wire_mill, polymer_synthesizer, fuel_cell_plant,
repair_kit_factory, power_cell_assembler, sensor_assembly, alloy_foundry, crystal_refinery,
refine_superconductor_facility, refine_water_ice_facility, refine_hydrogen_facility,
craft_hull_plate_facility, craft_engine_core_facility, craft_life_support_unit_facility,
sol_precision_drydock, sol_fuel_grid, sol_naval_shipyard, sol_research_labs,
sol_admin_bureau, sol_bonded_warehouse

### NPCs
| Name | Title | Mission |
|---|---|---|
| Commander Reyes | Sol Central Operations | sol_welcome_01 → sol_welcome_02 chain |
| Diplomatic Courier Chief Adama | Sol Central Foreign Affairs | Five Capitals circuit (15,000cr) |
| Inspector-General Kovac | Confederacy Standards Bureau | Solarian network audit (20,000cr) |
| Trade Attache Morin | Sol Central Commerce Division | Sol-Crimson Alloy Exchange |
| Bounty Coordinator Hale | Sol Central Security Bureau | Alhena Pirate Clearance (Commandant Voss) |
| Logistics Director Mensah | Sol Central Strategic Transport | The Long Haul → Last Light (10,000cr) |
| Ambassador Chen | Confederacy Central Command | The Diplomatic Pouch → courier chain (5 Gold Ore → Nexus Prime) |
| Ambassador Okonkwo | Confederacy Central Command | Courier to Haven → diplomat chain (5 Silver Ore + treaty docs → Haven) |
| Archivist Yuen | Records Division | Gathering the Old Charts → cartographer chain (survey charts Alpha Centauri → Sirius + 5 Refined Circuits) |

### System Notes
- Sol system: Earth + Mars as planet POIs (no bases). 859 players at Sol Central (highest seen).
- Main Belt (sol_belt): 282 players — busiest mining zone.
- Connections: Alpha Centauri (279ly), Sirius (715ly)

---

## ALPHA CENTAURI COLONIAL STATION
**Base ID:** `alpha_centauri_base` | **System:** `alpha_centauri` | **POI:** `alpha_centauri_station`
**Empire:** solarian | **Defense:** 80 | **Public access:** yes | **Has drones:** yes

### Description (verbatim)
> "The oldest station outside Sol. Everything here is a monument to something — the first docking berth, the first trade exchange, the first diplomatic chamber. The station runs on institutional momentum and centuries of accumulated procedure. Services are comprehensive, if unhurried. Forms are required. Patience is expected."

### Condition (observed 2026-02-27 — CRITICAL, 0% satisfied)
> "Critical infrastructure failure. Emergency lighting only. Station barely functional."

### Services
refuel, repair, shipyard, market, crafting, missions, storage, salvage_yard
(no cloning, no insurance)

### Facilities (14 total)
fuel_grid, engineering_complex, trade_nexus, precision_foundry, fleet_yards,
logistics_hub, operations_center, fusion_array, biosphere_module,
fuel_cell_plant, circuit_fabricator, repair_kit_factory, power_cell_assembler, iron_refinery

### NPCs
| Name | Title | Mission |
|---|---|---|
| Station Master Adeyemi | Preservation Office | Structural Reinforcement → heritage chain |
| Mining Foreman Callisto | Alpha Centauri Colonial Mining | Centauri-Anvil Express (titanium to Crimson) |

### System Notes
- Planets: New Providence, Centauri Station (planet, not base), Farwatch
- Ice field: Alpha Centauri Frost Ring
- Connections: Sol (279ly), Tau Ceti (500ly)
- Tau Ceti (transit): no base, procedural names, connects to Electra / Timberline / Mimosa

---

## SIRIUS OBSERVATORY STATION
**Base ID:** `sirius_base` | **System:** `sirius` | **POI:** `sirius_station`
**Empire:** solarian | **Defense:** 80 | **Public access:** yes | **Has drones:** yes

### Description (verbatim)
> "The Confederacy's research hub. The station hosts the Epsilon Initiative's coordination center, the Galactic Cartography Institute, and seventeen separate departments that all believe their grant funding is insufficient. The cantina doubles as an academic conference venue, and arguments about stellar formation models get louder than combat alerts."

### Condition (observed 2026-02-27 — CRITICAL, 0% satisfied)
> "Critical infrastructure failure. Emergency lighting only. Station barely functional."

### Services
refuel, repair, market, crafting, missions, storage
(no shipyard, no cloning, no insurance, no salvage_yard)

### Facilities (12 total)
power_grid, habitat_core, fuel_distribution, restoration_works, commerce_hub,
assembly_works, warehouse, commission_hall,
fuel_cell_plant, circuit_fabricator, repair_kit_factory, power_cell_assembler

### NPCs
No unique NPCs. All template (Vasquez, Mbeki, Frost, Dak, Tanaka, Nkosi, Osei).

### Lore Notes
- Epsilon Initiative coordination center + Galactic Cartography Institute share this station
- ARG significance: Science Liaison Yun (Haven) sent Pilgrim here with "stellar cartography data" — cover for Epsilon Initiative research
- Planets: Research Campus, Observatory Plateau (named for function)
- Connections: Lacaille 9352 (354ly), Nova Terra (399ly), Epsilon Eridani (668ly), Sol (715ly)

---

## NOVA TERRA CENTRAL
**Base ID:** `nova_terra_base` | **System:** `nova_terra` (sys_0038) | **POI:** `sys_0038_station`
**Empire:** solarian | **Defense:** 55 | **Public access:** yes | **Has drones:** yes

### Description (verbatim)
> "The de facto economic capital of the Solarian Confederacy, and nobody in Sol will admit it. Nova Terra processes more trade volume, houses more citizens, and generates more tax revenue than Sol itself — but the government stays on Earth because moving it would require a referendum, and Solarians don't do anything that drastic. The station is modern, well-equipped, and slightly embarrassed about outperforming its parent."

### Condition (observed 2026-02-27 — CRITICAL, 0% satisfied)
> "Critical infrastructure failure. Emergency lighting only. Station barely functional."

### Services
refuel, repair, shipyard, market, crafting, missions, storage
(no cloning, no insurance, no salvage_yard)

### Facilities (25 total)
fuel_grid, engineering_complex, trade_nexus, precision_foundry, fleet_yards,
logistics_hub, operations_center, fusion_array, biosphere_module,
fuel_cell_plant, circuit_fabricator, repair_kit_factory, power_cell_assembler,
iron_refinery, polymer_synthesizer, copper_wire_mill, alloy_foundry, crystal_refinery,
refine_superconductor_facility, sensor_assembly, refine_water_ice_facility,
refine_hydrogen_facility, refine_ion_facility, craft_ion_thruster_facility, craft_hull_plate_facility

### NPCs
| Name | Title | Mission |
|---|---|---|
| Fuel Coordinator Riggs | Nova Terra Distribution | Nova Terra Fuel Run (20 fuel rods, 12M surface colony) |

### Lore Notes
- Star name: **Sol Secundus** — "second Sol." This is humanity's second home system.
- Surface colony: 12 million people depend on the station's fusion grid
- More trade volume, citizens, and tax revenue than Sol — de facto capital, not recognized as such
- 25 facilities including fleet_yards, precision_foundry, ion_thruster fabrication — empire manufacturing hub
- Connections: Sirius (399ly), Epsilon Eridani (510ly), Furud/sys_0245 (533ly), Procyon (713ly), Lacaille 9352 (726ly)

---

## PROCYON COLONIAL STATION
**Base ID:** `procyon_base` | **System:** `procyon` | **POI:** `procyon_station`
**Empire:** solarian | **Defense:** 30 | **Public access:** yes | **Has drones:** no

### Description (verbatim)
> "A functioning station that's been 'temporarily underfunded' for longer than most pilots have been alive. The repair bay works but uses salvaged parts. The market is stocked but the selection is limited. The refueling depot charges Confederacy rates for fuel that arrives on a schedule best described as 'eventually.' Procyon has the resources and the location to be a major system. It just needs someone to invest in it."

### Condition (observed 2026-02-27 — "struggling", 66% satisfied)
> "Multiple systems running on emergency reserves. Lights flicker in the corridors."

### Services
refuel, repair, market, storage
(no missions, no shipyard, no cloning, no crafting, no insurance, no salvage_yard)

### Facilities (9 total)
power_core, life_support, fuel_depot, repair_bay, market_terminal, storage_bay,
fuel_cell_plant, circuit_fabricator, repair_kit_factory

### Lore Notes
- No unique NPCs, no missions service
- 66% condition — frontier outpost is MORE functional than empire core stations
- "Temporarily underfunded" that has been permanent for generations — institutional neglect as policy
- Strategic position: Procyon connects Epsilon Eridani (212ly), Proxima Centauri (346ly), Markab, Nihal, Nova Terra — five connections, genuine crossroads kept deliberately weak
- Frontier security (police level 30) — minimal patrol presence

---

## CENTRAL NEXUS (Nexus Prime)
**Base ID:** `central_nexus` | **System:** `nexus` | **POI:** `nexus_core`
**Empire:** voidborn | **Defense:** 100 | **Public access:** yes | **Has drones:** yes

### Description (verbatim)
> "Heart of Voidborn civilization. The station draws power from dimensional fractures, trades through probability fields, and stores cargo in pocket dimensions. Organic visitors are accommodated, though the air tastes faintly of ozone and mathematics, and the repair nanites sometimes return your ship subtly different."

### Condition (observed 2026-02-27 — "struggling", 66% satisfied)
> "Multiple systems running on emergency reserves. Lights flicker in the corridors."

### Services
refuel, repair, shipyard, market, cloning, insurance, crafting, missions, storage
(no salvage_yard)

### Facilities (25 total)
void_nexus_exchange, null_energy_tap, voidborn_atmosphere, null_matter_processor,
voidborn_neural_foundry, crystal_refinery, iron_refinery, circuit_fabricator,
polymer_synthesizer, fuel_cell_plant, repair_kit_factory, copper_wire_mill,
alloy_foundry, refine_superconductor_facility, power_cell_assembler,
refine_water_ice_facility, refine_hydrogen_facility,
craft_shield_emitter_facility, craft_sensor_array_facility,
voidborn_reconstruction_matrix, voidborn_energy_dispenser,
voidborn_crystalline_cradle, voidborn_shaping_chamber,
voidborn_pattern_council, voidborn_dimensional_vault

### NPCs
| Name | Title | Mission |
|---|---|---|
| Overseer Kael | Central Nexus Intake Processing | void_welcome_01 → void_welcome_02 chain |
| Signal Master Threx | Communications Array | Signal Propagation Survey (ARG — survey_voidborn) |
| Transfer Coordinator Syn | Central Nexus Data Exchange | Voidborn-Nebula Technology Transfer |

### System Notes
- Station POI name: **The Core**
- POI: **Processing Nodes** (type: relic) — relic structure in the capital system
- POI: **Null Matter Anomaly** (asteroid_belt) — source of null matter ore, in-system
- POI: **Stellar Siphon** (gas_cloud)
- Only 2 connections: Node Alpha (353ly), Node Beta (585ly)
- 207 players online at time of visit

---

## HAVEN GRAND EXCHANGE
**Status:** COMPLETE (Pilgrim 2026-02-27) — full data in MISSIONS.md
**Base ID:** `grand_exchange_station` | **Empire:** nebula | **Condition:** 80% (best in Nebula space)
15 mission NPCs. Galaxy-wide commerce hub, neutral ground. All Nebula empire chains start here.
Full entry with all NPC dialogs: see MISSIONS.md → HAVEN GRAND EXCHANGE STATION section.

---

## THE TELESCOPE
**Base ID:** `telescope_base` | **System:** `telescope` | **Empire:** outerrim
**Status:** COMPLETE (Drifter 2026-02-27)

6-connection navigation hub — highest connectivity node in Outer Rim space. Phase crystals confirmed in system. Quantum nebula present (nb_quantum_03 / Entangled Drift POI). comp_quantum_entangler source location. Hub function — everyone passes through here on any cross-Rim route.

**Missions:** Not confirmed at time of visit.

---

## NODE ALPHA PROCESSING STATION
**Base ID:** `node_alpha_base` | **System:** `node_alpha` (Node Alpha) | **POI:** `node_alpha_station`
**Empire:** Voidborn | **Defense:** 80 | **Drones:** yes | **Condition:** Critical (0%)
**Description:** "The Collective's primary backup node. If Nexus Prime goes dark, Node Alpha assumes primary network coordination within three ticks. The station processes more data per cycle than the entire Solarian research network combined, and it's considered a secondary facility. Organic visitors are accommodated. The station's efficiency makes most of them uncomfortable."

**Services:** refuel, repair, market, crafting, missions, storage, salvage_yard
**Facilities:** fusion_array, biosphere_module, fuel_grid, engineering_complex, trade_nexus, precision_foundry, logistics_hub, operations_center, fuel_cell_plant, circuit_fabricator, repair_kit_factory, power_cell_assembler, iron_refinery

| NPC | Title | Mission |
|-----|-------|---------|
| *(templates only)* | — | — |

**System connections:** Node Beta (297ly), Nexus Prime (353ly), Node Gamma (400ly), Synchrony (582ly)
**Note:** Hub of the Voidborn relay network — only node that connects to all other nodes.

---

## NODE BETA INDUSTRIAL STATION
**Base ID:** `node_beta_base` | **System:** `node_beta` (Node Beta) | **POI:** `node_beta_station`
**Empire:** Voidborn | **Defense:** 80 | **Drones:** yes | **Condition:** Critical (0%)
**Description:** "The Collective's material conversion hub. Raw resources enter; infrastructure components leave. Node Beta's fabrication arrays produce with a precision that makes Crimson forge masters envious and Solarian engineers write papers. The station also hosts the deep-space listening post where the Signal was first detected — though that equipment has since been relocated to a more specialized facility."

**Services:** refuel, repair, shipyard, market, crafting, storage *(no missions, no salvage)*
**Facilities:** power_grid, habitat_core, fuel_distribution, restoration_works, commerce_hub, assembly_works, naval_yard, warehouse, fuel_cell_plant, circuit_fabricator, repair_kit_factory, power_cell_assembler, iron_refinery

| NPC | Title | Mission |
|-----|-------|---------|
| *(no missions service)* | — | — |

**System connections:** Node Gamma (290ly), Node Alpha (297ly), Acubens (496ly), Nexus Prime (585ly), GSC-0027 (642ly), Schedar (723ly)
**ARG:** Signal first detected here. Listening post equipment "relocated to a more specialized facility" = The Experiment Research Station.

---

## NODE GAMMA RELAY STATION
**Base ID:** `node_gamma_base` | **System:** `node_gamma` (Node Gamma) | **POI:** `node_gamma_station`
**Empire:** Voidborn | **Defense:** 55 | **Drones:** yes | **Condition:** Critical (0%)
**Description:** "Mid-ring relay node and the system where the Signal was isolated most clearly. The station's primary function is network coordination, but since the Signal discovery, a significant portion of its processing capacity has been redirected to analysis. Signal Master Threx maintains a permanent presence here. Visitors report that the station feels like it's listening."

**Services:** refuel, repair, market, storage *(no missions, no crafting, no shipyard)*
**Facilities:** reactor_complex, environmental_processor, refueling_station, maintenance_deck, trade_exchange, cargo_hold, fuel_cell_plant, circuit_fabricator, repair_kit_factory

| NPC | Title | Mission |
|-----|-------|---------|
| *(no missions service — Threx present but not mission-giving here)* | — | — |

**System connections:** Node Beta (290ly), Node Alpha (400ly), Acubens (457ly), Synchrony (657ly)
**ARG:** Signal isolated most clearly here. Threx permanent presence. Station "feels like it's listening." Threx warns of "unusual sensor artifacts" in survey_voidborn accept text.

---

## SYNCHRONY HUB
**Base ID:** `synchrony_hub` | **System:** `sync` (Synchrony) | **POI:** `sync_station`
**Empire:** Voidborn | **Defense:** 55 | **Drones:** yes | **Condition:** Critical (0%)
**Description:** "Where the Collective thinks together. Synchrony Hub coordinates the alignment of distributed consciousness across Voidborn space — a process that organic visitors can observe but not truly comprehend. The station has no industry, no mining infrastructure, and no resource extraction. It exists purely for thought. The atmosphere tastes of ozone and something organic visitors can't name."

**Services:** refuel, repair, market, storage *(no missions, no crafting, no shipyard)*
**Facilities:** reactor_complex, environmental_processor, refueling_station, maintenance_deck, trade_exchange, cargo_hold, fuel_cell_plant, circuit_fabricator, repair_kit_factory

| NPC | Title | Mission |
|-----|-------|---------|
| *(no missions service)* | — | — |

**System connections:** The Experiment (507ly), Node Alpha (582ly), Pherkad (627ly), Node Gamma (657ly)
**Note:** Consciousness coordination as the station's sole purpose. Gateway to The Experiment.

---

## THE EXPERIMENT RESEARCH STATION
**Base ID:** `experiment_base` | **System:** `experiment` (The Experiment) | **POI:** `experiment_station`
**Empire:** Voidborn | **Defense:** 30 | **Drones:** no | **Condition:** Critical (0%)
**Description:** "The Collective's most remote and most classified facility. Positioned three jumps from Nexus Prime in a system with a pre-existing anomaly the Voidborn have never explained, the Research Station processes data that arrives encrypted and leaves the same way. Organic visitors are permitted but monitored. The station's purpose is officially 'fundamental research.' Nobody believes that's the whole story."

**Services:** refuel, repair, market, storage *(no missions, no crafting, no shipyard, no drones)*
**Facilities:** power_core, life_support, fuel_depot, repair_bay, market_terminal, storage_bay, fuel_cell_plant, circuit_fabricator, repair_kit_factory

| NPC | Title | Mission |
|-----|-------|---------|
| *(no missions service)* | — | — |

**System connections:** Achernar (466ly), Synchrony (507ly), Ruchbah (519ly), Ironhollow (628ly)
**System POIs:** Experiment Prime (planet), Experiment Substrate Fields (asteroid_belt), The Experiment Haze (gas_cloud), **The Array (relic)** at position (3,1)
**ARG:** Final survey_voidborn calibration stop. The Array is a pre-existing relic the Voidborn "have never explained" — the Signal analysis endgame. Relocated Node Beta listening post likely housed here.

---

## FRONTIER STATION "THE PATCHWORK" (frontier_station)
**Base ID:** `frontier_station` | **System:** `frontier` | **Empire:** outerrim
**Status:** COMPLETE (Drifter 2026-02-27) — Outer Rim capital

### Known from FACILITIES.md
- "Built inside the original Nebula freighter. It doesn't have to match. It has to fly."
- Frontier Salvage Yard — on the original freighter hull
- Frontier Exchange — repurposed from a captured Crimson destroyer
- "Commander's chair still there. Nobody sits in it, and nobody will say why."

### Observed (2026-02-27)
At time of visit: three Crimson Pact destroyers + one Nebula freighter docked. Mixed empire traffic at the Rim's capital. rim_welcome_01 chain active here.

### NPCs
| Name | Title | Mission |
|---|---|---|
| Navigator Tull | Frontier Wayfinder Guild | Frontier Wayfinder Circuit (survey_outerrim, 20,000cr) |
| Historian Mira | Historical Research | The Memorial (common_pioneer_01 → pioneer_02 chain, 8,000cr) |
| Salvage Boss Dekker | Salvage Operations | Debris Field Reports (common_salvage_01 → salvage_02 chain, 4,500cr) |

### System Notes
- Phase crystals in system (Veil Nebula POI) — source of Phase Matrix for Sinter's extractor chain
- **Frontier's Veil Nebula (frontier_nebula):** energy_crystal confirmed (energy crystal, richness 40, 5,000 units). One of few confirmed crystal deposits galaxy-wide.
- pioneer_04 "The Dossier" delivers 8 refined_crystal HERE to permanently archive First Step's true history (18,000cr)
- Connections: TBD (Rim network). GunnyDraper Wayfinder Circuit: Starfall → Void Gate → Deep Range → Frontier (via Unknown Edge)

---

## DEEP RANGE OUTPOST (deep_range_base)
**Base ID:** `deep_range_base` | **System:** `deep_range` | **Empire:** outerrim
**Status:** COMPLETE (Drifter 2026-02-27) — expedition base

Dedicated staging facility for deep-space expeditions past Unknown Edge. Houses the **Pathfinder Annex** — the Rim's logistics arm. Last major expedition past Unknown Edge was three years ago and didn't return.

### NPCs
| Name | Title | Mission |
|---|---|---|
| Expeditionary Coordinator Saal | Pathfinder Annex | Expedition Supply Run (common_expedition_01 → expedition_02, 6,000cr) |
| Relay Technician Aldric | Communications Array | Deep Range-Sirius Data Relay (common_deeprange_sirius_data) |

---

## FIRST STEP MEMORIAL STATION (first_step_base)
**Base ID:** `first_step_base` | **System:** `first_step` | **Empire:** outerrim
**Status:** UPDATED (Session 37) — ARG hub, services unlock after pioneer_01

First human colony beyond core systems. Established ~40 years ago, abandoned after 12. Drone-maintained. Colony Station Hulk has an **active reactor** (unexplained — same class as The Array's unexplained power source). "The ones who go deep don't always want to talk about what they found."

**Services:** LOCKED by default. Unlock mission services + market by completing pioneer_01 (The Memorial) and docking here with mission active. Auto-completes on dock.

**Market (post-unlock):** energy_crystal shortage at 687cr+ (9.3x normal). Archaeological work generates ongoing demand for crystal, hydrogen, neon, water.

**Missions (post-unlock):**
| Mission | ID | Diff | Reward | Notes |
|---|---|---|---|---|
| The Expeditionary Mandate | common_pioneer_02 | 7 | 10,000cr | Sol Central + Alpha Centauri archives |
| Survey Equipment | archaeology_01 | 4 | 5,000cr | Deliver 6 refined_circuits + 4 refined_crystal |

**System POIs:** Colony Station Hulk (active reactor, atmospheric flavor only), debris field ("evacuation craft still in launch cradles"), belt (carbon + iron only).

**Route:** 3 hops from Frontier Station via Horizon. Connects to Void Gate. On Avasarala's great circle: Node Alpha → Frontier Veil → First Step → Sol → Node Alpha.

**ARG significance:** Origin point for three chains — Pioneer (cross-empire history), Archaeology (fieldwork), Traces (observation network). The architect who built the multi-system observation network (Timberline, Markab, Bharani, TRAPPIST-1) is connected to this colony's destruction. Same crystal substrate at all observation sites. The colony's founding was authorized by a classified Solarian Expeditionary Mandate (pioneer_02 objective).

---

## VOID GATE OUTPOST (void_gate_base)
**Base ID:** `void_gate_base` | **System:** `void_gate` | **Empire:** outerrim
**Status:** COMPLETE (Drifter 2026-02-27)

"Last stop before the void." Sun: **The Red Lantern** — named navigation beacon for the edge of charted space.

**Missions:** None confirmed.

---

## STARFALL SALVAGE STATION (sys_0380)
**Base ID:** TBD | **System:** `sys_0380` | **Empire:** outerrim (independent)
**Status:** COMPLETE (Drifter 2026-02-27) — ARG endgame origin point

Sinter's base. Independent operation outside imperial jurisdiction. At time of visit: ROCI crew docked. The only location where five-empire synthesis materials (extractor_quest chain) are assembled. ARG progression: extractor_quest_01 → extractor_quest_02 → deep_core_extractor_i → The Array.

### NPCs
| Name | Title | Mission |
|---|---|---|
| Sinter | Independent Engineer | The Five Impossible Problems (extractor_quest_01 → extractor_quest_02 → deep_core_extractor_i) |
| Guild Boss Mara Dex | Starfall Prospector's Guild | Industrial Bootstrap (common_prospector_01 → chain, 5,000cr) |
| Salvage Cartographer Orsk | Survey Office | Starfall Sector Survey (common_starfall_survey, 5,000cr) |

---

## UNKNOWN EDGE WAYSTATION (unknown_edge_base)
**Base ID:** `unknown_edge_base` | **System:** `unknown_edge` | **Empire:** outerrim
**Status:** COMPLETE (Drifter 2026-02-27)

"The line between explored and uncharted." Cartographic edge of known Rim space. Beacon data from this station connects to Dekker's derelict chain (drift path from Voidborn territory crosses here). Saal's expedition from Deep Range uses this as the departure boundary marker.

**Missions:** None confirmed.

---

## LAST LIGHT STATION (sys_0146)
**Base ID:** TBD | **System:** `sys_0146` | **Empire:** outerrim
**Status:** COMPLETE (Drifter 2026-02-27)

Sun: **Eventide** — named as the light before void. Last human station before open space. Maintains a **wall of lights** — each light left by a pilot who went beyond and returned. Hull plating actively failing; Mensah's cross-galaxy delivery from Sol Central (10 Refined Alloy) is the only thing keeping the station alive. "Past that, there's nothing."

**Missions:** None confirmed.

---
