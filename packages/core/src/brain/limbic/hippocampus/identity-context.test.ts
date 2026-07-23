import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { CharacterFs } from "../../../services/CharacterFs.js"
import { meDir } from "../../../services/character-paths.js"
import { CharacterLog } from "../../../logging/log-writer.js"
import { MemoryGateway } from "#brain/limbic/hippocampus/memory/memory-gateway.js"
import { readIdentityContext, IDENTITY_PLACEHOLDERS } from "./identity-context.js"

const silentLog = Layer.succeed(CharacterLog, CharacterLog.of({ emit: () => Effect.void }))

// A CharacterFs whose four identity reads return the supplied strings.
const fsWith = (vals: { background?: string; values?: string; diary?: string; synthesis?: string }) =>
  Layer.succeed(
    CharacterFs,
    CharacterFs.of({
      readDiary: () => Effect.succeed(vals.diary ?? ""),
      writeDiary: () => Effect.void,
      readSecrets: () => Effect.succeed(""),
      writeSecrets: () => Effect.void,
      readCredentials: () => Effect.succeed({ username: "", password: "" }),
      readBackground: () => Effect.succeed(vals.background ?? ""),
      readValues: () => Effect.succeed(vals.values ?? ""),
      readPalette: () => Effect.succeed(""),
      readDrives: () => Effect.succeed(""),
      readSalience: () => Effect.succeed(""),
      characterExists: () => Effect.succeed(true),
      listSkills: () => Effect.succeed([]),
      readSkill: () => Effect.succeed(null),
      writeSkill: () => Effect.void,
      readSynthesis: () => Effect.succeed(vals.synthesis ?? ""),
      writeSynthesis: () => Effect.void,
      deleteSkill: () => Effect.void,
    }),
  )

const memoryWith = (recall: string) =>
  Layer.succeed(
    MemoryGateway,
    MemoryGateway.of({ remember: () => Effect.void, recall: () => Effect.succeed(recall) }),
  )

// char.root points at a non-existent path → readWm degrades to an empty wm file.
const emptyWmChar = { name: "ada", root: "/nonexistent/players/ada" }

const run = (
  vals: { background?: string; values?: string; diary?: string; synthesis?: string },
  recall: string,
  char = emptyWmChar,
) =>
  Effect.runPromise(
    readIdentityContext({ char, containerId: "c1", accumulatedEvents: ["e"], emotionalWeight: "😐" }).pipe(
      Effect.provide(Layer.mergeAll(fsWith(vals), memoryWith(recall), silentLog)),
    ),
  )

describe("readIdentityContext", () => {
  it("substitutes a per-block placeholder for every empty identity source", async () => {
    const ctx = await run({}, "")
    expect(ctx.background).toBe(IDENTITY_PLACEHOLDERS.background)
    expect(ctx.values).toBe(IDENTITY_PLACEHOLDERS.values)
    expect(ctx.diary).toBe(IDENTITY_PLACEHOLDERS.diary)
    expect(ctx.synthesis).toBe(IDENTITY_PLACEHOLDERS.synthesis)
    // The wm renderer owns its own empty placeholder.
    expect(ctx.workingMemory).toBe("(no open todos)")
  })

  it("empty recall passes through as '' — the recall block is self-guarding, never a bare header", async () => {
    // formatRecall returns "" when there are no hits and builds its own
    // "## You recall" header INSIDE the block; orient.md renders
    // {{recalledMemories}} with no surrounding header. So an empty recall never
    // produced a bare header, and a placeholder here would inject a stray
    // floating line into every cold-start orient prompt (behavior regression).
    const ctx = await run({}, "")
    expect(ctx.recalledMemories).toBe("")
  })

  it("passes non-empty sources through byte-for-byte (no placeholder, no trimming)", async () => {
    const ctx = await run(
      {
        background: "  Born on Ceres.  ",
        values: "Honesty above all",
        diary: "Day 1\nDay 2",
        synthesis: "I am cautious.",
      },
      "\n\n## You recall\n- a prior fight",
    )
    expect(ctx.background).toBe("  Born on Ceres.  ")
    expect(ctx.values).toBe("Honesty above all")
    expect(ctx.diary).toBe("Day 1\nDay 2")
    expect(ctx.synthesis).toBe("I am cautious.")
    expect(ctx.recalledMemories).toBe("\n\n## You recall\n- a prior fight")
  })

  it("treats whitespace-only sources as empty", async () => {
    const ctx = await run({ background: "   \n  ", synthesis: "\t" }, "")
    expect(ctx.background).toBe(IDENTITY_PLACEHOLDERS.background)
    expect(ctx.synthesis).toBe(IDENTITY_PLACEHOLDERS.synthesis)
  })

  it("renders the live working-memory todo tree when the wm file has open todos", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-wm-"))
    const char = { name: "ada", root: dir }
    fs.mkdirSync(meDir(char), { recursive: true })
    fs.writeFileSync(
      path.join(meDir(char), "wm.json"),
      JSON.stringify({
        version: 1,
        nextId: 2,
        todos: [
          {
            id: "t1",
            text: "chart a course",
            parent: null,
            state: "open",
            createdAt: "2026-07-03T00:00:00.000Z",
            updatedAt: "2026-07-03T00:00:00.000Z",
          },
        ],
        pendingDeltas: [],
      }),
    )
    try {
      const ctx = await run({}, "", char)
      expect(ctx.workingMemory).toContain("chart a course")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
