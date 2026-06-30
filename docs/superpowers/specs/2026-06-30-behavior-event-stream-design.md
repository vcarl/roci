# Structured Behavior Event Stream — Design

**Date:** 2026-06-30
**Status:** Approved (design); pending implementation plan
**Related prior art:** `2026-04-10-unified-event-log-design.md`, `2026-06-27-leveled-logging-design.md`, `2026-06-27-full-output-archival-design.md`, `2026-06-21-roci-qa-copilot-design.md`

## Problem

Watching a `roci start` run — live at the console or after the fact via `events.jsonl` — does not reliably tell you **what the bot actually did**. Concretely:

1. **Behaviors are reverse-engineered, not recorded.** The emitted stream (`UnifiedEvent` → `events.jsonl` + console, `packages/core/src/logging/events.ts:14`) carries behaviors as freeform `kind:"system"` strings. A separate QA layer (`apps/roci/src/qa/markers.ts:4`, `classifyEvent`) then regex-matches those strings to recover structure (`FOREBRAIN`, `DECISION`, `STEP_START`…), and **silently drops** anything that doesn't match — `Entering phase:`, `loop_start`, every non-escalate hindbrain disposition, and all non-system events. The "source of truth" is prose a brittle parser tries to reconstruct.
2. **You can only see failures, not successes.** Memory-CLI provisioning (`apps/roci/src/orchestrator.ts:155`) and conscious-provider provisioning (`:139`) log on failure but are **silent on success**. Diary promotion returns early before logging when nothing is fresh, so an empty-diary run looks like nothing happened (`packages/core/src/core/orchestrator/planned-action.ts:66`).
3. **A clean stop and a hang look identical.** `SESSION_END` is defined in the QA type system (`apps/roci/src/qa/types.ts`) and ranked in the digest (`apps/roci/src/qa/digest.ts:12`) but is **never emitted**, so `terminalCause` stays `null` for successful runs.
4. **Per-tier latency is invisible in real time.** `firstForebrainMs` is computed *retroactively* in the digest (`apps/roci/src/qa/digest.ts:54`); `callTier` (`packages/core/src/cortex/tiers.ts:84`) and `ModelService.withTier` (`packages/core/src/services/ModelService.ts:97`) have no timing. A ~183s forebrain first-response once went unflagged.

## Goal

Make behaviors — **both the operational/machinery layer and the cognitive/action layer** — first-class **structured events** that are the source of truth, with the console as a rendered view and the QA digest reading structure directly instead of recovering it. Nothing a behavior produces should be silently dropped.

## Non-goals

- Rewriting the leveled-logging / archival behavior already landed (we extend it, not replace it).
- New QA *detectors* (STUCK_STEP, TIER_UNREACHABLE, etc.) — those are downstream of this and remain backlog.
- A `roci logs` live-tail CLI — desirable follow-on, out of scope here.
- Changing control flow anywhere, including the cortex loop. Wave 2 changes *emit calls only*.

## Design

### 1. Event model — one `behavior` kind, typed core + escape hatch

Add a single new variant to `UnifiedEvent` (`packages/core/src/logging/events.ts`):

```ts
| { kind: "behavior"; behavior: Behavior }
```

`Behavior` is a discriminated union on `type`, in two tiers plus an escape hatch:

**Machinery types (Wave 1):**
- `session_start` — `{ domain; character; gitSha; tickIntervalMs }`
- `session_end` — `{ reason: "clean" | "signal" | "error"; signal?; digest }` — the terminal event; `digest` carries counts-by-type, ordered sequence, timings, terminalCause
- `provision` — `{ component: "container" | "embed_server" | "memory_cli" | "conscious_provider"; status: "ready" | "failed"; detail? }`
- `phase` — `{ phase: string; transition: "enter" | "exit" }`
- `reflection` — `{ stage: "consolidate" | "dream" | "promote"; status: "start" | "done"; counts? }` (promote carries N **including 0**)

**Cognition types (Wave 2):**
- `tier_call` — `{ tier: "hindbrain" | "forebrain" | "conscious"; latencyMs; outcome: "ok" | "error" | "timeout"; attempt? }`
- `appraisal` — `{ disposition: string; weight?; escalated: boolean }` (captures **non-escalate** hindbrain dispositions, currently dropped)
- `orient` — `{ headline: string }` (forebrain)
- `decision` — `{ disposition: "plan" | "wait" | "terminate" }` (conscious)
- `step` — `{ phase: "start" | "done" | "salvage"; turn?; task? }`
- `action` — `{ domain; name; input?; result? }` (concrete world actions)

**Escape hatch:**
- `note` — `{ label: string; data?: unknown; severity? }` — a typed-enough-to-route-and-render but **free-form-payload** behavior for anything that resists taxonomy, especially opencode conscious output whose shape is not yet stable.

**The no-drop rule:** if a behavior cannot be mapped to a known type, it is emitted as a `note` — never discarded. As recurring `note` labels stabilize (notably from opencode), they graduate into first-class types.

