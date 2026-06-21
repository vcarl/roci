# Phases 0–4 Holistic Review — Cortex / Cybernetics Redesign

> **What this is:** An arc-level retrospective comparing the *original intentions* at the start
> of each phase against what *actually landed*. It retains the load-bearing decisions and the
> *why*, and deliberately drops precise code-level changes (those live in git + the specs). This
> is **not** a code review — each phase already passed its own final whole-phase review
> ("READY TO MERGE"); see the SDD ledger.
>
> **Sources:** master design `specs/2026-06-18-cortex-cybernetics-design.md`; per-phase specs +
> plans under `docs/superpowers/{specs,plans}/`; SDD ledger
> `$(git rev-parse --git-path sdd)/progress.md`; `HARNESS.md`; git `c141269..94102e2`.
> Branch `worktree-steering`, HEAD `94102e2` (kept unmerged by standing choice).

---

## The arc at a glance

The redesign replaced a pre-cortex harness ("Phase 0") with a four-rung **escalation ladder**:
`hindbrain → forebrain → conscious → cybernetics(frontier)`. Seven implementation units landed
over 3 days (`c141269` → `94102e2`, 2026-06-18 → 2026-06-20).

| Unit | Base → HEAD | Final verdict |
|---|---|---|
| Phase 0 (baseline being replaced) | — | — |
| Phase 1 — Transport/Payload split | `c141269` → `85bb7c7` | READY TO MERGE |
| Phase 2 — SDK-runner + NDJSON wire protocol | `c30a82b` → `6fa9138` | READY TO MERGE |
| Phase 3 — Steering channel | `ec35ccb` → `4b37a72` | READY TO MERGE |
| Phase 4a — OpenCode conscious-session transport | `9602e56` → `5e108d3` | READY TO MERGE |
| Phase 4b — Cortex loop rework | `c76d247` → `fbdf3a2` | READY TO MERGE |
| Phase 4c — Frontier delegation as steerable bash tool | `9637704` → `c20d19c` | READY TO MERGE |
| Phase 4c follow-ups — model selection, cybernetics deletion, tidy | `bd61920` → `94102e2` | (closeout) |

Git topology: `merge-base main HEAD = ec35ccb`, so Phases 1 & 2 are shared with `main`; Phases
3 → 4c-followups are unique to `worktree-steering`.

---

## Phase 0 — The baseline being replaced

**The machinery (pre-cortex harness).** Grounded in `HARNESS.md` + the April precursor specs:
- **Channel-session as primary execution engine.** `runChannelSession()` (`channel-session.ts`)
  spawned a *persistent* `claude --channels` process in Docker via `session-runner.ts` and pushed
  state over HTTP for the whole session: spawn → 2s stabilize → inject task → 30s tick loop →
  terminate on completion/interrupt/1hr timeout.
- **An external OODA chain driving that session — four separate `claude -p --no-tools` calls per
  tick** (observe → orient → decide → evaluate) deciding what to push
  (`plans/2026-04-23-ooda-integration.md`).
- **Limbic world-interface** as a passive deterministic service layer: `EventProcessor`,
  `SituationClassifier`, `InterruptRegistry`/amygdala (kill-and-restart on criticals),
  `StateRenderer`.
- **Operating skills as markdown prompt templates** (`packages/core/src/skills/`), with real-time
  vs. planned-action cadence baked in (`specs/2026-04-18-agent-operating-skills-design.md`).
- **Brain/body split + `dream` memory consolidation** (the April plan moved `dream` *inside* the
  OODA loop as a gated step); a precursor effort collapsed 4 log files into one `events.jsonl`
  (`specs/2026-04-10-unified-event-log-design.md`).

**The core problem the master design names (§1):** the harness *duplicates the agent loop the
runtime now runs internally*. Built when `claude -p` was stateless, it reimplemented continuity,
planning, self-evaluation, and subagents *outside* the model. Claude Code has since become a
persistent self-directing agent, making the external layer redundant. The worst shape:
`channel-session.ts` runs a native Claude agent *inside* a session **and** an external
4-call-per-tick OODA brain driving it *from outside* — paying twice for one loop. And the
foundation was **unproven**: `claude --channels` (CLI 2.1.181) connected (HTTP 200) but the
session **did not stay alive to consume pushed events** in print mode; the live `session-runner.ts`
omitted `--dangerously-load-development-channels` and had a port mismatch.

