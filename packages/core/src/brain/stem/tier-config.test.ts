import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { isResponseTruncated, classifyTierOutcome, callTier, type ActivationRunnerConfig } from "./tier-config.js"
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
