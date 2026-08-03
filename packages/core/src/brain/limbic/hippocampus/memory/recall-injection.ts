/**
 * Randomised candidate injection: a permanent structural null for the ranker.
 *
 * WHY THIS EXISTS — and why it is worth letting a random memory reach the
 * character. Every number the recall telemetry stream records describes the
 * candidates the RANKER chose. That is a biased sample by construction: it can
 * tell you what the top of the ranking looks like, but it can never tell you
 * what the rest of the pool looked like, so it can never establish a base rate
 * and can never answer "does the ranking beat chance?" against anything but a
 * hand-labelled offline proxy. Offline proxies are exactly where this project
 * has been burned: hand-built random controls are what caught six of ten
 * salience variants scoring WORSE than random.
 *
 * On a small fraction of recalls, then, one candidate is drawn UNIFORMLY from
 * the REJECTED portion of the pool and swapped in for the lowest-ranked item
 * that would otherwise have been returned. Over many recalls those injections
 * accumulate into an unbiased sample of the pool — the control arm, collected
 * in production, permanently, at a cost of ~1-in-20 recalls carrying one extra
 * arbitrary memory.
 *
 * ── This changes what the character sees ─────────────────────────────────────
 *
 * That is the point, and it is also the hazard. Three guards:
 *  - the rate is small (5%) and configurable, and `0` disables it COMPLETELY —
 *    at rate 0 nothing is drawn and no candidate is ever swapped;
 *  - it is OFF BY DEFAULT UNDER VITEST, so no suite becomes non-deterministic
 *    (an explicit `ROCI_RECALL_INJECTION_RATE` still wins, for the tests that
 *    exercise this on purpose);
 *  - every realised decision is recorded — whether it fired, which candidate
 *    went in, which one it displaced — so the injected line is always
 *    attributable after the fact, never a mystery memory.
 *
 * ── Reproducibility ─────────────────────────────────────────────────────────
 *
 * The randomness is SEEDED and the seed is on every record, together with a
 * monotonic `drawIndex` and the raw draws. An analyst can therefore replay the
 * exact sequence and VERIFY the realised injection rate rather than trusting the
 * configured one. The generator is a plain mulberry32 over an FNV-1a seed hash:
 * deterministic, dependency-free, and adequate for a Bernoulli trial and a
 * uniform pick (it is NOT cryptographic, and must not be used as if it were).
 */

/** Default fraction of recalls that receive an injected candidate. */
export const DEFAULT_INJECTION_RATE = 0.05

/** Env var overriding the rate. `0` disables injection entirely. */
export const INJECTION_RATE_ENV = "ROCI_RECALL_INJECTION_RATE"
/** Env var pinning the seed, for a reproducible run. */
export const INJECTION_SEED_ENV = "ROCI_RECALL_INJECTION_SEED"

/** FNV-1a over a string → a 32-bit seed. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG. Returns values in
 * [0, 1). Deterministic for a given seed string; NOT cryptographic.
 */
export function createRng(seed: string): () => number {
  let a = fnv1a(seed)
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Resolved injection settings for one process. */
export interface InjectionConfig {
  /** Fraction of recalls that receive an injection; 0 disables it completely. */
  readonly rate: number
  /** The seed the run's generator was built from. Recorded on every record. */
  readonly seed: string
}

/**
 * Resolve the config from the environment.
 *
 * Default rate is `DEFAULT_INJECTION_RATE`, EXCEPT under vitest where it is 0 —
 * an unseeded 5% coin flip inside a test suite is a non-deterministic suite, and
 * the tests that exercise injection do so by calling the pure functions below
 * with an explicit rate and rng. An explicit env value always wins, including
 * under vitest. A malformed or out-of-range value falls back to the default
 * rather than silently disabling the control arm.
 */
export function resolveInjectionConfig(
  env: NodeJS.ProcessEnv = process.env,
  seedFallback: () => string = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
): InjectionConfig {
  const underTest = typeof env.VITEST === "string" && env.VITEST.length > 0
  const raw = env[INJECTION_RATE_ENV]?.trim()
  let rate = underTest ? 0 : DEFAULT_INJECTION_RATE
  if (raw !== undefined && raw.length > 0) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) rate = parsed
  }
  const seed = env[INJECTION_SEED_ENV]?.trim()
  return { rate, seed: seed && seed.length > 0 ? seed : seedFallback() }
}

