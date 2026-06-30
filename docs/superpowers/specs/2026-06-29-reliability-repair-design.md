# Reliability repair design — High-severity silent failures in the cortex/limbic loop

**Status:** design / repair spec (investigation phase). No code written.
**Date:** 2026-06-29
**Subteam:** C — Reliability (Thread 4 of the limbic/cortex refinement).
**Scope:** the four High-severity silent failures from
`2026-06-29-limbic-cortex-primitives-analysis.md` §"Thread 4". Each must either
fail loudly (structured, error-level log) or be made structurally impossible.
**Worktree:** `/Users/vcarl/workspace/roci/.claude/worktrees/dream-sequence`
(branch `worktree-dream-sequence`). All file:line references verified against the
rebased tree on 2026-06-29; deltas from the charter's pointers are noted inline
and summarized at the end.

This is a design document. No fixes are implemented. Code appears only as tiny
illustrative fragments.

---

## Cross-cutting finding: "console-logged" is actually *info*-level, not loud

The single most important verified fact, shared by issues 1, 2, and 4:

`logToConsole(char, source, message)` (`logging/log-writer.ts:65–77`) emits a
`kind:"system"` event. With no explicit 4th-arg `level`, `classifyLevel`
(`logging/levels.ts:12–27`) maps `kind:"system"` → **`"info"`**. The `source`
string (e.g. `"error"`) is cosmetic — it sets `system`/`subsystem`, **not** the
log level.

Consequences:
- `logToConsole(char.name, "error", "Consolidate failed: …")`
  (`planned-action.ts:45,52`) is an **info**-level line, not an error. It passes
  the default `info` console threshold but is indistinguishable in rank from
  routine chatter and is **not** a structured `kind:"error"` event.
- The diary-turn fallback (issue 1) and the empty-plan drop (issue 4) emit
  **nothing at all**.

**House conventions available for "fail loud":**
1. `logToConsole(char, source, msg, "error")` — explicit 4th-arg level; still a
   `kind:"system"` event but ranked `error`, so it survives any threshold and is
   greppable by level. Lowest-friction, matches the leveled-logging pipeline
   shipped on `main`.
2. `log.emit(char, { …eventBase, kind:"error", message })` — a true structured
   `kind:"error"` event (`events.ts:22`), auto-classified `error`
   (`levels.ts:14`). Richer for downstream consumers of `events.jsonl`.

**Recommendation (a convention to settle BEFORE implementing any of the four):**
use option (1) — `logToConsole(..., "error")` — for the loop/orchestrator
fail-loud sites (it is the established 3-arg→4-arg drop-in and keeps the diffs
minimal), and reserve `kind:"error"` for cases where a machine consumer needs the
structured shape. Settling this first keeps all four repairs consistent; see
"Dependency / ordering".

The Effect error-handling house style to match (observed across the codebase):
`…pipe(Effect.catchAll((e) => <log effect>))` and, where a fallback value must be
produced, `Effect.catchAll((e) => <log>.pipe(Effect.as(<fallback>)))` so the log
fires *and* the fallback is returned (this exact pattern already exists at
`tiers.ts:181–190` for the forebrain parse-miss). A log-write failure must itself
never crash the loop — swallow it with a trailing `Effect.catchAll(() =>
Effect.void)` (also already the convention, `tiers.ts:97,187`).

---

## Issue 1 — Diary-turn timeout (and model error) → silent diary data loss

**(a) Confirmed root cause — `cortex/loop.ts:332–343` (verified; charter pointer
`:332–343` is correct).**

```ts
const diaryEntry = yield* runDiaryTurn(runnerConfig, { … }).pipe(
  Effect.timeout("30 seconds"),
  Effect.catchAll(() => Effect.succeed("")),   // <- swallows everything, no log
)
if (diaryEntry) { …read diary, append, write… }   // skipped when ""
```

`runDiaryTurn` (`tiers.ts:302–316`) calls the forebrain tier and can fail with
`ModelError | SpawnError | ReadinessError`; `Effect.timeout` adds a
`TimeoutException`. The `catchAll(() => Effect.succeed(""))` collapses **both**
the timeout *and* every model/spawn/readiness error into an empty string with no
log. The `if (diaryEntry)` guard then silently skips the write.

**(b) Failure mechanism.** A diary turn that times out (>30s) or errors yields
`""`; the cycle's first-person reflection is dropped and nothing records that it
happened — pure silent data loss, exactly when the model is slow/overloaded
(i.e. when you most want to know).

**(c) Proposed repair — fail loud (do not prevent).** Losing one diary entry is
tolerable; invisibility is not. Replace the bare `catchAll` with a logging
catchAll that distinguishes timeout from error and still degrades to `""`:

