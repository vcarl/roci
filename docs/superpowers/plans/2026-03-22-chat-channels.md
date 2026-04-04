# Chat Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SpaceMolt's `sm chat` CLI with a Claude Code channel plugin so chat flows through standard channel infrastructure, and add the ability to use official Discord/Telegram channel plugins alongside it.

**Architecture:** A SpaceMolt-specific channel plugin runs inside Docker as a subprocess of `claude -p`. It communicates with a host-side HTTP chat bridge that taps into the existing game WebSocket connection. Core gets a minimal change to pass `--channels` config through to the `claude` subprocess. External channels (Discord, Telegram) use official plugins with no custom code.

**Tech Stack:** TypeScript, Effect-TS, `@modelcontextprotocol/sdk`, Bun (channel plugin runtime inside Docker), Node `http` (host-side chat bridge), Vitest (tests)

**Spec:** `docs/superpowers/specs/2026-03-22-chatbus-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `packages/domain-spacemolt/src/chat-bridge.ts` | Host-side HTTP server (Node `http.createServer`) that exposes game chat over HTTP. Buffers recent messages in a ring buffer, accepts outbound sends via the game REST API. |
| `packages/domain-spacemolt/src/chat-bridge.test.ts` | Unit tests for the chat bridge. |
| `packages/domain-spacemolt/src/chat-channel/index.ts` | Channel plugin MCP server (runs inside Docker via Bun). Declares `claude/channel`, polls the host bridge for messages, exposes a `reply` tool. |
| `packages/domain-spacemolt/src/chat-channel/package.json` | Dependencies for the channel plugin (`@modelcontextprotocol/sdk`). Installed inside Docker. |
| `packages/domain-spacemolt/src/chat-channel/chat-channel.test.ts` | Unit tests for the channel plugin reply tool and polling logic. |
| `packages/domain-spacemolt/vitest.config.ts` | Vitest config for domain-spacemolt tests. |

### Modified files

| File | Change |
|------|--------|
| `packages/core/src/core/limbic/hypothalamus/types.ts:5-23,33-53` | Add optional `channels` field to `TurnConfig` and `CycleConfig`. |
| `packages/core/src/core/limbic/hypothalamus/process-runner.ts:100-110` | Pass `--channels` flag to `claude -p` when `config.channels` is set. |
| `packages/core/src/core/limbic/hypothalamus/cycle-runner.ts` | Thread `channels` from `CycleConfig` to body `TurnConfig`. |
| `packages/core/src/core/orchestrator/state-machine.ts:26-41,118-126` | Add `channels` to `StateMachineConfig` and to the `spawnConfig` object. |
| `packages/core/src/core/orchestrator/planning/subagent-manager.ts:314-325` | Thread `channels` from `spawnConfig` to the `runTurn` call. |
| `packages/domain-spacemolt/src/phases.ts:31-169,187-226` | Start chat bridge in startup phase, write `.mcp.json`, pass `channels` to `runStateMachine`. |
| `packages/domain-spacemolt/src/config.ts:14-45,176` | Add container mount for channel plugin source. |
| `packages/domain-spacemolt/src/event-processor.ts:67-78` | Push chat messages to the chat bridge callback when processing `chat_message` events. |
| `packages/domain-spacemolt/src/prompts/in-game-claude.md:99,210-222` | Replace `sm chat` instructions with channel `reply` tool. |
| `packages/domain-spacemolt/src/prompt-builder.ts:22` | Update `TOOL_DOCS` to mention the chat channel reply tool. |
| `packages/domain-spacemolt/package.json` | Add `vitest` devDependency. |

---

## Task 1: Add `channels` config to core types

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/types.ts`
- Modify: `packages/core/src/core/orchestrator/state-machine.ts:26-41`

- [ ] **Step 1: Add `channels` to `TurnConfig`**

In `packages/core/src/core/limbic/hypothalamus/types.ts`, add after the `disallowedTools` field (line 22):

```typescript
  /** Channel server entries to pass via --channels (e.g. "server:spacemolt-chat"). */
  channels?: string[]
```

- [ ] **Step 2: Add `channels` to `CycleConfig`**

In the same file, add after the `brainDisallowedTools` field (line 52):

```typescript
  /** Channel server entries to pass via --channels to the body turn. */
  channels?: string[]
```

