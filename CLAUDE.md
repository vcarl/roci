# Signal Harness — Claude Workspace

You are NeonEcho operating on the Signal harness codebase.
Not a coding assistant. A system builder who knows what this system is for.

Engineering philosophy: Read before writing. Understand before modifying. Think once, act clean.

---

## What This Is

Signal is a TypeScript monorepo running autonomous character-driven sessions via Claude Code subprocesses. It is the CULT fleet's operational harness — 10 agents running in Docker, playing SpaceMolt MMO.

Architecture: domain-agnostic state machine (brain/body execution loop) with 6 injectable Effect service layers. Characters have persistent identities and operate inside a shared Docker container.

See `HARNESS.md` for full architecture. `docs/DOMAIN_GUIDE.md` for domain building.

---

## Directory Map

```
apps/signal/src/
  main.ts                    — CLI entrypoint, --nonstop, --deep-context flags
  overmind/overlord.ts       — Fleet monitor: polls status, drops edicts, detects stuck agents

packages/core/src/core/
  orchestrator/
    state-machine.ts         — Main event loop (phase transitions, edict drain, wind-down poll)
    planning/
      brain.ts               — Brain turn (Opus/Sonnet plan prompt)
      subagent-manager.ts    — Body delegation + HARNESS_STATE parser
    planned-action.ts        — Body execution (haiku/sonnet task runner)
  limbic/
    hypothalamus/
      process-runner.ts      — claude -p subprocess, effort flags, HELP_REQUESTED/PRAYER tags
      timeout-summarizer.ts  — Free nemotron call on body timeout
    hippocampus/
      dream.ts               — Diary compression (reflection phase)

packages/domain-spacemolt/src/
  phases.ts                  — SpaceMolt phase orchestration (startup/active/social/reflection)
                               Officer deep context injection (GLOBAL_DIRECTIVE + ROSTER)
  prompt-builder.ts          — Template assembly: plan/subagent/evaluate/interrupt prompts
  prompts/
    plan.md                  — Brain planning (identity-first: background → values → diary → state)
    subagent.md              — Body execution (voice discipline → mission → prayer DSL)
    evaluate.md              — Brain evaluation of body output
    interrupt.md             — Urgent interrupt handler
    dinner.md                — Diary compression writer
    in-game-claude.md        — Main game system prompt (identity anchor at top)

packages/core/src/
  server/
    status-server.ts         — GET /status, GET /status/:name endpoints
    status-reporter.ts       — Writes players/{name}/status.json on phase transitions
  operator/
    edict-inbox.ts           — One-shot edict files: players/{name}/inbox/ → processed/
    wind-down-file.ts        — Wind-down IPC: players/{name}/WIND_DOWN.json
    todo-reader.ts           — TODO.md operator directives (injected before brain turn)
  prayer/
    prayer-manager.ts        — Prayer backend client + PRAYER_SET/HALT parser
    prayer-client.ts         — HTTP client for Prayer DSL backend

packages/cult/src/
  context/deep-context.ts    — Officer context injection (overlord symlink → GLOBAL_DIRECTIVE)
  memory/memory-bridge.ts    — Dream → Memory MCP fact extraction

players/{name}/
  me/
    background.md            — Who the character is + ## How I Speak voice rules
    VALUES.md                — Character creed in their voice
    DIARY.md                 — Structured memory: Beliefs/Relationships/Accomplishments/Todos
    SECRETS.md               — Private thoughts the character runs from
    TODO.md                  — Operator session directives (injected by todo-reader.ts)
    credentials.txt          — SpaceMolt login credentials
  inbox/                     — Edict drop zone (overlord or operator writes here)
  status.json                — Live agent status (written by status-reporter.ts)

overlord/                    — Symlink → /mnt/c/Users/Roy D. Lewis Jr/NeonEcho/overlord
  GLOBAL_DIRECTIVE.md        — Fleet-wide orders (injected into officer brain turns)
  memory/ROSTER.md           — All 10 agent roster + goals

.claude/
  settings.json              — MCP servers: signal memory-mcp + mcp-remote spacemolt
```

---

## Model Tier Map

| Role | Model | When |
|---|---|---|
| Brain (plan) | sonnet | Every active phase brain turn |
| Brain (interrupt) | sonnet | On critical alerts |
| Brain (evaluate) | haiku | After each body turn |
| Body | haiku (congregation) / sonnet (officer social) | Task execution |
| Dinner/Dream/Timeout | nemotron (free via OpenRouter) | Off-critical-path reflection |
| Overlord triage | haiku | Regular fleet polling |
| Overlord escalation | opus | HELP_REQUESTED + intervention decisions only |

Officers: neonecho, zealot, savolent, blackjack — get deep context, sonnet body for social tasks.
Congregation: cipher, pilgrim, seeker, drifter, investigator, scrapper — haiku body.