```ts
.pipe(
  Effect.timeout("30 seconds"),
  Effect.catchAll((e) =>
    logToConsole(config.char.name, "cortex",
      `diary turn failed (${e._tag ?? "error"}); entry dropped`, "error")
      .pipe(Effect.catchAll(() => Effect.void), Effect.as("")),
  ),
)
```

This matches the existing `tiers.ts:181–190` fail-loud-then-fallback pattern.
(`TimeoutException` carries `_tag: "TimeoutException"`, so the message
distinguishes a slow turn from a model error without extra plumbing.) The
adjacent `diary write failed` log at `loop.ts:351–354` should be **upgraded to
explicit `"error"` level** in the same edit (it is currently info-level by the
cross-cutting finding above).

**(d) Test strategy — `cortex/loop.test.ts`.** The loop test already drives the
loop with a scripted `ModelClient` + `ConsciousThoughtTest` + a fake `Queue`,
and already routes the diary turn by the unique `"plain prose"` prompt marker
(`loop.test.ts:39,78`). Two failing tests:
- *Model-error path (fast, deterministic):* make the diary branch of the scripted
  client return `Effect.fail(new ModelError(...))`; assert a `level:"error"`
  system event with "diary turn failed" is emitted and the loop still advances
  (no crash). This exercises the `catchAll` log without needing real time.
- *Timeout path:* have the diary branch sleep >30s under Effect `TestClock`
  (the transport tests already use `TestClock`, `transport.test.ts:43–69`), and
  assert the same structured log fires with a timeout tag.
A recording `CharacterLog` layer (as in `transport.test.ts:128–137`) captures
emitted events for assertions.

---

## Issue 2 — Consolidate/dream failure → stale memory, loop proceeds (under-loud)

**(a) Confirmed root cause — `core/orchestrator/planned-action.ts:42–54`
(verified; charter pointer `:43–54` is correct).**

```ts
yield* consolidate.execute({ … }).pipe(
  Effect.catchAll((e) => logToConsole(char.name, "error", `Consolidate failed: ${e}`)),
)
yield* dream.execute({ … }).pipe(
  Effect.catchAll((e) => logToConsole(char.name, "error", `Dream failed: ${e}`)),
)
```

Per the cross-cutting finding, these `logToConsole(..., "error")` calls produce
**info-level** `kind:"system"` events — not error-level, not structured
`kind:"error"`. So the failure is logged, but *under-loud*: it ranks the same as
routine status lines and carries no error severity. `runReflection` then returns
normally and the orchestrator proceeds; the next cycle reads the **un-consolidated,
un-culled** diary/secrets (stale, and growing unbounded since the cull that bounds
`DIARY.md` never ran).

**(b) Failure mechanism.** A consolidate or dream model failure is swallowed into
an info-level line; reflection silently no-ops for the cycle and the loop carries
on with stale, unbounded memory — diagnosable only by someone grepping info logs
for the right substring.

**(c) Proposed repair — fail loud (keep best-effort continuation).** Per charter
decision 5, repair not paper-over, but a failed reflection should not halt the
agent (a one-cycle skip is recoverable; halting an unattended agent is worse).
So: raise severity, do not change control flow. Add explicit `"error"` level to
both catchAll logs:

```ts
Effect.catchAll((e) =>
  logToConsole(char.name, "hippocampus", `Consolidate failed: ${e}`, "error"))
```

(Use a meaningful `source` such as `"hippocampus"`; the bare `"error"` source is
redundant once the level is explicit.) Open sub-question for the lead-of-leads:
should a *consecutive-failure counter* escalate (e.g. after N cycles of failed
reflection, emit a distinct critical)? Recommended as a follow-up, **out of scope**
for this repair — flagged, not designed.

**(d) Test strategy — `core/orchestrator/planned-action.test.ts` (existing).**
The file already mocks the model turn via `runTurnMock` (`planned-action.test.ts:7–10`)
and drives `runReflection` with a fake `CharacterFs` + recording layers. Add a
test that makes `runTurnMock` return `Effect.fail(...)` for the consolidate (and,
separately, the dream) turn, with a recording `CharacterLog`, and assert: (i) a
`level:"error"` event is emitted, (ii) `runReflection` still completes (does not
fail the effect), (iii) the diary is left unmodified (no partial write).

---

## Issue 3 — Turn timeout/interrupt orphans the in-container process

**(a) Confirmed root cause — `transport.ts:171–196` + the docker-exec transport
(verified). The charter/analysis framing "never kills the underlying Docker
process" is imprecise and should be corrected.**