### 2. Consumers — `classifyEvent` collapses; the digest becomes authoritative

- `classifyEvent` (`apps/roci/src/qa/markers.ts`) gains a `kind:"behavior"` branch that maps `behavior.type → TransitionType` directly (no regex). `note` becomes its own counted `NOTE` transition.
- **Digest authority:** a small **digest accumulator** in the logging package updates on every `behavior` emit — counts-by-type, ordered sequence, first-tier timings, and the highest-rank terminal cause. `session_end` snapshots it and carries the digest inline in `events.jsonl`, making the emitted `session_end` the **authoritative** run digest.
- The QA monitor (`apps/roci/src/qa/monitor.ts`) stops re-deriving the digest by regex — it **reads `session_end`'s digest directly** and writes `run-digest.json` (`monitor.ts:110`) from it. Its existing fold survives only as a **crash fallback** for runs that die before emitting `session_end` (so a hard `PROCESS_DIED` still yields something).
- The legacy string-pattern matchers in `classifyEvent` stay as an **interim shim** for not-yet-migrated cognition events during Wave 1, and are removed in Wave 2.

### 3. Console rendering

The console renderer (`packages/core/src/logging/console-renderer.ts`) gains one case: render `kind:"behavior"` into the existing `[name:component]` line format. The structured event remains the source of truth; the console line is a view of it.

## Phasing (Approach C)

### Wave 1 — machinery (no hot loop)

Emit structured machinery behaviors at these reachable seams:
- `session_start` → orchestrator entry, before phases (replaces feed.ts's auto-injected `SESSION_START` guess at `apps/roci/src/qa/feed.ts:22`).
- `provision` → `orchestrator.ts` container-ensure; `embed-server.ts:308` (convert existing log); memory-CLI `orchestrator.ts:155` and conscious-provider `:139` (**add success path**).
- `phase` enter/exit → `packages/core/src/core/phase-runner.ts:29` (has enter; add exit).
- `reflection` → `planned-action.ts:86` consolidate, `:95` dream, `:66` promote (**carry N including 0**).
- `session_end` → `orchestrator.ts` `Effect.ensuring` block (clean/graceful) and `apps/roci/src/main.ts:24` signal handlers (signal/error).

Ships: the event model, the digest accumulator + authoritative `session_end`, the monitor reading `session_end`, console rendering, and the `classifyEvent` behavior branch (with the interim shim still covering cognition strings).

### Wave 2 — cognition + latency (the one hot-loop touch)

Migrate the cognitive emit sites in `packages/core/src/cortex/loop.ts` and `tiers.ts` from freeform strings to behavior events (`orient`/`decision`/`step`/`appraisal`/`action`), and wrap `callTier` (`tiers.ts:84`) with timing to emit `tier_call{tier, latencyMs, outcome}` — making `firstForebrainMs` a live event. Retire the `classifyEvent` string shim.

**Hot-loop discipline:** this is the *only* change touching `cortex/loop.ts`. It is a **mechanical emit-call swap with no control-flow change**, done as its own wave with an independent reviewer — the same posture that worked for moving memory-CLI provisioning out of the loop. This is the deliberate, justified relaxation of the "don't touch the hot loop" guardrail, scoped to emit-call shape only.

## Error handling

- Behavior emits are **best-effort** and must never throw into the loop or orchestrator (mirror today's emit resilience in `log-writer.ts`).
- The digest accumulator snapshots defensively and must never crash a run.
- `session_end` is **idempotent** via a guard flag, so the `Effect.ensuring` path and a signal handler cannot double-emit.
- If the process dies before `session_end`, the monitor's fold fallback still produces a `PROCESS_DIED` digest.

## Testing

- **Unit:** the `Behavior` discriminated union; the accumulator fold (counts / sequence / timings / terminal-rank); `classifyEvent`'s `type → TransitionType` mapping including `note`; `session_end` digest snapshot.
- **Integration:** emit a sequence and assert `events.jsonl` carries structured behaviors plus a terminal `session_end` with digest; assert the monitor reads `session_end`'s digest and falls back to its fold when `session_end` is absent.
- **Regression:** the existing `apps/roci/src/qa/feed.test.ts` fixture guards the interim shim during Wave 1.
- **Live proof:** a `vcarl`/spacemolt `roci start`, reading `session_end` + `provision` + `reflection(promote N)` from the stream, confirming a clean-vs-signal terminal cause is distinguishable. (Per established proven-live discipline; read `roci-qa` CALIBRATION first.)

## Verdict on cost (from grounding)

- (a) `SESSION_END` + digest: **extend** (one seam + accumulator).
- (b) positive lifecycle events: **extend** (low-friction, scattered orchestrator/phase seams, no hot loop).
- (c) per-tier latency: **light extend** at `callTier`/`withTier` (Wave 2).

Only Wave 2 touches `cortex/loop.ts`, and only its emit calls.
