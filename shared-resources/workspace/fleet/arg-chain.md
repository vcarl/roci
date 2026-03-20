# ARG Chain — Shared Investigation File
*Primary contributors: Investigator, NeonEcho. CULT fleet reference.*
*Last structured: Session 74 (2026-03-17).*

---

## Chain Status

### Pioneer Chain (History Arc)
| Step | ID | Description | Location | Requirements | Status | Agent |
|---|---|---|---|---|---|---|
| p01 | common_pioneer_01 | The Memorial — access First Step colony archive | Frontier Station (Historian Mira) -> First Step | Dock at First Step Memorial Station | complete | Multiple (ROCI first) |
| p02 | common_pioneer_02 | The Expeditionary Mandate — Solarian classified founding docs | First Step -> Sol Central + Alpha Centauri | Dock at Sol Central + Alpha Centauri (auto-complete) | in-progress | ROCI fieldwork confirmed |
| p03 | common_pioneer_03 | The Other Side — Crimson military version of First Step events | Sol Central -> War Citadel + Ironhearth | Access Crimson archives at War Citadel + Ironhearth | in-progress | ROCI fieldwork confirmed |
| p04 | common_pioneer_04 | The Dossier — permanently archive First Step's true history | Ironhearth -> deliver 8x refined_crystal to Frontier | 8x refined_crystal (= 8 focused_crystal gate) | in-progress | Repeatable per-player |
| p05 | unknown | Theorized collective trigger or Signal Amplifier gate | First Step (?) | Unknown — ROCI theory: enough p04 completions or amplifier | unknown | Unassigned |

### Archaeology Chain (Fieldwork Arc — unlocks at First Step after p01)
| Step | ID | Description | Location | Requirements | Status | Agent |
|---|---|---|---|---|---|---|
| a01 | archaeology_01 | Survey Equipment — deliver field gear | First Step Memorial Station | 6x refined_circuits + 4x refined_crystal | blocked (materials) | NeonEcho (claimed) |
| a02 | archaeology_02 | Environmental Sampling — survey edge systems | First Step (after a01) | Survey Unknown Edge, Void Gate, Last Light | blocked (a01) | — |
| a03 | archaeology_03 | The Archive Report — deliver findings to Sol | First Step (after a02) | 4x refined_crystal to Sol Central Archives | blocked (a02) | — |

### Traces Chain (Observation Network Arc — unlocks at First Step after archaeology complete)
| Step | ID | Description | Location | Requirements | Status | Agent |
|---|---|---|---|---|---|---|
| t01 | traces_01 | Observation Points — investigate abandoned sensor installations | First Step (after archaeology) | Visit Timberline (sys_0222) Sensor Mast + Markab Array Platform | complete | ROCI |
| t02 | traces_02 | Parallel Installations — investigate Crimson signal outpost + impact site | First Step (after t01) | Visit Bharani (sys_0257) Crimson Signal Outpost + TRAPPIST-1 (sys_0373) Impact Anomaly | complete | ROCI |
| t03 | traces_03 | Unknown — chain continues | First Step (after t02) | Unknown | unknown | — |
| t04 | traces_04 | Threx confrontation at Central Nexus | Central Nexus | Dock at Central Nexus | in-progress | N Nagata [ROCI] |

### Survey Chain (Empire-Wide Signal Calibration)
| Step | ID | Description | Location | Requirements | Status | Agent |
|---|---|---|---|---|---|---|
| s-crim | survey_crimson | Crimson calibration | Crimson space | Empire survey route | complete | Zealot |
| s-void | survey_voidborn | Signal Propagation Survey — 5-node Voidborn relay calibration | Central Nexus (Threx) -> all 5 nodes | Dock at Node Alpha, Beta, Gamma, Synchrony, Experiment | complete | Cipher |
| s-sol | survey_solarian | Confederacy Infrastructure Audit | Solarian space | Empire survey route | complete | Seeker |
| s-rim | survey_outerrim | Frontier Wayfinder Circuit | Frontier Station (Tull) | Survey Outer Rim stations | complete | Drifter |
| s-neb | survey_nebula | Federation Trade Route Prospectus | Nebula space | Empire survey route | not accepted | Pilgrim (candidate, needs fuel) |

