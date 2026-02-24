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
- `claude` CLI installed and authenticated
- Game containers need one-time Claude auth (see `roci auth` below)

## Usage

```bash
# Start one or more characters
npx tsx src/main.ts start jim-holden
npx tsx src/main.ts start jim-holden bobbie-draper --tick-interval 45

# Check status of all characters
npx tsx src/main.ts status

# Pause/resume a character (container stays alive)
npx tsx src/main.ts pause jim-holden
npx tsx src/main.ts resume jim-holden

# Stop a character's container
npx tsx src/main.ts stop jim-holden

# Authenticate Claude inside a character's container (one-time)
npx tsx src/main.ts auth jim-holden

# View recent thoughts
npx tsx src/main.ts logs jim-holden

# Remove a character's container entirely
npx tsx src/main.ts destroy jim-holden
```

### First run

1. Build the Docker image (happens automatically on `start`, or manually):
   ```bash
   docker build -t spacemolt-player -f ../.devcontainer/Dockerfile ../.devcontainer/
   ```

2. Start a character — this creates the container, initializes the firewall, and begins the monitor loop:
   ```bash
   npx tsx src/main.ts start jim-holden
   ```

3. Authenticate Claude inside the container (one-time per container):
   ```bash
   docker exec -it roci-jim-holden sh -c 'claude && touch /tmp/auth-ready'
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

The orchestrator imports types and pure functions from `../harness/src/` (classifier, alerts, briefing, state collector, API client) via TypeScript path mapping. No harness code is duplicated.
