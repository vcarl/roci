# Roci QA Co-pilot — Design

**Date:** 2026-06-21
**Status:** Design approved; ready for implementation plan
**Topic:** A tag-team live-session QA co-pilot for Roci

## Problem

Testing Roci end-to-end is a tag-team activity. A session runs **indefinitely**, emitting
several concurrent streams — tagged console stdout (`hindbrain:`/`forebrain:`/`conscious:`/
`Critical:`/`step …` markers), the per-character `players/<char>/logs/events.jsonl`, Docker
container logs, and three local model servers — plus one-shot automated smoke tests (build,
`client.smoke`, `opencode-session.smoke`).

Today a human must watch all of this by eye while also doing the irreducibly-manual steps:
start the three model servers, keep Docker up, trigger domain "critical" events, and judge
whether the character's behaviour is actually *good*.

We want a division of labour where **Claude monitors all log streams efficiently and takes
every scriptable action automatically**, while **the human takes only the steps Claude
cannot** — and where the tool **improves itself through use** (dogfooding a review/improvement
loop).

## Goals

1. **Pipeline health / liveness** — confirm the escalation ladder fires end-to-end with no
   hangs or crashes (hindbrain → forebrain → conscious → delegation; ticks keep flowing;
   containers and model servers stay up).
2. **Character behaviour quality** — surface the artifacts (conscious prompt, decision/plan,
   diary, forebrain-vs-raw-event for laundering) for the human's judgment. The tool presents;
   the human grades.
3. **Regression vs known-good** — capture a run's "fingerprint" and diff it against a named
   baseline to spot drift.

Explicitly **not** a separate goal: special-casing the new Phase 3–4c paths (steering,
resumable sessions, frontier delegation, critical interrupts). Liveness already exercises
them; no bespoke logic.

## Non-goals (YAGNI)

- A fixed 7-step protocol runner / checklist. We are building the monitoring **engine**, not a
  scripted checklist. (`docs/cortex-smoke.md` remains the manual runbook.)
- A pre-built, curated anomaly taxonomy. See "Anomaly detection grows empirically" below.
- MCP. The monitor is a plain subprocess, per standing preference.

## Interaction model

**Phase-transition + anomaly only.** Claude narrates the meaningful beats (session start,
phase transitions, delegation, critical interrupt, completion) and raises anomalies, and stays
quiet through routine same-state ticks. Claude is **event-driven** — woken on signal, silent
otherwise — and never tails raw logs into its context.

## Architecture

Two artifacts.

1. **`qa-monitor`** — a deterministic TypeScript subprocess (run via `tsx`, lives in-repo, e.g.
   `apps/roci/src/qa/monitor.ts`). The filter/watchdog/fingerprinter. No MCP.
2. **`roci-qa` skill** — a Claude Code skill (`.claude/skills/roci-qa/SKILL.md`) that is
   Claude's playbook for running the tag-team session.

### Data flow

```
Roci session (bg) ──stdout──▶ session.log ─┐
players/<char>/logs/events.jsonl ──────────┤
docker logs <container> ────────────────────┼──▶ qa-monitor (bg)
model-server health (curl 8081/2/3) ────────┘         │
                                                       ├─▶ qa-feed.jsonl   (signal-only: transitions + anomalies)
                                                       ├─▶ run-digest.json  (running fingerprint for regression)
                                                       └─▶ stdout one-liners (wakes Claude on a noteworthy beat)
                                                                  │
                                                                  ▼
                                              Claude ──▶ narrate beats / flag anomalies /
                                                         request human steps / run scriptable actions
                                                                  │
                                                                  ▼
                                                                 human
```

**Efficiency property:** `qa-monitor` runs as a background process and emits **only** on a
phase-transition or anomaly. Its terse **stdout one-liner is the wake signal** — a background
process re-invokes Claude when it prints — and `qa-feed.jsonl` is the **durable record Claude
reads deltas from** (with `refs` to drill into detail on demand). So Claude is woken on signal,
reads only the new feed lines, and stays silent through routine ticks, never tailing raw logs
into context. Claude self-schedules a slow fallback heartbeat (~2× tick-interval) purely as a
dead-man's-switch in case the monitor itself goes silent.

### On-disk layout

```
players/<char>/qa/<run-id>/   session.log, qa-feed.jsonl, run-digest.json
players/<char>/qa/baselines/  <named>.json   ← known-good fingerprints for regression compare
```

## Component: `qa-monitor`

Three jobs, all deterministic, grounded in the markers the app already emits.

### a) Phase-transition vocabulary (Claude narrates these)

Derived from real emitted markers, so not speculative:

- `SESSION_START`
- `ESCALATE` — hindbrain disposition = escalate (discard/wait stay silent)
- `FOREBRAIN` — synthesis headline, including in-session re-orientation
- `DECISION` — conscious plan / wait / terminate, with step count
- `STEP_START` / `STEP_DONE` (done-marker) / `STEP_SALVAGE` (tick-budget elapsed)
- `DELEGATION` — frontier start / poll / steer / wait
- `CRITICAL` — amygdala interrupt
- `SESSION_END` — Completed / Interrupted

### b) Anomaly detection — a minimal generic net, grown empirically

**v1 is intentionally crude.** The monitor knows only three "something's off" signals:

- **process died** — the session background process exited unexpectedly
- **stall** — no new `events.jsonl` activity past the threshold (default: 2× tick-interval)
- **raw error-ish lines** — exception/stack-trace-shaped lines, surfaced verbatim for Claude
  to look at

