import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import {
  isResponseTruncated,
  classifyTierOutcome,
  callTier,
  renderAxisBlock,
  type ActivationRunnerConfig,
} from "./tier-config.js"
import { buildAxisSpecs } from "../../core/salience.js"
import { DEFAULT_CORTEX_MODELS } from "../../model/handles.js"
import { fixedClient, recordingService, recordingLog } from "../../testing/model-test-layers.js"
import type { UnifiedEvent } from "../../logging/events.js"

const cfg: ActivationRunnerConfig = {
  char: { name: "ada", root: "/work/players/ada" },
  cadence: "real-time",
  models: DEFAULT_CORTEX_MODELS,
}

type BehaviorEvent = Extract<UnifiedEvent, { kind: "behavior" }>

describe("isResponseTruncated", () => {
  it("flags a completion that reached the token ceiling", () => {
    expect(isResponseTruncated({ completionTokens: 1024 }, 1024, "length")).toBe(true)
  })
  it("flags on completionTokens >= maxTokens even without a finish reason", () => {
    expect(isResponseTruncated({ completionTokens: 1100 }, 1024, undefined)).toBe(true)
  })
  it("flags on finish_reason=length even when tokens are unknown", () => {
    expect(isResponseTruncated(undefined, undefined, "length")).toBe(true)
  })
  it("does not flag a normal stop under budget", () => {
    expect(isResponseTruncated({ completionTokens: 200 }, 1024, "stop")).toBe(false)
  })
  it("does not flag when maxTokens is unknown and stop is normal", () => {
    expect(isResponseTruncated({ completionTokens: 5000 }, undefined, "stop")).toBe(false)
  })
  it("does not flag when there is no usage and no length signal", () => {
    expect(isResponseTruncated(undefined, 1024, undefined)).toBe(false)
  })
})

describe("classifyTierOutcome", () => {
  it("classifies a TimeoutException as timeout", () => {
    expect(classifyTierOutcome({ _tag: "TimeoutException" })).toBe("timeout")
  })
  it("classifies an unknown error as error", () => {
    expect(classifyTierOutcome(new Error("boom"))).toBe("error")
  })
})

describe("callTier — in-flight start event", () => {
  it("emits a tier_call_start (carrying tier + step) BEFORE the tier_call completion", async () => {
    const logs: UnifiedEvent[] = []
    await Effect.runPromise(
      Effect.provide(
        callTier(cfg, "conscious", "decide", "hello"),
        Layer.mergeAll(
          fixedClient('{"decision":"wait","reasoning":"x"}'),
          recordingService([]),
          recordingLog(logs),
        ),
      ),
    )
    const behaviors = logs.filter((e): e is BehaviorEvent => e.kind === "behavior")
    const startIdx = behaviors.findIndex((e) => e.behavior.type === "tier_call_start")
    const doneIdx = behaviors.findIndex(
      (e) => e.behavior.type === "tier_call" && e.behavior.outcome === "ok",
    )
    // A start event fired…
    expect(startIdx).toBeGreaterThanOrEqual(0)
    // …the completion event fired…
    expect(doneIdx).toBeGreaterThanOrEqual(0)
    // …and the start strictly precedes the completion.
    expect(startIdx).toBeLessThan(doneIdx)
    // The start event carries the tier and step context the completion uses.
    expect(behaviors[startIdx].behavior).toMatchObject({
      type: "tier_call_start",
      tier: "conscious",
      step: "decide",
    })
  })
})

describe("renderAxisBlock", () => {
  const axes = buildAxisSpecs(
    "- safety — your physical integrity\n- voyage — progress toward your destination",
    "😫 😮‍💨 😐 🤩 🚀 # burdened → exhilarated",
  )

  it("lists every axis with its range, drives before palette axes", () => {
    const block = renderAxisBlock(axes)
    const lines = block.trim().split("\n")
    expect(lines[0]).toContain("safety")
    expect(lines[1]).toContain("voyage")
    expect(lines[2]).toContain("burdened-exhilarated")
  })

  it("states the unipolar range for a drive axis and NO negative pole", () => {
    const line = renderAxisBlock(axes).split("\n").find((l) => l.includes("safety"))!
    expect(line).toContain("0.0 to 1.0")
    expect(line).not.toContain("-1.0")
  })

  it("states the SIGNED range for a palette axis and names both poles in order", () => {
    const line = renderAxisBlock(axes).split("\n").find((l) => l.includes("burdened-exhilarated"))!
    expect(line).toContain("-1.0")
    expect(line).toContain("+1.0")
    // first pole negative, second positive — the convention is legible from the line
    expect(line.indexOf("burdened")).toBeLessThan(line.indexOf("exhilarated"))
  })

  it("renders (none) for an absent or empty axis list, and never throws", () => {
    expect(renderAxisBlock(undefined)).toContain("(none)")
    expect(renderAxisBlock([])).toContain("(none)")
  })
})