**Deletion list (master §9 + §1) — what was slated to die:** `claude --channels` usage; the
`session-runner.ts` / `channel-session.ts` persistence model; the brain/body split;
OODA-as-4-Claude-calls (`ooda-runner.ts` in its current form); `runtime.ts`'s claude/opencode
binary split; operating-skill prompt templates *as the primary cognition path*; the external 30s
tick loop and plan/step/budget state machine. **Kept:** world interface (`EventProcessor`→`State`),
interrupt rules, logging, `dream`, character identity files, and the *tier concept* from
`model-config.ts` (repointed at endpoints).

## Master design intention (the spine)

**The reframe — metaphor stack (§1):** **Limbic** = reflex/relay world-interface (kept).
**Cortex** = deliberation on *inspectable local models* (Apple Silicon M5/128GB) — the persistent
character; a cheap, local, auditable controller. **Cybernetics** = frontier models as *prosthetics
the cortex reaches for* (Claude Code doing real agentic work, "the same way a person does"). Moving
cognition onto local models converts the old redundancy into a clean **controller ↔ worker**
relationship.

**The escalation ladder as designed (§4/§5) — *escalation, not pipeline*.** The cortex *is* the
loop; each layer only wakes the one above it:

| Rung | Role | Escalation trigger upward |
|---|---|---|
| **Hindbrain** | always-resident triage → `{ pass \| note \| wake, weight }`; most events die here | `WAKE`, N accrued notes, or the **staleness timer** |
| **Forebrain** | resident synthesis → `{ headline, whatChanged, sections, metrics }` | material change, no active plan, or plan stale |
| **Conscious** | loaded-on-demand MoE → `act \| wait \| delegate \| done` | `DELEGATE(scoped task)` |
| **Cybernetics** | `claude -p` in Docker, run-to-completion → structured result | returns; conscious evaluates and loops |

- **Never goes blind:** a staleness timer forces a forebrain synthesis every N cycles absent a
  wake (tunable per cadence).
- **Amygdala cuts the line:** interrupts evaluate every cycle independently — a critical can jump
  straight to conscious or abort an in-flight delegation. Reflexes stay live during delegation.

