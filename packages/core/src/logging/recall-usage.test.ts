import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { describe, it, expect, beforeEach } from "vitest"
import type { CharacterConfig } from "../services/CharacterFs.js"
import {
  RECALL_USAGE_FILE,
  USAGE_METRIC,
  buildOutputIndex,
  overlap,
  registerRecallForUsage,
  recordRecallUsage,
  resetPendingRecalls,
  takePendingRecall,
  type PendingRecall,
  type RecallUsageRecord,
} from "./recall-usage.js"

beforeEach(() => resetPendingRecalls())

const MEMORY = "The jump to Horizon failed because the drive coil overheated at 3.5 AU."

describe("token-containment-v1", () => {
  it("scores a near-verbatim quotation high and unrelated text at zero content overlap", () => {
    const quoted = overlap(
      MEMORY,
      buildOutputIndex(
        "Trying again is pointless: the jump to Horizon failed because the drive coil " +
          "overheated at 3.5 AU, so I will vent heat before re-attempting.",
      ),
    )
    // Every content word of the memory is present, and an 8-token contiguous run
    // of it survives — that is what distinguishes quotation from coincidence.
    expect(quoted.contentContainment).toBe(1)
    expect(quoted.longestMatchedNgram).toBe(8)
    expect(quoted.metric).toBe(USAGE_METRIC)

    const unrelated = overlap(
      MEMORY,
      buildOutputIndex("Docked at Altais station and sold ore to the local broker."),
    )
    expect(unrelated.contentContainment).toBe(0)
    expect(unrelated.contentMatched).toBe(0)
    // Function words DO collide ("the", "at", "to") — which is exactly why the
    // guarded number is the one to read.
    expect(unrelated.rawMatched).toBeGreaterThan(0)
    expect(unrelated.longestMatchedNgram).toBeLessThanOrEqual(1)
  })

  it("the stopword guard is what suppresses boilerplate-only overlap, and both numbers prove it", () => {
    const boilerplate = "It is the case that we should do this and then it will be done."
    const echo = "It is the thing that we should do this and then it will be over."
    const o = overlap(boilerplate, buildOutputIndex(echo))
    // Guard OFF: the two sentences look nearly identical.
    expect(o.rawContainment as number).toBeGreaterThan(0.7)
    // Guard ON: neither content word ("case", "done") occurs. The whole apparent
    // overlap was function words.
    expect(o.contentContainment).toBe(0)
    expect(o.stopwordTokens).toBeGreaterThan(o.contentTokens)
    // The raw counts are all on the record, so the guard's effect is a
    // subtraction an analyst performs rather than a claim they must accept.
    expect(o.rawMatched - o.contentMatched).toBe(o.rawMatched)
  })

  it("reports null rather than a fake zero when a quantity is undefined", () => {
    const empty = overlap("", buildOutputIndex("anything at all"))
    expect(empty.rawContainment).toBeNull()
    expect(empty.contentContainment).toBeNull()
    expect(empty.ngrams.every((g) => g.containment === null)).toBe(true)
    const allStopwords = overlap("it is the and to", buildOutputIndex("it is the and to"))
    expect(allStopwords.rawContainment).toBe(1)
    expect(allStopwords.contentContainment).toBeNull()
  })
})

describe("the pending-recall registry", () => {
  const pending = (recallId: string): PendingRecall => ({
    recallId,
    site: "decide",
    label: "Relevant memories",
    k: 2,
    poolSize: 8,
    tick: 4,
    stepId: "c1-s4-0",
    epoch: "1",
    candidates: [
      { id: 11, rank: 1, injection: "ranked", text: MEMORY, promptLineIntact: true },
    ],
  })

  it("takes a recall by id exactly once, and returns null for an id it never held", () => {
    registerRecallForUsage("ada", pending("n-1"))
    registerRecallForUsage("ada", pending("n-2"))
    expect(takePendingRecall("ada", "n-2")?.recallId).toBe("n-2")
    expect(takePendingRecall("ada", "n-2")).toBeNull()
    expect(takePendingRecall("bob", "n-1")).toBeNull()
    expect(takePendingRecall("ada", "n-1")?.recallId).toBe("n-1")
  })

  it("an unwritable character root cannot break the caller", async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "roci-usage-fail-"))
    writeFileSync(path.join(tmpRoot, "blocked"), "not a directory")
    const broken = { name: "ada", root: path.join(tmpRoot, "blocked", "ada") } as CharacterConfig
    registerRecallForUsage("ada", pending("n-9"))
    // Succeeds (Effect<void, never>) despite ENOTDIR on mkdir.
    await Effect.runPromise(
      recordRecallUsage(broken, "n-9", { outputKind: "decide", output: MEMORY }),
    )
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("writes one record per recall, and a null recallId is a silent no-op", async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "roci-usage-"))
    const char = { name: "ada", root: path.join(tmpRoot, "ada") } as CharacterConfig
    const file = path.join(char.root, "logs", RECALL_USAGE_FILE)

    await Effect.runPromise(
      recordRecallUsage(char, null, { outputKind: "decide", output: "anything" }),
    )
    expect(() => readFileSync(file, "utf8")).toThrow()

    registerRecallForUsage("ada", pending("n-1"))
    await Effect.runPromise(
      recordRecallUsage(char, "n-1", {
        outputKind: "decide",
        output: `Replanning: ${MEMORY} Vent heat first.`,
      }),
    )
    const lines = readFileSync(file, "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0]) as RecallUsageRecord
    expect(rec).toMatchObject({
      type: "recall-usage",
      recallId: "n-1",
      site: "decide",
      outputKind: "decide",
      signal: "textual-overlap-not-usage",
      metric: USAGE_METRIC,
    })
    expect(rec.candidates).toHaveLength(1)
    expect(rec.candidates[0].contentContainment).toBe(1)
    rmSync(tmpRoot, { recursive: true, force: true })
  })
})