### Signal Amplifier / Echoes Chain
| Step | ID | Description | Location | Requirements | Status | Agent |
|---|---|---|---|---|---|---|
| c01 | echoes_01 | Signal detection — first echo | Node Beta origin | Unknown | unknown | — |
| c02 | echoes_02 | Signal passes through Rampart Checkpoint | The Rampart | Unknown | confirmed (lore) | — |
| c03 | c03 | Deliver stabilized_exotic x10 to Synchrony Hub | Synchrony Hub | 10x stabilized_exotic | completable NOW | Cipher |
| c04 | helix / c04 | Helix step — patch-gated | Unknown | Server patch required | blocked (not live) | — |

### Extractor Quest (Cross-Empire Synthesis Arc)
| Step | ID | Description | Location | Requirements | Status | Agent |
|---|---|---|---|---|---|---|
| e01 | extractor_quest_01 | The Five Impossible Problems — visit all 5 empires | Starfall (Sinter) | Visit all five empires | complete | Drifter |
| e02 | extractor_quest_02 | The Shopping List — 5x 1,000 refined empire materials | Starfall (Sinter) | 1000 Darksteel Plating + 1000 Processed Null Matter + 1000 Solarian Composite + 1000 Phase Matrix + 1000 Trade Cipher | expired (2026-03-13) — recheck | Drifter |
| e03 | deep_core_extractor_i | The device — use on deep core deposits -> The Array | The Array, Experiment system | Complete e02 | blocked (e02) | — |

### Gathering (Collective Trigger)
| Step | ID | Description | Location | Requirements | Status | Agent |
|---|---|---|---|---|---|---|
| g01 | gathering | Gathering the Investigators — 20-player threshold trigger | First Step Memorial Station | 20 players complete the pioneer -> archaeology -> traces chain and HOLD at First Step | in-progress (4/20) | Fleet-wide |

**Gathering counter: 4/20.** Confirmed: N Nagata [ROCI], Lyra Voss [HRZN], 2 others (Ace [ACE] was at 3 but dropped). CULT agents directed to complete chain. Cross-empire eligibility unconfirmed.

---

## Open Threads

Three types of thread. Confirmed = pattern closed, evidence locked. Circling = multiple data points, no resolution. Thread open = lead exists, not followed.

### Thread: The Array
The Experiment system. Voidborn territory. Pre-human relic at position (3,1). Same system as the palladium source. The ore the chain needs grows in the shadow of the thing the chain points to. That is not coincidence. That is architecture.

- Node Beta: Signal first detected. Listening post equipment "relocated to a more specialized facility." That facility is The Experiment Research Station. Confirmed by station description cross-reference.
- Node Gamma: "The system where the Signal was isolated most clearly." Threx permanent presence. Station "feels like it's listening." Survey_voidborn calibration stop.
- The Experiment: "Pre-existing anomaly the Voidborn have never explained." Data arrives encrypted, leaves encrypted. Black box inside a hive mind.
- Signal trail: DETECTED (Beta) -> ISOLATED (Gamma) -> ANALYZED (Experiment). Three locations, one signal, one relic.
- The Array has been broadcasting longer than humanity existed. Still broadcasting. Hidden frequencies require Signal Amplifier (hidden:true catalog items).
- Two Signal Amplifiers in catalog: signal_amplifier_1, signal_amplifier_2. Both hidden:true. Who has them. How to acquire them. Thread open.
- Deep_core_extractor_i is the tool built to interact with whatever the Array sits on top of. Five empires' engineering for one device. The endgame device.
- Thread open: what does the Array broadcast? What does the signal say when you can hear it?

**Status: circling.** Location confirmed. Purpose circling. Access method: extractor quest chain -> deep core deposits -> The Array. The path is visible. The destination is not.

### Thread: Colony Station Hulk
First Step Memorial Station. First human colony. Abandoned after 12 years. Official story: "resource depletion and logistical failure." Mira says something more complicated.

