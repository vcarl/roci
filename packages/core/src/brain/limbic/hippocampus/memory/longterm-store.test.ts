import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import {
  splitDiaryEntries,
  diaryMark,
  newSinceMark,
  LongtermStore,
  LongtermStoreLive,
  MEMORY_CLI_PATH,
  buildMemoryCommand,
  shQuote,
  type MemoryHit,
} from "./longterm-store.js"
import {
  encodeRememberArgs,
  encodeSearchArgs,
  encodeMarkGetArgs,
  encodeMarkSetArgs,
  encodePromoteArgs,
  type RememberEntry,
} from "@roci/player-tools/command-codec"
import { Docker } from "../../../../services/Docker.js"
import type { CharacterConfig } from "../../../../services/CharacterFs.js"

/** The `<MEMORY_CLI_PATH> <quoted-args>` fragment the store is expected to emit. */
const cliFrag = (argv: ReadonlyArray<string>) => `${MEMORY_CLI_PATH} ${buildMemoryCommand(argv)}`

/**
 * Word-split a shell fragment exactly as bash would, via `printf '%s\0'` (NUL
 * delimiter so a newline inside an argument is preserved, not split). The
 * fragment MUST contain no shell operators — only quoted CLI args — so this is
 * safe to eval; we only ever pass the `<MEMORY_CLI_PATH>`-args portion.
 */
