# Leveled Logging + Live-View Cleanup — Design

**Date:** 2026-06-27
**Status:** Approved for planning
**Scope:** The stdout/JSONL logging pipeline. Excludes the forebrain orient-parse fix, which is a separate, concurrently-applied bug fix (see "Related work").

## Problem

The live stdout "follow along" view is hard to read. Concretely, from real output:

1. **OpenCode "init" spam.** Every OpenCode `step_start` renders as a generic `init` line (`events.ts:35`). A local model taking many steps floods the view with `[char:opencode] init`.
2. **Empty tool_use entries.** `normalizeOpenCode` reads `part.name` / `part.input`, but OpenCode's real tool part nests these under `part.tool` and `part.state.input` (verified against OpenCode 1.17.8's on-disk store and its `run --format json` printer). So every tool call logs `tool:""`, `input:{}` — the single most useful body signal is blank.
3. **Status-bar collision.** `domain-spacemolt/renderer.ts:24-34` writes `process.stderr.write(\`\r[${name}] ...\`)` — a carriage-return, no-newline, in-place bar on **stderr**, entirely outside the `CharacterLog`/`renderEvent` pipeline. It collides with the scrolling `console.log` stream (`cargo:40/50[vcarl:opencode]`).
4. **No verbosity control.** The full docker exec command, heartbeats, every tier transition, and high-signal decisions all print at one flat level. There is no way to get a clean view or a firehose on demand.

## Goals

- A clean default live view where the four signals the operator cares about — **cortex decisions, body/tool activity, lifecycle & timing, errors** — read as a narrative.
- Per-event **log levels** with a threshold that filters stdout; `events.jsonl` stays the complete archive.
- Fix the three bugs above as the foundation.

Non-goals (YAGNI): per-subsystem toggles; preserving the in-place updating status bar / building an output coordinator; restructuring the JSONL schema beyond adding `level`.

## Current architecture (for reference)

```
stream lines ──normalize──> InternalEvent ──map(events.ts)──> UnifiedEvent ─┐
logToConsole(char, sub, msg) ───────────────────> UnifiedEvent ────────────┤
                                                                            │
                                            CharacterLog.emit (log-writer.ts)
                                                       ├─> events.jsonl   (JSON.stringify + "\n", append)
                                                       └─> console.log(renderEvent(event))  (console-renderer.ts)
```

Key files:
- `packages/core/src/logging/events.ts` — `EventBase`, `UnifiedEvent` (discriminated union by `kind`), `eventBase`, and the InternalEvent→UnifiedEvent mapper.
- `packages/core/src/logging/log-writer.ts` — `CharacterLog` service + `CharacterLogLive` layer; JSONL sink + `console.log` fanout; `logToConsole` helper.
- `packages/core/src/logging/console-renderer.ts` — `renderEvent`, color/tag formatting.
- `packages/core/src/logging/stream-normalizer.ts` — `normalizeClaude` / `normalizeOpenCode` / `normalizeSdk`.
- `packages/domain-spacemolt/src/renderer.ts` — `logStateBar` (the rogue status writer).

## Design

Three layers, built bottom-up.

### Layer 1 — Foundation bug fixes

**1.1 OpenCode tool field paths** (`stream-normalizer.ts`, `normalizeOpenCode`, ~lines 81-88).
Change the `tool_use` branch to read the real schema:
- name: `part.tool` (was `part.name`)
- input: `part.state.input` (was `part.input`)
- id: keep `part.id`

Verified real shape (OpenCode 1.17.8): the stdout line is `{ type: "tool_use", timestamp, sessionID, part: <Part> }` where the Part is
```json
{ "type": "tool", "tool": "bash", "callID": "...", "id": "prt_...",
  "state": { "status": "completed", "input": { "command": "...", "description": "..." },
             "output": "...", "metadata": {...}, "title": "...", "time": {...} } }
```
Tool lines are emitted **only** on `state.status` of `completed`/`error`, so `state.input` is always populated by the time we see it — this is purely a wrong-path bug, not a timing issue.

**Replace the fake fixture.** `stream-normalizer.test.ts:88` currently feeds `part: { id, name, input }` — which matches the *buggy* code, so the test is green while production is blank. Replace it with the real Part shape above and assert the extracted name/input.

**1.2 Status bar through the pipeline** (`domain-spacemolt/renderer.ts`, `logStateBar`).
Drop the `\r` + `process.stderr.write`. Emit the state bar as a normal newline-terminated event through `CharacterLog.emit` (or `logToConsole`) at **info** level. This eliminates the collision and makes the bar leveled and consistent with everything else. The in-place updating behavior is intentionally dropped (see Non-goals).

**1.3 Demote "init" noise.** The OpenCode `step_start` → `init` system event is lifecycle noise; it is assigned **debug** at the mapper (see 2.2) so it disappears from the default view. No dedup logic needed — leveling handles it.