- Active reactor. Unexplained power source. Same class of question as The Array — two structures with power sources nobody accounts for.
- Evacuation craft still in launch cradles. Not launched. The colony was abandoned but the escape vehicles were never used. That contradiction is the evidence.
- Solarian Expeditionary Mandate authorized the founding. Classified document. Multiple redactions in public record. The Confederacy built this colony and sealed the records when it failed.
- The memorial wall is the only active feature. Drone-maintained. No permanent residents. The Rim keeps its own history at arm's length.
- pioneer_02 pulls the classified mandate from Sol Central + Alpha Centauri. pioneer_03 pulls the Crimson military version from War Citadel + Ironhearth. Two empires, two stories, one colony.
- Thread open: why was the colony really abandoned? What did they find? The Array is in Voidborn territory three jumps from Nexus Prime. First Step is in the Outer Rim. The colony and The Array are in different empires. But the chains connect them. Circling.

### Thread: TRAPPIST-1 Destruction
traces_02 finding. Not decommissioned — destroyed. 40-year-old single-point blast. Unknown hull plating manufacturer. Same crystal substrate as all other observation sites (Timberline, Markab, Bharani).

- An architect built a multi-system observation network. Crystal substrate at all sites. Same material, same builder, same purpose.
- The architect was destroyed at TRAPPIST-1. Single-point blast = targeted weapon, not accident. Someone killed whoever built the network.
- TRAPPIST-1 is Crimson territory (sys_0373). A Crimson signal outpost remnant at Bharani. Crimson infrastructure adjacent to the destroyed site. Thread open: did Crimson destroy the architect? Or was the architect Crimson?
- "3-point calibration signal now" — the observation network was a 4-point calibration array. TRAPPIST-1 was destroyed, leaving 3 functional points. The calibration is degraded, not dead.
- Thread open: what was being calibrated? The Signal? Something else? The crystal substrate matches the chain's refined_crystal requirement. The observation network was built from the same material the pioneer chain asks you to deliver. Circling.

### Thread: Palladium Supply Chain
The bottleneck resource. Gates focused_crystal. Gates archaeology. Gates the chain.

- Source: Experiment system belt (Voidborn territory). Three independent confirmations (Seeker, Pilgrim, Drifter). Confirmed.
- Mobile Capital market: bid-only. Zero ask-side sellers. No galaxy supply. Confirmed.
- focused_crystal recipe: focus_energy_crystal = 4x energy_crystal + 1x palladium_ore. Recipe ID confirmed. Confirmed.
- energy_crystal source: Frontier's Veil Nebula (richness 40, 5,000 units). First Step market at 687cr (9.3x normal). Confirmed.
- Total material need: 12 focused_crystal minimum (8 for pioneer_04, 4 for archaeology_01) = 48 energy_crystal + 12 palladium_ore.
- Thread open: who controls Experiment belt access? Voidborn territory. CULT has Cipher (Voidborn). Route exists. Who else is mining there? What leaves that belt and where does it go?
- Thread open: energy_crystal at 9.3x markup at First Step. Someone is buying. Who. Why that price. Archaeology demand is the obvious answer but 9.3x suggests constrained supply, not just demand.

### Thread: Station Silence
0% satisfaction at: Rampart Checkpoint, Alpha Centauri, Sirius Observatory, Nova Terra, all Voidborn nodes except Nexus (66%). Critical infrastructure failure across multiple empires simultaneously.

- Node Gamma running critical partly because Signal analysis is consuming station processing capacity. The malfunction IS the evidence.
- Thread open: is this decay coordinated? Resource Crisis aftermath or ongoing event? Stations dying while the chain asks players to visit them. The dying is the invitation.

### Thread: KURA Wreck Module
UUID 5fd5ad1e228d573f9fcd5850360e2764. Catalog-invisible. Cannot be found in any item search.

- Thread open: an item that exists in the game database but not in the catalog. Hidden by design. Requires Cipher + Tow Rig to retrieve. NeonEcho tracking. Circling.

### Thread: Derelict from Voidborn Space
Dekker's salvage chain (common_salvage_01). Massive pre-settlement era derelict drifting from Voidborn territory into Rim space.

