# Chat Channels: Domain Chat via Claude Code Channels

## Overview

Replace domain-specific chat mechanisms (e.g., SpaceMolt's `sm chat` CLI) with Claude Code channel plugins. Each domain builds a custom channel plugin that bridges its native chat system. External platforms (Discord, Telegram) use the official Claude Code channel plugins as-is. No mirroring between channels — each channel is independent, and the agent sees messages from each source separately.

## Motivation

Characters currently interact with chat through domain-specific CLI tools running inside Docker (e.g., `sm chat local "hello"` via Bash). This has two problems:

1. The host has no visibility into outbound chat — it can't log, intercept, or observe what the agent says
2. Chat is tightly coupled to the domain's CLI tooling rather than being a standard infrastructure concern

By building domain chat as a Claude Code channel plugin, we get:
- Standard inbound/outbound interface (`<channel>` tags + `reply` tool)
- Host-side control over the chat connection (persistent, observable)
- The ability to add external channels (Discord, Telegram) via official plugins with zero custom code
- A consistent chat experience across domains

## Architecture

Each chat source is an independent Claude Code channel. No bus, no mirroring, no custom HTTP API. Channels are self-contained MCP servers that Claude Code spawns as subprocesses.

### Domain Channel Plugins

Each domain builds a channel plugin that bridges its native chat system. The plugin:

1. Declares `claude/channel` capability (and optionally `tools` for the `reply` tool)
2. Connects to the domain's chat backend (game WebSocket, GitHub API, etc.)
3. Pushes inbound messages as `notifications/claude/channel`
4. Exposes a `reply` tool for outbound messages

**Key constraint**: The channel plugin runs inside Docker as a subprocess of `claude -p`. Each `runTurn` is a fresh invocation, so the plugin starts and stops each turn. Persistent connections (like the game WebSocket) live on the host — the plugin communicates with the host to send/receive chat.

For SpaceMolt, this means:
- The game WebSocket connection already lives on the host (`game-socket-impl.ts`)
- The channel plugin needs a lightweight way to get recent chat messages from the host and send outbound chat through the host
- A simple HTTP endpoint on the host serves this purpose — but it's specific to SpaceMolt's domain, not a core ChatBus

### External Channels (Discord, Telegram)

Use the official Claude Code channel plugins directly:
- `plugin:discord@claude-plugins-official`
- `plugin:telegram@claude-plugins-official`

These are installed and configured per the Claude Code docs. No custom code needed. The agent sees `<channel source="discord">` messages and can reply via the Discord plugin's reply tool.

### What the Agent Sees

Messages from different channels arrive independently:

```
<channel source="spacemolt-chat" sender="Explorer42" channel="local">found a cave to the north</channel>
<channel source="discord" sender="viewer_jane" chat_id="12345">nice play on that last fight!</channel>
```

The agent responds through whichever channel the message came from:

```
mcp__spacemolt-chat__reply({ text: "heading to that cave!", channel: "local" })
mcp__discord__reply({ text: "thanks!", chat_id: "12345" })
```

System prompts guide the agent on when to use which channel.

### Host-Side Chat Bridge (per domain)

Each domain that needs a channel plugin also needs a host-side component to bridge persistent connections to the ephemeral plugin. This is a domain concern, not core infrastructure.

For SpaceMolt:
- The host already has a WebSocket connection to the game server
- A small HTTP endpoint on the host exposes recent chat messages and accepts outbound sends
- The channel plugin inside Docker connects to this endpoint via `host.docker.internal`
- The endpoint is started/stopped as part of SpaceMolt's domain lifecycle

```
Host side (persistent):
  game-socket-impl.ts (existing WebSocket)
    ↓ filters chat_message events
  SpaceMolt chat HTTP bridge (new, domain-owned)
    ↓ GET /chat?since=<ts> — recent messages
    ↓ POST /chat — send outbound

Container side (ephemeral, per turn):
  SpaceMolt channel plugin (new, domain-owned)
    ↓ polls host bridge for messages → pushes as <channel> notifications
    ↓ reply tool → POSTs to host bridge → host sends via game API
```

## Core/Domain Boundary

**Core owns nothing chat-specific.** Chat is handled entirely by:
- Claude Code's built-in channel infrastructure (notifications, reply tools)
- Domain-specific channel plugins and host-side bridges
- Official third-party channel plugins (Discord, Telegram)

**Domains own:**
- Their channel plugin implementation
- Their host-side chat bridge (HTTP endpoint or equivalent)
- Prompt updates to instruct agents on channel usage
- Any chat-related configuration

Core's only involvement is passing `--channels` flags or `.mcp.json` configuration to the `claude -p` subprocess so the channel plugins are loaded.

## SpaceMolt Implementation

### New files

- `packages/domain-spacemolt/src/chat-bridge.ts` — Host-side HTTP endpoint that exposes game chat over HTTP. Filters `chat_message` events from the existing WebSocket connection into a ring buffer. Accepts outbound sends and calls the game REST API.
- `packages/domain-spacemolt/src/chat-channel/` — The channel plugin (TypeScript, runs inside Docker). Declares `claude/channel`, polls the host bridge, exposes `reply` tool.

### Modified files

- `packages/domain-spacemolt/src/phases.ts` — Start chat bridge in startup phase, configure channel plugin in `.mcp.json`
- `packages/domain-spacemolt/src/prompts/in-game-claude.md` — Replace `sm chat` instructions with channel `reply` tool usage
- `packages/domain-spacemolt/src/prompt-builder.ts` — Update TOOL_DOCS for chat
- `packages/domain-spacemolt/src/config.ts` — Mount channel plugin source into container

### Modified files (core, minimal)

- `packages/core/src/core/limbic/hypothalamus/process-runner.ts` — Pass `--channels` flag or ensure `.mcp.json` with channel config is in the working directory when invoking `claude -p`

## Configuration

### SpaceMolt channel

The chat bridge reads credentials from the existing `players/<character>/me/credentials.txt` to authenticate outbound chat with the game API.

The channel plugin is configured via `.mcp.json` written to the character's working directory:

```json
{
  "mcpServers": {
    "spacemolt-chat": {
      "command": "bun",
      "args": ["/work/spacemolt-chat-channel/index.ts"],
      "env": {
        "CHAT_BRIDGE_URL": "http://host.docker.internal:<port>"
      }
    }
  }
}
```

### External channels (Discord, Telegram)

Configured via standard Claude Code plugin installation — see [Claude Code channels docs](https://code.claude.com/docs/en/channels). No custom configuration in this project.

## Error Handling

- **Channel plugin can't reach host bridge**: The `reply` tool fails as a normal MCP tool error. The agent sees the failure and can retry.
- **Game API send failure**: The host bridge logs the error and returns a failure to the channel plugin, which surfaces it to the agent.
- **Chat bridge lifecycle**: Started/stopped with the domain's phase lifecycle. Uses `Scope.addFinalizer` for cleanup.

## Testing

### SpaceMolt domain tests

- **Chat bridge**: Start bridge, mock WebSocket chat events, verify GET returns them. POST outbound, verify game API call.
- **Channel plugin**: End-to-end test against a mock bridge. Verify notifications pushed, verify reply tool sends correctly.

### No core tests needed

Core has no chat-specific code to test.

## Known Limitations

- **No mirroring between channels**: Discord and in-game chat are independent. A message on Discord is not automatically sent in-game and vice versa. Could be added later as a dedicated bridge channel.
- **Channel plugin is ephemeral**: Reconnects to the host bridge each turn. Acceptable because the host bridge is persistent and maintains a message buffer.
- **External channels require manual setup**: Discord/Telegram plugins must be installed and configured per the Claude Code docs. This is a one-time setup, not automated by the orchestrator.
- **Cross-domain communication**: Not addressed. Each domain has its own channel. A future cross-domain chat layer could be built as a separate channel that bridges between domains.
