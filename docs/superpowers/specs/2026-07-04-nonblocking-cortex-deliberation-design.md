# Non-blocking cortex deliberation — design

**Status:** proposed · **Date:** 2026-07-04 · **Branch:** feat/wm

## Problem

The cortex tick loop `yield*`s every reasoning-tier completion **synchronously on
its own fiber**. The idle-path deliberation — forebrain `orient` → `memory.recall`
→ conscious `decide` (`loop.ts:499/513/519`) — therefore blocks the *entire* loop
until it returns. Observed impact in the 2026-07-04 QA run: conscious `decide`
durations of 59s / 3.6min / **21.4min** for near-identical ~800-char outputs
(memory-pressure-starved resident model). During each, the fast/limbic loop —
event drain, amygdala critical check, hindbrain triage — went completely blind.
This is not a tail event: 2 of 3 decides blocked the loop for minutes.

The transport-level guard (`client.ts` `3 × 300s` retry `AbortController`) did **not**
fire — the 21-min call ran as one attempt, exceeding the ~15min nominal ceiling. So
today there is **no working wall-clock cap** at any layer, and the serial structure
means a slow thought blinds the reflexes.

## Goal

**Reflexes stay live.** While a slow deliberation runs, the fast/limbic loop keeps
draining events, checking amygdala criticals, and running hindbrain triage on its
own cadence. The deliberation runs off the loop fiber; its result is applied when it
lands, or it is interrupted/superseded by the **existing escalation ladder** when the
world moves. There is **no wall-clock timeout** — the pathological slow case is
addressed at its root (see "Avoiding the pathological case"), not capped.

### Non-goals

- **Parallel conscious throughput.** The conscious tier is a single resident mlx
  process (8083, one model, one GPU). Two conscious calls contend on that server; they
  do not run in parallel. Forking `decide` buys loop *responsiveness*, not deliberation
  *throughput*. (Different tiers on 8081/8082/8083 *can* overlap, but that is not this
  change.)
- Fixing the `noTools`-on-opencode no-op, the transport `AbortController`, or `memory`
  survey — tracked as separate follow-ups.

## Approach: fork the idle deliberation, govern it with the ladder, hand back on the loop fiber

This is not new machinery — it **extends a pattern the loop already uses one layer
down**. The conscious *body* turn is already forked into a background fiber
(`consciousFiber`, `loop.ts:902/926`), polled non-blocking (`:408`), and its result
folded in **on the loop fiber** (`:410-420`). We apply the same fork/poll/join shape
to the idle deliberation.

### The invariant that makes it safe

**The fiber does pure model computation over a snapshot taken at fork time. ALL
loop-state mutation happens on the loop fiber — at fork time (snapshot) and at land
time (apply).** The deliberation fiber never writes `cortex.*`, `state`, episode
context, wm, or skills. It returns a value; the loop fiber applies it. This turns the
current *inline atomic critical section* (`orient → recall → decide → seed
plan/skill/wm/episode`, `loop.ts:478-613`) into a *fork-then-apply* section with the
same atomicity — the seed still happens in one place on one fiber, just at the
hand-back point instead of inline.

### New loop state

- `deliberationFiber: Fiber.RuntimeFiber<DeliberationResult> | null` — mirrors
  `consciousFiber`. Non-null ⇒ a deliberation is in flight.
- A captured **`DeliberationContext`** snapshot passed into the fork: the tick's
  `summary`, `accumulatedEvents`, `emotionalWeight`, identity context, and — critically
  — the **episode attribution** (`epoch`, `tick`, `stepId`) as of fork time.

`deliberationFiber` and `consciousFiber` are **mutually exclusive** by construction: a
deliberation produces the plan; the body turn runs only once `currentPlan !== null`
(`loop.ts:695`). Deliberation → plan → body turn is sequential; at most one fiber is
active. The loop guards both.

### Per-tick control flow (revised idle path)

Each iteration, in order (fast/limbic portion always runs first, never behind a tier
call):

1. Drain events → `state` (unchanged, `loop.ts:349-380`).
2. Classify + **amygdala critical** (unchanged, `:382-404`). A critical still
   `Fiber.interrupt`s any in-flight fiber (now: `consciousFiber` **and**
   `deliberationFiber`) and exits the loop.
3. **Poll `deliberationFiber`** (new, mirrors `:407-420`). If done → `Fiber.join`,
   then **apply on the loop fiber**: run the landed-result reconciliation (below),
   and on accept seed `currentPlan`/`wornSkill`/wm todos/episode step exactly as the
   inline path does today.
