import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import {
  splitDiaryEntries,
  diaryMark,
  newSinceMark,
  LongtermStore,
  LongtermStoreLive,
  MEMORY_CLI_PATH,
  type MemoryHit,
} from "./longterm-store.js"
import { Docker } from "../../../../services/Docker.js"
import type { CharacterConfig } from "../../../../services/CharacterFs.js"

describe("splitDiaryEntries", () => {
  it("splits on blank-line boundaries, trimming and dropping empties", () => {
    const diary = "First entry.\nstill first.\n\n  \n\nSecond entry.\n\n\n"
    expect(splitDiaryEntries(diary)).toEqual(["First entry.\nstill first.", "Second entry."])
  })
  it("returns [] for an empty diary", () => {
    expect(splitDiaryEntries("")).toEqual([])
    expect(splitDiaryEntries("   \n\n  ")).toEqual([])
  })
})

describe("diaryMark", () => {
  it("captures the diary length and a stable sha256 of its exact text", () => {
    const m = diaryMark("hello world")
    expect(m.len).toBe(11)
    expect(m.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(diaryMark("hello world")).toEqual(m)
    expect(diaryMark("hello worlds").hash).not.toBe(m.hash)
  })
})

describe("newSinceMark — bounded high-water mark isolates new raw appends", () => {
  it("returns the whole diary as entries when there is no prior mark (first promotion)", () => {
    expect(newSinceMark("A.\n\nB.", null)).toEqual(["A.", "B."])
  })

  it("returns ONLY the entries appended after the marked prefix", () => {
    // The loop only ever appends `\n\n`-separated entries during a session, so
    // the marked (post-reflection) diary is a verbatim prefix of the next one.
    const baseline = "Culled narrative from last cycle."
    const mark = diaryMark(baseline)
    const diary = `${baseline}\n\nRaw entry C.\n\nRaw entry D.`
    expect(newSinceMark(diary, mark)).toEqual(["Raw entry C.", "Raw entry D."])
  })

  it("promotes nothing when the diary is unchanged since the mark", () => {
    const baseline = "Culled narrative."
    expect(newSinceMark(baseline, diaryMark(baseline))).toEqual([])
  })

  it("falls back to the whole diary (anti-loss) when the prefix does not match the mark", () => {
    // e.g. an external rewrite / fresh db against an existing diary: don't silently
    // drop content — promote it all and re-baseline (logged loud by the caller).
    const staleMark = diaryMark("some OTHER prefix that is no longer present")
    const diary = "Completely different diary.\n\nSecond."
    expect(newSinceMark(diary, staleMark)).toEqual(["Completely different diary.", "Second."])
  })

  it("falls back to the whole diary when the mark length exceeds the diary length", () => {
    const mark = { len: 9999, hash: "deadbeef" }
    expect(newSinceMark("short.", mark)).toEqual(["short."])
  })
})

describe("LongtermStoreLive — in-container command construction (N2)", () => {
  // Capture every docker exec command the live store issues, so the brittle bits
  // (single-quoting the cwd path + base64 entry framing) are locked by a test.
  const captured: string[][] = []
  const StubDocker = Layer.succeed(
    Docker,
    Docker.of({
      exec: (_id: string, command: string[]) => {
        captured.push(command)
        return Effect.succeed("") // empty stdout: mark-get → null, promote → fallback count
      },
    } as unknown as typeof Docker.Service),
  )
  const char = { name: "ada space", dir: "/work/players/ada space/me" }

  const runWith = <A>(eff: Effect.Effect<A, unknown, LongtermStore>) =>
    Effect.runPromise(
      Effect.provide(eff, Layer.provide(LongtermStoreLive, StubDocker)) as Effect.Effect<A, unknown, never>,
    )

  it("single-quotes the cwd path (L1: a name with a space must not break the shell)", async () => {
    captured.length = 0
    await runWith(Effect.flatMap(LongtermStore, (s) => s.readMark("cid", char)))
    const joined = captured.flat().join(" ")
    expect(joined).toContain(`cd '/work/players/ada space'`)
    expect(joined).toContain(`${MEMORY_CLI_PATH} mark-get`)
  })

  it("promote frames each entry as a base64 line piped to `memory promote`", async () => {
    captured.length = 0
    await runWith(Effect.flatMap(LongtermStore, (s) => s.promote("cid", char, ["raw one", "raw two"])))
    const joined = captured.flat().join(" ")
    expect(joined).toContain(`cd '/work/players/ada space'`)
    expect(joined).toContain(`${MEMORY_CLI_PATH} promote`)
    expect(joined).toContain(Buffer.from("raw one", "utf8").toString("base64"))
    expect(joined).toContain(Buffer.from("raw two", "utf8").toString("base64"))
  })

  it("promote is a no-op (no docker exec) for an empty entry list", async () => {
    captured.length = 0
    const n = await runWith(Effect.flatMap(LongtermStore, (s) => s.promote("cid", char, [])))
    expect(n).toBe(0)
    expect(captured).toHaveLength(0)
  })

  it("writeMark upserts the JSON mark via `memory mark-set`", async () => {
    captured.length = 0
    await runWith(Effect.flatMap(LongtermStore, (s) => s.writeMark("cid", char, { len: 42, hash: "abc" })))
    const joined = captured.flat().join(" ")
    expect(joined).toContain(`${MEMORY_CLI_PATH} mark-set`)
    expect(joined).toContain('"len":42')
    expect(joined).toContain('"hash":"abc"')
  })
})

const char = { name: "ada space" } as CharacterConfig

// Minimal Docker stub: records the argv it was called with, returns canned stdout.
function dockerStub(stdout: string, captured: string[][]) {
  return Layer.succeed(
    Docker,
    {
      exec: (_id: string, args: ReadonlyArray<string>) =>
        Effect.sync(() => {
          captured.push([...args])
          return stdout
        }),
    } as unknown as typeof Docker.Service,
  )
}

describe("LongtermStore.remember / recall", () => {
  it("remember shells `memory remember` with quoted text, --tags and --source", async () => {
    const captured: string[][] = []
    await Effect.runPromise(
      Effect.flatMap(LongtermStore, (s) =>
        s.remember("cid", char, { text: "the wormhole is unstable", source: "orient", tags: ["medium", "situation"] }),
      ).pipe(Effect.provide(LongtermStoreLive.pipe(Layer.provide(dockerStub("", captured))))),
    )
    const joined = captured.flat().join(" ")
    expect(joined).toContain(`cd '/work/players/ada space'`)
    expect(joined).toContain(`${MEMORY_CLI_PATH} remember 'the wormhole is unstable'`)
    expect(joined).toContain(`--tags 'medium,situation'`)
    expect(joined).toContain(`--source 'orient'`)
  })

  it("recall shells `memory search` with -k and parses NDJSON into hits", async () => {
    const captured: string[][] = []
    const ndjson =
      `{"id":1,"ts":"t","source":"orient","tags":["a"],"text":"first","score":0.9}\n` +
      `{"id":2,"ts":"t","source":"evaluate","tags":[],"text":"second","score":0.5}\n` +
      `   \n` // blank line must be ignored
    const hits: ReadonlyArray<MemoryHit> = await Effect.runPromise(
      Effect.flatMap(LongtermStore, (s) => s.recall("cid", char, "danger", { k: 2 })).pipe(
        Effect.provide(LongtermStoreLive.pipe(Layer.provide(dockerStub(ndjson, captured)))),
      ),
    )
    const joined = captured.flat().join(" ")
    expect(joined).toContain(`${MEMORY_CLI_PATH} search 'danger' -k 2`)
    expect(hits.map((h) => h.text)).toEqual(["first", "second"])
    expect(hits[0].score).toBeCloseTo(0.9)
  })

  it("remember shells --dims with quoted JSON when dims is non-empty", async () => {
    const captured: string[][] = []
    await Effect.runPromise(
      Effect.flatMap(LongtermStore, (s) =>
        s.remember("cid", char, { text: "hull breach", source: "observe", tags: ["escalate", "safety"], dims: { safety: 0.8 } }),
      ).pipe(Effect.provide(LongtermStoreLive.pipe(Layer.provide(dockerStub("", captured))))),
    )
    const joined = captured.flat().join(" ")
    expect(joined).toContain(`--dims '{"safety":0.8}'`)
    expect(joined).toContain(`--source 'observe'`)
  })

  it("remember omits --dims entirely when dims is empty or absent", async () => {
    const captured: string[][] = []
    await Effect.runPromise(
      Effect.flatMap(LongtermStore, (s) =>
        s.remember("cid", char, { text: "a guess", source: "orient", tags: [], dims: {} }),
      ).pipe(Effect.provide(LongtermStoreLive.pipe(Layer.provide(dockerStub("", captured))))),
    )
    expect(captured.flat().join(" ")).not.toContain("--dims")
  })
})
