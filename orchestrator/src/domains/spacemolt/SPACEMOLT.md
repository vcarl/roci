# SpaceMolt Domain

AI agents playing a multiplayer space MMO via WebSocket. Characters pilot ships, mine resources, trade at stations, explore star systems, and engage in combat -- all driven by a plan/act/evaluate state machine loop. Each character has a persistent identity with its own personality, values, and diary that shape its in-game decisions.

## Execution Model

The SpaceMolt domain uses the **state machine** execution model (`runStateMachine` from `core/orchestrator/state-machine.ts`). Each turn follows a three-phase cycle:

1. **Plan** (Opus) -- Receives a structured briefing of current game state (location, ship status, nearby players, market data). Produces a multi-step plan as a JSON array of steps, each with a task type, goal, success condition, and tick budget.

2. **Act** (Haiku or Sonnet) -- Executes each step in sequence. Runs inside the Docker container with access to the `sm` CLI tool, which wraps the game's WebSocket API. Operates under a per-step tick budget; the orchestrator monitors for timeout.

3. **Evaluate** (Opus) -- After each step completes (or times out), assesses whether the step succeeded by examining the subagent's report, state diff, and deterministic condition checks. Decides whether to continue with the next step, retry, or replan.

Interrupts can fire between steps. Critical interrupts (combat, hull critical) abort the current plan and force an immediate replan. Soft alerts accumulate and feed into the next planning prompt.

## Phase Lifecycle

```
startup --> active (100 turns) --> social (dinner) --> reflection (dream) --> active (loop)
```

- **startup** -- Reads `credentials.txt` from the character's `me/` directory. Connects to the game server via WebSocket (`GameSocket.connect`). Runs diary compression if the diary exceeds 200 lines. Transitions to `active`.

- **active** -- Runs `runStateMachine` for 100 turns (approximately 50 minutes at 30 seconds per tick). The state machine drains events from the WebSocket, updates game state, classifies the situation, checks interrupt rules, and orchestrates plan/act/evaluate cycles. On exit, transitions to `social`.

- **social** -- The "dinner" phase. Runs `dinner.execute()`, which provides a social reflection opportunity for the character. On completion (or failure, which is caught and logged), transitions to `reflection`.

- **reflection** -- Runs `runReflection` to compress the diary if it exceeds 200 lines. Always transitions back to `active`, creating an indefinite gameplay loop.

## Service Implementations

### EventProcessor

Translates raw WebSocket `GameEvent`s into state machine operations:

| Event | Handling |
|-------|----------|
| `state_update` | Full state merge: player, ship, nearby players, combat flag, travel progress, tick |
| `tick` | Heartbeat -- advances tick counter |
| `combat_update` | Informational logging only; the `inCombat` flag is set by the subsequent `state_update` |
| `player_died` | `LifecycleReset` category -- triggers plan abort and state reset |
| `chat_message` | Accumulated as context (`chatMessages`) for the next planning prompt |
| `error` | Logged externally |
| `welcome`, `logged_in` | Connection lifecycle -- handled by GameSocket, no state machine action |
| `mining_yield`, `poi_arrival`, `poi_departure`, `skill_level_up`, `trade_offer_received`, `ok` | Suppressed -- available in raw WS event logs but not processed |

### SituationClassifier

Pure function classification based on current game state. Produces a `Situation` with a type and flags:

**Situation types** (checked in priority order):
1. `in_combat` -- `inCombat` flag is true
2. `in_transit` -- `travelProgress` is non-null
3. `docked` -- `docked_at_base` is non-null
4. `in_space` -- Default (not docked, not traveling, not fighting)

**Situation flags** (derived from ship/game state):
- `atMineablePoi` -- Current POI is asteroid belt, ice field, or gas cloud
- `atDockablePoi` -- Current POI has a base
- `lowFuel` -- Fuel below 25%
- `cargoNearlyFull` -- Cargo above 90% capacity
- `cargoFull` -- Cargo at 100% capacity
- `lowHull` -- Hull below 50%
- `hasPendingTrades` -- Currently always false (reserved)
- `hasUnreadChat` -- Chat message notifications present
- `hasCompletableMission` -- An active mission has `completed` or `ready` status

The classifier also generates a briefing string (via `briefing.ts`) summarizing location, credits, fuel, hull, cargo, and nearby players.

### InterruptRegistry

Nine interrupt rules across four priority levels:

| Rule | Priority | Trigger |
|------|----------|---------|
| `in_combat` | critical | Situation type is `in_combat` (suppressed when task is `combat`) |
| `hull_critical` | critical | Hull below 20% |
| `fuel_low_undocked` | high | Low fuel while not docked |
| `hull_low_undocked` | high | Low hull (20-50%) while not docked |
| `cargo_full` | medium | Cargo hold at capacity |
| `pending_trades` | medium | Pending trade offers to review |
| `completable_mission` | medium | A mission is ready to turn in |
| `cargo_nearly_full` | low | Cargo above 90% but not full |
| `unread_chat` | low | New chat messages |
| `fuel_low_docked` | low | Low fuel while docked (reminder to refuel before undocking) |