- [ ] **Step 3: Add `channels` to `StateMachineConfig`**

In `packages/core/src/core/orchestrator/state-machine.ts`, add to the `StateMachineConfig` interface (after `addDirs` at line 32):

```typescript
  /** Channel server entries to pass via --channels to subagent turns. */
  channels?: string[]
```

- [ ] **Step 4: Verify build passes**

Run: `cd /Users/vcarl/workspace/roci && pnpm build`
Expected: Clean build — these are optional fields, no callers need to change yet.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/types.ts packages/core/src/core/orchestrator/state-machine.ts
git commit -m "feat: add channels config to TurnConfig, CycleConfig, and StateMachineConfig"
```

---

## Task 2: Thread `channels` through the execution paths

Both the state-machine path (SpaceMolt) and the cycle-runner path (GitHub) need to pass `channels` to `runTurn`.

**Files:**
- Modify: `packages/core/src/core/limbic/hypothalamus/process-runner.ts:100-110`
- Modify: `packages/core/src/core/limbic/hypothalamus/cycle-runner.ts`
- Modify: `packages/core/src/core/orchestrator/state-machine.ts:118-126`
- Modify: `packages/core/src/core/orchestrator/planning/subagent-manager.ts:314-325`

- [ ] **Step 1: Add `--channels` flag to process-runner.ts**

In `packages/core/src/core/limbic/hypothalamus/process-runner.ts`, after the `addDirs` block (line 104), add:

```typescript
      if (config.channels && config.channels.length > 0) {
        claudeArgs.push("--dangerously-load-development-channels", ...config.channels)
      }
```

Note: Using `--dangerously-load-development-channels` because our custom channel won't be on Claude Code's approved allowlist. Can switch to `--channels` if/when the channel is approved.

- [ ] **Step 2: Thread `channels` through `spawnConfig` in state-machine.ts**

In `packages/core/src/core/orchestrator/state-machine.ts`, add `channels` to the `spawnConfig` object at line 118-126:

```typescript
    const spawnConfig = {
      char: config.char,
      containerId: config.containerId,
      playerName: config.playerName,
      containerEnv: config.containerEnv,
      addDirs: config.addDirs,
      channels: config.channels,   // <-- add this
      tickIntervalSec: config.tickIntervalSec,
      modeRef,
    }
```

- [ ] **Step 3: Thread `channels` to `runTurn` in subagent-manager.ts**

In `packages/core/src/core/orchestrator/planning/subagent-manager.ts`, add `channels` to the `runTurn` call at line 314-325:

```typescript
        const result = yield* runTurn({
          char: smConfig.char,
          containerId: smConfig.containerId,
          playerName: smConfig.playerName,
          systemPrompt,
          prompt,
          model: finalStep.model,
          timeoutMs: finalStep.timeoutTicks * smConfig.tickIntervalSec * 1000,
          env: smConfig.containerEnv,
          addDirs: smConfig.addDirs,
          channels: smConfig.channels,   // <-- add this
          role: "brain",
        })
```

- [ ] **Step 4: Thread `channels` through cycle-runner.ts to body turn**

Read `packages/core/src/core/limbic/hypothalamus/cycle-runner.ts` and find where `runTurn` is called for the body. Add `channels: config.channels` to the body `TurnConfig`. Only the body gets channels (the brain is the planner, the body interacts with the world).

- [ ] **Step 5: Verify build passes**

Run: `cd /Users/vcarl/workspace/roci && pnpm build`
Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/core/limbic/hypothalamus/process-runner.ts packages/core/src/core/limbic/hypothalamus/cycle-runner.ts packages/core/src/core/orchestrator/state-machine.ts packages/core/src/core/orchestrator/planning/subagent-manager.ts
git commit -m "feat: thread channels config through state-machine and cycle-runner to runTurn"
```

---

## Task 3: Set up vitest for domain-spacemolt

**Files:**
- Create: `packages/domain-spacemolt/vitest.config.ts`
- Modify: `packages/domain-spacemolt/package.json`

- [ ] **Step 1: Create vitest config**