### Layer 2 — Leveling mechanism

**2.1 Add `level` to the event model.** Extend `EventBase` (or `UnifiedEvent`) with an optional `level?: "debug" | "info" | "warn" | "error"`. Optional because most events get their level from the classifier; only special cases set it explicitly.

**2.2 Hybrid assignment.**
- A pure `classifyLevel(event): Level` provides the default from `kind` (and, narrowly, subsystem):
  - `error` → `error`
  - `rate_limit` (mapped from stream) → `warn`
  - `thinking` → `debug`
  - `tool_use`, `tool_result`, `text`, `subagent_start`, `subagent_stop`, and `system` → `info`
- **Explicit overrides** at the few call sites / mapper branches that know better:
  - `logToConsole` gains an optional `level` argument. Body docker-exec command (`process-runner.ts:63` et al.) → `debug`; heartbeat "still running" (`transport.ts:147`) → `debug`; forebrain orient parse failure (`tiers.ts:153`) → `warn`.
  - In the InternalEvent→UnifiedEvent mapper (`events.ts`): `step_start`/`init` system event → `debug`; `rate_limit` → `warn`.
- Resolution happens once in `CharacterLog.emit`: `const level = event.level ?? classifyLevel(event)`.

**2.3 Threshold filtering.** Read `LOG_LEVEL` (one of `debug|info|warn|error`, default `info`) once at startup. In the console fanout in `log-writer.ts`, render only when `rank(level) >= rank(threshold)`. The **JSONL sink is unaffected** — it always writes every event, with the resolved `level` included as a field, so the archive is complete and downstream-filterable.

### Layer 3 — The default view, by signal

With levels assigned, the default `info` view *is* the four-signal narrative; `debug` is the opt-in firehose.

| Signal | Events | Level |
|---|---|---|
| Cortex decisions | hindbrain / forebrain orient / conscious decide / evaluate (`loop.ts`) | `info` |
| Body / tool activity | tool_use (real names now), tool_result, text | `info` |
| Lifecycle & timing | turn/step boundaries (`loop.ts`, `orchestrator.ts`), state bar | `info` |
| Errors | parse failure, rate_limit → `warn`; hard `error` kind → `error` |
| (noise) | thinking, heartbeat, docker exec command, step_start/init, passthrough | `debug` |

**Render polish:** today `error` events are *dimmed* in `renderEvent` (`console-renderer.ts:97`) — de-emphasizing failures, which is backwards. `warn`/`error` should get a visible marker/color (not DIM) so they stand out in the stream.

## Verbosity control

Single env var `LOG_LEVEL=debug|info|warn|error`, default `info`. Affects **console only**. No CLI flag in this iteration (env is sufficient; a flag can wrap it later if wanted). JSONL is always complete.

## Affected files (summary)

| File | Change |
|---|---|
| `logging/events.ts` | add `level` to event model; set `debug` on init, `warn` on rate_limit in the mapper |
| `logging/stream-normalizer.ts` | fix `normalizeOpenCode` tool field paths |
| `logging/stream-normalizer.test.ts` | replace fake OpenCode tool fixture with real shape |
| `logging/log-writer.ts` | resolve level (`event.level ?? classifyLevel`); threshold-filter console; write `level` into JSONL; `logToConsole` gains `level` param |
| `logging/console-renderer.ts` | `classifyLevel` (or a new `logging/levels.ts`); make warn/error visible not dimmed |
| `core/limbic/hypothalamus/process-runner.ts` | docker-exec command log → `debug` |
| `core/limbic/hypothalamus/transport.ts` | heartbeat log → `debug` |
| `cortex/tiers.ts` | orient parse-failure log → `warn` |
| `domain-spacemolt/src/renderer.ts` | route state bar through `CharacterLog` at `info`, drop `\r`/stderr |

## Testing

- `classifyLevel` — table test over representative events of each kind/override.
- Threshold filter — events below threshold are suppressed from console but still written to JSONL.
- `normalizeOpenCode` — against the **real** captured Part fixture; asserts name = `part.tool`, input = `part.state.input`.
- Status bar — emits a newline-terminated `info` event through the pipeline (no raw stderr/`\r`).

## Related work (out of this spec)

The forebrain **orient parse failure** ("situation unknown") is a separate harness-correctness bug being fixed concurrently: forebrain (Qwen3.5-9B on mlx_lm 0.31.2) keeps `enable_thinking: true` but its `maxTokens` is raised from 4096 → 16384 so the chain-of-thought plus trailing JSON both fit. `response_format`/schema-constrained decoding is **not** available on mlx_lm 0.31.2 (silently dropped) and is intentionally not used. This spec's Layer 2 will surface that parse failure at `warn` so it's visible if it recurs.
