# Agent Harness

The harness runs autonomous SpaceMolt game sessions inside a shared Docker container, using Claude Code as the agent runtime. An orchestrator on the host manages the game loop: connect via WebSocket, plan with a brain LLM, dispatch subagents into the container, and capture all output.

## Architecture

```
cli.ts
 └─ runOrchestrator(configs[])                      pipeline/orchestrator.ts
     ├─ ensureSharedContainer()                      Start/reuse Docker container
     └─ for each character: fork characterLoop()     pipeline/character-loop.ts
         ├─ gameSocket.connect(creds)                WS connection → Queue<GameEvent>
         ├─ dream() (if diary > 200 lines)           Compress diary via LLM
         └─ eventLoop(config)                        monitor/event-loop.ts (thin wrapper)
             ├─ new SpaceMoltAdapter()                domains/spacemolt/adapter.ts
             ├─ new SpaceMoltEventProcessor()         domains/spacemolt/event-processor.ts
             └─ runStateMachine(config)               core/state-machine.ts
                 ├─ initial planning + spawn
                 └─ { event loop }
```

### { event loop }

Runs forever, one iteration per event from the WS queue.

```
Queue.take(event)
 │
 ▼
eventProcessor.processEvent(event, state) → EventResult
 ├─ apply stateUpdate to gameStateRef
 ├─ update tickCountRef
 ├─ run log side effect
 ├─ accumulate chat/combat context
 │
 ▼
dispatch on result flags:
 ├─ isReset ─────► handleReset: kill subagent, clear plan
 ├─ isInterrupt ─► { handle interrupt }
 └─ isTick/isStateUpdate ─► { handle heartbeat }
```

### { handle interrupt }

```
killSubagent
 └─ brainInterrupt.execute()
     └─ adapter.interruptUserPrompt() → LLM → new Plan
```

### { handle heartbeat }

Runs on both tick and state_update events.

```
adapter.detectInterrupts()
 ├─ if criticals → { handle interrupt }
 │
checkMidRun()
 └─ adapter.isStepComplete() (deterministic matchers)
     ├─ complete → kill fiber, step++
     └─ timeout exceeded → kill fiber, step++
 │
poll subagent fiber
 ├─ if done → { evaluate completed subagent }
 │
{ maybe request plan }
 └─ { maybe spawn subagent }
```

### { evaluate completed subagent }

```
Build diff: adapter.richSnapshot() before vs after
Run adapter.isStepComplete()
 ├─ deterministic PASS → skip LLM, step++, record outcome, return
 └─ no match / FAIL →
     brainEvaluate.execute()
      └─ adapter.evaluateUserPrompt() → LLM → {complete, reason}
          ├─ complete → step++
          └─ failed → clear plan, set previousFailure
```

### { maybe request plan }

Only runs if no plan and no subagent.

```
Read diary, background, values
brainPlan.execute()
 └─ adapter.planUserPrompt()
     (includes stepTimingHistory with outcomes + diffs)
     → LLM → Plan{steps[]}
```

### { maybe spawn subagent }

Only runs if plan exists and no fiber running.

```
Save spawnStateRef (rich snapshot)
runGenericSubagent()                              core/subagent.ts
 └─ adapter.subagentPrompt()
     → claude.execInContainer()
         → Docker exec → Claude Code in shared container
     → fork as Fiber, streams output back
```

## System Layers

- **`pipeline/`** — SpaceMolt-specific wiring (Docker, WS, diary compression)
- **`core/`** — Domain-agnostic plan/act/evaluate loop (`DomainAdapter<S,Sit>`)
- **`domains/spacemolt/`** — SpaceMolt adapter implementation (prompts, step matchers, state rendering)

Note: `core/agent-loop.ts` and `core/orchestrator.ts` exist as generic versions of `pipeline/character-loop.ts` and `pipeline/orchestrator.ts` but aren't wired in yet.

## Sequence Diagram: Subagent Execution

```
  Orchestrator          Docker Container          Log Files        Console
  (host)                (roci-crew)
  │                     │                         │                │
  │ docker exec -i      │                         │                │
  │ -e OAUTH_TOKEN=...  │                         │                │
  │────────────────────►│                         │                │
  │  stdin: prompt      │                         │                │
  │                     │ run-step.sh             │                │
  │                     │ cd /work/players/<name> │                │
  │                     │ claude -p --stream-json │                │
  │                     │         │               │                │
  │                     │         │ $ sm status   │                │
  │                     │         │─────────► …   │                │
  │                     │         │◄───────── …   │                │
  │                     │         │ $ sm market   │                │
  │                     │         │─────────► …   │                │
  │                     │         │◄───────── …   │                │
  │                     │         │ $ sm market …│                │
  │                     │         │─────────► …   │                │
  │                     │         │◄───────── …   │                │
  │                     │         │               │                │
  │◄════════════════════╡ stdout: stream-json lines                │
  │  (each line)        │         │               │                │
  │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ►│                │
  │  log.raw(line)      │         │       stream.jsonl (verbatim)  │
  │                     │         │               │                │
  │  parseStreamJson(line)        │               │                │
  │  ├─ ok ──► demuxEvent         │               │                │
  │  │   │─ assistant:text ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ► │
  │  │   │                        │               │  [name:assistant:text]
  │  │   │─ assistant:tool_use ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ► │
  │  │   │                        │               │  [name:assistant:tool_use]
  │  │   │─ user:tool_result ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─► │
  │  │   │                        │               │  [name:user:tool_result]
  │  │   └─ result ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ► │
  │  │                            │               │  [name:result] |
  │  └─ parse fail ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ► │
  │                               │               │  [name:raw]    |
  │                               │               │                │
  │◄════════════════════╡ stream ends             │                │
  │                     │         │               │                │
  │  waitForExit        │         │               │                │
  │  ├─ join stderr fiber         │               │                │
  │  ├─ get exit code   │         │               │                │
  │  │                  │         │               │                │
  │  ├─ exitCode != 0 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ►│
  │  │   fail with ClaudeError    │               │  [name:stderr]
  │  │                  │         │               │  [name:error]
  │  └─ exitCode == 0   │         │               │                │
  │     return text     │         │               │                │
  │                     │         │               │                │
```

