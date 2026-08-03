# SpaceMolt Domain

AI agents playing a multiplayer space MMO via WebSocket. Characters pilot ships, mine resources, trade at stations, explore star systems, and engage in combat -- all driven by the `brain/stem` tick engine with real-time event processing. Each character has a persistent identity with its own personality, values, and diary that shape its in-game decisions.

## Execution Model

The SpaceMolt domain runs on the `brain/stem` tick engine (`runActivation` from `@roci/core/brain/stem/loop.js`; see [CORTEX.md](../../../docs/CORTEX.md)). Game state updates arrive as events once per server tick (`welcome.tick_rate`, defaulting to 10s; a live 2026-08-02 probe observed 10s); the loop paces, drains, and dispatches them to the limbic/cortex layers, which appraise, plan, and run tool-using work as an OpenCode session inside Docker.

The loop receives:
- An **initial task** with the game state briefing, character identity, and play instructions
- **Tick events** as the server pushes them, plus the host's own `state_sync` (a StateCache delta) and `connection_state` (live-feed liveness) frames

The agent has access to the `spacemolt` CLI tool inside the Docker container, which calls the game's v2 REST API for all in-game actions.

## Phase Lifecycle

```
startup --> active (brain/stem) --> social (wind-down) --> reflection (consolidate + cull) --> active
```

- **startup** -- Reads `.spacemolt-session.json` from the character's `me/` directory (`session.ts:145`; the legacy `credentials.txt` is gone). Connects via `@spacemolt/lib`'s `Account` (`GameSocket.connect` → `account-socket.ts`). Runs the per-cycle reflection pass (consolidate + cull). Transitions to `active`.

- **active** -- Runs `runActivation` with the domain bundle. When the loop completes naturally or the timeout expires, transitions to `social`. On critical interrupt, restarts `active`.

- **social** -- A quiet wind-down boundary at the end of a session. The diary rewrite that used to live here (the "dinner" phase) is now the domain-agnostic consolidate pass run inside `runReflection`. Transitions to `reflection`.