/** The realised decision for ONE recall — recorded whether or not it fired. */
export interface InjectionDecision {
  /** Was injection enabled at all for this recall (`rate > 0`)? */
  readonly enabled: boolean
  /** The configured rate this recall was judged against. */
  readonly rate: number
  /** The seed of the run's generator. */
  readonly seed: string
  /** Monotonic index of this recall's draws within the run — replay coordinate. */
  readonly drawIndex: number
  /** The Bernoulli draw; null when disabled (nothing is drawn at rate 0). */
  readonly draw: number | null
  /** The uniform draw used to pick from the rejected portion; null when disabled. */
  readonly pick: number | null
  readonly fired: boolean
  /** How many candidates were available to draw from (the rejected portion). */
  readonly eligibleRejected: number
  /** Index into the rank-ordered pool of the injected candidate; null if not fired. */
  readonly injectedIndex: number | null
  /** Index of the ranked candidate it displaced; null if not fired. */
  readonly displacedIndex: number | null
}

/** Anything with a `returned` flag — kept structural so this module is testable alone. */
export interface Returnable {
  readonly returned: boolean
}

/**
 * Decide, for one recall, whether to inject and what.
 *
 * Both draws are taken whenever injection is ENABLED, even when the Bernoulli
 * trial fails, so the generator advances by exactly two per recall and a replay
 * does not have to know the outcome to stay in step. At rate 0 NOTHING is drawn
 * — disabled means the generator is untouched and the pool is returned verbatim.
 *
 * `returnedCount` is the ranker's top-k. Injection needs at least one ranked
 * winner to displace and at least one rejected candidate to draw; when either is
 * missing the decision is a well-formed no-fire, not an error.
 */
export function decideInjection(
  poolSize: number,
  returnedCount: number,
  cfg: InjectionConfig,
  rng: () => number,
  drawIndex: number,
): InjectionDecision {
  const eligibleRejected = Math.max(0, poolSize - returnedCount)
  const base = {
    rate: cfg.rate,
    seed: cfg.seed,
    drawIndex,
    eligibleRejected,
  }
  if (!(cfg.rate > 0)) {
    return {
      ...base,
      enabled: false,
      draw: null,
      pick: null,
      fired: false,
      injectedIndex: null,
      displacedIndex: null,
    }
  }
  const draw = rng()
  const pick = rng()
  const possible = eligibleRejected > 0 && returnedCount > 0
  const fired = draw < cfg.rate && possible
  if (!fired) {
    return {
      ...base,
      enabled: true,
      draw,
      pick,
      fired: false,
      injectedIndex: null,
      displacedIndex: null,
    }
  }
  // Uniform over the rejected portion — indices [returnedCount, poolSize).
  const offset = Math.min(eligibleRejected - 1, Math.floor(pick * eligibleRejected))
  return {
    ...base,
    enabled: true,
    draw,
    pick,
    fired: true,
    injectedIndex: returnedCount + offset,
    displacedIndex: returnedCount - 1,
  }
}

/**
 * Apply a decision to the rank-ordered pool, returning a new array in the SAME
 * rank order with `returned` re-flagged: the injected candidate now reaches the
 * prompt, the lowest-ranked winner no longer does. `returnedCount` is unchanged
 * — this is a swap, not an extra hit.
 *
 * A displaced candidate is recognisable in the telemetry without any extra
 * field: its rank is within the top k and its `returned` is false.
 */
export function applyInjection<T extends Returnable>(
  candidates: ReadonlyArray<T>,
  decision: InjectionDecision,
): T[] {
  const out = [...candidates]
  if (!decision.fired) return out
  const { injectedIndex, displacedIndex } = decision
  if (injectedIndex === null || displacedIndex === null) return out
  if (injectedIndex >= out.length || displacedIndex >= out.length) return out
  out[injectedIndex] = { ...out[injectedIndex], returned: true }
  out[displacedIndex] = { ...out[displacedIndex], returned: false }
  return out
}