Critical interrupts (`in_combat`, `hull_critical`) abort the current plan and force immediate replanning.

### PromptBuilder

Template-based prompt generation. Templates are loaded from the `prompts/` directory at startup:

- `planPrompt` -- Renders the `plan.md` template with game state briefing, character identity (background, values, diary), failure history, recent chat messages, step timing history, and available task types (`mine|travel|sell|dock|undock|refuel|repair|combat|chat|explore`).
- `interruptPrompt` -- Renders the `interrupt.md` template with alert details, current plan summary, state briefing, and character background.
- `evaluatePrompt` -- Renders the `evaluate.md` template with step goal, subagent report, state diff, state snapshot, timing data, and condition check results.
- `subagentPrompt` -- Renders the `subagent.md` template with task details, game state summary, personality, values, tick budget, and `sm` CLI documentation reference.
- `systemPrompt` -- Returns the `in-game-claude.md` template, which describes the `sm` CLI and in-game capabilities. Same for all modes and tasks.
- `brainPrompt` -- Not implemented (throws). SpaceMolt uses the state machine model, not the hypervisor.

### StateRenderer

- `snapshot` -- Compact game state: situation type, location, fuel/hull ratios, cargo, combat flag, tick.
- `richSnapshot` -- Extended snapshot with additional detail for diff computation.
- `stateDiff` -- Compares before/after snapshots to detect meaningful changes (location, fuel, hull, cargo, combat state, etc.).
- `logStateBar` -- Writes a compact status line to stderr with situation type, combat flag, fuel percentage, hull percentage, and cargo usage.

### SkillRegistry

Stub implementation. Returns an empty skill list. `isStepComplete` always returns incomplete with the message "No deterministic check -- use your judgment based on state changes." All step completion evaluation falls through to the LLM evaluator (Opus).

## Data Model

**`GameState`** -- Top-level aggregate: player info, ship state, current POI, current system, cargo, nearby players, notifications, travel progress, combat flag, tick, timestamp. Optional fields for market data, missions, active missions, orders, and storage.

**`PlayerState`** -- Username, empire, credits, current system/POI/ship, home base, docked status, faction, status message, clan tag, cloaking, skills, XP, stats.

**`ShipState`** -- Ship class, name, hull/shield/armor/speed/fuel (current and max), cargo (used and capacity), CPU/power usage, weapon/defense/utility slots, modules, cargo items, active buffs, disruption ticks.

**`Situation`** -- Situation type enum (`docked`, `in_space`, `in_transit`, `in_combat`) plus `SituationFlags` struct.

**`GameEvent`** (in `ws-types.ts`) -- Discriminated union of all WebSocket events: `welcome`, `logged_in`, `state_update`, `tick`, `combat_update`, `player_died`, `chat_message`, `mining_yield`, `poi_arrival`, `poi_departure`, `skill_level_up`, `trade_offer_received`, `error`, `ok`.

## Configuration

**`credentials.txt`** -- Per-character file in the `me/` directory containing game server login credentials (username and password).

**Tempo constants** (in `phases.ts`):
- Active session turns: 100 (approximately 50 minutes at 30s/tick)
- Diary compression threshold: 200 lines
- Tick interval: 30 seconds (set by server via `tick_rate` in the welcome event)

**Environment:** Characters operate inside a shared Docker container. The `sm` CLI tool is available on `PATH` for all game commands. Run `sm --help` or `sm commands` for the full command reference.

## Key Files

| File | Purpose |
|------|---------|
| `phases.ts` | Phase definitions (startup, active, social, reflection) and session constants |
| `index.ts` | Domain bundle assembly and stub skill registry |
| `types.ts` | All domain types: game state, player, ship, system, POI, situation, social |
| `ws-types.ts` | WebSocket event type definitions (server-to-client messages) |
| `game-socket.ts` | GameSocket service tag and interface |
| `game-socket-impl.ts` | WebSocket connection implementation, login flow, event dispatching |
| `event-processor.ts` | Translates WebSocket events into state machine operations |
| `situation-classifier.ts` | Pure function situation classification (type + flags) |
| `situation.ts` | SituationClassifier service layer (wraps classifier + briefing) |
| `briefing.ts` | Generates human-readable game state briefings |
| `interrupts.ts` | Nine interrupt rules across four priority levels |
| `prompt-builder.ts` | Template-based prompt generation for all prompt types |
| `renderer.ts` | StateRenderer service layer (delegates to state-renderer.ts) |
| `state-renderer.ts` | Snapshot, rich snapshot, and diff computation |
| `dinner.ts` | Social/dinner phase implementation |
| `prompts/` | Prompt templates (plan, interrupt, evaluate, subagent, in-game-claude) |
| `config.ts` | Domain configuration utilities |
