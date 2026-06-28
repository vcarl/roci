# Full Prompt+Response Archival in events.jsonl — Design

**Date:** 2026-06-27
**Status:** Draft for review
**Builds on:** the leveled-logging system (`LOG_LEVEL` threshold, `events.jsonl` is never filtered).

## Problem

`events.jsonl` is supposed to be the complete, unadulterated record we use to tune prompts and monitor agent behavior. Today it isn't:

1. **Pre-store truncation corrupts the archive.** Two call sites shorten content *before* it's stored, so jsonl permanently loses it:
   - `cortex/tiers.ts` — forebrain parse-failure slices raw output to 2000 chars (`RAW_FOREBRAIN_LOG_LIMIT`) and embeds `[truncated N chars]` into the stored message.
   - `limbic/hypothalamus/transport.ts:190` — process `stderr` sliced to 500 chars before logging.
2. **The cortex tiers barely capture anything.** On the **success** path none of the four tiers (hindbrain/observe, forebrain/orient, conscious/decide, conscious/evaluate) log their model output — only a one-line parsed headline (`forebrain: <headline>`). `callTier` (`tiers.ts:55-64`) returns `res.text` and discards the prompt, `res.raw`, and `res.usage`. Raw output reaches jsonl only on a forebrain *failure*, and even then truncated. We have almost nothing to tune against.

(The console-renderer truncations — tool_result head/tail, tool_use desc `slice(0,120)` — are render-only and leave jsonl intact. They stay.)

## Goals

- **Invariant: `events.jsonl` stores full, untruncated content. `renderEvent` is the only place that truncates, for console readability.**
- Capture **full prompt+response pairs** for every cortex-tier model call (all four tiers) and for the body/opencode agent, at `debug` level — hidden from the default `info` console view, but always written in full to jsonl.

Non-goals (YAGNI): log rotation/retention (note the volume cost, don't solve it here); capturing a verbatim second copy of every opencode JSON line (the normalized per-event stream already carries full body output — see Part 2.3); a UI/query tool over the archive.

## Design

### Part 1 — Stop corrupting the archive

**1.1 Remove the two pre-store truncations.**
- `tiers.ts` forebrain parse-failure: log the **full** `text` (delete `RAW_FOREBRAIN_LOG_LIMIT` and the slice). Keep it at `warn`.
- `transport.ts:190`: log the **full** `stderr.trim()` (delete `slice(0, 500)`).

**1.2 Add render-time truncation for long lines (console only).** Because the parse-failure event is `warn` (visible by default), storing the full 13 KB must not flood the console. In `console-renderer.ts`, truncate long `system` / `text` / `error` message lines for display: if a line exceeds `CONSOLE_LINE_LIMIT` (≈ 800 chars), show the head plus a ` … (N more chars — full in events.jsonl)` marker. `renderEvent` operates on the event for display only; the stored event is untouched, so jsonl keeps the full text. This generalizes the existing render-only truncation already used for tool results.

### Part 2 — Capture full prompt+response exchanges

**2.1 New event kind.** Add to `UnifiedEvent` (`events.ts`):
```ts
| { kind: "exchange"; channel: string; step: string; prompt: string; response: string; meta?: Record<string, unknown> }
```
- `channel`: `"cortex"` | `"body"`. `step`: `"observe"|"orient"|"decide"|"evaluate"` for cortex; `"act"` (or the task name) for the body.
- `prompt` / `response`: full, untruncated strings.
- `meta`: optional bag (e.g. token usage, model id, tier).
- `classifyLevel(exchange) → "debug"` (so it's hidden from default console, full in jsonl).
- `renderEvent` exchange case: a compact one-line preview only — e.g. `[char:channel] ⟳ <step> prompt=<N>c resp=<N>c` followed by a short head of the response (subject to `CONSOLE_LINE_LIMIT`). The full prompt/response live only in jsonl.

**2.2 Cortex tiers — emit in `callTier`.** `callTier` is the single chokepoint for all four tiers. Changes (`tiers.ts`):
- Add a `step: "observe"|"orient"|"decide"|"evaluate"` parameter (callers pass it; this disambiguates conscious's decide vs evaluate, which share `tier:"conscious"`).
- After `res = yield* svc.withTier(...)(...)`, emit an `exchange` event: `{ channel:"cortex", step, prompt, response: res.text, meta: { tier, model: handle.model, usage: res.usage } }` via `CharacterLog`. Swallow log-write errors (must never crash the loop), matching the existing parse-failure pattern.
- This adds `CharacterLog` to `callTier`'s requirements, which propagates to the `runHindbrain` / `runConsciousDecide` / `runConsciousEvaluate` signatures (their `R` channel gains `CharacterLog`). `runForebrain` already has it. Update the four runner signatures and their call sites in `loop.ts` accordingly (the loop already provides `CharacterLog`).
- The existing one-line headline logs (`forebrain: <headline>`, etc.) stay as the readable `info` narrative — the exchange is an additional `debug` record.

**2.3 Body/opencode.** The transport already emits every normalized stream event (text/tool_use/tool_result, and non-JSON lines verbatim) with **full** content to jsonl, so the body's *output* is already archived per-event. The gaps:
- **Prompt:** the body's task prompt is currently only embedded inside the logged `docker …` command string. Emit a clean `exchange`-style record of the body's task prompt where the body run is initiated (the cortex loop / process-runner that builds the task), at `debug`. (The implementer locates the exact construction site; the task string is the `# Task: …` payload.)
- **Output:** keep the existing per-event capture (it is already full and untruncated). Optionally also set the body exchange's `response` to the transport's accumulated `output` so prompt and a consolidated response sit in one record; the granular per-event stream remains for detail.
- Apply 1.1/1.2 so the stderr line and any long body system lines are full in jsonl.

## Volume note (accepted)

Capturing full prompts+responses for every tier on every tick (forebrain with thinking can be 10 KB+) grows `events.jsonl` substantially. This is the intended cost of a complete archive; it stays out of the console by being `debug`. Log rotation/retention is explicitly deferred.

## Affected files

| File | Change |
|---|---|
| `logging/events.ts` | add `exchange` kind |
| `logging/levels.ts` | `classifyLevel`: `exchange → debug` |
| `logging/console-renderer.ts` | `CONSOLE_LINE_LIMIT` long-line truncation (system/text/error); `exchange` compact render case |
| `cortex/tiers.ts` | remove `RAW_FOREBRAIN_LOG_LIMIT`; `callTier` gains `step`, emits `exchange`; runner signatures gain `CharacterLog` |
| `cortex/loop.ts` | pass `step` through; satisfy updated runner signatures |
| `limbic/hypothalamus/transport.ts` | remove stderr `slice(0,500)`; (optional) body exchange `response` from accumulated output |
| `limbic/hypothalamus/process-runner.ts` (or body-run site) | emit body task-prompt `exchange` at debug |

## Testing

- `classifyLevel(exchange) === "debug"`.
- `renderEvent` exchange → compact preview; long system/text/error line → head + `… (N more chars — full in events.jsonl)`; assert the **stored** event is unchanged (full text) while the rendered string is truncated.
- `callTier` emits an exchange with the full prompt and full `res.text` (assert via a captured `CharacterLog` test double); a forebrain parse-failure stores the **full** raw output (no `[truncated]`).
- Body: stderr over 500 chars is stored in full; the body task-prompt exchange is emitted.
```