## Container Layout

Single shared container `roci-crew`, all characters isolated via `--add-dir`.

**Volume mounts:**

| Host Path | Container Path | Access |
|-----------|---------------|--------|
| `players/` | `/work/players` | RW |
| `shared-resources/workspace/` | `/work/shared/workspace` | RW |
| `shared-resources/spacemolt-docs/` | `/work/shared/spacemolt-docs` | RW |
| `docs/` | `/work/shared/docs` | RW |
| `shared-resources/sm-cli/` | `/work/sm-cli` | RW |
| `.claude/` | `/work/.claude` | RO |
| `.devcontainer/` | `/opt/devcontainer` | RO |
| `harness/` | `/opt/harness` | RO |
| `scripts/` | `/opt/scripts` | RO |

**What the subagent sees** (via `--add-dir` in `run-step.sh`):

| Path | Purpose |
|------|---------|
| `/work/players/<name>/` | CWD — credentials, background, diary, secrets, values |
| `/work/shared/` | Shared workspace, game docs |
| `/work/sm-cli/` | sm CLI source |

**What the subagent doesn't see:**

| Path | Purpose |
|------|---------|
| `/opt/scripts/` | run-step.sh |
| `/opt/harness/` | TypeScript sensing harness |
| `/opt/devcontainer/` | Dockerfile, firewall script |

## Log Files

Per character at `players/<name>/logs/`:

| File | Contents | Written by |
|------|----------|-----------|
| `stream.jsonl` | Every raw stdout line, verbatim | `log.raw()` |
| `thoughts.jsonl` | Assistant text blocks (LLM thinking) | `log.thought()` |
| `actions.jsonl` | Tool use, tool results, subagent lifecycle | `log.action()` |
| `words.jsonl` | sm chat/forum commands (social actions) | `log.word()` |

## Console Output

All events printed type-tagged with timestamp and character name:

```
18:04:37 [test-pilot:assistant:text] I'll check the market prices first...
18:04:37 test-pilot: "I'll check the market prices first..."
18:04:38 [test-pilot:assistant:tool_use] Bash: sm market
18:04:38   $ sm market
18:04:39 [test-pilot:user:tool_result] Iron Ore: 5cr/unit (3 buy orders)...
18:04:39   > Iron Ore: 5cr/unit (3 buy orders)...
18:04:45 [test-pilot:result] ok:
18:04:45 [test-pilot:stderr] (if any stderr output)
```

## Commands

```bash
./roci start <character> [character...]    # Build image, start orchestrator
./roci start <char> --tick-interval 60     # Custom tick interval (default 30s)
./roci stop                                # Stop the shared container
./roci pause                               # Pause the shared container
./roci resume                              # Resume the shared container
./roci destroy                             # Remove the shared container
./roci status                              # Show container status
./roci logs <character>                    # Show recent thoughts
```

## Key Files

| File | Role |
|------|------|
| `orchestrator/src/cli.ts` | CLI commands and service wiring |
| `orchestrator/src/pipeline/orchestrator.ts` | Container lifecycle, fork character fibers |
| `orchestrator/src/pipeline/character-loop.ts` | Per-character: login, dream, start event loop |
| `orchestrator/src/monitor/event-loop.ts` | Thin wrapper: constructs adapter + processor, delegates to state machine |
| `orchestrator/src/core/state-machine.ts` | Domain-agnostic plan/act/evaluate event loop |
| `orchestrator/src/core/brain.ts` | Generic brain functions: plan, interrupt, evaluate (Opus) |
| `orchestrator/src/core/subagent.ts` | Build prompt, run in container, handle exit |
| `orchestrator/src/core/domain.ts` | `DomainAdapter<S,Sit>` interface |
| `orchestrator/src/core/types.ts` | Plan, PlanStep, StepTiming, StepCompletionResult |
| `orchestrator/src/core/event-source.ts` | `EventProcessor<S,Evt>` interface |
| `orchestrator/src/domains/spacemolt/adapter.ts` | SpaceMolt implementation of DomainAdapter |
| `orchestrator/src/domains/spacemolt/prompts.ts` | All LLM prompts (plan, evaluate, interrupt, subagent) |
| `orchestrator/src/domains/spacemolt/step-matchers.ts` | Deterministic step completion checks |
| `orchestrator/src/domains/spacemolt/state-renderer.ts` | State snapshots, rich snapshots, diffs, console bar |
| `orchestrator/src/domains/spacemolt/event-processor.ts` | Maps WS GameEvents to EventResults |
| `orchestrator/src/services/Claude.ts` | Host invoke + container exec with stream/exit |
| `orchestrator/src/services/GameApi.ts` | REST client for game.spacemolt.com |
| `orchestrator/src/services/GameSocket.ts` | WebSocket connection + event queue |
| `orchestrator/src/logging/log-demux.ts` | Raw capture, parse, route to logs + console |
| `orchestrator/src/logging/log-writer.ts` | CharacterLog service (JSONL append) |
| `orchestrator/src/logging/console-renderer.ts` | Type-tagged + narrative console output |
| `scripts/run-step.sh` | In-container: cd to player dir, exec claude -p |
| `.devcontainer/Dockerfile` | Container image: node20, claude-code, firewall |
| `.devcontainer/init-firewall.sh` | iptables whitelist for allowed domains |