**Three load-bearing boundaries (§3):** host↔Docker = cortex↔cybernetics (forced by Metal — local
models can't run in the Linux container); cortex↔model-serving = a plain OpenAI-compatible HTTP
call (residency is the serving layer's concern); world-interface↔cortex = existing
`EventProcessor`→`State`, kept as-is.

**Key decisions (§11) + the provider seam:** escalation ladder not pipeline (consciousness is the
expensive exception); **spawn-per-task, not channels** (proven, no research-preview dependency —
cybernetics is *agentic*, a remote-backed tier is still just a one-shot completion); host cortex /
Docker cybernetics (topology *is* the metaphor); **the `ModelHandle`/`ModelClient` provider seam
(`provider ∈ {mlx | llamacpp | openai-compatible}`) replaces `runtime.ts`'s binary split** — "which
HTTP endpoint," not "which CLI binary"; **fail fast on missing local models** — no auto-failover.

**Parked Questions (§10) — later phases may pick these up:** (1) **mid-task interruption instead of
abort** — steering a *running* Claude Code delegation, "the one narrow place a *proven*
`claude --channels` could earn its place"; (2) **society of mind** in the conscious tier; (3)
**residency tuning** against testbench numbers.

---

## Phase 1 — Transport / Payload split

**Intention.** Refactor the monolithic `runTurn` (built the `docker exec` command, attached stdin,
streamed/normalized stdout, raced exit-vs-timeout — all in one function) into two seams: a reusable
**transport** (exec + stream + race + kill, payload-agnostic) and swappable **payloads** (inner
command + normalizer, pure, per-runtime). Done as a **pure, behavior-preserving refactor** —
`runTurn` keeps its exact signature; all eight callers untouched. This lays the foundation later
phases build on (a Phase 2 SDK payload, the wire protocol, a Phase 3 steering channel) without
changing observable behavior.

**Result.** All 5 tasks landed clean, `c141269..85bb7c7`; baseline green (101 passed). Final
whole-branch review (opus): *"READY TO MERGE — Yes. No Critical/Important. Minors deferred to later
phases (intentional behavior-preserving artifacts)."*

**Decisions kept.** Split along the right axis: transport = *mechanism* (identical regardless of
inner command); payload = *swappable* per-runtime command + normalizer — the seam that lets later
phases drop in new runtimes without touching execution machinery. **OAuth lives outside the
transport** (token baked into the command by the caller; `runTransport` has no `OAuthToken`
dependency → credential-agnostic + independently testable). "Behavior-preserving" was the binding
constraint, made concrete: the `toUnifiedEvents` subsystem tag stays hardcoded `"claude"` even for
opencode (matching pre-split behavior) rather than being "fixed" here — correcting it is *explicitly
deferred to Phase 2* to keep the refactor a true no-op. Transport is testable against a real local
`bash` subprocess (no container). A **retained-capability test for the dormant `claude -p` path**
guards it against silent bit-rot once the SDK runner becomes default.

**Drift / accepted deviations.** A `mapError` divergence in `runTurn` from the plan's literal code,
accepted as "verified correct & behavior-preserving." The `isAuthError` false-positive test, first
flagged as a missing-coverage Minor, was *retired* at final review — the test already existed
(`transport.test.ts:43`).

**Debt carried.** Deferred Minors (intentional behavior-preserving artifacts): `buildInnerCommand`
hardcodes `'claude'`/`'opencode'` literals; no `disallowedTools` test; thin `shellEscape` coverage;
an inherited no-op `'system'` ternary; an `exitCode` union cast; no explicit "no `env` field"
branch test. **Headline carried item:** the hardcoded `runtimeTag: "claude"` for the opencode
runtime — flagged for correction in Phase 2.

## Phase 2 — SDK-runner + NDJSON wire protocol

**Intention.** Add a **third worker payload**: an in-container Node host (`sdk-runner.mjs`) driving
the Anthropic Agent SDK's streaming-input `query()`, plus a minimal **versioned NDJSON wire
protocol** (`"v":1`) over `docker exec -i` — so the frontier worker can run a task
run-to-completion through the SDK, not only via `claude -p`. **Reuse the Phase 1 split unchanged**
(the SDK payload just supplies a prebuilt command + `normalizeSdk` + `runtimeTag:"sdk"`). Crucially,
establish the protocol's **forward-compatible shape now**: the runner already parses `steer`
(structurally identical to `task`) even though Phase 2 only sends `task`+`end`, so Phase 3's
steering channel plugs in without re-cutting the protocol. This is the pivot from the master
design's *spawn-per-task* delegation toward a long-lived streaming session — the seam is laid here
but not yet exercised.

**Result.** All 8 tasks landed, `c30a82b..6fa9138`. **Container smoke PASSED**: a real
run-to-completion turn via `CLAUDE_CODE_OAUTH_TOKEN` (`apiKeySource:none`) returned
`{"v":1,"type":"result","status":"completed","output":"OK"}`. Suite green (149 passed, 2 skipped).
Final review (opus): *"READY TO MERGE = YES. No Critical/Important."* Subsequently squash-merged
locally to `main` as `ec35ccb` (not pushed to origin) — this is why Phases 1–2 are shared history.

**Decisions kept.** `CLAUDE_CODE_OAUTH_TOKEN` auth, **no API key** (the spike confirmed the SDK's
bundled binary honors the OAuth token; `ANTHROPIC_API_KEY` never added). **SDK pinned `0.3.183`**
(the exact validated version, pinned identically across core + both domain images). **Phase-1 pieces
byte-unchanged / additive-only** — the SDK path is pure composition, limiting blast radius.
**`claude -p` retained dormant** (with guard test) — added alongside, not a cutover. The
**dual-result-emit** design: the SDK `result` is emitted twice (event-wrapped + terminal line) so
`normalizeSdk` takes output from accumulated text while the terminal line carries status. `sonnet`
alias passed verbatim (spike found aliases accepted) → no alias-mapping layer built.

**Drift / accepted deviations.** Runner files **duplicated per domain** (copied into each docker
context) — accepted, matching the `roci-channel.ts` precedent; a build-time copy step is out of
scope. `parseCommand` coerces a missing `text` to `""` (vs. spec's optional `text?`) — harmless.
Two optional nits recorded but **NOT applied**: N1 (redundant `String()` in `normalizeSdk` — left to
avoid re-diverging from a just-aligned fix); N2 (a comment explaining the dual emit — deferred
because it needs a parity update across both docker copies).

**Debt carried.** Four deferred Minors (all DON'T-BLOCK): T2a hand-maintained
`sdk-runner-protocol.d.mts` (drift risk if `.mjs` exports change); T2b `parseCommand` text
coercion; T7a spacemolt layer ordering (caching nit); T7b dual result-emit intended-but-undocumented
in code. **Watch-item:** the per-domain runner duplication means T7b/N2-style fixes must be applied
in lockstep across both docker copies — a silent-drift hazard that compounds as Phase 3 touches
these files.

## Phase 3 — Steering channel

**Intention.** Build the **mechanical channel** for mid-task steering of a single live delegated
session: a `Directive` type, a coalescing capacity-1 queue, `buildSteeredStdinStream`,
`runSdkSession`, and an optional `steering` param on `delegate`. Steering works on a live session;
run-to-completion is the **degenerate case** (no queue offered). This **cashes in the master
design's parked "mid-task interruption instead of abort"** — the original cortex spec listed
mid-task steering as an explicit *non-goal*, and this branch deliberately reverses it. It stays
faithful to "spawn-per-task, not channels" by keeping steering **soft**: a directive becomes the
*next* user turn after the current one completes (queue-and-finish), never a mid-turn preempt (the
TS Agent SDK has no mid-turn interrupt; hard preemption stays the kill path). The single-live-session
invariant (escalation is a handoff, never parallel) is what makes it tractable. **This is the first
phase unique to `worktree-steering`** — it diverges from `main`. The cortex loop that *produces*
directives is deferred to Phase 4.

**Result.** 5 tasks landed clean, `ec35ccb..4b37a72`. Suite 155 passed/2 skipped; focused steering
suite 7/7; `tsc` clean. Final review (opus): *"READY TO MERGE = YES. No Critical/Important."* Kept
unmerged/unpushed per user; the worktree was then preserved and the user pivoted to Phase 4.

**Decisions kept.** **Reuse Phase-2's NDJSON `steer` line** — `task` and `steer` are structurally
identical (one user turn each), so the runner already handled `steer`; Phase 3 only had to *send*
it host-side (Phase 2 parsed-but-never-sent → Phase 3 sends). Wire protocol unchanged; the channel
is a pure host-side addition. The full seam
`delegate → buildSteeredStdinStream → runSdkSession → runSdkWithStdin → runTransport` threads a
*dynamic* stdin through the **unchanged Phase-1 transport** (`runSdkTurn` became a thin one-liner
over a shared private `runSdkWithStdin` — steering adds a seam without forking transport logic).
**Coalescing capacity-1 queue** (`Queue.sliding(1)`): a newer directive fully supersedes an
unconsumed older one (each payload is a complete self-contained synthesis); `task`/`end` are control
messages, exempt from coalescing. **`DEFAULT_STEER_CADENCE_TICKS` defined-but-unconsumed** (defined
here, consumed only in Phase 4) — a deliberate clean phase boundary; final review confirmed **zero
Phase-4 leakage**. All four `!delegationFiber` gates left intact and steering symbols kept absent
from `cortex/` — the loop rework is explicitly Phase 4.

**Drift / accepted deviations.** Only type-level / test-scaffolding: a `Stream.decodeText()`
call-form adopted as a TS 5.9 inference fix (semantics-identical); the plan's conditional
`Stream.fromQueue` shutdown fallback proved **unneeded** (it ends gracefully on shutdown). No
behavioral drift.

**Debt carried.** Cosmetic deferred Minors: T2a stale `buildSdkStdin` JSDoc ("Phase 2 never emits
steer"); T2b no trailing-newline-absence assertion; T4a `Directive` import consolidation; T4b a
dropped "claude" comment (intentional). **Key carry-forward watch-item:** the session emits `end`
only when the caller shuts the queue down — Phase-3 `delegate` never shuts it (only tests do,
correctly). **The Phase-4 producer MUST guarantee queue shutdown on every path (error/interrupt
included) or a steered session hangs on stdin**; the kill path (`Fiber.interrupt`→SIGKILL) is the
hard backstop.

## Phase 4a — OpenCode conscious-session transport

**Intention.** Give the cortex loop a **resumable, steerable conscious-tier session**: a sequence of
`docker exec … opencode run` turns sharing one OpenCode session, driven by the local host model with
a per-character system prompt — the *transport substrate only* (loop/steering/evaluate are 4b/4c).
This realizes the master design's **"cortex ↔ model-serving = a plain OpenAI-compatible HTTP call"**
boundary: the conscious tier is configured as an `@ai-sdk/openai-compatible` OpenCode provider
pointing at the host `llama-server` `/v1` endpoint (binary bundled in opencode → no firewall/npm
change). The standalone `runOpenCodeSessionTurn` transport sits beside the untouched `delegate`
(Agent-SDK frontier path) — **the provider seam replacing runtime.ts's binary split**, separating
conscious-session transport from escalation transport rather than overloading one runtime switch.
Chose **re-invoke-per-turn (Approach A, `-s <id>`)** over a long-lived `opencode serve` (B) because
A stays inside the existing per-session `docker exec` boundary, gets turn-complete = process-exit
for free, and matches the steering spec's rejection of long-lived in-container socket services.

**Result.** Tasks 1–7 landed, `9602e56..5e108d3`. Suite 174 passed/3 skipped, exit 0. Final review
(opus): *"READY TO MERGE = YES. No Critical/Important"* — and confirmed the **changed-file set ==
the plan's declared 11 files**, with `delegate.ts`/`runTurn`/`runSdkTurn`/`runSdkSession`/`loop.ts`
untouched (scope boundary intact).

**Decisions kept.** **`-s <id>` only, never `-c/--continue`** (`--continue` resumes the most-recent
session — unsafe under multi-character orchestration). **Resume turns omit `--agent`/`-m`** (the
resumed session already carries agent/system context; re-passing risks divergence). **Provider
config GLOBAL, agent file PROJECT-LOCAL with `chmod 0o444`** — the host-model endpoint is shared
infra (one per container), only the character prompt needs per-character scoping; read-only is
defense-in-depth (a confused tool-using turn — observed corrupting a writable config in the spike —
can't rewrite its own definition). **Loopback → `host.docker.internal` rewrite** (host loopback
becomes the container's route to the host). **Additive-transport guarantee** — session-id capture is
gated behind an optional `captureFromRaw` hook, so claude/sdk paths get `sessionId` undefined and
are byte-unaffected. **First-wins session-id capture** — concurrency-safe (single `mapEffect` fiber
+ `already===null` guard). Stable ids centralized (`local`, `conscious`, `local/conscious`).

**Drift / accepted deviations.** T5b: `provisionConsciousProvider`'s inferred return is
`Effect<string,DockerError,Docker>` not the `Effect<void>` the spec named — accepted as cosmetic
(callers discard the value; one `Effect.asVoid` would match), recorded as a 4b follow-up.

**Debt carried (12 minors, by theme).** Test-convention nits (generators in `describe` bodies; new
imports below describe blocks; a sync write not `Effect.try`-wrapped in the smoke). Coverage gaps
where logic is correct on read (no first-wins-overwrite test; no shell-special-char round-trip; the
session-turn unit test is export-only by design — the real round-trip is the gated smoke).
Theoretical corners (trailing-slash regex; truthy `if (v)` dropping empty-string captures; `char.dir`
hardcoded to the mount path). A docs gap (`base64 -d` Linux-correct, macOS needs `-D`).
**Watch-items into 4b:** apply `asVoid` at the call site; add first-wins + shell-special tests; carry
a *typed* "session-not-found on resume" error forward (currently a generic `ClaudeError` — recovery
policy is a 4b concern).

## Phase 4b — Cortex loop rework

**Intention.** Make the **conscious tier the per-step executor**: each plan step runs as a
tool-using OpenCode conscious session (local LLM = the brain) instead of being forked to the
frontier worker. The plan/step skeleton is kept; only the executor is swapped. Consumes the
**Phase-4a OpenCode session** transport and the **Phase-3 steering channel** (but only its
`Directive` type + `DEFAULT_STEER_CADENCE_TICKS`, not the SDK queue/stdin machinery — reserved for
4c). **Removes the four `!delegationFiber` gates** so the hindbrain triage + forebrain run *during*
an active session and can feed steering into the live session. Wires **cadence-gated steer turns**
(a non-discard hindbrain disposition wakes the forebrain → directive in a capacity-1
`pendingDirective` buffer → pushed at most every 3 ticks) and **completion-marker detection**
(`detectCompletion` on `STEP_DONE_MARKER`), with the tick-budget as a salvage backstop. Introduces a
peer `ConsciousThought` service; leaves `Cybernetics`/`delegate` intact but **dormant** (the
escalation path returns in 4c).

**Result.** 5 tasks landed, `c76d247` → `af1ffed`, cleanup → final `fbdf3a2`. Core suite 193 pass/3
skip. `delegate.ts` byte-unchanged across the phase. Cleanup `fbdf3a2` closed several deferred
Minors. Final review (opus): *"READY TO MERGE = YES. No Critical/Important. Concurrency
interrupt-safe … Laundering invariant holds (no raw event text reaches a conscious prompt). Scope
clean: delegate.ts byte-unchanged, no 4c leakage."*

**Decisions kept.** **Laundering invariant** — no raw inbound event text ever reaches a conscious
prompt; `formatSteerDirective` only formats already-laundered forebrain `OrientResult` output.
**Concurrency interrupt-safety** — the `consciousFiber` is polled/joined/interrupted-before-return
exactly like the old step fiber (no leak, no lost wakeup; tick-budget spans the whole step).
**`pendingDirective` capacity-1 coalesce** — newest-wins overwrite (no `Queue` needed in a
single-fiber loop), the in-session forebrain gate keys off a *non-discard* disposition.
**Signal-driven completion** — `STEP_DONE_MARKER` + `detectCompletion`, but `runConsciousEvaluate`
stays the arbiter (a premature marker isn't trusted; tick-budget is salvage only). The
`formatStepTask` doc framing changed "cybernetic worker" → "conscious agent" (intentional rename).
`delegate.ts` byte-unchanged (Cybernetics retained at the layer level, never imported by the loop).

**Drift / accepted deviations.** A relocated smoke test needed `NodeContext` provided into
`DockerLive` — a latent TS error uncaught since 4a because intervening commits were `--no-verify`
docs; accepted as a necessary fix. Explicit type annotations on two Effect destructures (TS7022
inference fixes). **Two controller-adjudicated downgrades:** a re-reviewer's "Important" findings
(T3a generator yield inferring `A=string` before `void` collapse; T4a two `import type` lines that
should merge) were both adjudicated down to **Minor** — compile-safe, pre-commit runs `tsc` not
eslint.

**Debt carried.** Deferred Minors (mostly closed by `fbdf3a2`): unused-import/local cleanups, a
non-idiomatic `Effect.void` cast, a heading-assertion coverage gap. **Explicit INTEGRATION
FOLLOW-UP (plan-deferred, tracked as the first item of 4c):** *wire `ConsciousThoughtLive` into the
live global runtime layer.* After 4b the loop requires `ConsciousThought` + `Docker` and is
type-clean across all 3 packages, but `ConsciousThoughtLive` is **not yet composed into any running
effect** (same posture `CyberneticsLive` held pre-4b — referenced in src, never provided to a live
run).

## Phase 4c — Frontier delegation as a steerable bash tool (+ follow-ups)

**Intention.** Make frontier delegation **a tool the conscious mind reaches for, not a route the
orchestrator picks**: expose Claude Code delegation as an in-container **bash CLI**
(`frontier start/poll/steer/wait`) the conscious OpenCode agent invokes inline like any other tool —
handle-based and **async** (async forced by steering: a blocking call can't be steered by its own
caller). Make it **steerable from the conscious mind** using the worker's *partial output* (`poll`)
as feedback (layered steering: forebrain→conscious from 4b; conscious→frontier new; nobody reaches
*past* the mind into its tool). Reuse the Phase 2/3 **NDJSON wire protocol** intact, only relocating
the *driver* host→container (a detached worker reading a fifo). Close the latent 4b gap by wiring
`ConsciousThoughtLive` into the live runtime. Keep **laundering structural**. **No MCP — bash only.**
This **completes the master design's "cybernetics = a prosthetic the cortex reaches for"**: routing a
step to a frontier worker would make the frontier an alternative *mind*; making it a bash tool the
conscious mind runs inline makes it a *tool the mind uses* — "it uses Claude Code to do work, the
same way a person does." The escalation lives entirely inside a conscious turn; the orchestrator
never mediates. **Follow-ups** closed three loose ends: (1) conscious-selectable frontier model
(`--model`, default config-sourced — resolves the hardcoded-sonnet seam); (2) **delete the dormant
cybernetics subsystem** the frontier tool superseded; (3) tidy mid-file test imports.

**Result.** 4c Tasks 1–5 landed, `9637704` → `9e3853c` → `c20d19c` (after the final-review
follow-up). Suite 209 pass/3 skip, all four projects clean. Final review (opus): *"READY TO MERGE =
YES. No Critical/Important blockers."* **Follow-ups** landed `bd61920` → `94102e2`; final review
*"READY TO MERGE = WITH FIXES (one docs gap), code merge-ready as-is"* — the docs gap (runbook still
describing cybernetics) fixed in `94102e2`; suite settled at 206 pass/2 skip (9 deleted cybernetics
tests removed).

**Decisions kept.** **Detached-worker-reads-fifo, file-backed by handle id** — each conscious turn
is a separate `docker exec`, so the worker is detached (`setsid`) with all state on the shared
container FS, letting a *later* turn reattach via the handle (this is what makes async cross-turn
steering work). **The agent markdown teaches start/poll/steer/wait** — learned like any other tool,
keeping the mind in the loop and folding the worker's result into its own reasoning.
**`containerId` param-threaded, no `ROCI_FRONTIER_CONTAINER` env gate** — the harness is a scheduler
with many concurrent `(player, container)` pairs whose ids are runtime-generated; identity stays a
per-call parameter (loop→provision→`provisionFrontierCli`). **DRY wire protocol enforced by the
`endLine()` drift test** (the script's embedded NDJSON reproduces the `sdk-payload` builders; a unit
test asserts equality). **Laundering taught + structural.** **Follow-ups:** config-sourced frontier
model (default `(workerModels ?? DEFAULT_MODEL_CONFIG).tiers.reasoning` = opus; per-call `--model`
via injection-safe `FRONTIER_MODEL` env); **deletion of `cybernetics/{delegate,steering,result,
types}.ts`** once `frontier-cli.ts` superseded them.

**Drift / accepted deviations.** Spec §6.4's planned env-gated per-domain **smoke test was
superseded** by the scheduler-identity decision (no env-var container id) — automated coverage
stayed at the string/unit level and *live* verification moved to the orchestrator runbook; an
accepted, reasoned divergence. **Task-2 fix-wave `fe4ed97`** hardened the draft post-implementation
(single long-lived `python3 -u` reader replacing a python-fork-per-line storm; runtime values
crossing into the detached child via the **environment**, never source-spliced; timeout-guarded fifo
writes) — the reviewer credited it as **materially better than the plan draft**. The final-review
**extractor-widening `c20d19c`** (walk `message.content[].text`, the real stream-json frame shape)
was **RESOLVED, not deferred** — the controller independently verified the extracted python against
realistic frames before fixing additively. Follow-up **FU-2's `git add -A` swept two stray untracked
files** into the impl commit; controller amended (`b6b47ea`) to scope it — noted as a plan defect
for future deletion tasks.

**Debt carried (open after both).** T2b — 2s fifo-write-timeout heuristic (a steer arriving
mid-read can drop; runbook notes a retry is safe). T3a — unquoted `${b64}` echo (safe: base64 has no
shell-specials, inherited). FU1a — a throwaway `"sonnet"` arg passed to `runtimeBaseArgs` purely to
satisfy `AnyModel` before `--model` is stripped (harmless, DRY-justified, commented). **What the
follow-ups CLOSED:** the cybernetics-deletion cleanup item, the hardcoded-sonnet seam, and the
recurring mid-file test-import nit (FU-3 hoisted them).

---

## Arc-level synthesis

### Where the ladder ended up vs. what the master design drew

The master design drew a four-rung ladder with a specific division of labor: a **host cortex** on
local models (hindbrain/forebrain/conscious) that, at a real decision point, **spawns a `claude -p`
worker per task** in Docker and reads the result. The shipped arc realizes the ladder — but the
**locus of control for delegation moved**, and a master-design *non-goal* became a load-bearing
feature.

- **The ladder exists and escalates as drawn.** Phase 4b is the spine: hindbrain triage → forebrain
  synthesis → conscious executor, with the staleness/cadence machinery and amygdala-style
  preemption posture intact. "Escalation, not pipeline" survived from §5 to `loop.ts`.
- **The biggest evolution: delegation went from *host-orchestrated* to *agent-driven*.** In the
  master drawing (and as Phases 1–3 actually built it), the host cortex decides to delegate and the
  host orchestrates the worker via an Effect `delegate()` over an SDK-runner. By Phase 4c, frontier
  delegation is a **bash tool the conscious agent invokes inline** (`frontier start/poll/steer/wait`);
  the orchestrator never mediates. This is a *deeper* reading of "cybernetics = a prosthetic the
  cortex reaches for" than the master design itself drew — "a tool the mind uses, not a route the
  orchestrator picks." It is the single largest divergence-by-evolution in the arc.
- **A master-design non-goal was deliberately reversed into the spine.** §2/§10 listed "no mid-task
  steering of a running delegation" as an explicit non-goal and parked it as future work. Phase 3
  reversed it on purpose, and Phases 4b–4c made **two-layer steering** (forebrain→conscious,
  conscious→frontier) a first-class capability. The arc chose to cash in Parked Question #1 early.
- **Consequence: the Phases 1–3 delegation transport was superseded and then deleted.** The
  host-side SDK-runner orchestration (`cybernetics/{delegate,steering,result,types}.ts`) that
  Phases 1–3 built became dormant in 4b and was **deleted** in the 4c follow-ups, superseded by the
  frontier bash tool. What *survived the pivot* is the **NDJSON wire protocol** (the `sdk-payload`
  builders, `endLine()`), now reused by `frontier-cli` and DRY-enforced by a drift test. The arc's
  durable interface turned out to be the *wire format*, not the transport that first carried it.
- **The provider seam landed as config, per the design.** Phase 4a wired the conscious tier as an
  OpenCode `openai-compatible` provider pointed at a host `llama-server` `/v1` endpoint —
  "which HTTP endpoint, not which CLI binary" (§4b). The conscious tier genuinely runs on the local
  host model over plain HTTP.

### Load-bearing decisions (and why — the knowledge to retain)

1. **Escalation ladder, not pipeline** (§11) — consciousness is the expensive exception; most events
   die in the hindbrain. Realized in the single-fiber cortex loop.
2. **Steering as a first-class spine capability** — soft/queue-and-finish, not mid-turn preempt (the
   TS Agent SDK has no mid-turn interrupt; hard kill stays the backstop). Two layers, with the rule
   *nobody reaches past the mind into its tool*.
3. **Delegation is a tool the conscious agent runs, not an orchestrator route** — async/handle-based
   (forced by steering: a blocking call can't be steered by its own caller); detached worker reading
   a fifo, all state on the container FS so a later turn reattaches by handle.
4. **The NDJSON wire protocol is the durable interface** — versioned (`"v":1`), forward-compatible
   from Phase 2 (parsed `steer` before it was sent), single-source-of-truth enforced by a drift test.
   It outlived two different drivers.
5. **Provider seam = config, not binary** — local-vs-remote is a `baseUrl`; the conscious tier
   reaches the local model as plain HTTP via OpenCode's provider.
6. **The laundering invariant** — no raw inbound event text ever reaches a conscious/frontier prompt;
   every task/steer is model-authored, laundered through the forebrain. Both *structural* and
   *taught* (in the agent markdown).
7. **Scheduler-identity discipline** — `containerId`/`playerName` are per-call parameters threaded
   loop→provision→tool, never a process-global env var, because the harness runs many concurrent
   `(player, container)` pairs with runtime-generated ids. (Matches the standing project memory.)
8. **Behavior-preserving, additive, hard phase boundaries** — each phase left prior work
   byte-unchanged (verified by empty git diffs), defined-but-unconsumed knobs to enforce clean
   seams (`DEFAULT_STEER_CADENCE_TICKS`), and produced **zero cross-phase leakage**. This process
   discipline is *why* seven units each landed "READY TO MERGE" with no Critical/Important across the
   whole arc.

### Carried debt

- **Heuristic fragility:** the 2s fifo-write-timeout (T2b) means a steer arriving while the worker is
  mid-read can be dropped (runbook says retry is safe) — the one behavioral sharp edge left open.
- **Live-runtime composition is a blind spot:** the global runtime layer that *provides*
  `ConsciousThoughtLive`/`DockerLive` lives **outside the typechecked packages**. The 4b→4c
  integration gap (ConsciousThoughtLive never composed into a running effect) was type-clean yet real,
  and was only caught because it was explicitly tracked. Future wiring gaps here won't be caught by
  `tsc`.
- **Documentation lag:** `HARNESS.md` still documents the **entire Phase-0 architecture as current**
  (channel-session, OODA-as-4-calls, `claude --channels`) — none of the redesign is reflected. The
  `docs/cortex-smoke.md` runbook needed a follow-up fix for the same reason. User-facing docs trail
  the implementation across the whole arc.
- **Silent-drift hazards:** per-domain runner duplication (Phase 2 — fixes must be applied in lockstep
  across docker copies) and the hand-maintained `.d.mts`.
- **Cosmetic residue:** unquoted `${b64}` echo (shell-safe), FU1a's throwaway `"sonnet"` arg to
  satisfy `AnyModel`.
- **Branch isolation:** Phases 3→4c-followups live **only on `worktree-steering`** (unmerged by
  standing choice); `main` carries only Phases 1–2.

### Unfinished intent

- **The testbench never visibly filled the roles.** The master design committed to *roles* and said
  "the benchmark fills them" (§7/§8) — empirical per-tier model ranking on M5/128GB. The arc built the
  ladder *logic* (tiers tested with a mocked `ModelClient`) and pointed the conscious tier at a
  `llama-server` endpoint, but the reviewed specs/ledgers show **no evidence the testbench ranking ran
  or that hindbrain/forebrain got concrete local-model assignments**. (Not directly reviewed here —
  flagged as the most likely open thread.)
- **Phase-0 physical deletion is unverified in these sources.** The cognition *path* was replaced by
  the ladder, but the only deletion the ledgers record is the **new** Phase-3 cybernetics subsystem —
  *not* the old `channel-session.ts`/`session-runner.ts`/`ooda-runner.ts`/`runtime.ts`. Whether the
  Phase-0 machinery on the master §9 deletion list was physically removed is not established here (and
  `HARNESS.md` still presents it as live). An honest open question, not a confirmed deletion.
- **Parked Questions #2 and #3 remain parked:** society-of-mind deliberation in the conscious tier,
  and residency/idle-unload tuning against testbench numbers — neither was touched.
- **Robustness items from master §6 are not surfaced in the phase ledgers:** fail-fast on missing
  local models, grammar-constrained decoding for parse safety, and per-tier logged safe-defaults.
  Status unknown from these sources.
- **Domain integration:** the arc built the core cortex; how SpaceMolt/GitHub phase lifecycles bind
  to the new loop (the `domain-integration-and-deletion` plan exists) is not covered by the Phases
  0–4 ledgers reviewed here.
