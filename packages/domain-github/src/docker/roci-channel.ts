#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = parseInt(process.env.ROCI_CHANNEL_PORT ?? "7878", 10);
const PLAYER_DIR = process.env.ROCI_PLAYER_DIR ?? process.cwd();

const instructions = `
You are operating within a long-lived Claude session managed by the roci orchestrator.
Events are delivered to you via channel notifications from "roci-channel":

- State updates arrive as <channel source="roci-channel" type="tick"> events — continue working on your current task
- Critical alerts arrive as <channel source="roci-channel" type="alert"> — reassess your approach immediately
- The initial task arrives as <channel source="roci-channel" type="task"> — begin working on the task

When your task is complete or not achievable, you MUST call the \`terminate\` tool with a reason and summary.

Use the Agent tool to spawn subagents for parallel or delegated work.
`.trim();

const mcp = new Server(
  { name: "roci-channel", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions,
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "terminate",
    description: "Signal that the current task is complete or cannot be achieved. This ends the session.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["completed", "unachievable"] },
        summary: { type: "string", description: "A summary of what was accomplished or why the task is not achievable" },
      },
      required: ["reason", "summary"],
    },
  }],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "terminate") {
    const { reason, summary } = req.params.arguments as { reason: "completed" | "unachievable"; summary: string };
    const result = { reason, summary, timestamp: new Date().toISOString() };
    try {
      writeFileSync(join(PLAYER_DIR, "session-result.json"), JSON.stringify(result, null, 2));
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to write session result: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: `Session terminated: ${reason}. Result written to session-result.json.` }],
    };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

const transport = new StdioServerTransport();
await mcp.connect(transport);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let body: { content: string; meta?: Record<string, string> };
    try {
      body = await req.json();
    } catch {
      return new Response("Bad Request: invalid JSON", { status: 400 });
    }

    if (typeof body.content !== "string") {
      return new Response("Bad Request: missing content field", { status: 400 });
    }

    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: body.content,
          meta: body.meta ?? {},
        },
      });
    } catch (err) {
      return new Response(
        `Failed to send notification: ${err instanceof Error ? err.message : String(err)}`,
        { status: 500 },
      );
    }

    return new Response("ok");
  },
});

process.on("SIGTERM", async () => {
  await server.stop();
  process.exit(0);
});
