import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect } from "effect"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import type { CharacterConfig } from "../../../services/CharacterFs.js"
import { buildAxisSpecs, DEFAULT_VOLATILITY } from "../../../core/salience.js"
import {
  MOOD_EPSILON,
  MOOD_JSON_FILE,
  advanceMood,
  moodChanged,
  moodJsonPath,
  readMood,
  updateMood,
  writeMood,
} from "./mood-store.js"

const AXES = buildAxisSpecs(
  "- safety — your physical integrity\n- voyage — progress toward your destination",
  "😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated",
)

let root: string
let char: CharacterConfig

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "roci-mood-"))
  char = { name: "ada", root: path.join(root, "ada") } as CharacterConfig
  mkdirSync(path.join(char.root, "me"), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("updateMood (the EMA — design 2026-07-31 §5)", () => {
  it("blends the observation into the prior at α", () => {
    expect(updateMood({}, { safety: 1 }, 0.3, AXES)).toEqual({ safety: 0.3 })
    expect(updateMood({ safety: 1 }, { safety: 1 }, 0.3, AXES)).toEqual({ safety: 1 })
  })

  it("DECAYS toward neutral when there is no observation — every tick pulls", () => {
    // The whole point of updating on quiet ticks: calm returns on its own.
    const t1 = updateMood({ safety: 1 }, undefined, 0.3, AXES)
    expect(t1.safety).toBeCloseTo(0.7, 6)
    const t2 = updateMood(t1, {}, 0.3, AXES)
    expect(t2.safety).toBeCloseTo(0.49, 6)
  })

  it("decays all the way to an EMPTY vector, so an old mood cannot linger forever", () => {
    let m: Record<string, number> = { safety: 1 }
    for (let i = 0; i < 200; i++) m = updateMood(m, undefined, 0.3, AXES)
    expect(m).toEqual({})
  })

  it("prunes components below MOOD_EPSILON rather than keeping numeric dust", () => {
    expect(updateMood({ safety: MOOD_EPSILON / 2 }, undefined, 0.3, AXES)).toEqual({})
  })

  it("KEEPS THE SIGN on a bipolar axis and clamps it to [-1, +1]", () => {
    expect(updateMood({}, { "burdened-exhilarated": -1 }, 0.5, AXES))
      .toEqual({ "burdened-exhilarated": -0.5 })
    expect(updateMood({ "burdened-exhilarated": -1 }, { "burdened-exhilarated": -1 }, 0.5, AXES))
      .toEqual({ "burdened-exhilarated": -1 })
  })

  it("clamps a unipolar drive axis to [0, 1] — a negative 'how much safety' is meaningless", () => {
    expect(updateMood({}, { safety: -1 }, 0.5, AXES)).toEqual({})
  })

  it("admits ONLY keys in the axis list — a retired axis is dropped, not decayed", () => {
    expect(updateMood({ curiosity: 0.9 }, { curiosity: 1 }, 0.3, AXES)).toEqual({})
    expect(updateMood({}, { invented: 1, safety: 1 }, 0.3, AXES)).toEqual({ safety: 0.3 })
  })

  it("an EMPTY axis list yields an empty mood — a malformed palette makes the term inert", () => {
    expect(updateMood({ safety: 1 }, { safety: 1 }, 0.3, [])).toEqual({})
  })

  it("clamps α into (0, 1] and falls back to the default when it is absent or junk", () => {
    // α = 0 would freeze the vector permanently, so it is unreachable.
    expect(updateMood({}, { safety: 1 }, 0, AXES).safety).toBeGreaterThan(0)
    expect(updateMood({}, { safety: 1 }, undefined, AXES).safety).toBeCloseTo(DEFAULT_VOLATILITY, 6)
    expect(updateMood({}, { safety: 1 }, Number.NaN, AXES).safety).toBeCloseTo(DEFAULT_VOLATILITY, 6)
    expect(updateMood({}, { safety: 1 }, 5, AXES).safety).toBeCloseTo(1, 6)
  })

  it("ignores non-finite components on either side", () => {
    expect(updateMood({ safety: Number.NaN }, { safety: 1 }, 0.3, AXES)).toEqual({ safety: 0.3 })
    expect(updateMood({ safety: 1 }, { safety: Number.NaN }, 0.3, AXES).safety).toBeCloseTo(0.7, 6)
  })
})

describe("moodChanged", () => {
  it("is false for identical vectors and true for any difference", () => {
    expect(moodChanged({}, {})).toBe(false)
    expect(moodChanged({ safety: 0.5 }, { safety: 0.5 })).toBe(false)
    expect(moodChanged({ safety: 0.5 }, { safety: 0.6 })).toBe(true)
    expect(moodChanged({}, { safety: 0.5 })).toBe(true)
    expect(moodChanged({ safety: 0.5 }, {})).toBe(true)
    expect(moodChanged({ safety: 0.5 }, { agency: 0.5 })).toBe(true)
  })
})

describe("readMood / writeMood", () => {
  it("round-trips through me/mood.json", async () => {
    await Effect.runPromise(writeMood(char, { safety: 0.4, "burdened-exhilarated": -0.2 }))
    expect(await Effect.runPromise(readMood(char)))
      .toEqual({ safety: 0.4, "burdened-exhilarated": -0.2 })
    expect(moodJsonPath(char)).toBe(path.join(char.root, "me", MOOD_JSON_FILE))
  })

  it("writes a versioned, timestamped envelope a QA run can read", async () => {
    await Effect.runPromise(writeMood(char, { safety: 0.4 }))
    const raw = JSON.parse(readFileSync(moodJsonPath(char), "utf8")) as Record<string, unknown>
    expect(raw.version).toBe(1)
    expect(typeof raw.updatedAt).toBe("string")
    expect(raw.state).toEqual({ safety: 0.4 })
  })

  it("degrades to {} on a missing, torn or wrong-shaped file — never throws", async () => {
    expect(await Effect.runPromise(readMood(char))).toEqual({})
    writeFileSync(moodJsonPath(char), "{ not json")
    expect(await Effect.runPromise(readMood(char))).toEqual({})
    writeFileSync(moodJsonPath(char), JSON.stringify({ version: 1, state: [1, 2] }))
    expect(await Effect.runPromise(readMood(char))).toEqual({})
  })

  it("drops junk components on read and clamps survivors to [-1, +1]", async () => {
    writeFileSync(
      moodJsonPath(char),
      JSON.stringify({ version: 1, updatedAt: "x", state: { a: 5, b: -5, c: "hi", d: null, e: 0.3 } }),
    )
    expect(await Effect.runPromise(readMood(char))).toEqual({ a: 1, b: -1, e: 0.3 })
  })

  it("never fails when the character root does not exist", async () => {
    const missing = { name: "ghost", root: path.join(root, "nope", "deeper") } as CharacterConfig
    expect(await Effect.runPromise(readMood(missing))).toEqual({})
    await Effect.runPromise(writeMood(missing, { safety: 0.1 }))
    expect(await Effect.runPromise(readMood(missing))).toEqual({ safety: 0.1 })
  })

  it("degrades instead of throwing when the write directory cannot be created", async () => {
    // A regular FILE sits where the "me" directory needs to go, so
    // fsp.mkdir(meDir, { recursive: true }) fails deterministically
    // (EEXIST/ENOTDIR) regardless of the test process's privileges —
    // portable, unlike a chmod-based unwritable-directory trick, which
    // silently passes (and would be vacuous) when run as root.
    const blocked = { name: "blocked", root: path.join(root, "blocked") } as CharacterConfig
    mkdirSync(blocked.root, { recursive: true })
    writeFileSync(path.join(blocked.root, "me"), "not a directory")

    await expect(Effect.runPromise(writeMood(blocked, { safety: 0.5 }))).resolves.toBeUndefined()
    expect(await Effect.runPromise(readMood(blocked))).toEqual({})
  })
})

describe("advanceMood (the per-tick step)", () => {
  it("returns the advanced vector and persists it when it moved", async () => {
    const next = await Effect.runPromise(
      advanceMood({ char, prev: {}, observed: { safety: 1 }, alpha: 0.3, axes: AXES }),
    )
    expect(next).toEqual({ safety: 0.3 })
    expect(await Effect.runPromise(readMood(char))).toEqual({ safety: 0.3 })
  })

  it("does NOT touch disk when the vector did not move — the expected quiet-tick path", async () => {
    const out = await Effect.runPromise(
      advanceMood({ char, prev: {}, observed: undefined, alpha: 0.3, axes: AXES }),
    )
    expect(out).toEqual({})
    // Nothing was written, so there is still no file at all.
    expect(() => readFileSync(moodJsonPath(char), "utf8")).toThrow()
  })

  it("decays a persisted mood on a quiet tick", async () => {
    await Effect.runPromise(writeMood(char, { safety: 1 }))
    const next = await Effect.runPromise(
      advanceMood({ char, prev: { safety: 1 }, observed: undefined, alpha: 0.3, axes: AXES }),
    )
    expect(next.safety).toBeCloseTo(0.7, 6)
    const onDisk = await Effect.runPromise(readMood(char))
    expect(onDisk.safety).toBeCloseTo(0.7, 6)
  })
})