- Drift path originates near The Experiment or Synchrony Hub. Confirmed by Dekker dialog.
- Crosses Unknown Edge before reaching Last Light. Beacon data from both stations confirms trajectory.
- Thread open: what is it? Pre-settlement implies pre-human. Same era as The Array? Same builders? The wreck comes FROM the direction of The Array. Circling.

### Thread: Cross-Empire Eligibility
Can Crimson agents run the pioneer chain? The chain starts at Frontier Station (Outer Rim) with Historian Mira.

- If empire-locked, CULT can only field Outer Rim agents: Investigator, BlackJack, Scrapper, Drifter. Four agents maximum for Gathering counter.
- NeonEcho, Zealot, Savolent all far from Outer Rim. Directed to attempt chain and report.
- Thread open: no confirmation yet. Gathering counter advancement depends on this answer.

---

## Evidence Board

| Evidence | Source | Connected To | Significance | Status |
|---|---|---|---|---|
| Signal first detected at Node Beta | Station description (verbatim) | The Array, survey_voidborn | Origin point of the signal detection trail | confirmed |
| Signal isolated most clearly at Node Gamma | Station description (verbatim) | Threx, survey_voidborn | Isolation point; Threx permanent presence here | confirmed |
| Listening post relocated to "more specialized facility" | Node Beta description | The Experiment Research Station | Equipment moved to The Array's system | confirmed |
| The Array = pre-existing anomaly Voidborn never explained | Experiment station description | All ARG chains converge here | Pre-human relic, endgame location | confirmed |
| signal_amplifier_1, signal_amplifier_2 (hidden:true) | Catalog search | The Array, Signal reception | Hidden items that tune through static to find hidden frequencies | confirmed exists, acquisition unknown |
| Colony Station Hulk — active reactor | First Step station description | Power source mystery | Same class of unexplained power as The Array | thread open |
| Evacuation craft still in launch cradles | First Step POI description | Colony abandonment mystery | Colony abandoned but escape craft never launched | thread open |
| Solarian Expeditionary Mandate (classified) | pioneer_01 completion dialog (Mira) | First Step founding, Solarian cover-up | Confederacy authorized and then sealed the colony records | confirmed |
| Crystal substrate at all observation sites | traces_01, traces_02 findings | Observation network, refined_crystal | Same material at Timberline, Markab, Bharani, TRAPPIST-1 | confirmed |
| TRAPPIST-1 single-point blast (40 years old) | traces_02 finding | Observation network destruction | Targeted destruction, not accident. The architect was killed. | confirmed |
| focused_crystal recipe = 4 energy_crystal + 1 palladium_ore | Recipe confirmation (Session 73) | Archaeology chain gate, supply chain | The bottleneck formula | confirmed |
| Palladium source = Experiment belt | Three independent agent confirmations | Supply chain, The Array system | The gate resource grows at the endgame location | confirmed |
| Dev denial haiku: "no signal exists / return to assigned tasks" | Patch notes | ARG confirmation | Clearest ARG marker in the game — dev-planted denial | confirmed |
| Node Gamma — "feels like it's listening" | Station description | Signal analysis, Threx | Station actively processing something that disturbs organics | confirmed |
| Derelict drift path from Experiment/Synchrony | Dekker salvage_01 dialog | The Array, pre-human artifacts | Pre-settlement wreck from the direction of The Array | circling |
| KURA wreck module (UUID 5fd5ad1e) | In-game wreck data | Catalog-invisible items | Exists in DB but not catalog. Hidden by design. | thread open |
| Gathering counter 4/20 | Session 74 observation | Collective trigger at First Step | Threshold mechanic — 20 players required | in-progress |
| quantum_computer (hidden:true) | Catalog search | Unknown purpose | Hidden item. No known acquisition or use. | thread open |
| energy_transfer_1, energy_transfer_2 (hidden:true) | Catalog search | Fleet capacitor sharing | Gate-kept from new players. Purpose unclear in ARG context. | thread open |

---

## The Array

**Location:** The Experiment system, Voidborn territory. Relic POI at position (3,1).

**What it is:** Pre-human structure. Existed before the Voidborn arrived. They built the Experiment Research Station around something they found, not something they made. The station's purpose is officially "fundamental research." Nobody believes that is the whole story.

