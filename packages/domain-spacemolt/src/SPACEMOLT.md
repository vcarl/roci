# SpaceMolt Domain

AI agents playing a multiplayer space MMO via WebSocket. Characters pilot ships, mine resources, trade at stations, explore star systems, and engage in combat -- all driven by the cortex loop with real-time event processing. Each character has a persistent identity with its own personality, values, and diary that shape its in-game decisions.

## Execution Model

The SpaceMolt domain runs on the cortex loop (`runCortex` from `@roci/core/cortex/loop.js`; see [CORTEX.md](../../../docs/CORTEX.md)). Game state updates arrive as events every 30 seconds; the loop appraises them, plans, and runs tool-using work as an OpenCode session inside Docker.

The loop receives:
- An **initial task** with the game state briefing, character identity, and play instructions
- **Tick events** every 30 seconds with state diffs, situation summaries, and soft alerts
- **Alert events** immediately when combat or critical conditions are detected

The agent has access to the `spacemolt` CLI tool inside the Docker container, which calls the game's v2 REST API for all in-game actions.

## Phase Lifecycle

```
startup --> active (cortex loop) --> social (wind-down) --> reflection (consolidate + cull) --> active
```

- **startup** -- Reads `credentials.txt` from the character's `me/` directory. Connects to the game server via WebSocket (`GameSocket.connect`). Runs the per-cycle reflection pass (consolidate + cull). Transitions to `active`.

- **active** -- Runs `runCortex` with the domain bundle. When the loop completes naturally or the timeout expires, transitions to `social`. On critical interrupt, restarts `active`.

- **social** -- A quiet wind-down boundary at the end of a session. The diary rewrite that used to live here (the "dinner" phase) is now the domain-agnostic consolidate pass run inside `runReflection`. Transitions to `reflection`.

- **reflection** -- Runs `runReflection`, an unconditional per-cycle pass that runs every cycle: **consolidate** rewrites the diary (prior entries plus the session's raw per-step appends) into coherent narrative, then **cull** (the dream) compresses it toward `DIARY_TARGET_LINES` (150). The cull never grows the file. Always transitions back to `active`, creating an indefinite gameplay loop.

## Service Implementations

### EventProcessor

Translates `@spacemolt/client-v2` `GameEvent`s into state operations:

| Event | Handling |
|-------|----------|
| `logged_in` | Initial full state on login/reconnect: player, ship, system, poi, cargo |
| `observation_update` | Per-tick delta: advances tick counter, applies nearby-player upserts/departures |
| `combat_update` | Sets `inCombat` flag, advances tick, emits a combat alert |
| `mining_yield` | Adds the yielded resource to ship cargo |
| `player_died` | `LifecycleReset` -- triggers plan abort and state reset |
| `chat_message` | Accumulated as context for the next prompt |
| `scan_detected` | Emits a "you were scanned" alert |
| acks / informational frames (`welcome`, `ok`, `market_update`, etc.) | No-op -- still reach the hindbrain via the raw event stream |

### SituationClassifier

Pure function classification based on game state:

**Situation types** (priority order):
1. `in_combat` -- `inCombat` flag is true
2. `in_transit` -- `travelProgress` is non-null
3. `docked` -- `docked_at_base` is non-null
4. `in_space` -- Default

**Situation flags:** `atMineablePoi`, `atDockablePoi`, `lowFuel`, `cargoNearlyFull`, `cargoFull`, `lowHull`, `hasUnreadChat`, `hasCompletableMission`.

### InterruptRegistry

Nine interrupt rules across four priority levels:

| Rule | Priority | Trigger |
|------|----------|---------|
| `in_combat` | critical | In combat (suppressed when task is `combat`) |
| `hull_critical` | critical | Hull below 20% |
| `fuel_low_undocked` | high | Low fuel while not docked |
| `hull_low_undocked` | high | Low hull while not docked |
| `cargo_full` | medium | Cargo at capacity |
| `pending_trades` | medium | Pending trade offers |
| `completable_mission` | medium | Mission ready to turn in |
| `cargo_nearly_full` | low | Cargo above 90% |
| `unread_chat` | low | New chat messages |

### PromptBuilder

- `systemPrompt(mode, task)` -- Returns the `in-game-claude.md` template describing the `spacemolt` CLI and capabilities. Same for all modes.

### StateRenderer

- `richSnapshot` -- Extended detail for diff computation.
- `stateDiff` -- Detects changes in location, fuel, hull, cargo, combat state.
- `formatStateBar` -- Status line: situation type, fuel %, hull %, cargo usage.

## Configuration

**`.spacemolt-session.json`** -- Per-character session file (the `spacemolt` CLI's native multi-account format) holding the game server credentials. Created automatically during first in-game registration from `registration-code.txt`. The container CLI is pointed at it via `SPACEMOLT_SESSION` (see `session.ts`).

**Tempo constants** (in `phases.ts`):
- Diary target size: `DIARY_TARGET_LINES` = 150 lines (defined in `core/limbic/hippocampus/dream.ts:16`); the per-cycle cull compresses toward it and never grows the file
- Tick interval: 30 seconds (set by server)

## Key Files

| File | Purpose |
|------|---------|
| `phases.ts` | Phase definitions and session constants |
| `index.ts` | Domain bundle assembly |
| `types.ts` | Game state, player, ship, system, POI, situation types |
| `ws-types.ts` | WebSocket event type definitions |
| `game-socket-impl.ts` | WebSocket connection, login, event dispatching |
| `event-processor.ts` | WebSocket event to state translation |
| `situation-classifier.ts` | Game situation classification |
| `interrupts.ts` | Interrupt rules |
| `prompt-builder.ts` | Prompt generation |
| `session-system-prompt.md` | System prompt for the persistent session |
