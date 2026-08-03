import { describe, expect, it } from "vitest"
import {
  DEFAULT_INJECTION_RATE,
  applyInjection,
  createRng,
  decideInjection,
  resolveInjectionConfig,
} from "./recall-injection.js"

const POOL = 20
const K = 5

/** Run `n` recalls' worth of decisions off one seeded generator. */
function trials(rate: number, n: number, seed = "fixed-seed") {
  const cfg = { rate, seed }
  const rng = createRng(seed)
  const out = []
  for (let i = 0; i < n; i += 1) out.push(decideInjection(POOL, K, cfg, rng, i))
  return out
}

describe("injection fires at the configured rate, and can be turned off completely", () => {
  it("realises approximately the configured rate over many seeded trials", () => {
    // 5% over 20k trials: the binomial sd is ~0.15%, so ±1% is ~6.5 sd — this
    // catches a wrong rate without being a flake. Seeded, so it is deterministic.
    const fired = trials(DEFAULT_INJECTION_RATE, 20_000).filter((d) => d.fired).length
    expect(fired / 20_000).toBeCloseTo(DEFAULT_INJECTION_RATE, 2)
  })

  it("NEVER fires at rate 0, and does not even draw", () => {
    const decisions = trials(0, 5_000)
    expect(decisions.some((d) => d.fired)).toBe(false)
    expect(decisions.every((d) => d.enabled === false)).toBe(true)
    expect(decisions.every((d) => d.draw === null && d.pick === null)).toBe(true)
    // The generator is untouched when disabled: a disabled run consumes nothing.
    const rng = createRng("fixed-seed")
    const cfg = { rate: 0, seed: "fixed-seed" }
    decideInjection(POOL, K, cfg, rng, 0)
    expect(rng()).toBe(createRng("fixed-seed")())
  })

  it("fires on every recall at rate 1, and is reproducible from the seed alone", () => {
    const a = trials(1, 50)
    const b = trials(1, 50)
    expect(a.every((d) => d.fired)).toBe(true)
    expect(a.map((d) => d.injectedIndex)).toEqual(b.map((d) => d.injectedIndex))
  })

  it("cannot fire when there is nothing to draw or nothing to displace", () => {
    const cfg = { rate: 1, seed: "s" }
    const rng = createRng("s")
    // Whole pool returned → no rejected portion.
    expect(decideInjection(5, 5, cfg, rng, 0).fired).toBe(false)
    // Nothing returned → nothing to displace.
    expect(decideInjection(5, 0, cfg, rng, 1).fired).toBe(false)
  })
})

describe("the injected candidate is genuinely drawn from the rejected portion", () => {
  it("always picks an index at or below the top-k boundary, and reaches deep into it", () => {
    const seen = new Set<number>()
    for (const d of trials(1, 2_000)) {
      expect(d.injectedIndex).not.toBeNull()
      // Strictly outside the ranker's returned prefix, and inside the pool.
      expect(d.injectedIndex as number).toBeGreaterThanOrEqual(K)
      expect(d.injectedIndex as number).toBeLessThan(POOL)
      // The displaced one is always the lowest-ranked winner.
      expect(d.displacedIndex).toBe(K - 1)
      seen.add(d.injectedIndex as number)
    }
    // Uniform, not "the first reject every time": every rejected slot is hit.
    expect(seen.size).toBe(POOL - K)
  })

  it("applyInjection swaps exactly one in and one out, leaving the count and order intact", () => {
    const pool = Array.from({ length: POOL }, (_, i) => ({ id: i, returned: i < K }))
    const d = trials(1, 1)[0]
    const after = applyInjection(pool, d)
    expect(after.map((c) => c.id)).toEqual(pool.map((c) => c.id)) // rank order preserved
    expect(after.filter((c) => c.returned)).toHaveLength(K)
    expect(after[d.injectedIndex as number].returned).toBe(true)
    expect(after[d.displacedIndex as number].returned).toBe(false)
    expect(pool[d.injectedIndex as number].returned).toBe(false) // input untouched
  })

  it("a no-fire decision returns the pool verbatim", () => {
    const pool = Array.from({ length: 3 }, (_, i) => ({ id: i, returned: i < 1 }))
    const d = decideInjection(3, 1, { rate: 0, seed: "s" }, createRng("s"), 0)
    expect(applyInjection(pool, d)).toEqual(pool)
  })
})

describe("config resolution", () => {
  it("defaults to OFF under vitest, and on to the default rate outside it", () => {
    expect(resolveInjectionConfig({ VITEST: "true" }, () => "s").rate).toBe(0)
    expect(resolveInjectionConfig({}, () => "s").rate).toBe(DEFAULT_INJECTION_RATE)
  })

  it("an explicit rate wins everywhere; a malformed one falls back rather than silently disabling", () => {
    expect(
      resolveInjectionConfig({ VITEST: "true", ROCI_RECALL_INJECTION_RATE: "0.5" }, () => "s").rate,
    ).toBe(0.5)
    expect(resolveInjectionConfig({ ROCI_RECALL_INJECTION_RATE: "banana" }, () => "s").rate).toBe(
      DEFAULT_INJECTION_RATE,
    )
    expect(resolveInjectionConfig({ ROCI_RECALL_INJECTION_RATE: "7" }, () => "s").rate).toBe(
      DEFAULT_INJECTION_RATE,
    )
    expect(resolveInjectionConfig({ ROCI_RECALL_INJECTION_RATE: "0" }, () => "s").rate).toBe(0)
  })

  it("uses a pinned seed when given one, so a run replays", () => {
    expect(resolveInjectionConfig({ ROCI_RECALL_INJECTION_SEED: "abc" }, () => "s").seed).toBe("abc")
    expect(resolveInjectionConfig({}, () => "generated").seed).toBe("generated")
  })
})