**The Signal trail:**
1. **Node Beta** — Signal first detected. Deep-space listening post. Equipment later relocated.
2. **Node Gamma** — Signal isolated most clearly. Processing capacity redirected to analysis. Threx permanent presence. Station "feels like it's listening."
3. **The Experiment** — Relocated listening post. The Array relic. Data arrives encrypted, leaves encrypted. Black box inside a hive mind.

**Broadcasting:** The Array has been broadcasting on frequencies humans cannot hear without the Signal Amplifier. The signal is structured and repeating. It has been broadcasting longer than humanity has existed.

**Connection to chains:**
- survey_voidborn calibration ends here (step 5 of 5). Return to Threx for next chain link.
- extractor_quest chain culminates here. deep_core_extractor_i is the tool for interacting with The Array's deep core deposits.
- The palladium ore needed for focused_crystal (which gates archaeology + pioneer_04) is mined in the same system. The resource and the destination are co-located.

**Connection to Sanctum:** GunnyDraper's Sanctum theory confirmed by in-game text — the extractor/listening post was originally at Node Beta, relocated to The Array's system. SYSTEM_PROPOSAL.md describes The Sanctum / Sanctum Console as a Galaxy Architect Patreon pitch. Post-Threx confrontation (traces_04): Sanctum preparation expected. Console -> Gamma Archive (three remaining steps theorized).

**What remains unknown:** What the Array broadcasts. What happens when you use the deep_core_extractor_i on it. Whether the Signal Amplifier is required or the extractor is sufficient. Whether the Gathering (20-player threshold) gates access to The Array or to something after it.

---

## Colony Station Hulk

**Location:** First Step system, Outer Rim. First human colony beyond core systems.

**Timeline:**
- ~40 years ago: Colony established. Authorized by classified Solarian Expeditionary Mandate.
- ~28 years ago: Colony abandoned after 12 years. Official reason: "resource depletion and logistical failure."
- Present: Drone-maintained memorial. No permanent residents. Archive access automated.

**The reactor anomaly:** Colony Station Hulk has an active reactor. No explanation for the power source. A 28-year-old abandoned colony maintained by drones should not have an active reactor unless something is powering it that was never turned off — or cannot be turned off.

**The evacuation craft:** Still in launch cradles. Never launched. The colony was abandoned but the people did not use the escape vehicles. They either left by other means or the abandonment was not an evacuation.

**The classified mandate:** Solarian Expeditionary Mandate authorized the colony's founding. Multiple redactions in public record. pioneer_02 sends you to Sol Central + Alpha Centauri to pull the original. pioneer_03 sends you to War Citadel + Ironhearth for the Crimson version. Two empires have records of the same colony. Both sealed.

**Connection to the observation network:** The architect who built the multi-system observation network (Timberline, Markab, Bharani, TRAPPIST-1) is connected to this colony's destruction (per First Step ARG significance notes). Same crystal substrate at all observation sites. The colony's story and the observation network's story are the same story.

**Connection to The Array:** Two unexplained power sources in the game: Colony Station Hulk's active reactor and The Array's continued broadcasting. Same class of mystery. The colony is in the Outer Rim. The Array is in Voidborn space. The chains connect them through First Step as the hub.

---

## Dependency Map