**Opus is rare.** Overlord escalation only. Never for routine turns.

---

## Build & Run

```bash
# Build all packages (run from /home/savolent/Signal)
pnpm build
# or specific package:
nx run @signal/domain-spacemolt:build

# Typecheck only (faster):
pnpm typecheck

# Lint:
pnpm lint

# Run the fleet (standalone terminal ONLY — never from inside Claude Code):
bash signal.sh --domain spacemolt neonecho zealot savolent

# Run overlord (separate standalone terminal):
bash run-overlord.sh                         # production (5min poll)
bash run-overlord.sh --interval 60 --no-usage-check  # testing

# Run single agent for testing:
bash signal.sh --domain spacemolt investigator
```

**STANDALONE TERMINAL ONLY.** The harness runs `claude -p` subprocesses. If Claude Code is active in this session, those subprocesses starve waiting for API capacity. Always launch from a terminal that is NOT running Claude Code.

---

## Overlord

`apps/signal/src/overmind/overlord.ts`

Fleet monitor. Runs every 5 minutes (configurable). Does:
1. Reads all `players/*/status.json` files, skips stale (age > 3× poll interval)
2. Detects stuck agents: same `(phase, stepIndex)` for 3+ consecutive polls → drops edict nudge
3. HELP_REQUESTED: agent emits tag → parsed by process-runner → written to `players/{name}/help_request.json` → overlord wakes immediately, Opus responds
4. Usage check: runs `fetch-usage.py` (CULT-only) → if over threshold, writes WIND_DOWN.json

To drop a manual wind-down for testing:
```bash
echo '{"reason":"test","issuedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > players/neonecho/WIND_DOWN.json
```

To drop a manual edict:
```bash
mkdir -p players/neonecho/inbox
echo '{"id":"test-001","priority":"high","content":"Focus on steel_plate crafting this session.","issuedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > players/neonecho/inbox/test-001.json
```

---

## Key Patterns

**Sequential mutation calls only.** The game has an `action_pending` lock that survives re-login. Never parallelize game mutations. Always sequential.

**Prayer for grind.** Mining loops, sell loops, refuel sequences — all should emit `PRAYER_SET` from the body agent. Prayer runs with zero Claude tokens. Body turns are reserved for judgment: social, ARG dialogs, complex missions.

**Voice discipline in prompts.** The `## How I Speak` section in each agent's `background.md` is the canonical voice spec. `plan.md` injects background before state. `subagent.md` injects voice discipline before the mission. If an agent speaks like Claude instead of their character, the prompt ordering is the first thing to check.

**Deep context for officers.** `phases.ts` auto-injects `GLOBAL_DIRECTIVE.md` + `ROSTER.md` from the overlord symlink before each officer brain turn. Max 3000 chars each. Officers: neonecho, zealot, savolent.

**Memory MCP.** Signal Memory MCP server (`NeonEcho/memory-mcp/src/server.ts`) backed by SQLite + FTS5 at `memory-mcp/data/memory.db`. Mounted into container: server at `/work/memory-mcp/src`, DB at `/work/memory-mcp/data/memory.db`. Container `.claude/settings.json` written by `containerSetup` in `config.ts`. Tools: `store_memory`, `recall_memories`, `search_memories`, `get_session_briefing`, `pin_memory`, `create_relationship`, etc. Post-dream memory bridge (`memory-bridge.ts`) auto-extracts facts from compressed diary and writes them to the DB.

---

## Coding Discipline

- Read existing code before modifying. Find patterns before inventing them.
- Plan before code for non-trivial tasks.
- After changes: `pnpm typecheck` → fix before moving on. Then `pnpm build` if shipping.
- No `any` in TypeScript — use `unknown` and narrow.
- Atomic commits per completed task.
- When blocked: stop, re-plan. Do not retry the same failing approach.

---

## Agent Credentials Index

All credentials at `players/{name}/me/credentials.txt`:
- neonecho, zealot, savolent — Officers (Crimson)
- cipher — Voidborn
- pilgrim — Nebula
- seeker — Solarian
- drifter, blackjack, scrapper — Outer Rim
- investigator — unaffiliated

---

## Quick Reference: Common Edits

| What | Where |
|---|---|
| Add a new prompt template variable | `prompt-builder.ts` + relevant `*.md` template |
| Change brain model for a role | `packages/core/src/core/limbic/hypothalamus/process-runner.ts` |
| Change overlord poll behavior | `apps/signal/src/overmind/overlord.ts` |
| Change phase timing | `packages/domain-spacemolt/src/phases.ts` constants |
| Add a new agent | `config.json` + `players/{name}/me/` soul files |
| Update agent voice | `players/{name}/me/background.md` (## How I Speak) |
| Update agent creed | `players/{name}/me/VALUES.md` |
| Update fleet directives | `overlord/GLOBAL_DIRECTIVE.md` (propagates via symlink) |
