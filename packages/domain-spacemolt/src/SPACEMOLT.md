# SpaceMolt Domain

AI agents playing a multiplayer space MMO via WebSocket. Characters pilot ships, mine resources, trade at stations, explore star systems, and engage in combat -- all driven by a persistent channel session with real-time event processing. Each character has a persistent identity with its own personality, values, and diary that shape its in-game decisions.

## Execution Model

The SpaceMolt domain uses a persistent channel session (`runChannelSession` from `core/orchestrator/channel-session.ts`). The orchestrator spawns a `claude --channels` process in Docker and pushes game state updates every 30 seconds.

The session receives:
- An **initial task** with the game state briefing, character identity, and play instructions
- **Tick events** every 30 seconds with state diffs, situation summaries, and soft alerts
- **Alert events** immediately when combat or critical conditions are detected

The agent has access to the `spacemolt` CLI tool inside the Docker container, which calls the game's v2 REST API for all in-game actions.

## Phase Lifecycle

```
startup --> active (channel session) --> social (dinner) --> reflection (dream) --> active
```

- **startup** -- Reads `credentials.txt` from the character's `me/` directory. Connects to the game server via WebSocket (`GameSocket.connect`). Runs diary compression if the diary exceeds 200 lines. Transitions to `active`.

- **active** -- Runs `runChannelSession` with the domain bundle. When the session completes naturally or the timeout expires, transitions to `social`. On critical interrupt, restarts `active`.

- **social** -- The "dinner" phase. Runs `dinner.execute()`, which provides a social reflection opportunity for the character. Transitions to `reflection`.

- **reflection** -- Runs `runReflection` to compress the diary if it exceeds 200 lines. Always transitions back to `active`, creating an indefinite gameplay loop.

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

Implements the three-method interface:

- `systemPrompt(mode, task)` -- Returns the `in-game-claude.md` template describing the `spacemolt` CLI and capabilities. Same for all modes.
- `taskPrompt(ctx)` -- Game state briefing, character identity, and play instructions.
- `channelEvent(ctx)` -- State update with situation summary, diff, and alerts.

### StateRenderer

- `snapshot` -- Compact: situation type, location, fuel/hull ratios, cargo, combat flag.
- `richSnapshot` -- Extended detail for diff computation.
- `stateDiff` -- Detects changes in location, fuel, hull, cargo, combat state.
- `formatStateBar` -- Status line: situation type, fuel %, hull %, cargo usage.

### SkillRegistry

Stub implementation. All step completion evaluation falls through to the LLM.

## Configuration

**`.spacemolt-session.json`** -- Per-character session file (the `spacemolt` CLI's native multi-account format) holding the game server credentials. Created automatically during first in-game registration from `registration-code.txt`. The container CLI is pointed at it via `SPACEMOLT_SESSION` (see `session.ts`).

**Tempo constants** (in `phases.ts`):
- Diary compression threshold: 200 lines
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
| `dinner.ts` | Social/dinner phase |
