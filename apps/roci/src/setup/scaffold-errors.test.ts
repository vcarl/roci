import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { CharacterLog } from "@roci/core/logging/log-writer.js"
import type { UnifiedEvent } from "@roci/core/logging/events.js"
import { classifyLevel, passesThreshold, type LogLevel } from "@roci/core/logging/levels.js"
import { AxisCollisionError, UnknownAxisError } from "@roci/core/core/salience.js"
import { MalformedAxisError } from "@roci/core/core/palette.js"
import { ArtifactUnreadableError } from "@roci/core/core/character-scaffold.js"
import { isPerCharacterScaffoldError, logScaffoldSkip, logRegistrationSkip } from "./scaffold-errors.js"

/** Captures every emitted event so a test can assert on its KIND, which is what
 *  `classifyLevel` reads to decide whether a console threshold can hide it. */
const capturing = (events: UnifiedEvent[]) =>
  Layer.succeed(
    CharacterLog,
    CharacterLog.of({
      emit: (_char, event) =>
        Effect.sync(() => {
          events.push(event)
        }),
    }),
  )

const runCapturing = async (eff: Effect.Effect<void, unknown, CharacterLog>): Promise<UnifiedEvent[]> => {
  const events: UnifiedEvent[] = []
  await Effect.runPromise(Effect.provide(eff, capturing(events)) as Effect.Effect<void>)
  return events
}

const ALL_THRESHOLDS: LogLevel[] = ["debug", "info", "warn", "error"]

describe("isPerCharacterScaffoldError", () => {
  it("accepts all four per-character vocabulary/artifact defects", () => {
    expect(isPerCharacterScaffoldError(new AxisCollisionError("safety"))).toBe(true)
    expect(isPerCharacterScaffoldError(new MalformedAxisError("🙄 # → tender"))).toBe(true)
    expect(isPerCharacterScaffoldError(new UnknownAxisError(["curiosity"], ["safety"]))).toBe(true)
    // The Phase-2 addition: an artifact that exists but cannot be read is a
    // per-CHARACTER problem (it is under players/<name>/me/), so it must skip that
    // character rather than abort a run that had already scaffolded others.
    expect(isPerCharacterScaffoldError(new ArtifactUnreadableError("/p/PALETTE.md", new Error("EISDIR")))).toBe(true)
  })

  it("rejects everything else, so environmental failures still abort the run", () => {
    expect(isPerCharacterScaffoldError(new Error("model server unreachable"))).toBe(false)
    expect(isPerCharacterScaffoldError({ _tag: "AxisCollisionError" })).toBe(false)
    expect(isPerCharacterScaffoldError(undefined)).toBe(false)
    expect(isPerCharacterScaffoldError("AxisCollisionError")).toBe(false)
  })
})

describe("logScaffoldSkip — the report cannot be silenced by a console threshold", () => {
  it("emits a kind:'error' event, not the kind:'system' one that classifies to info", async () => {
    const events = await runCapturing(
      logScaffoldSkip("hoshi", new AxisCollisionError("panic-calm")),
    )
    expect(events.length).toBe(1)
    // The whole fix: kind "system" (what logToConsole builds) classifies to
    // `info`, which LOG_LEVEL=warn filters out of the console — a character would
    // then fail to register with no visible reason.
    expect(events[0].kind).toBe("error")
    expect(events[0].kind).not.toBe("system")
    expect(classifyLevel(events[0])).toBe("error")
  })

  it("passes EVERY console threshold, including the ones that hid it before", () => {
    const asSystem = { kind: "system", message: "x" } as unknown as UnifiedEvent
    for (const threshold of ALL_THRESHOLDS) {
      expect(passesThreshold("error", threshold)).toBe(true)
    }
    // the old channel, for contrast: suppressed at warn and error
    expect(passesThreshold(classifyLevel(asSystem), "warn")).toBe(false)
    expect(passesThreshold(classifyLevel(asSystem), "error")).toBe(false)
  })

  it("names the character and carries the underlying error's own message", async () => {
    const e = new UnknownAxisError(["curiosity"], ["safety", "agency"])
    const events = await runCapturing(logScaffoldSkip("hoshi", e))
    const msg = (events[0] as { message: string }).message
    expect(msg).toContain("hoshi")
    expect(msg).toContain("skipping this character")
    expect(msg).toContain("curiosity")
  })
})

describe("logRegistrationSkip — the sibling line, same channel", () => {
  it("emits a kind:'error' event too (it was the same info-level weakness)", async () => {
    const events = await runCapturing(logRegistrationSkip("hoshi"))
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("error")
    expect(classifyLevel(events[0])).toBe("error")
    expect((events[0] as { message: string }).message).toContain(
      "Skipping config.json registration for hoshi",
    )
  })
})
