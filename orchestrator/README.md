# Roci Orchestrator

Brain + subagent architecture for the Rocinante crew. Replaces the monolithic `play.sh` session loop with an Effect-TS orchestrator that continuously monitors game state, invokes Opus for strategic planning, and delegates narrow tasks to cheap subagents running in Docker containers.

## Architecture

```
Orchestrator (host, Effect-TS)
  └── Per character (one Fiber each):
      ├── Monitor (every tick)
      │   ├── Poll game API → GameState
      │   ├── Classify situation, detect alerts
      │   ├── Check: plan on track? danger? plan exhausted?
      │   └── Invoke brain when needed
      │
      ├── Brain (Opus, on-demand)
      │   ├── Planning: "Here's the state. Plan the next N steps."
      │   │   → Returns structured Plan (JSON)
      │   └── Interrupt: "DANGER — combat detected. React now."
      │       → Returns revised Plan
      │
      └── Subagent (one at a time, in Docker)
          ├── Narrow goal: "Mine until cargo 90% full"
          ├── Model: Haiku for routine, Sonnet for judgment
          ├── Interruptible via Fiber.interrupt
          └── Output demuxed into structured logs
```

### How it works

1. **Monitor tick loop** runs every N seconds (default 30). It polls the game API, classifies the situation using the existing harness code (classifier, alerts), and decides what to do.

2. **Brain** is an on-demand Opus call — not a long-running session. When the monitor needs a plan (first start, plan exhausted, conditions changed), it sends game state + diary + character background to Opus, which returns a structured `Plan` with concrete steps.

3. **Subagents** execute one plan step at a time inside the character's Docker container. Each gets a narrow prompt (e.g., "mine at this POI until cargo 90% full"), the appropriate model (Haiku/Sonnet), and runs until done, timed out, or interrupted.

4. **Interrupts** — if a critical alert fires (combat, hull <20%), the monitor kills the active subagent and asks the brain for a revised plan.

### Plan — the intermediate representation

```
Plan {
  steps: PlanStep[]     // sequence of tasks
  reasoning: string     // Opus's strategic thinking
}

PlanStep {
  task: string              // "mine", "travel", "sell", "dock", etc.
  goal: string              // NL goal for the subagent
  model: "haiku" | "sonnet" // appropriate model
  successCondition: string  // checked against game state each tick
  timeoutTicks: number      // max ticks before re-evaluating
}
```

### Logging — three JSONL streams

Each character gets three log files in `players/<character>/logs/`:

- **thoughts.jsonl** — internal reasoning (subagent text, brain plans, dream output, monitor observations)
- **words.jsonl** — social actions (chat messages sent, forum posts)
- **actions.jsonl** — game actions (all `sm` commands, tool calls, state transitions, lifecycle events)

## Setup

```bash
cd orchestrator
npm install
```

Requires:
- Node.js 20+
- Docker
- `claude` CLI installed on the host

### Authentication

The orchestrator authenticates subagents using `CLAUDE_CODE_OAUTH_TOKEN`, read from `.env` at the project root. This token is passed to the container at exec time (not baked in), so you can rotate it without recreating the container.

1. Generate a token:
   ```bash
   claude setup-token
   ```

2. Create `.env` in the project root:
   ```
   CLAUDE_CODE_OAUTH_TOKEN=<token from above>
   ```

The `.env` file is gitignored. If the token expires, update `.env` and restart the orchestrator.

## Usage

```bash
# Start one or more characters
./roci start jim-holden
./roci start jim-holden bobbie-draper --tick-interval 45

# Check container status
./roci status

# Pause/resume the shared container
./roci pause
./roci resume

# Stop the shared container
./roci stop

# View recent thoughts for a character
./roci logs jim-holden

# Remove the shared container entirely
./roci destroy
```

### First run

1. Build the Docker image (happens automatically on `start`, or manually):
   ```bash
   docker build -t spacemolt-player -f .devcontainer/Dockerfile .devcontainer/
   ```

2. Set up `.env` with your Claude auth token (see Authentication above).

3. Start a character — this creates the shared `roci-crew` container, initializes the firewall, and begins the monitor loop:
   ```bash
   ./roci start jim-holden
   ```

4. The orchestrator logs in to the game API, optionally compresses the diary (dream), then starts polling game state and invoking the brain for plans.

## Effect services

| Service | What it does |
|---------|-------------|
| `Docker` | Container lifecycle — build, create, exec, execStream, pause, resume, stop, status |
| `Claude` | LLM invocation — host-side `claude -p` for brain, `docker exec claude -p` for subagents |
| `GameApi` | Wraps existing `SpaceMoltAPI` + `collectGameState` + classifier + alerts + briefing |
| `CharacterFs` | Character file I/O — diary, secrets, credentials, background, values |
| `PromptTemplates` | Load prompt templates from `.devcontainer/` |
| `CharacterLog` | Structured JSONL writer for the three log streams |

All services use `Context.Tag` for dependency injection and `Layer` for providing implementations.

## AI functions

| Function | Model | When | What it does |
|----------|-------|------|-------------|
| `brain.plan` | Opus | Plan exhausted or first wake | Produces a Plan from game state + diary |
| `brain.interrupt` | Opus | Critical alert detected | Revises the plan for immediate danger |
| `dream` | Opus | Diary exceeds size threshold | Compresses diary and secrets between active periods |
| `dinner` | Opus | After meaningful work completes | Post-session diary reflection |
| `subagent` | Haiku/Sonnet | Each plan step | Executes a narrow task in the container |

## Project layout

```
orchestrator/src/
├── main.ts                    # Entry point
├── cli.ts                     # CLI commands
├── services/                  # Effect service layers
├── ai/                        # AI functions (brain, subagent, dream, dinner)
├── monitor/                   # Tick loop, interrupt detection, plan tracking
├── pipeline/                  # Character loop, multi-character orchestrator
└── logging/                   # JSONL writers, stream-json demux, console output
```

Game types, API client, situation classifiers, and briefing generators live in `src/game/`.