There is **no** pre-built `DEAD_TIER` / `DELEGATION_FAIL` / `LAUNDERING_LEAK` taxonomy.

**Named anomaly detectors are an output of the retro loop, not an input.** Each time a real
failure is hit, the retro (below) decides whether it is worth codifying into a named, sharper
detector. The dogfood loop *is* the mechanism that builds the anomaly vocabulary — over real
failures, not guesses.

### Feed record shape

```
{ ts, kind: "transition" | "anomaly", type, severity, tick, summary, refs }
```

`refs` point at log offsets / artifact paths so Claude can drill in on demand without holding
everything in context.

### c) Run-digest fingerprint (regression)

Continuously updated, finalised at session end. Captures:

- **counts** — ticks, escalations, decisions by type, steps done/salvaged, delegations,
  criticals, anomalies
- **timings** — avg tick latency, time-to-first-forebrain, time-to-first-plan, avg step duration
- **tier health** — reachability + latency samples per tier
- **sequence** — the ordered list of transition types (the run's "shape")
- **env** — character, domain, tick-interval, per-tier models, git SHA

**Baseline compare** diffs this fingerprint against a named known-good baseline and flags drift:
missing/extra phases, count deltas past tolerance, latency regressions past a %, new anomaly
classes, sequence divergence.

**Default thresholds** (starting points, tuned via the retro loop): stall = 2× tick-interval;
fallback heartbeat = 2× tick-interval.

## Component: `roci-qa` skill (lifecycle + human handoff)

The skill is Claude's playbook. Lifecycle:

1. **Preflight** *(Claude acts)* — check Docker; curl the three model servers; ensure the build
   is current (build if not); run `client.smoke` per tier. Any failure → hand off to the human
   with the exact fix.
2. **Launch** *(Claude acts)* — start the session in background (`main.ts start <char> --domain
   <d> --tick-interval N`, stdout → `session.log`); start `qa-monitor` on the run dir.
3. **Monitor loop** — woken on feed signal → narrate the beat or raise the generic anomaly; slow
   fallback heartbeat as dead-man's-switch.
4. **Behaviour-quality checkpoints** — on `DECISION` / `SESSION_END` (or on the human's ask),
   surface artifacts (conscious prompt, forebrain-headline-vs-raw-event for laundering,
   decision + plan, diary delta) for the human's judgment. Claude presents; the human grades.
5. **Wind-down** — finalise the digest; if a baseline exists, run the compare and report drift.
6. **Retro** — see below.

### Human-handoff protocol

Whenever Claude needs the human, it emits a single clearly-marked block so it is never buried in
narration:

```
⚠ ACTION NEEDED
  What:    restart model server on :8083 (conscious tier)
  Why:     stall — no tick in 70s, :8083 health curl failing
  Command: <exact command, if one exists>
  After:   I'll confirm ticks resume in the feed
```

The human does it, says "done" (or pastes output), and Claude verifies the expected effect
appears in the feed. Handoff categories: start/restart a model server; trigger a domain critical
event; judge a surfaced artifact; decide continue/stop.

## The retro / calibration loop (the dogfood engine)

At wind-down, Claude runs a short **retro**, automatically. This is what makes the tool improve
through use and how the anomaly vocabulary grows.

**Inputs:** the run's `qa-feed.jsonl` (everything that fired), the digest + baseline drift,
Claude's narration history, and — the richest signal — the human's interjections: what the human
caught by eye that the monitor was blind to, and what fired but was noise.

**Three questions, each turning into a concrete change:**

- *Misses* — "what did you notice that the monitor didn't flag?" → candidate **new named anomaly
  detector** (this is how the anomaly vocabulary grows empirically).
- *False positives / chattiness* — "what fired or got narrated that was noise?" → **threshold
  tweak** or **promote/demote a narrated beat**.
- *Blind spots in the record* — "what did we wish the digest had captured?" → **new fingerprint
  field**.

**Outputs** (concrete, committable): threshold consts, a new detector, narration-filter changes,
digest fields, skill-playbook edits (a forgotten preflight check, handoff wording), and — if the
run was good — **promote its digest to a named baseline**.

**Where it lives:** a persistent `CALIBRATION.md` in the skill dir. Each retro appends a dated
entry (observations → decided changes → applied/queued).

Because these outputs are *code changes to the QA tool*, we dogfood our own discipline on them:
new detectors are TDD'd, changes are reviewed. The retro runs every session, so the anomaly
vocab and thresholds converge over real failures rather than guesses.

## Build sequencing

- **Layer 1 (usable co-pilot, first):** `qa-monitor` phase-transition feed + generic anomaly net
  + the skill's preflight / launch / monitor-loop / handoff.
- **Layer 2 (regression):** digest fingerprint + baseline capture / compare.
- **Retro is not a layer** — it operates from day one; it is how Layer 1 gets tuned.

## Testing

`qa-monitor` is a pure parser/filter, so it is unit-testable against **fixture log streams**:
sample `session.log` + `events.jsonl` → expected feed records. This is buildable TDD with no live
session needed.

The first real captured run becomes both the first test fixture **and** the first baseline —
the first dogfood.

## Open questions / to tune via the retro loop

- Exact default thresholds (stall multiple, heartbeat cadence) — start at 2× tick-interval, tune.
- Baseline drift tolerances (count delta %, latency regression %).
- Whether a heuristic `LAUNDERING_LEAK` substring detector earns its place once we see real runs
  (deferred from v1; artifact surfacing covers the goal meanwhile).