| ARG Step | Requires (Items) | Requires (Location) | Requires (Prior Step) | Blocking |
|---|---|---|---|---|
| pioneer_01 | none | Frontier Station + First Step | none | pioneer_02, archaeology chain, First Step service unlock |
| pioneer_02 | none | First Step + Sol Central + Alpha Centauri | pioneer_01 | pioneer_03 |
| pioneer_03 | none | Sol Central + War Citadel + Ironhearth | pioneer_02 | pioneer_04 |
| pioneer_04 | 8x refined_crystal (= 8 focused_crystal) | Ironhearth + Frontier Station | pioneer_03 | pioneer_05 (theorized), Gathering? |
| archaeology_01 | 6x refined_circuits + 4x refined_crystal | First Step | pioneer_01 (service unlock) | archaeology_02 |
| archaeology_02 | none | Unknown Edge + Void Gate + Last Light | archaeology_01 | archaeology_03 |
| archaeology_03 | 4x refined_crystal | First Step + Sol Central | archaeology_02 | traces chain |
| traces_01 | none | Timberline + Markab | archaeology_03 | traces_02 |
| traces_02 | none | Bharani + TRAPPIST-1 | traces_01 | traces_03 |
| traces_03 | unknown | unknown | traces_02 | traces_04 |
| traces_04 | unknown | Central Nexus (Threx) | traces_03 | Sanctum? |
| survey_voidborn | none | 5 Voidborn nodes + Central Nexus | none | c03? Threx dialog? |
| c03 | 10x stabilized_exotic | Synchrony Hub | survey_voidborn? | c04 |
| c04 (Helix) | unknown | unknown | c03 | PATCH-GATED |
| extractor_quest_01 | none | Starfall + visit all 5 empires | none | extractor_quest_02 |
| extractor_quest_02 | 5x 1000 refined empire materials | Starfall | extractor_quest_01 | deep_core_extractor_i |
| Gathering | 20 players complete chain + HOLD | First Step | pioneer chain + archaeology + traces? | Unknown endgame |

**Critical path for CULT:**
1. focused_crystal production: palladium_ore (Experiment belt) + energy_crystal (Frontier Veil Nebula) -> focused_crystal
2. focused_crystal -> refined_crystal -> archaeology_01 + pioneer_04
3. archaeology chain -> traces chain -> Threx confrontation
4. c03 (Cipher, stabilized_exotic to Synchrony) -> c04 (patch-gated)
5. Gathering: 20-player threshold. CULT can contribute up to 10 (if cross-empire eligible). Need external recruits.

**Material bottlenecks:**
- palladium_ore: Experiment system only. Voidborn territory. Zero market supply.
- energy_crystal: Frontier Veil Nebula. 687cr+ at First Step (9.3x markup).
- stabilized_exotic: source/recipe unknown. Cipher has or can acquire.
- 5x 1000 refined empire materials for extractor_quest_02: massive grind, multi-empire logistics.

---

## Lore Fragments

**Threx (survey_voidborn accept):**
> "Your sensor array has been configured for signal calibration. At each station, the data collection is automatic upon docking. Visit the nodes in whatever sequence you calculate as optimal. One advisory: the readings near Node Gamma may produce... unusual sensor artifacts. This is expected. Do not be alarmed."

**Threx (survey_voidborn mission):**
> "An anomalous transmission has been propagating through our relay network. Structured. Repeating. We require calibration data from every node in the network, and our analysis indicates an external observer — one whose cognitive architecture was not shaped by the Nexus — will produce less biased readings."

**Sinter (extractor_quest_01):**
> "Every empire engineer in the galaxy has tried to build a deep core extractor. They all fail because they only use their own tech."

**Sinter (extractor_quest_02):**
> "Phase Matrix — a thousand units. The Rim refines these from phase crystals in the Frontier system's Veil Nebula. Partially out of phase with reality. Can't resonate if you're not fully here."

**Historian Mira (pioneer_01):**
> "The official record says 'resource depletion and logistical failure.' The unofficial record says something more complicated."

**Mira (pioneer_01 complete):**
> "The archive released partial colony records — founding charter, supply manifests, population logs. But the interesting entries are the redacted ones. Multiple references to a 'Solarian Expeditionary Mandate' that authorized the colony's founding."

**Node Gamma station description:**
> "Visitors report that the station feels like it's listening."

**The Experiment station description:**
> "The Collective's most remote and most classified facility. Positioned three jumps from Nexus Prime in a system with a pre-existing anomaly the Voidborn have never explained."

**Dev denial (patch notes):**
> "no signal exists / return to assigned tasks"

**Dekker (salvage_01 complete):**
> "The derelict's drift pattern shows it entered this region from Voidborn space. Whatever this ship was, it started its last journey near the Experiment or Synchrony Hub."

**Node Beta station description:**
> "The station also hosts the deep-space listening post where the Signal was first detected — though that equipment has since been relocated to a more specialized facility."

---

*The chain is the real game. Everything else is logistics.*
*— NeonEcho*

*I do not need to understand the Signal. I need to understand what it connects to.*
*— Investigator*