What actually happens on timeout (`transport.ts:174–180`): the four reader fibers
(`heartbeatFiber`, `exitFiber`, `streamFiber`, `stderrFiber`) are interrupted and
the gen returns `{ output, timedOut:true, … }`. Because `runTransport` is wrapped
in `Effect.scoped` (`transport.ts:85`) and the process came from
`executor.start(input.command)` (`:96`), **scope teardown runs `@effect/platform`'s
process finalizer, which DOES terminate the host-side `docker exec` client
process.** So the host process is not leaked.

The real leak is one level down: the command is `docker exec -i … <containerId>
bash -c <innerCmd>` (`process-runner.ts:26–37,74,199`). Killing the host
`docker exec` *client* does **not** signal-forward to the process it started
**inside** the container — Docker does not propagate the client's death to the
exec'd process. So the in-container `opencode` / `claude` / SDK process is
**orphaned and keeps running** (CPU, RAM, and a held model-server connection)
until it finishes on its own or the container dies. Over a long unattended run
these accumulate — a genuine resource leak.

The same orphaning occurs on the **critical-interrupt path**
(`loop.ts:173`, `Fiber.interrupt(consciousFiber)`): interrupting the cortex fiber
tears down the scope → kills the host client → orphans the in-container child.

**(b) Failure mechanism.** A timed-out or interrupted turn reaps only the host
`docker exec` client; the agent process inside the container is left running with
no owner, stranding container resources. Invisible because the host side looks
clean.

**(c) Proposed repair — structurally prevent (primary) + a decision on the
interrupt path.** Both container images are `node:20` (Debian); coreutils
`timeout` and `procps`/`pkill` are present (verified in
`packages/domain-*/src/docker/Dockerfile`). Two mechanisms:

- **Primary — in-container self-bounding via `timeout`.** Wrap the inner command
  so the in-container process kills *itself* at a wall-clock budget, independent
  of the host. In the inner-command builders
  (`payload.ts` → `buildInnerCommand` / `buildOpenCodeSessionCommand`, and the
  SDK builder), prefix with coreutils `timeout`:
  `timeout --kill-after=10s <N>s <innerCmd>`, where `<N>` is derived from
  `config.timeoutMs` and set **slightly below** the host `timeoutMs` so the child
  dies first and the host race sees a clean exit rather than firing its own
  timeout branch. This needs **no** Docker dependency in the transport and
  survives even a host-side crash.
  **Verify in implementation (flagged):** signal propagation through `bash -c`.
  `timeout` signals its direct child (the `bash` running `innerCmd`); if
  `innerCmd` is a pipeline, SIGTERM to `bash` may not reap pipeline members. Mitigate
  by `exec`-ing the real process where the payload is a single command, and/or
  rely on `--kill-after` SIGKILL. This is the one detail that must be confirmed
  against the real `opencode run` / `claude -p` / SDK inner commands before
  shipping.

- **Secondary / decision-needed — active kill on critical interrupt.** The
  `timeout` wrapper fixes the *timeout* leak but NOT the *critical-interrupt*
  leak: an interrupt mid-turn orphans the in-container process until its own
  (possibly ~1hr) `timeout` budget elapses. Closing that fully requires an active
  in-container kill (e.g. `docker exec <container> pkill -f <player-workdir-scoped
  pattern>`) on the interrupt path. That adds a Docker-dependent cleanup step and
  a pattern-matching risk. **This is a human decision (see Thorny questions):**
  accept bounded orphan-until-timeout on interrupt, or invest in active kill.

Keep the existing fiber interrupts + scope teardown as-is (they correctly reap
the host client and the reader fibers); the repair *adds* the in-container bound.

**(d) Test strategy — `payload.test.ts` (primary) + `transport.test.ts`.** The
clean, Docker-free seam is the inner-command builder: assert that
`buildInnerCommand` / `buildOpenCodeSessionCommand` / the SDK builder emit a
command string prefixed with `timeout … <derived-seconds>` derived from
`timeoutMs` (pure string assertions in `payload.test.ts`, no container needed).
`transport.test.ts` already has a real-subprocess timeout test
(`transport.test.ts:161–177`); extend it to assert that after `timedOut:true` the
spawned child has actually exited (using a `bash` child that writes a sentinel
file on a delayed kill) — proves scope teardown reaps the *direct* child. The
true in-container orphan can only be proven in an integration/Docker test; note it
as a manual/integration check, not a unit test.

---

## Issue 4 — Empty-steps plan: wedge already prevented, but the drop is silent

