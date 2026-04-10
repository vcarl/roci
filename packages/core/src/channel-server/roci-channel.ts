#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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

const mcp = new McpServer(
  {
    name: "roci-channel",
    version: "1.0.0",
  },
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    capabilities: {
      "claude/channel": {},
      tools: {},
    } as any,
    instructions,
  },
);

mcp.tool(
  "terminate",
  "Signal that the current task is complete or cannot be achieved. This ends the session.",
  {
    reason: z.enum(["completed", "unachievable"]),
    summary: z.string().describe("A summary of what was accomplished or why the task is not achievable"),
  },
  async ({ reason, summary }) => {
    const result = {
      reason,
      summary,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(PLAYER_DIR, "session-result.json"), JSON.stringify(result, null, 2));
    return {
      content: [
        {
          type: "text" as const,
          text: `Session terminated: ${reason}. Result written to session-result.json.`,
        },
      ],
    };
  },
);

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mcp.server as any).notification({
      method: "notifications/claude/channel",
      params: {
        content: body.content,
        meta: body.meta ?? {},
      },
    });

    return new Response("ok");
  },
});

process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