function bashSplit(fragment: string): string[] {
  const out = execFileSync("bash", ["-c", `printf '%s\\0' ${fragment}`], { encoding: "utf8" })
  const parts = out.split("\0")
  parts.pop() // trailing empty after the final NUL
  return parts
}

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
  const char = { name: "ada space", root: "/work/players/ada space" }

  const runWith = <A>(eff: Effect.Effect<A, unknown, LongtermStore>) =>
    Effect.runPromise(
      Effect.provide(eff, Layer.provide(LongtermStoreLive, StubDocker)) as Effect.Effect<A, unknown, never>,
    )

  it("single-quotes the cwd path (L1: a name with a space must not break the shell)", async () => {
    captured.length = 0
    await runWith(Effect.flatMap(LongtermStore, (s) => s.readMark("cid", char)))
    const joined = captured.flat().join(" ")
    expect(joined).toContain(`cd '/work/players/ada space'`)
    expect(joined).toContain(cliFrag(encodeMarkGetArgs()))
  })

  it("promote frames each entry as a base64 line piped to `memory promote`", async () => {
    captured.length = 0
    await runWith(Effect.flatMap(LongtermStore, (s) => s.promote("cid", char, ["raw one", "raw two"])))
    const joined = captured.flat().join(" ")
    expect(joined).toContain(`cd '/work/players/ada space'`)
    expect(joined).toContain(cliFrag(encodePromoteArgs()))
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
    expect(joined).toContain(cliFrag(encodeMarkSetArgs(JSON.stringify({ len: 42, hash: "abc" }))))
    expect(joined).toContain('"len":42')
    expect(joined).toContain('"hash":"abc"')
  })

  it("delivers the host-rewritten MEMORY_EMBED_URL via an `export …&&` prefix on EVERY exec (spec §3)", async () => {
    // The bundled binary resolves config up-front and requires MEMORY_EMBED_URL for
    // every verb — including the non-embedding mark-get/mark-set — so the export
    // must ride ALL exec calls, ahead of the `cd`. The url is the FINAL host-side
    // rewrite (loopback → host.docker.internal), composed in core, not in-container.
    const expectPrefix = `export MEMORY_EMBED_URL='http://host.docker.internal:8084/v1/embeddings' && cd `
    for (const op of [
      (s: typeof LongtermStore.Service) => s.readMark("cid", char),
      (s: typeof LongtermStore.Service) => s.writeMark("cid", char, { len: 1, hash: "h" }),
      (s: typeof LongtermStore.Service) => s.remember("cid", char, { text: "t", source: "orient", tags: [] }),
      (s: typeof LongtermStore.Service) => s.recall("cid", char, "q"),
      (s: typeof LongtermStore.Service) => s.promote("cid", char, ["raw"]),
    ]) {
      captured.length = 0
      await runWith(Effect.flatMap(LongtermStore, op))
      const shell = captured.flat().at(-1) ?? ""
      expect(shell.startsWith(expectPrefix)).toBe(true)
    }
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
  it("remember shells the codec-encoded `memory remember` (text, --tags, --source)", async () => {
    const captured: string[][] = []
    const entry = { text: "the wormhole is unstable", source: "orient", tags: ["medium", "situation"] }
    await Effect.runPromise(
      Effect.flatMap(LongtermStore, (s) => s.remember("cid", char, entry)).pipe(
        Effect.provide(LongtermStoreLive.pipe(Layer.provide(dockerStub("", captured)))),
      ),
    )
    const joined = captured.flat().join(" ")
    expect(joined).toContain(`cd '/work/players/ada space'`)
    expect(joined).toContain(cliFrag(encodeRememberArgs(entry)))
  })

  it("recall shells the codec-encoded `memory search` and parses NDJSON into hits", async () => {
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
    expect(joined).toContain(cliFrag(encodeSearchArgs({ query: "danger", k: 2 })))
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
    // The dims JSON is a single shQuoted token (the codec owns the flag order).
    expect(joined).toContain(shQuote('{"safety":0.8}'))
    expect(joined).toContain(shQuote("--dims"))
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

/**
 * CRITICAL compatibility gate (codec-seam decision 2026-07-23): core switched to
 * the codec encoder NOW, but the DEPLOYED parser is still the old string-CLI until
 * phase 3. Core is now grammar-blind — it maps `shQuote` over the WHOLE argv, so
 * the raw command string is uniformly quoted rather than per-value quoted. That is
 * cosmetically different but PROVABLY shell-equivalent: bash word-splits both the
 * legacy hand-concatenation and the new codec output to the IDENTICAL argv the
 * deployed CLI reads from `process.argv`. This test diffs them.
 */
describe("command byte-compat — codec+shQuote is shell-equivalent to the legacy hand-concat", () => {
  // Verbatim replicas of the pre-codec per-value hand-concatenation (the code
  // this commit replaced), so the diff is against the actual prior output.
  const legacyRemember = (e: RememberEntry): string => {
    const tagsArg = e.tags.length > 0 ? ` --tags ${shQuote(e.tags.join(","))}` : ""
    const dimsArg =
      e.dims && Object.keys(e.dims).length > 0 ? ` --dims ${shQuote(JSON.stringify(e.dims))}` : ""
    return `remember ${shQuote(e.text)}${tagsArg} --source ${shQuote(e.source)}${dimsArg}`
  }
  const legacySearch = (query: string, k: number, tags?: string[]): string => {
    const tagsArg = tags && tags.length > 0 ? ` --tags ${shQuote(tags.join(","))}` : ""
    return `search ${shQuote(query)} -k ${k}${tagsArg}`
  }

  const rememberCases: Array<{ name: string; entry: RememberEntry }> = [
    { name: "single quotes in text", entry: { text: "it's a 'station'", source: "orient", tags: [] } },
    { name: "double quotes + spaces", entry: { text: 'a "quiet" bar', source: "observe", tags: ["x", "y"] } },
    { name: "unicode", entry: { text: "café ☕ 東京", source: "conscious", tags: ["城市"] } },
    { name: "newline in text", entry: { text: "line1\nline2", source: "orient", tags: [] } },
    { name: "with dims", entry: { text: "salient", source: "observe", tags: ["a"], dims: { safety: 0.8, fear: 1 } } },
    { name: "empty dims (omitted)", entry: { text: "trivial", source: "observe", tags: [], dims: {} } },
    { name: "absent dims", entry: { text: "plain", source: "observe", tags: ["t"] } },
  ]

  for (const { name, entry } of rememberCases) {
    it(`remember — ${name}: bash-splits identically to legacy and to the codec argv`, () => {
      const legacy = legacyRemember(entry)
      const modern = buildMemoryCommand(encodeRememberArgs(entry))
      // 1) legacy and codec output word-split to the same argv (deployed-parser safe).
      expect(bashSplit(modern)).toEqual(bashSplit(legacy))
      // 2) and that argv is exactly the codec's intended argv (no quoting artifacts).
      expect(bashSplit(modern)).toEqual(encodeRememberArgs(entry))
    })
  }

  it("search — bash-splits identically to legacy (with and without tags)", () => {
    expect(bashSplit(buildMemoryCommand(encodeSearchArgs({ query: "where's the 'dock'?", k: 5 })))).toEqual(
      bashSplit(legacySearch("where's the 'dock'?", 5)),
    )
    expect(
      bashSplit(buildMemoryCommand(encodeSearchArgs({ query: "danger", k: 2, tags: ["a", "b"] }))),
    ).toEqual(bashSplit(legacySearch("danger", 2, ["a", "b"])))
  })

  it("mark-set — bash-splits identically to the legacy `mark-set <json>`", () => {
    const json = JSON.stringify({ len: 42, hash: "abc" })
    expect(bashSplit(buildMemoryCommand(encodeMarkSetArgs(json)))).toEqual(
      bashSplit(`mark-set ${shQuote(json)}`),
    )
  })
})