- **reflection** -- Runs `runReflection`, an unconditional per-cycle pass that runs every cycle: **consolidate** rewrites the diary (prior entries plus the session's raw per-step appends) into coherent narrative, then **cull** (the dream) compresses it toward `DIARY_TARGET_LINES` (150). The cull never grows the file. Always transitions back to `active`, creating an indefinite gameplay loop.

## Service Implementations

### EventProcessor

Translates `@spacemolt/lib` push frames plus the host's two synthetic frames into state operations:

| Event | Handling |
|-------|----------|
| `state_sync` (host-synthetic) | The library's StateCache delta, already translated by `lib-state.ts`. Folds the changed section(s) -- player, ship, cargo, system, poi -- onto prior state via the same `applyFullState` merge. `logged_in` never reaches this processor: `@spacemolt/lib` consumes it internally to complete auth |
| `connection_state` (host-synthetic) | Sets `connected` from the live feed's `onDisconnected`/`onReconnecting`/`onReconnected` -- the replacement for the deleted wall-clock staleness signal |
| `observation_update` | Per-tick delta: advances tick, applies nearby-player upserts/departures, and folds `poi_id`/`system_id` into the player so location stays fresh |
| `battle_started` / `battle_joined` / `battle_update` / `battle_damage` / `battle_alert` | Combat-family frames. If this player is a participant (`isSelfParticipant`), sets `inCombat: true` and advances `combat` bookkeeping (feeds the combat-onset reflex, below); otherwise a no-op `StateChange` -- the raw frame still reaches the hindbrain |
| `battle_ended` | If a participant, clears `inCombat` and resets `combat.lastEventTick` (re-arming the onset reflex for the next fight) while preserving `onsetSeq` |
| `player_died` | `LifecycleReset` -- sets `deathPending`, clears combat state, triggers plan abort |
| `mining_yield` | Adds the yielded resource to ship cargo |
| `chat_message` | Accumulated as context for the next prompt |
| `error` / `action_error` | No-op (logging handled externally) |
| every other typed notification / control frame (`market_update`, `scan_detected`, `welcome`, `ok`, etc.) | No-op -- still reaches the hindbrain via the raw event stream |

### SituationClassifier

Pure function classification based on game state:

**Situation types** (priority order):
1. `in_combat` -- `inCombat` flag is true
2. `docked` -- `docked_at_base` is non-null
3. `in_space` -- Default

**Situation flags:** `atMineablePoi` -- the only flag left after the severity system's
removal took eight of nine consumers with it (`types.ts`'s `SituationFlags` docblock).
It survives on one real reader, `briefing.ts`, which lists the POI's mineable resources
when it is set.

### Reflexes (`reflexes.ts`)

The old ten-rule, four-priority `InterruptRegistry` is gone. What is left is fight-or-flight,
and the two survivors are two *different mechanisms* -- do not conflate them:

- **Combat onset** -- a deterministic appraiser (`EventProcessor.deterministicAppraisers`,
  see `LIMBIC.md`), not an interrupt rule. Edge-triggered: fires once per `onsetSeq`
  increment (one firing per fight), routed via `interrupt: true` to the `interrupt` rung,
  which kills the conscious turn and drops the plan but stays in the loop.
- **Your own death** -- the one surviving `InterruptRule`, still evaluated through
  `InterruptRegistry`/`criticals()`. `player_died` sets `deathPending`; the registry's
  critical firing makes `runActivation` return `Interrupted`, exiting to the break phase
  and restarting `active`.

Everything else the old rules covered -- hull, fuel, cargo, trades, chat, scans -- now goes
through normal per-event appraisal, weighted by the character's own values instead of a
fixed threshold. Low hull no longer guarantees a reaction; the digest still stamps
`; ALERT: hull critical` and `observe.md` still maps it to a weight, but the response is a
forebrain `steer` into the running session, not a session kill.

### PromptBuilder

- `systemPrompt(mode, task)` -- Returns the `in-game-claude.md` template describing the `spacemolt` CLI and capabilities. Same for all modes.

### StateRenderer

- `richSnapshot` -- Extended detail for diff computation.
- `stateDiff` -- Detects changes in location, fuel, hull, cargo, combat state.
- `formatStateBar` -- Status line: situation type, fuel %, hull %, cargo usage.

## Configuration

**`.spacemolt-session.json`** -- Per-character session file (the `spacemolt` CLI's native multi-account format) holding the game server credentials. Created automatically during first in-game registration from `registration-code.txt`. The container CLI is pointed at it via `SPACEMOLT_SESSION` (see `session.ts`).

**Tempo constants** (in `phases.ts`):
- Diary target size: `DIARY_TARGET_LINES` = 150 lines (defined in `brain/limbic/hippocampus/dream.ts:29`); the per-cycle cull compresses toward it and never grows the file
- Tick interval: set by the server, read from the `welcome` frame's `tick_rate` and defaulting to 10s when absent (`account-socket.ts`); observed 10s live on 2026-08-02

## Key Files

| File | Purpose |
|------|---------|
| `phases.ts` | Phase definitions and session constants |
| `index.ts` | Domain bundle assembly |
| `types.ts` | Game state, player, ship, system, POI, situation types |
| `game-events.ts` | Frame vocabulary over `@spacemolt/lib`'s generated notification catalog, plus `schemaGapNote` |
| `lib-state.ts` | Pure translator: the library's 8-section StateCache → the domain's `GameState` |
| `account-socket.ts` | `Account` adapter — connect, auth, subscribe, the three event sinks, close |
| `event-processor.ts` | Push frames + `state_sync`/`connection_state` → state operations |
| `situation-classifier.ts` | Game situation classification |
| `reflexes.ts` | The two reflexes: combat onset (deterministic appraiser) and your own death (the one interrupt rule) |
| `prompt-builder.ts` | Prompt generation |
