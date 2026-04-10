# Unified Event Log

All observable activity across a character's session — orchestrator lifecycle, LLM output, tool calls, subagent work, WebSocket events — flows through a single `emit()` call that writes to one log file (`events.jsonl`) and renders to stdout. No other log files are produced.

## UnifiedEvent type

New file: `packages/core/src/logging/events.ts`

```typescript
interface EventBase {
  timestamp: string
  character: string
  system: string     // top-level origin
  subsystem: string  // specific component
}

type UnifiedEvent = EventBase & (
  | { kind: "system"; message: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; tool: string; id: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; text: string }
  | { kind: "subagent_start"; description: string; data: unknown }
  | { kind: "subagent_stop"; data: unknown }
  | { kind: "error"; message: string }
)
```

### system / subsystem mapping

| Log site | system | subsystem |
|----------|--------|-----------|
| Phase runner lifecycle | `orchestrator` | `phase-runner` |
| Channel session loop | `orchestrator` | `channel-session` |
| Interrupt evaluation | `orchestrator` | `interrupt` |
| WebSocket connect/close/login | `orchestrator` | `ws` |
| Reflection/dream | `orchestrator` | `reflection` |
| Session runner lifecycle | `session` | `runner` |
| Session channel push events | `session` | `channel` |
| Main session stream-json | `session` | `claude` |
| Process runner (brain) lifecycle | `brain` | `runner` |
| Brain stream-json | `brain` | `claude` |
| activity.log hook events | `subagent` | `claude` |

## CharacterLog service

Rewrite `packages/core/src/logging/log-writer.ts`.

Collapse from 4 methods (`thought`, `word`, `action`, `raw`) to one:

```typescript
interface CharacterLog {
  emit(char: CharacterConfig, event: UnifiedEvent): Effect<void, LogWriterError>
}
```

`emit` does two things:
1. Appends `JSON.stringify(event) + "\n"` to `players/<name>/logs/events.jsonl`
2. Calls `renderEvent(event)` and prints each returned line to stdout

One log file replaces the previous four (`stream.jsonl`, `thoughts.jsonl`, `actions.jsonl`, `words.jsonl`).

## Console renderer

Rewrite `packages/core/src/logging/console-renderer.ts`.

Core becomes a pure function:

```typescript
function renderEvent(event: UnifiedEvent): string[]
```

Dispatches on `event.kind` to produce ANSI-colored console lines. Existing rendering logic (tag colors, name bolding, tool_result truncation, thinking dimming) moves into this function.

`logToConsole` becomes a convenience wrapper that builds a `{ kind: "system" }` event and calls `emit`. All existing `logToConsole(name, source, message)` call sites keep their current signature but gain the `system`/`subsystem` split — the wrapper maps old source strings to the appropriate system+subsystem pair, or call sites are updated to pass both explicitly.

Tag format for console: `[character:subsystem]` by default (e.g., `[kvothe:ws]`, `[kvothe:claude]`). The full `system` field is always present in the log file for filtering.

## Stream-json adapter

`packages/core/src/logging/stream-normalizer.ts` stays unchanged — it still parses raw stream-json into `InternalEvent[]`.

A thin adapter function maps `InternalEvent` → `UnifiedEvent`, adding `timestamp`, `character`, `system`, and `subsystem` fields:

```typescript
function toUnifiedEvents(
  events: InternalEvent[],
  character: string,
  system: string,
  subsystem: string,
): UnifiedEvent[]
```

This replaces the current `demuxEvents` function. `log-demux.ts` is deleted.

## Activity.log tail fiber

In `session-runner.ts`, after starting the claude process, fork a fiber that watches the host-side `players/<name>/logs/activity.log` file (the container writes to a mounted volume, so it's directly readable on the host).

On each new JSONL line, parse and emit as a `UnifiedEvent`:
- Hook events with `event: "tool_use"` → `{ kind: "tool_use", system: "subagent", subsystem: "claude", ... }`
- Hook events with `event: "subagent_start"` → `{ kind: "subagent_start", system: "session", subsystem: "claude", ... }`
- Hook events with `event: "subagent_stop"` → `{ kind: "subagent_stop", system: "session", subsystem: "claude", ... }`

The tail fiber uses `fs.watch` or polling (whichever is more reliable on the mounted volume) to detect new lines.

## Producer changes

### session-runner.ts
- `streamFiber`: replace `normalizeClaude → demuxEvents` with `normalizeClaude → toUnifiedEvents → emit`
- Remove `log.raw()` calls (stream.jsonl no longer exists)
- Add activity.log tail fiber after spawning the claude process
- `logToConsole` calls use `system: "session"` with appropriate subsystem

### process-runner.ts
- Same streamFiber change as session-runner
- Remove `log.raw()` calls
- `logToConsole` calls use `system: "brain"` with appropriate subsystem

### channel-session.ts
- `logToConsole` calls use `system: "orchestrator"`, `subsystem: "channel-session"` or `"interrupt"`
- No other structural changes — it already uses logToConsole for everything

### phases.ts (SpaceMolt)
- `logToConsole` calls use `system: "orchestrator"`, `subsystem: "phase-runner"` or `"ws"` or `"reflection"`

### game-socket-impl.ts
- Direct `console.log` calls in WS handlers need to route through emit
- These are in sync callbacks (WebSocket `on("close")`, etc.), so they'll need a sync emit path or a queued approach

## Files deleted

- `packages/core/src/logging/log-demux.ts` — absorbed into emit + renderEvent
- Host-side log files: `stream.jsonl`, `thoughts.jsonl`, `actions.jsonl`, `words.jsonl` — replaced by `events.jsonl`

## Files unchanged

- `packages/core/src/logging/stream-normalizer.ts` — still parses stream-json
- `packages/domain-spacemolt/src/docker/claude-settings.json` — hooks still write to activity.log inside container

## Sync emit in WebSocket callbacks

`game-socket-impl.ts` uses `console.log` inside WebSocket event handlers (sync callbacks outside Effect fibers). These will use `runFork` from the captured runtime to emit events — consistent with how the file already handles Deferred/Queue operations in WS callbacks.