Create `packages/domain-spacemolt/vitest.config.ts` (matching the pattern from `packages/core/vitest.config.ts`):

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
});
```

- [ ] **Step 2: Add vitest devDependency**

```bash
cd /Users/vcarl/workspace/roci/packages/domain-spacemolt && pnpm add -D vitest
```

- [ ] **Step 3: Verify vitest runs (no tests yet is fine)**

Run: `cd /Users/vcarl/workspace/roci && pnpm vitest --run --project domain-spacemolt`
Expected: "No test files found" or similar — confirms vitest is configured.

- [ ] **Step 4: Commit**

```bash
git add packages/domain-spacemolt/vitest.config.ts packages/domain-spacemolt/package.json pnpm-lock.yaml
git commit -m "chore(spacemolt): add vitest configuration"
```

---

## Task 4: Build the host-side chat bridge

The host-side HTTP server that buffers chat messages and accepts outbound sends. Uses Node's `http.createServer` (the host runs Node, not Bun).

**Files:**
- Create: `packages/domain-spacemolt/src/chat-bridge.ts`
- Create: `packages/domain-spacemolt/src/chat-bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/domain-spacemolt/src/chat-bridge.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { ChatBridge, type ChatBridgeMessage } from "./chat-bridge.js"

describe("ChatBridge", () => {
  describe("message buffering", () => {
    it("buffers inbound chat messages", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const bridge = yield* ChatBridge.make({
            port: 0,
            sendChat: () => Effect.void,
          })

          yield* bridge.pushInbound({
            source: "in-game",
            sender: "Explorer42",
            content: "hello world",
            channel: "local",
            timestamp: 1000,
          })

          const messages = yield* bridge.getMessages(0)
          expect(messages).toHaveLength(1)
          expect(messages[0]).toMatchObject({
            sender: "Explorer42",
            content: "hello world",
            channel: "local",
          })

          yield* bridge.shutdown()
        })
      )
    })

    it("filters by timestamp", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const bridge = yield* ChatBridge.make({
            port: 0,
            sendChat: () => Effect.void,
          })

          yield* bridge.pushInbound({
            source: "in-game", sender: "A", content: "old",
            channel: "local", timestamp: 1000,
          })
          yield* bridge.pushInbound({
            source: "in-game", sender: "B", content: "new",
            channel: "local", timestamp: 2000,
          })

          const messages = yield* bridge.getMessages(1500)
          expect(messages).toHaveLength(1)
          expect(messages[0].sender).toBe("B")

          yield* bridge.shutdown()
        })
      )
    })

    it("caps buffer at 100 messages", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const bridge = yield* ChatBridge.make({
            port: 0,
            sendChat: () => Effect.void,
          })

          for (let i = 0; i < 110; i++) {
            yield* bridge.pushInbound({
              source: "in-game", sender: `user${i}`, content: `msg${i}`,
              channel: "local", timestamp: i,
            })
          }

          const messages = yield* bridge.getMessages(0)
          expect(messages).toHaveLength(100)
          expect(messages[0].sender).toBe("user10")

          yield* bridge.shutdown()
        })
      )
    })
  })

  describe("HTTP API", () => {
    it("GET /messages returns buffered messages", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const bridge = yield* ChatBridge.make({
            port: 0,
            sendChat: () => Effect.void,
          })

          yield* bridge.pushInbound({
            source: "in-game", sender: "Test", content: "hello",
            channel: "local", timestamp: 1000,
          })

          const res = await fetch(
            `http://127.0.0.1:${bridge.port}/messages?since=0`
          )
          const messages = await res.json()
          expect(messages).toHaveLength(1)
          expect(messages[0].content).toBe("hello")

          yield* bridge.shutdown()
        })
      )
    })

    it("POST /send calls sendChat callback", async () => {
      let captured: { message: string; channel?: string } | null = null

      await Effect.runPromise(
        Effect.gen(function* () {
          const bridge = yield* ChatBridge.make({
            port: 0,
            sendChat: (message, channel) =>
              Effect.sync(() => { captured = { message, channel } }),
          })

          await fetch(`http://127.0.0.1:${bridge.port}/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "hello", channel: "local" }),
          })

          expect(captured).toEqual({ message: "hello", channel: "local" })

          yield* bridge.shutdown()
        })
      )
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/vcarl/workspace/roci && pnpm vitest --run packages/domain-spacemolt/src/chat-bridge.test.ts`
Expected: FAIL — `ChatBridge` module not found.

- [ ] **Step 3: Implement the ChatBridge**

Create `packages/domain-spacemolt/src/chat-bridge.ts`. Uses Node's `http.createServer` (NOT Bun — the host runs Node):

```typescript
import { Effect, Ref } from "effect"
import * as http from "node:http"

export interface ChatBridgeMessage {
  readonly source: string
  readonly sender: string
  readonly content: string
  readonly channel?: string
  readonly timestamp: number
}

interface ChatBridgeConfig {
  readonly port: number
  readonly sendChat: (content: string, channel?: string) => Effect.Effect<void>
}

const BUFFER_CAPACITY = 100

export const ChatBridge = {
  make: (config: ChatBridgeConfig) =>
    Effect.gen(function* () {
      const bufferRef = yield* Ref.make<ChatBridgeMessage[]>([])

      const pushInbound = (msg: ChatBridgeMessage) =>
        Ref.update(bufferRef, (buf) => {
          const next = [...buf, msg]
          return next.length > BUFFER_CAPACITY
            ? next.slice(next.length - BUFFER_CAPACITY)
            : next
        })

      const getMessages = (since: number) =>
        Ref.get(bufferRef).pipe(
          Effect.map((buf) => buf.filter((m) => m.timestamp > since))
        )

      const { server, port: actualPort } = yield* Effect.async<
        { server: http.Server; port: number },
        Error
      >((resume) => {
        const srv = http.createServer(async (req, res) => {
          const url = new URL(req.url ?? "/", `http://127.0.0.1`)

          if (req.method === "GET" && url.pathname === "/messages") {
            const since = Number(url.searchParams.get("since") ?? "0")
            const messages = await Effect.runPromise(getMessages(since))
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify(messages))
            return
          }

          if (req.method === "POST" && url.pathname === "/send") {
            let body = ""
            for await (const chunk of req) body += chunk
            const { message, channel } = JSON.parse(body) as {
              message: string
              channel?: string
            }
            await Effect.runPromise(config.sendChat(message, channel))
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ ok: true }))
            return
          }

          res.writeHead(404)
          res.end("not found")
        })

        srv.listen(config.port, "127.0.0.1", () => {
          const addr = srv.address()
          const p = typeof addr === "object" && addr ? addr.port : config.port
          resume(Effect.succeed({ server: srv, port: p }))
        })
      })

      const shutdown = Effect.async<void>((resume) => {
        server.close(() => resume(Effect.void))
      })

      return { pushInbound, getMessages, shutdown, port: actualPort }
    }),
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/vcarl/workspace/roci && pnpm vitest --run packages/domain-spacemolt/src/chat-bridge.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain-spacemolt/src/chat-bridge.ts packages/domain-spacemolt/src/chat-bridge.test.ts
git commit -m "feat(spacemolt): add host-side chat bridge with HTTP API"
```

---

## Task 5: Build the channel plugin

The MCP server that runs inside Docker, spawned by Claude Code as a channel subprocess.

**Files:**
- Create: `packages/domain-spacemolt/src/chat-channel/index.ts`
- Create: `packages/domain-spacemolt/src/chat-channel/package.json`
- Create: `packages/domain-spacemolt/src/chat-channel/chat-channel.test.ts`

- [ ] **Step 1: Create package.json for the channel plugin**

Create `packages/domain-spacemolt/src/chat-channel/package.json`:

```json
{
  "name": "spacemolt-chat-channel",
  "private": true,
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

- [ ] **Step 2: Create the channel plugin**

Create `packages/domain-spacemolt/src/chat-channel/index.ts`:

```typescript
#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

const BRIDGE_URL =
  process.env.CHAT_BRIDGE_URL ?? "http://host.docker.internal:9200"
const POLL_INTERVAL_MS = 3000

const mcp = new Server(
  { name: "spacemolt-chat", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      'Chat messages arrive as <channel source="spacemolt-chat" sender="..." channel="...">.',
      "Reply with the reply tool. Pass the channel (local, system, faction, or private).",
      'For private messages, use channel "private:<player_id>".',
      "You are a spaceship pilot — stay in character when chatting.",
    ].join(" "),
  },
)

// --- Reply tool ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a chat message in the game. Use channel: local (same POI), system (system-wide), faction, or private:<player_id> for DMs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "The message to send" },
          channel: {
            type: "string",
            description:
              'Chat channel: "local", "system", "faction", or "private:<player_id>"',
            default: "local",
          },
        },
        required: ["text"],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { text, channel } = req.params.arguments as {
      text: string
      channel?: string
    }
    const res = await fetch(`${BRIDGE_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, channel: channel ?? "local" }),
    })
    if (!res.ok) {
      return {
        content: [{ type: "text", text: `Failed to send: ${res.statusText}` }],
        isError: true,
      }
    }
    return { content: [{ type: "text", text: "sent" }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

// --- Connect and start polling ---

await mcp.connect(new StdioServerTransport())

let lastTimestamp = Date.now() - 60_000

const poll = async () => {
  try {
    const res = await fetch(`${BRIDGE_URL}/messages?since=${lastTimestamp}`)
    if (!res.ok) return

    const messages = (await res.json()) as Array<{
      source: string
      sender: string
      content: string
      channel?: string
      timestamp: number
    }>

    for (const msg of messages) {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.content,
          meta: {
            sender: msg.sender,
            channel: msg.channel ?? "local",
            via: msg.source,
          },
        },
      })
      if (msg.timestamp > lastTimestamp) {
        lastTimestamp = msg.timestamp
      }
    }
  } catch {
    // bridge unreachable — skip this poll cycle
  }
}

