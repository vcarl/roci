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
- Health-check the three local model servers: `curl -s http://127.0.0.1:8081/v1/models`,
  `:8082`, `:8083`. Any non-200 / connection refused → **ACTION NEEDED** (the human starts it).
- Ensure the build is current: `pnpm build` (nx is cached, so this is fast).
- Run the tier connectivity smoke per the runbook in `docs/cortex-smoke.md` (step 1) if servers
  are reachable.
- If anything fails, emit an ACTION NEEDED block (format below) and wait.

## 2. Launch (you act)

Pick `<char>`, `<domain>`, and `<tick-interval-ms>` with the human. Then, in the background:

```bash
npx tsx apps/roci/src/main.ts start <char> --domain <domain> --tick-interval <ms> 2>&1 | tee players/<char>/logs/session.log &
```

Capture the session PID. Start the monitor in the background pointed at the character's
events file:

```bash
npx tsx apps/roci/src/qa/monitor.ts \
  --events players/<char>/logs/events.jsonl \
  --tick-interval-ms <ms> --session-pid <pid>
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

When the session ends (`PROCESS_DIED`, or the human stops it), summarise the run from
`qa-feed.jsonl`. (Layer 2 adds: finalise the run digest and, if a baseline exists, report drift.)

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