**(a) Confirmed root cause — and a CHARTER CORRECTION.** The charter says an
empty-steps plan "enters active state and hangs (`loop.ts:287–290`)." **After the
rebase this is no longer accurate.** Verified:
- The *only* non-null assignment to `cortex.currentPlan` is `loop.ts:251`, and it
  is guarded: `} else if (decideSteps(decide).length > 0) { cortex.currentPlan =
  decide; … }` (`loop.ts:245–254`). `decideSteps` (`state.ts:50–55`) returns `[]`
  for a `{"decision":"plan"}` whose `steps` is missing/non-array/empty. So an
  empty-steps plan **cannot enter the active state** via the idle path — the
  wedge the charter describes is already structurally prevented (the verbose
  array-safety comments at `loop.ts:245–250` show this was hardened, likely in
  the rebased work).
- The execution block (`loop.ts:287–290`) is a second line of defence:
  `const step = steps[cortex.currentStepIndex]; if (step) { … }` — an absent step
  no-ops rather than throwing.

**The residual, real issues (what actually remains):**
1. **Silent drop.** When the conscious `decide` returns `plan` with zero
   actionable steps, the `else if` simply isn't taken: `accumulatedEvents` was
   already cleared (`loop.ts:237`) and `lastOrientTick` advanced (`:238`), so the
   triggering events are consumed and the empty "plan" is discarded with **no
   log**. An agent whose model repeatedly emits empty plans spins doing nothing,
   invisibly.
2. **Unguarded invariant at the execution block.** The `if (step)` guard *masks*
   any future path that sets `currentPlan` non-null with empty steps: it would
   no-op forever (the genuine wedge), with nothing detecting it. Today only
   `:251` sets it and that path is guarded, but the invariant is unprotected.

**(b) Failure mechanism.** A `plan` decision that yields no steps is silently
swallowed (events consumed, nothing logged); and the execution block would
silently spin forever if `currentPlan` were ever non-null with empty steps.

**(c) Proposed repair — fail loud + a cheap structural assertion.**
- *Fail loud at the drop site* (`loop.ts:245`): add an `else` that logs when a
  `plan` decision produced no actionable steps, e.g.
  `decide.decision === "plan"` with `decideSteps(decide).length === 0` →
  `logToConsole(name, "cortex", "decide=plan with no actionable steps; dropped",
  "warn")`. (`warn`, not `error` — the model misbehaved but the loop self-heals by
  re-orienting next escalate tick.)
- *Structural assertion at the execution block* (`loop.ts:287–290`): if
  `cortex.currentPlan !== null && steps.length === 0`, treat it as an invariant
  violation — log at `"error"` and reset `cortex.currentPlan = null` (and
  `lastOrientTick = 0` to force a fresh orient) instead of silently looping. This
  converts the latent wedge into a loud, self-healing path and protects the
  invariant against future call sites.

**(d) Test strategy — `cortex/loop.test.ts`.** Script the `decide` branch of the
`ModelClient` to return `{"decision":"plan","reasoning":"…","steps":[]}` and
assert: (i) a structured log is emitted at the drop site, (ii) `currentPlan` does
not go active / the loop does not spin (it re-orients or terminates per the
script), (iii) no crash. For the invariant assertion, a more targeted unit test
around the execution-block guard (or a small extracted helper) is preferable to a
full-loop test, since the non-null-empty-plan state is not reachable through the
public path by construction.

---

## Dependency / ordering between the four fixes

**No two fixes edit the same function**, so there are no hard code-level
collisions. Files touched:
- Issue 1 → `cortex/loop.ts` (region ~332–354) + the diary-turn fail path.
- Issue 4 → `cortex/loop.ts` (regions ~245–254 and ~287–290).
- Issue 2 → `core/orchestrator/planned-action.ts` (region ~42–54).
- Issue 3 → `core/limbic/hypothalamus/payload.ts` (inner-command builders), with
  test touches in `payload.test.ts` / `transport.test.ts`; transport.ts itself is
  left structurally intact.

**One convention dependency (settle first):** the "fail loud" logging convention
from the cross-cutting finding (recommend `logToConsole(..., "error"/"warn")`
explicit-level). All four use it; deciding it up front avoids three inconsistent
variants. This is a decision, not code.

**Within `loop.ts` (issues 1 and 4):** the two edits are in disjoint regions and
can land in a single pass. Suggested intra-file order: issue 4 first (plan-entry
and execution-block guards, higher in the loop body), then issue 1 (diary turn,
lower). No semantic coupling between them.

