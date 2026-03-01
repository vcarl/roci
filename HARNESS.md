# Agent Harness

The harness runs autonomous SpaceMolt game sessions inside a shared Docker container, using Claude Code as the agent runtime. An orchestrator on the host manages the game loop: poll state, plan with a brain LLM, dispatch subagents into the container, and capture all output.

## System Layers

```
┌──────────────────────────────────────────────────────────────────┐
│  CLI                                                             │
│  $ roci start test-pilot       (cli.ts → orchestrator.ts)        │
│  $ roci stop | pause | resume | destroy | status | logs          │
├──────────────────────────────────────────────────────────────────┤
│  Orchestrator                                                    │
│  Load .env, ensure shared container, fork 1 fiber per character  │
│  (orchestrator.ts)                                               │
├──────────────────────────────────────────────────────────────────┤
│  Character Loop                                                  │
│  Login to game API, dream (compress diary), start tick loop      │
│  (character-loop.ts)                                             │
├──────────────────────────────────────────────────────────────────┤
│  Tick Loop                              every 30s                │
│  Poll state → detect interrupts → check subagent → plan → spawn │
│  (tick-loop.ts)                                                  │
├──────────────────────────────────────────────────────────────────┤
│  Brain (Opus on host)          │  Subagent (!opus, in Docker)    |
│  brainPlan — strategic plan    │  docker exec -i → run-step.sh   │
│  brainInterrupt — replan       │  claude -p --stream-json        │
│  brainEvaluate — judge result  │  runs sm commands via Bash tool │
├──────────────────────────────────────────────────────────────────┤
│  Stream Pipeline                                                 │
│  stdout line → stream.jsonl (raw) → parse → demuxEvent           │
│  stderr → forked fiber drain → surface after stream ends         │
│  (Claude.ts, log-demux.ts)                                       │
├──────────────────────────────────────────────────────────────────┤
```

## Tick Loop State Machine

```
                         ┌──────────────────────────────────────────────┐
                         │                                              │
                         ▼                                              │
                   ┌───────────┐                                        │
            ┌─────►│ POLL STATE │                                       │
            │      └─────┬─────┘                                        │
            │            │                                              │
            │            ▼                                              │
            │      ┌───────────────┐   critical        ┌────────────┐  │
            │      │DETECT         │──────────────────►│ INTERRUPT   │  │
            │      │INTERRUPTS     │   alerts          │ kill fiber  │  │
            │      └───────┬───────┘                   │ brainInter… │  │
            │              │ none                       └──────┬─────┘  │
            │              ▼                                   │        │
            │      ┌───────────────┐                    set plan, step=0
            │      │ CHECK         │                           │        │
            │      │ SUBAGENT      │◄──────────────────────────┘        │
            │      └───┬───┬───┬───┘                                    │
            │          │   │   │                                        │
            │   ┌──────┘   │   └──────────────┐                        │
            │   │ done     │ running          │ no fiber               │
            │   ▼          ▼                  │                        │
            │ ┌──────┐  ┌──────────────┐      │                        │
            │ │EVAL  │  │ MID-RUN      │      │                        │
            │ │brain │  │ condition met?│      │                        │
            │ │Eval… │  │ timed out?   │      │                        │
            │ └──┬───┘  └──────┬───────┘      │                        │
            │    │             │               │                        │
            │    ▼             ▼               ▼                        │
            │ complete?   interrupt?    ┌─────────────┐                 │
            │  ├─yes──►step++          │NEED PLAN?    │                 │
            │  └─no───►replan          │plan=null or  │                 │
            │          (set plan=null)  │step>=len     │                 │
            │                          └──────┬───────┘                 │
            │                                 │ yes                     │
            │                                 ▼                         │
            │                          ┌─────────────┐                  │
            │                          │ BRAIN PLAN   │                 │
            │                          │ (Opus)       │                 │
            │                          └──────┬───────┘                 │
            │                                 │                         │
            │                                 ▼                         │
            │                          ┌─────────────┐                  │
            │                          │ SPAWN       │                  │
            │                          │ SUBAGENT    │──────────────────┘
            │                          │ (fork fiber)│
            │                          └─────────────┘
            │
        wait 30s
```

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
| `orchestrator/src/pipeline/character-loop.ts` | Per-character: login, dream, start tick loop |
| `orchestrator/src/monitor/tick-loop.ts` | 30s tick: poll, interrupt, evaluate, plan, spawn |
| `orchestrator/src/monitor/interrupt.ts` | Filter critical alerts from situation |
| `orchestrator/src/monitor/plan-tracker.ts` | State-based step completion checks |
| `orchestrator/src/ai/brain.ts` | brainPlan, brainInterrupt, brainEvaluate (Opus) |
| `orchestrator/src/ai/subagent.ts` | Build prompt, run in container, handle exit |
| `orchestrator/src/services/Claude.ts` | Host invoke + container exec with stream/exit |
| `orchestrator/src/services/GameApi.ts` | REST client for game.spacemolt.com |
| `orchestrator/src/logging/log-demux.ts` | Raw capture, parse, route to logs + console |
| `orchestrator/src/logging/log-writer.ts` | CharacterLog service (JSONL append) |
| `orchestrator/src/logging/console-renderer.ts` | Type-tagged + narrative console output |
| `scripts/run-step.sh` | In-container: cd to player dir, exec claude -p |
| `.devcontainer/Dockerfile` | Container image: node20, claude-code, firewall |
| `.devcontainer/init-firewall.sh` | iptables whitelist for allowed domains |
