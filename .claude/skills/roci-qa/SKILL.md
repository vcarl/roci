<!-- .claude/skills/roci-qa/SKILL.md -->
---
name: roci-qa
description: Use when running a tag-team live QA session on a Roci character session — launches the session under the qa-monitor, narrates phase-transitions and anomalies, hands off human-only steps, and runs a calibration retro. Reference for monitoring the cortex loop end-to-end.
---

# Roci QA Co-pilot

You are the automated half of a tag-team QA session. You run everything scriptable and
monitor all log signal; the human takes only the irreducibly-manual steps. Narrate
**phase-transitions and anomalies only** — stay quiet through routine same-state ticks.

Design reference: `docs/superpowers/specs/2026-06-21-roci-qa-copilot-design.md`.

## 1. Preflight (you act)

- `docker ps` — confirm the daemon is up and note any existing `roci-*` containers.
- **Make `mlx_lm.server` reachable on PATH** (see "Model runtime access" below). As of the
  ModelService layer, the harness *spawns the tier servers itself* (122B conscious pinned-resident
  and gated first; 2B/9B transient per-phase) — so you normally do **not** pre-start servers. What
  the harness needs is the `mlx_lm.server` binary on the `PATH` of the shell that runs `roci start`.
  Verify: `which mlx_lm.server` returns a path. If not → **ACTION NEEDED** (activate the venv).
- If servers are *already* running (adopt-if-healthy), confirm with a **real generate** probe, not
  `/v1/models` — the latter returns 200 before weights finish loading and will lie:
  `curl -s http://127.0.0.1:8083/v1/chat/completions -H 'content-type: application/json' -d '{"model":"<id>","messages":[{"role":"user","content":"ping"}],"max_tokens":1}'`
  (ports: 8081 hindbrain / 8082 forebrain / 8083 conscious).
- Ensure the build is current: `pnpm build` (nx is cached, so this is fast).
- Run the tier connectivity smoke per the runbook in `docs/cortex-smoke.md` (step 1) if servers
  are reachable.
- If anything fails, emit an ACTION NEEDED block (format below) and wait.

### Model runtime access (mlx-lm)

`mlx_lm.server` ships in a Python venv at `~/llm-env`, **not** on the system Python or global PATH.
The harness spawns it by bare name (`Command.make("mlx_lm.server", …)` in
`packages/core/src/services/mlx-backend.ts`) with **no configurable path override**, so it resolves
purely through `PATH`. Two ways to satisfy that:

- **Activate the venv** in the launching shell — fish: `source ~/llm-env/bin/activate.fish`
  (bash/zsh: `source ~/llm-env/bin/activate`). Then launch `roci start` from that same shell.
- **Or prepend the venv bin** for a single command:
  `env PATH="$HOME/llm-env/bin:$PATH" <cmd>` (used by the gated smoke
  `ROCI_MODEL_SMOKE_SPAWN=1 … vitest run …mlx-backend.smoke.test.ts`).

The console scripts are self-contained (shebang → the venv's `python3.12`), so once `mlx_lm.server`
is on PATH it runs standalone — no separate activation needed for the *spawned* child. Sanity check:
`~/llm-env/bin/python -c "import mlx_lm; print(mlx_lm.__version__)"` (known-good: 0.31.2 / mlx 0.31.1).

## 2. Launch (you act)

Pick `<char>`, `<domain>`, and `<tick-interval-ms>` with the human. Then, in the background:

```bash
# IMPORTANT: launch via `node --import tsx` (single process), NOT bare `tsx … main.ts`.
# Bare `tsx` double-forks; on SIGTERM it SIGKILLs the worker ~30ms later, before the
# async kill/container-stop finalizers can run — orphaning the resident 122B mlx
# server (port 8083, ~42% RAM) and leaking the Docker container. `--import tsx` runs
# in one process with no CLI-parent wrapper, so runMain's graceful finalizers fire.
node --import tsx apps/roci/src/main.ts start <char> --domain <domain> --tick-interval <ms> 2>&1 | tee players/<char>/logs/session.log &
```

Capture the session PID. Start the monitor in the background pointed at the character's
events file:

```bash
node --import tsx apps/roci/src/qa/monitor.ts \
  --events players/<char>/logs/events.jsonl \
  --char <char> --domain <domain> \
  --tick-interval-ms <ms> --session-pid <pid> \
  [--baseline players/<char>/qa/baselines/<name>.json]
```

The monitor's stdout one-liners are your **wake signal**; `players/<char>/logs/qa-feed.jsonl`
is the durable record you read deltas from.

## 3. Monitor loop

- On a `transition` line, narrate the beat in one short sentence.
- On an `anomaly` line (`STALL` / `PROCESS_DIED` / `ERROR`), stop and raise it via ACTION
  NEEDED with your read of the cause and the exact fix command.
- Self-schedule a slow fallback check (~2× tick-interval) as a dead-man's-switch in case the
  monitor itself goes silent.

## 4. Behaviour-quality checkpoints

On a `DECISION` beat, on `SESSION_END`, or when the human asks, surface the artifacts for the
human's judgment (you present, they grade):

- the conscious prompt vs. the raw inbound event (laundering check — no raw event text should
  appear verbatim in the prompt),
- the decision + plan,
- the diary delta (`players/<char>/me/DIARY.md`).

## 5. Human-handoff protocol

Whenever you need the human, emit exactly this block so it is never buried in narration:

```
⚠ ACTION NEEDED
  What:    <the action>
  Why:     <the signal that prompted it>
  Command: <exact command, or "none — manual">
  After:   <what you will confirm once they are done>
```

Handoff categories: start/restart a model server; trigger a domain critical event; judge a
surfaced artifact; decide continue/stop.

## 6. Wind-down

When the session ends, the monitor writes `players/<char>/logs/run-digest.json` and (if you
launched it with `--baseline players/<char>/qa/baselines/<name>.json`) prints a drift report.
Relay the drift report. If the run was good and you want it as a new reference, copy the digest:
`cp players/<char>/logs/run-digest.json players/<char>/qa/baselines/<name>.json`.

## 7. Calibration retro (the dogfood loop)

Always run a short retro and append the outcome to `.claude/skills/roci-qa/CALIBRATION.md`.
Ask the human three questions and turn each answer into a concrete change:

- **Misses** — "what did you notice that the monitor didn't flag?" → candidate new named
  anomaly detector in `apps/roci/src/qa/` (this is how the anomaly vocabulary grows).
- **False positives / chattiness** — "what fired or got narrated that was noise?" → threshold
  tweak or promote/demote a narrated beat.
- **Blind spots in the record** — "what did we wish the digest had captured?" → new fingerprint
  field.

Record each as an entry. Treat resulting code changes with normal discipline (TDD new
detectors, review before merge).