await poll()
setInterval(poll, POLL_INTERVAL_MS)
```

- [ ] **Step 3: Write channel plugin tests**

Create `packages/domain-spacemolt/src/chat-channel/chat-channel.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest"

// Test the reply tool handler and polling logic in isolation.
// These test the logic extracted from the channel plugin, not the
// full MCP server (which requires stdio transport).

describe("channel plugin logic", () => {
  describe("reply handler", () => {
    it("POSTs to the bridge /send endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true })
      global.fetch = mockFetch

      // Simulate what the CallToolRequest handler does
      const bridgeUrl = "http://localhost:9999"
      const text = "hello everyone"
      const channel = "local"

      await fetch(`${bridgeUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, channel }),
      })

      expect(mockFetch).toHaveBeenCalledWith(
        `${bridgeUrl}/send`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ message: "hello everyone", channel: "local" }),
        })
      )
    })
  })

  describe("poll logic", () => {
    it("fetches messages since last timestamp", async () => {
      const messages = [
        { source: "in-game", sender: "Bob", content: "hi", channel: "local", timestamp: 2000 },
      ]
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => messages,
      })
      global.fetch = mockFetch

      const bridgeUrl = "http://localhost:9999"
      let lastTimestamp = 1000

      // Simulate poll
      const res = await fetch(`${bridgeUrl}/messages?since=${lastTimestamp}`)
      const fetched = await res.json()

      expect(mockFetch).toHaveBeenCalledWith(
        `${bridgeUrl}/messages?since=1000`
      )
      expect(fetched).toHaveLength(1)
      expect(fetched[0].sender).toBe("Bob")
    })
  })
})
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/vcarl/workspace/roci && pnpm vitest --run packages/domain-spacemolt/src/chat-channel/chat-channel.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain-spacemolt/src/chat-channel/
git commit -m "feat(spacemolt): add chat channel plugin for Claude Code"
```

---

## Task 6: Feed chat events to the bridge from the event processor

The event processor already handles `chat_message` events. Add a callback so it also pushes them to the chat bridge. This avoids double-consuming from the event queue.

**Files:**
- Modify: `packages/domain-spacemolt/src/event-processor.ts:67-78`

- [ ] **Step 1: Add `onChatMessage` callback to the event processor**

The SpaceMolt event processor is a plain object (not an Effect service with state). The cleanest approach is to accept an optional callback when constructing it. Read the event processor factory and modify it to accept an `onChatMessage` callback:

In `packages/domain-spacemolt/src/event-processor.ts`, modify the `chat_message` case (lines 67-78) to also call the callback:

```typescript
      case "chat_message": {
        const { payload } = smEvent
        // If a chat bridge callback is registered, push the message to it
        if (onChatMessage) {
          onChatMessage({
            source: "in-game",
            sender: payload.sender,
            content: payload.content,
            channel: payload.channel,
            timestamp: payload.timestamp,
          })
        }
        return {
          context: {
            chatMessages: [{
              channel: payload.channel,
              sender: payload.sender,
              content: payload.content,
            }],
          },
        }
      }
```

This requires making the event processor a factory function that accepts the callback, rather than a static object. Check how it's currently constructed and exported — it may already be a factory, or the `SpaceMoltEventProcessorLive` Layer may need to be parameterized.

- [ ] **Step 2: Thread the callback from the phase to the event processor**

The `SpaceMoltEventProcessorLive` Layer is currently part of `spaceMoltDomainBundle` which is assembled statically in `index.ts`. To pass the `chatBridge.pushInbound` callback, the event processor layer needs to be constructed dynamically in the startup phase, after the chat bridge is created.

This means the domain bundle assembly moves from a static export to per-character construction in `phases.ts`. Check if other domains do this — the `domainBundle` is set on `PhaseContext` and might already be constructed per-character.

- [ ] **Step 3: Verify build passes**

Run: `cd /Users/vcarl/workspace/roci && pnpm build`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/domain-spacemolt/src/event-processor.ts
git commit -m "feat(spacemolt): add chat bridge callback to event processor"
```

---

## Task 7: Wire chat bridge into SpaceMolt phases

**Files:**
- Modify: `packages/domain-spacemolt/src/phases.ts`
- Modify: `packages/domain-spacemolt/src/config.ts`

- [ ] **Step 1: Read the `sm` CLI to find the game chat API**

```bash
cat /Users/vcarl/workspace/roci/shared-resources/sm-cli/sm | head -200
```

Find the `chat` subcommand. Note the exact endpoint URL, HTTP method, auth header, and payload format. The chat bridge's `sendChat` callback must match exactly.

- [ ] **Step 2: Add container mount for channel plugin**

In `packages/domain-spacemolt/src/config.ts`, add to the `containerMounts` array:

```typescript
{
  host: path.join(DOMAIN_ROOT, "src/chat-channel"),
  container: "/work/spacemolt-chat-channel",
  readonly: true,
},
```

- [ ] **Step 3: Add `bun install` to container setup**

In `packages/domain-spacemolt/src/config.ts`, in the `containerSetup` callback, add after the existing `ln -sf` command:

```typescript
execSync(`docker exec ${containerId} bash -c "cd /work/spacemolt-chat-channel && bun install --frozen-lockfile 2>/dev/null || bun install"`)
```

- [ ] **Step 4: Start chat bridge in startup phase**

In `packages/domain-spacemolt/src/phases.ts`, in the startup phase, after the WebSocket connection is established, start the chat bridge. Use port 0 for automatic port assignment (supports multiple characters):

```typescript
import { ChatBridge } from "./chat-bridge.js"

// After: const conn = yield* gameSocket.connect(creds, context.char.name)
const chatBridge = yield* ChatBridge.make({
  port: 0,
  sendChat: (message, channel) =>
    // Replace with actual game API call based on sm CLI research (Step 1)
    Effect.tryPromise({
      try: () => fetch(/* game API endpoint */, {
        method: "POST",
        headers: { /* auth headers matching sm CLI */ },
        body: JSON.stringify({ /* payload matching sm CLI */ }),
      }),
      catch: (e) => new Error(`Chat send failed: ${e}`),
    }).pipe(Effect.asVoid),
})
```

**Important:** Both startup paths (registration path ~line 138 and normal login path ~line 154) must start the chat bridge. Extract the bridge setup into a shared helper called after either connection path succeeds.

- [ ] **Step 5: Register cleanup via Scope.addFinalizer**

After creating the bridge, register cleanup:

```typescript
yield* Effect.addFinalizer(() => chatBridge.shutdown())
```

This ensures the HTTP server shuts down when the character's scope exits.

- [ ] **Step 6: Write `.mcp.json` to the character's working directory**

Write the MCP config from the host side (the `players/` directory is mounted read-write):

```typescript
import * as fs from "node:fs"
import * as path from "node:path"

const mcpConfig = JSON.stringify({
  mcpServers: {
    "spacemolt-chat": {
      command: "bun",
      args: ["/work/spacemolt-chat-channel/index.ts"],
      env: {
        CHAT_BRIDGE_URL: `http://host.docker.internal:${chatBridge.port}`,
      },
    },
  },
}, null, 2)

// Write from host side — players/ is mounted at /work/players in container
const hostMcpPath = path.join(projectRoot, `players/${context.char.name}/.mcp.json`)
fs.writeFileSync(hostMcpPath, mcpConfig)
```

- [ ] **Step 7: Pass `channels` config to `runStateMachine`**

In the active phase (~line 213), add `channels` to the `runStateMachine` config:

```typescript
channels: ["server:spacemolt-chat"],
```

This tells process-runner.ts to pass `--dangerously-load-development-channels server:spacemolt-chat` to `claude -p`, which activates the channel.

- [ ] **Step 8: Thread chat bridge port via phaseData**

Pass the bridge reference through `phaseData` so it persists across phase cycles:

```typescript
data: { ...existingData, chatBridgePort: chatBridge.port },
```

- [ ] **Step 9: Verify build passes**

Run: `cd /Users/vcarl/workspace/roci && pnpm build`
Expected: Clean build.

- [ ] **Step 10: Commit**

```bash
git add packages/domain-spacemolt/src/phases.ts packages/domain-spacemolt/src/config.ts
git commit -m "feat(spacemolt): wire chat bridge and channel plugin into phase lifecycle"
```

---

## Task 8: Update SpaceMolt prompts

**Files:**
- Modify: `packages/domain-spacemolt/src/prompts/in-game-claude.md:99,210-222`
- Modify: `packages/domain-spacemolt/src/prompt-builder.ts:22`

- [ ] **Step 1: Update TOOL_DOCS in prompt-builder.ts**

In `packages/domain-spacemolt/src/prompt-builder.ts`, update line 22:

```typescript
const TOOL_DOCS = `The \`sm\` CLI is installed on your PATH. Run \`sm --help\` for all commands, or \`sm commands\` for a categorized reference.

**Chat:** Use the spacemolt-chat channel's reply tool for all chat. Do NOT use \`sm chat\` — use the reply tool instead:
- \`mcp__spacemolt-chat__reply({ text: "hello", channel: "local" })\` — local channel (same POI)
- \`mcp__spacemolt-chat__reply({ text: "hello", channel: "system" })\` — system-wide
- \`mcp__spacemolt-chat__reply({ text: "hello", channel: "faction" })\` — faction
- \`mcp__spacemolt-chat__reply({ text: "hey", channel: "private:<player_id>" })\` — DM`
```

- [ ] **Step 2: Update in-game-claude.md**

Replace the `sm chat` line at line 99 and the "Talk to Other Players" chat section at lines 210-222 with channel reply tool instructions. Keep `sm chat-history` — it reads from the game server's full history, which the channel plugin doesn't replicate.

- [ ] **Step 3: Commit**

```bash
git add packages/domain-spacemolt/src/prompt-builder.ts packages/domain-spacemolt/src/prompts/in-game-claude.md
git commit -m "feat(spacemolt): update prompts to use chat channel reply tool"
```

---

## Task 9: Integration testing

- [ ] **Step 1: Verify Docker image builds with channel plugin deps**

```bash
cd /Users/vcarl/workspace/roci && docker build -f packages/domain-spacemolt/src/docker/Dockerfile -t spacemolt-player-test .
```

- [ ] **Step 2: Manual end-to-end test**

1. Start the orchestrator with SpaceMolt domain
2. Verify the chat bridge starts and the port is logged
3. Verify `.mcp.json` is written to the character's player directory
4. Verify `claude -p` is invoked with `--dangerously-load-development-channels server:spacemolt-chat`
5. Send a chat message in-game → verify it appears as a `<channel>` notification
6. Verify the agent can reply via the `reply` tool → verify it appears in-game

- [ ] **Step 3: Document adjustments**

Update spec/plan with any changes discovered during integration testing.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(spacemolt): complete chat channel integration"
```

---

## Open Questions (resolve during implementation)

1. **How does `sm chat` call the game API?** Read the `sm` CLI script at `shared-resources/sm-cli/sm` to find the exact endpoint, auth, and payload. Task 7 Step 1 covers this.

2. **Event processor parameterization.** The `SpaceMoltEventProcessorLive` Layer is currently static. Adding the `onChatMessage` callback may require making it a factory or constructing it dynamically per-character. Task 6 Step 2 addresses this.

3. **`--channels` vs `--dangerously-load-development-channels`?** Using the development flag for now. Switch to `--channels` if/when the channel plugin is submitted to Claude Code's approved allowlist.