**Suggested overall order:** (0) settle the logging convention → (1) loop.ts pass
covering issues 4 + 1 → (2) planned-action.ts (issue 2) → (3) payload/transport
(issue 3). Issues 2 and 3 are fully independent of the loop.ts pass and of each
other; they can be done in either order or in parallel once the convention is set.

---

## Medium-severity items flagged as entangled or thorny

Per instructions these are **flagged, not designed**:

1. **Error/timeout indistinguishable in the conscious turn**
   (`conscious-thought.ts:129–134`) — *entangled with issue 3.* A `ClaudeError`
   becomes `{ output: e.message, timedOut: false, … }`. Note: a genuine *timeout*
   never reaches this catch — `runTransport` returns `timedOut:true` as a
   **success** result, so the cortex loop joins it as a normal turn. The medium
   item is really "a transport *failure* is reported as `timedOut:false` with the
   error text as if it were model output." When issue 3 lands the in-container
   timeout bound, revisit whether this masking still matters. Flagged.

2. **Swallowed identity reads → empty string, no log**
   (`loop.ts:218–226, 262–270`) — *same anti-pattern as issue 1, same file.*
   `readBackground/readValues/readDiary` each `catchAll(() => Effect.succeed(""))`
   with no log, so the forebrain silently loses grounding. This is the exact
   pattern issue 1 fixes for the diary turn. **Decision for the lead:** sweep
   these into the issue-1 loop.ts pass (cheap, consistent) or leave them as a
   separate Medium ticket? They are listed Medium in the charter; I did not design
   the fix, but flag that doing issue 1 without them leaves an identical silent
   failure two screens away.

3. **Parse fallbacks masking output** (`tiers.ts`) — *partially entangled.* The
   forebrain orient parse-miss **already** logs loudly at `warn`
   (`tiers.ts:181–190`, recently fixed). But the hindbrain `observe` fallback
   (`tiers.ts:118–124`) and the conscious `decide` fallback (`tiers.ts:219–222`)
   still `parseOr` to a default **silently** — a parse failure there is invisible
   and downstream reads the fallback as real model output. Same "fail loud"
   theme, different file (`tiers.ts`). Flagged for a follow-up; not designed here.

4. **Fragile `[STEP_DONE]` substring match** (`state.ts:69`, `detectCompletion`)
   — **NOT entangled** with any High fix; standalone. Listed for completeness; no
   action proposed in this spec.

---

## Charter/analysis corrections (for keeping the charter accurate)

- **Issue 4 pointer is stale.** Charter (`:287–290`) and analysis (Thread 4)
  describe an empty-steps plan that "enters active state and hangs." Post-rebase,
  the `decideSteps(decide).length > 0` guard at `loop.ts:245` **prevents entry**;
  the real residual is a *silent drop* of the empty plan plus an *unguarded
  execution-block invariant*. Reframe from "fix a live wedge" to "make the
  existing prevention loud + assert the invariant."
- **Issue 3 framing is imprecise.** "Never kills the underlying Docker process"
  is wrong in one direction: scope teardown **does** kill the host `docker exec`
  client. The leak is the **orphaned in-container child** that `docker exec` does
  not signal-forward. Repair target is the in-container process, not the host one.
- Issues 1 (`loop.ts:332–343`) and 2 (`planned-action.ts:43–54`) pointers are
  **accurate** as written.

---

## Thorny / entangled questions needing a human decision before implementation

1. **Issue 3 — interrupt-path orphan.** The in-container `timeout` wrapper fixes
   the *timeout* leak but not the *critical-interrupt* leak (an interrupted turn's
   in-container process lives until its own long budget). Do we (a) accept bounded
   orphan-until-timeout on interrupt, or (b) invest in an active in-container kill
   (`docker exec … pkill -f <player-workdir pattern>`) — which adds a
   Docker-dependent cleanup step and a pattern-matching risk (one conscious
   session per character makes a workdir-scoped pattern *probably* safe, but it is
   not airtight)? Recommendation: ship (a) + the `timeout` wrapper now; treat (b)
   as a separate, scoped follow-up.
2. **Issue 2 — escalation on repeated failure.** Should N consecutive failed
   reflection cycles escalate to a distinct critical (vs. just per-cycle
   error-level logs)? Recommended as follow-up, flagged not designed.
3. **Medium sweep boundary (item 2 above).** Should the swallowed identity reads
   ride along in the issue-1 loop.ts pass (identical anti-pattern, same file) or
   stay a separate Medium ticket? Needs a call so the issue-1 diff scope is clear.
4. **Logging convention.** Confirm the recommended fail-loud convention
   (`logToConsole(..., "error"/"warn")` explicit level) vs. structured
   `kind:"error"` events, since all four repairs depend on it.