4. Poll `consciousFiber` (unchanged).
5. **Hindbrain triage** every tick (unchanged, `:424-459`) → `HindbrainEscalation`.
6. **Escalation dispatch:**
   - `currentPlan !== null` → the existing in-session ladder (5b, unchanged): steer /
     reorient / interrupt the running body turn.
   - `deliberationFiber !== null` (new "deliberating" state) → apply the ladder to the
     **in-flight deliberation**:
     - `interrupt` rung → `Fiber.interrupt(deliberationFiber)`, clear it, re-orient
       next tick.
     - `reorient` rung → `Fiber.interrupt(deliberationFiber)`, clear it, re-orient
       next tick (world moved materially; the snapshot is stale).
     - `steer` / `accumulate` → **let it cook**; the newly-accumulated events are
       retained (not drained) so they feed the *next* orient if this deliberation is
       later interrupted, or inform the landed-result reconciliation. There is no open
       session to push a `pendingDirective` into yet, so steer does not run a forebrain
       turn here (that is the in-session path's job).
     - `none` → let it cook.
   - `currentPlan === null && deliberationFiber === null && escalate` → **fork a new
     deliberation** (snapshot the `DeliberationContext`, `Effect.fork` the whole
     `orient → recall → decide` chain).
7. Step execution (unchanged, gated on `currentPlan !== null && !consciousFiber`).
8. Sleep one tick (unchanged, `:946`).

### Landed-result reconciliation (when the deliberation fiber completes)

On the loop fiber, before applying the plan:

- If events accumulated *during* the deliberation reached a **reorient/interrupt**
  rung, **discard the landed plan and re-orient** (the world moved; the plan is stale).
  This is the ladder answering "stale decision," per the approved model.
- Otherwise **apply** the plan: seed `currentPlan`/`wornSkill`/wm/episode step as the
  inline path does today, drain the deliberation's snapshot events.

This reuses the ladder's own thresholds as the freshness test — no new "staleness"
concept.

### Episode attribution (the sharpest race — required sub-fix)

`emitTier` stamps a tier record with `ctx.tick`/`ctx.stepId` **read at completion
time** (`tiers.ts:134-136`). A deliberation forked at tick N and completing at tick
N+k would mis-stamp its `orient`/`decide` records with N+k's tick/stepId (the fast
loop advances `setEpisodeTick` every tick, `loop.ts:342`). **Fix:** capture the
episode attribution (epoch/tick/stepId) into the `DeliberationContext` at fork time,
and have the forked chain emit its tier records against the *captured* attribution,
not the live module-level context. (Mechanism — thread an explicit attribution through
the tier runners, or run the fork under a scoped attribution override — decided in the
plan.)

### Avoiding the pathological case (no timeout)

**Decision: no wall-clock timeout on the deliberation.** A cap papers over a slow
model; we treat the pathology as a root-cause problem instead.

The 21-min decide was a *small* (~800-char) output produced at near-zero throughput —
the signature of a **memory-pressure-starved resident model** during a contention
spike (the macro frontier turn + synthesis turn + embed + transient tier servers all
live around the 33 GB resident conscious model). It was not a long generation. So the
avoidance strategy is **prompt + supporting structure**, tracked as follow-ups, not a
timeout:

- **Resource/contention management** — keep the resident conscious model's working set
  resident (don't co-run the heavy frontier macro turn against the conscious tier such
  that the model gets paged); stagger/gate tier usage so `decide` runs on a healthy
  server. This is the actual fix for the observed pathology.
- **Bounded decide prompt/output** — keep the decide prompt and expected output tight
  so a healthy model finishes fast; a bounded task is a fast task.

Because the fork already removes the **loop-freeze**, an occasional slow deliberation
is no longer catastrophic: reflexes stay live, and any material world-change routes
through the ladder to interrupt the stale deliberation and re-orient. The residual
case — quiet world *and* a stuck model — leaves the deliberation running long but
harmless (loop responsive; no new deliberation forks until it lands or is interrupted).
We accept that in exchange for not masking slowness, and fix the cause upstream.

## Error handling

- Deliberation fiber failure/interrupt → never-fail: no plan seeded, placeholder state
  retained, re-orient next tick. Matches the existing degrade-never-crash posture of
  dream/retrospect/macro and the current `parseOr` decide fallback.
- Amygdala critical during deliberation → interrupt the fiber and exit to break/social,
  identical to today's critical path (now also targeting `deliberationFiber`).

## Testing

Extend `loop.test.ts` (the 39-test limbic-drives suite) with:

1. **Reflexes stay live:** a slow (blocking) forked deliberation does not prevent
   hindbrain triage / amygdala checks from running on subsequent ticks.
2. **Ladder interrupts deliberation:** a `reorient`-rung event mid-deliberation
   interrupts the fiber and re-orients; an `interrupt`-rung / amygdala-critical does the
   same (critical also exits).
3. **Landed reconciliation:** a deliberation that lands after a `reorient`-rung event
   is discarded (re-orient), not applied; one that lands into a quiet world is applied.
4. **Episode attribution:** tier records emitted by a deliberation forked at tick N
   carry N's `stepId`, not the completion tick's.
5. **Mutual exclusion:** never fork a deliberation while one is in flight or while a
   plan/body-turn is active.

All existing loop/tier tests must stay green. TDD: tests first.

## Risks

- **Fiber/interruption correctness in the loop.** De-risked by mirroring the proven
  `consciousFiber` fork/poll/join/interrupt template already in `loop.ts`.
- **Attribution threading** touches the tier runners (`tiers.ts`) — must not regress the
  in-session (non-forked) path's attribution.
- **Reconciliation subtlety** (drain vs retain `accumulatedEvents` across the fork) —
  covered by test 3.
- **Residual quiet-world slow deliberation** (no timeout). A stuck model in a silent
  world runs long but harmless — loop responsive, ladder re-arms on any world change,
  and the deliberation completes or is superseded. Accepted; the slowness cause is
  fixed upstream (resource/prompt structure), not capped.

## Decisions (resolved in review)

- **No wall-clock timeout.** Root-cause the pathology (resource/prompt structure)
  rather than cap it. See "Avoiding the pathological case."
- **Fork the whole `orient → recall → decide` chain** (all the heavy pre-plan work),
  not `decide` alone.

## Follow-ups (out of scope)

- `noTools` no-op on opencode (`payload.ts:88`).
- Transport `AbortController` not capping a stuck resident read (`client.ts`).
- `memory survey` subcommand; wm render-not-duplicate; the flaky fs/readiness test.
