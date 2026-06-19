# Cybernetics & Cortex — Tool-Using Conscious Tier + Escalation Worker

> **Status:** Design approved, pending spec review. Next step: implementation plan via `writing-plans`.
> **Date:** 2026-06-18
> **Branch:** `cortex-cybernetics-redesign`
> **Supersedes:**
> - The **worker-as-default-executor** model in `docs/superpowers/specs/2026-06-18-cortex-cybernetics-design.md` §3–§5, where the cybernetics worker (Claude Code in Docker) did all "real work" per plan step and the conscious tier only produced a plan. This design **inverts** that: the conscious tier becomes a tool-using local agent that does the everyday work itself, and the frontier worker is reframed as an **escalation** (validate / rescue), not the default executor.
> - The **"no mid-task steering of a running delegation"** non-goal in that prior spec (§2 / §10). This design deliberately introduces steering — generically, over whichever single tool-using session is currently live.

## 1. Summary & Motivation

The earlier cortex design treated the cortex as a ladder of pure, tool-less local reasoners (hindbrain → forebrain → conscious) that produced a **plan**, then forked a frontier **cybernetics worker** (Claude Code in Docker) per plan step to do all the real tool work. A subsequent revision added **live steering** of that worker. Two problems remained:

1. **The conscious tier was a bottleneck and a waste.** It deliberated but couldn't act; every concrete action required spawning an expensive frontier worker. The local hardware (Apple Silicon, M5 Pro) is capable of running a competent tool-using agent on a local model — so the everyday "real work" should happen there, not on the frontier by default.
2. **Steering a forked-per-step worker created a concurrency question** — could the conscious tier steer a running worker *while itself being steered*? That dual-session shape is high-complexity for negligible benefit.

This revision resolves both:

- **The conscious tier becomes a tool-using agent** — an **OpenCode** agent (the `opencode` runtime) running **inside Docker**, backed by a **local model**, doing the everyday shell / git / gh / file work itself. It is the primary intelligence.
- **The frontier cybernetic worker is reframed as an escalation** — Claude Code via the Anthropic Agent SDK, in Docker, invoked only to **validate** the conscious tier's work or **rescue** problems the local models are failing at. It is no longer forked per plan step.
- **Escalation is always a handoff, never parallel.** There is only ever **one live tool-using session at a time** — the conscious agent during everyday work, the frontier worker during an escalation. The forebrain steers whichever single session is currently active. This eliminates the dual-session concurrency question entirely.

The live-steering machinery from the prior revision (Agent SDK runner, NDJSON wire protocol, coalescing queue, cadence throttle, soft queue-and-finish semantics, hard-kill preemption) carries over **unchanged** — it now applies generically to "the active session" rather than specifically to a per-step worker.

### The hard SDK constraint (unchanged)

The TypeScript Agent SDK has **no mid-turn interrupt** — only Python's `ClaudeSDKClient.interrupt()` does. So steering is **soft: queue-and-finish**. A pushed directive becomes the *next user turn* after the current turn completes — it is **not** preemption. True preemption remains the hard-kill path: amygdala criticals → `Fiber.interrupt` → SIGKILL of the in-container process tree. (OpenCode likewise offers no programmatic mid-turn interrupt over our transport, so the same soft semantics apply to the conscious-agent session.)

## 2. Revised Architecture Overview

Five cognitive components. The key axis is **where each runs** and **whether it has tools** — because tools + credentials are what must be sandboxed, and inference is what must stay native.

| Component | Runs | Model | Tools? | Role |
|---|---|---|---|---|
| **Model server** | **Host** (native) | — (serves the local weights) | No | Inference engine (MLX / Ollama / llama.cpp-style, OpenAI-compatible). No tools, no credentials, never acts on the world. Needs Metal/ANE → stays native on host. **Not a sandboxing concern.** |
| **Hindbrain** | Host | Local (small, resident) | **No** | Reflexive triage of world events. Pure completion call to the model server. *Unchanged.* |
| **Forebrain** | Host | Local (mid, resident) | **No** | Situational synthesis. Pure completion call. Authors steering directives. *Unchanged.* |
| **Conscious agent** | **Docker** | Local (large) | **Yes** | The primary intelligence. An OpenCode agent doing everyday real work (shell/git/gh/file edits). Reads untrusted content with its own tools. |
| **Frontier worker** | **Docker** | Frontier (Claude Code via Agent SDK) | **Yes** | **Escalation only:** validate the conscious agent's work, or rescue hard problems. Not the default executor. |

### Why this topology

- **Inference stays native; agents go in the box.** The model server needs Metal/ANE and must run native on the host. But the OpenCode conscious agent is **not compute-bound** — it only makes HTTP calls to the host model server and runs tools — so it can live in Docker without losing any inference performance. The model server's lack of in-VM GPU access (a limitation of any container) costs the agents **nothing**, because no inference happens inside the container. This is what makes "tool-using agent in Docker, local model on host" a clean split rather than a compromise.
- **Only tool-using agents are sandboxed.** The model server has no tools, no credentials, and never acts on the world, so it is not an isolation concern; it stays on the host where it runs fastest. **Both** tool-using tiers (conscious agent, frontier worker) are inside Docker because they hold credentials and read untrusted content (§3).
- **Reflexive tiers stay tool-less on the host.** Hindbrain and forebrain see raw untrusted world events but have **no tools and no credentials** (§3, Vector A). They remain pure completion calls and are genuinely safe on the host.

```
HOST (Apple Silicon, Metal)                          DOCKER (roci-<domain>)
┌────────────────────────────────────────┐          ┌────────────────────────────┐
│ Orchestrator (per character: a fiber)  │          │  sandboxed worktrees,      │
│  ┌───────────────────────────────────┐ │          │  egress firewall, repos    │
│  │ WORLD INTERFACE (reused limbic)   │ │          │                            │
│  │  WS / GraphQL → EventProcessor    │ │  task /   │  ┌──────────────────────┐  │
│  │  → domain State                   │ │  steer    │  │ CONSCIOUS AGENT      │  │
│  └────────────────┬──────────────────┘ │ ───────►  │  │ opencode (local mdl, │  │
│                   ▼ (no tools)          │  events / │  │ tools) — everyday    │  │
│  ┌───────────────────────────────────┐ │  result   │  │ real work            │  │
│  │ HINDBRAIN  (triage)               │ │ ◄───────  │  └──────────────────────┘  │
│  │ FOREBRAIN  (synthesis, steering)  │ │           │  ┌──────────────────────┐  │
│  └────────────────┬──────────────────┘ │  task /   │  │ FRONTIER WORKER      │  │
│                   │ HTTP /v1            │  steer    │  │ sdk-runner.js        │  │
│                   ▼                     │ ───────►  │  │ (Claude Code, Agent  │  │
│  ┌───────────────────────────────────┐ │  events / │  │ SDK) — ESCALATION    │  │
│  │ MODEL SERVER (host, native)       │◄┼──────────►│  │ only (validate /     │  │
│  │ MLX / llama-server (no tools,     │ │  result   │  │ rescue)              │  │
│  │ no creds; serves all local tiers) │ │           │  └──────────────────────┘  │
│  └───────────────────────────────────┘ │   (one tool-using session live at a    │
└────────────────────────────────────────┘    time: conscious OR worker)          │
                                                    └────────────────────────────┘
```

## 3. Threat Model

The cortex is an escalation ladder; raw untrusted text flows in at the bottom and credentialed tool actions happen at the top. Two injection vectors, now spanning **two** tool-using tiers.

The **laundering chain** still holds: raw untrusted text reaches **only** the hindbrain and forebrain — both pure completion calls via the model server with **no tools**. Both tool-using tiers (conscious agent, frontier worker) receive **model-generated / laundered** instructions, never raw inbound text verbatim:
- The conscious agent's task is authored from forebrain synthesis + conscious-tier framing.
- The frontier worker's task is authored at handoff from the conscious agent's own (laundered) account of the problem (`formatStepTask`-style framing from `packages/core/src/cortex/state.ts`).
- Steering directives are forebrain output — model-generated — so steering preserves Vector-A protection in both sessions.

**Vector A — instruction-time injection** (untrusted text reaches a tool-using tier's *instructions*). *Mitigated* by the laundering chain. An injected payload must survive hindbrain triage and forebrain synthesis to reach a tool-using tier, and those models are local and auditable. Honest caveats: small local models are generally **more** injection-susceptible than frontier models, and a faithful summarizer can forward a payload intact — so Vector A is **reduced, not closed**.

**Vector B — execution-time injection** (a tool-using tier reads untrusted content with its *own* tools mid-session: gh issue/PR bodies, web fetches, game messages, third-party repos). **Not mitigated by laundering at all** — it is the **dominant vector**, and it is now **live for the conscious tier too** (confirmed: the conscious agent reads untrusted external content during everyday work). Both tool-using tiers simultaneously hold gh/git credentials and read raw untrusted content. The **Docker boundary** — egress firewall, secure-by-default isolation — is exactly what defends this. **Both** tiers stay in Docker.

### Requirements that fall out of the threat model

1. **Steering directives flow to whichever tool-using session is active, so they MUST be model-generated (laundered) — never raw inbound text.** Forebrain synthesis already has this property; reuse it as the steering payload (§7).
2. **The host components that read raw attacker text (hindbrain/forebrain) have no tools and no credentials** — genuinely safe on the host. The model server they call likewise has no tools/credentials and never acts on the world.
3. **Both tool-using tiers must have equally strong egress containment.** This is the deciding factor (§4): the conscious tier does untrusted tool work **constantly** (everyday), the frontier worker **rarely** (escalation). The constantly-running tier must **not** end up with weaker containment than the occasional one.
4. **Vector-B hardening is explicit.** The Docker boundary stops exfiltration *routes* but not injected-yet-in-scope actions (e.g. a `git push` to a known-allowed host). The egress allowlist plus per-task credential/tool scoping (`allowedTools` in `DelegationConfig`, already supported) are the live mitigations and apply to both sessions.

## 4. Architecture Decision: Docker Network Boundary

**Chosen: Docker remains the network/isolation boundary for both tool-using tiers.** It has a mature, proven egress firewall; secure-by-default isolation; per-exec OAuth/credential injection; and an established build pipeline. The agents lose nothing by being in the container, because all inference happens on the host model server (§2). The cortex (on the host) drives each session with:

```
docker exec -i <containerId> opencode run ...        # conscious agent
docker exec -i <containerId> node sdk-runner.js      # frontier worker (escalation)
```

The container is the isolation boundary for both — working dir (`-w /work/players/<name>`), `--add-dir`, egress firewall, per-exec OAuth token injection, and the process-exit-vs-timeout race are all retained from today's path.

### Deferred alternative — Apple `container` (Containerization framework)

Apple's `container` was seriously evaluated as the agent sandbox and **deferred, not rejected**. Findings (as of mid-2026):

- **Maturity & isolation.** GA at v1.0.0 (June 2026); requires macOS 26 Tahoe + Apple Silicon; runs standard OCI/Linux images (including Node). It gives **one lightweight VM per container** — isolation stronger than Docker Desktop's shared-VM model — with sub-second-ish start. Apple-native and lighter than Docker Desktop. The appeal is real.
- **Dealbreaker for our threat model: no native egress control.** Networking is all-or-nothing (full / `--network none` / host-only `--internal`); there is **no per-container firewall or domain allowlist**, and `HTTP_PROXY` env is **not honored** (closed "not planned"). The maintainer-recommended egress filtering is a DIY dual-homed Squid proxy container — which has a **documented leak**: host services bound to `0.0.0.0` remain reachable from the "internal" network, bypassing the proxy. Given §3 requirement 3 — the conscious tier does untrusted work *constantly* — we cannot accept weaker egress on the tier that needs it most. **This was the deciding factor.**
- **Other sharp edges.** Localhost host-service access (i.e. reaching the model server) is fiddly: manual `container system dns create`, disables iCloud Private Relay, pf rule resets on restart. virtiofs has UID/GID friction and 3–10× slower many-small-file I/O. Container memory is not reliably returned to the host on long-running sessions. There is **no GPU/Metal inside containers** (confirmed) — but this is **irrelevant** here, since the model server runs on the host and the agents only make HTTP calls.
- **Decision.** Keep Docker for the network boundary now (mature egress firewall, proven). **Revisit Apple `container` when its egress story matures** — the per-VM isolation and Apple-native footprint keep the door open.

### Rejected alternatives

- **Run the tool-using agents on the host under an OS sandbox** (macOS Seatbelt / Linux bubblewrap + socat). Rejected: the default-allow-read footgun, weaker network egress control (hostname-only, no TLS inspection), and platform fragmentation. The Docker boundary is stronger, already in place, and Vector B (§3) means we genuinely need it.
- **A long-lived socket service inside the container.** A persistent in-container daemon the host talks to over a socket. Rejected: more moving parts and real lifecycle complexity (start/health/restart/teardown) for no benefit over a per-session `docker exec`.

### On OpenCode's own sandboxing

OpenCode itself provides **no OS-level sandboxing** — only approval/permission prompts, which are not a security boundary. Isolation must come from the container layer regardless of runtime. The conscious agent runs with permissions effectively bypassed inside Docker, and the Docker boundary is the real containment.

## 5. Components & Module Boundaries

### (1) Split the process-runner into transport + payloads

`packages/core/src/core/limbic/hypothalamus/process-runner.ts` currently exposes `runTurn(config: TurnConfig)`, which today:

- builds the `docker exec -i -w /work/players/<name> -e CLAUDE_CODE_OAUTH_TOKEN=... <containerId> ...` command,
- pipes the prompt via stdin,
- streams / splits / parses NDJSON stdout, normalizes events (`normalizeClaude` / `normalizeOpenCode`), accumulates text,
- and races process-exit vs `Effect.sleep(timeoutMs)` via fibers, interrupting on timeout / critical kill (`Fiber.interrupt`).

Split it into:

- **one reusable transport**: `docker exec -i` + stream + timeout race + OAuth/credential injection + critical-kill via `Fiber.interrupt`; and
- **swappable payloads**, now **three**, mapping to the revised tiers:
  - **(a) OpenCode payload** — the **conscious agent's** runtime (`opencode run ...`, normalized via `normalizeOpenCode`). The everyday tool-using session.
  - **(b) SDK-runner payload** — `node sdk-runner.js`, the new in-container Agent SDK host driving `query({ prompt: generator })`. The **frontier worker** (escalation).
  - **(c) Dormant `claude -p` one-shot** — **retained capability** (explicit user requirement: the process-isolation machinery is retained even if unused).

Runtime selection lives in `packages/core/src/core/limbic/hypothalamus/runtime.ts` (`runtimeBinary`, `runtimeBaseArgs`; `AgentRuntime = "claude" | "opencode"`). **Never use `--bare` with `claude -p`** — it disables OAuth token resolution (`runtime.ts` already documents this).

### (2) New `sdk-runner.js` (frontier-worker payload)

A new script baked into the Docker image. The image must ship the `@anthropic-ai/claude-agent-sdk` npm package alongside the bundled `claude` binary (this is a **new dependency** — not yet in any `package.json`). The runner reads NDJSON from stdin → `SDKUserMessage`s, drives `query({ prompt: generator })`, and writes NDJSON to stdout. Used only by the frontier worker during an escalation.

### (3) Steering channel on `delegate`

`packages/core/src/cybernetics/delegate.ts` defines the `Cybernetics` `Context.Tag` with `delegate(config: DelegationConfig)` (today it calls `runTurn` and maps via `toDelegationResult`). It gains a steering channel:

```
delegate(config, steering: Queue<Directive>)
```

Run-to-completion becomes the **degenerate case** — the caller never offers into the queue. `CyberneticsLive` is the production layer; `CyberneticsTest` returns canned results and should be **extended to capture steer directives** for assertions. Types live in `packages/core/src/cybernetics/types.ts` — `DelegationConfig` and `DelegationResult` (`status: "completed" | "timed_out" | "failed"`). `Directive` is a **new type** to add here.

The same `delegate` + transport drives both tool-using payloads; the OpenCode conscious session and the SDK frontier session differ only by payload selection and which model handle backs them.

### (4) Cortex loop control flow (`packages/core/src/cortex/loop.ts`, `runCortex`)

This is a **real change to the loop's control flow**, not just a gating tweak. The prior code structure — `forkStep` / `delegationFiber` / per-step delegation — was built around "conscious produces a plan, then fork a worker per step." The revised loop instead manages a sequence of tool-using sessions:

```
conscious-agent session  →  (optional) escalation handoff to frontier-worker session  →  evaluation
```

- **The conscious tier is no longer a single `runConsciousDecide` completion call.** It becomes an **agent session** (an OpenCode tool-using session). The loop now manages that session's lifecycle the way it previously managed a worker's. `forkStep`/`delegationFiber`/per-step delegation are **reworked** accordingly. (This spec describes the intended control flow; it does **not** prescribe the implementation.)
- **Hindbrain and forebrain run during ANY active tool-using session** (conscious agent OR frontier worker) — they are the reflexive layers that stay live and feed steering. Remove the `!delegationFiber` gates on the hindbrain (step 4) and the forebrain half (step 5) so they run during an active session.
- **Forebrain synthesis is pushed (cadence-throttled, coalesced) to whatever single session is currently active.**
- **Hindbrain disposition** ∈ `discard | accumulate | escalate` (confirmed values; default `accumulate` on parse failure, `tiers.ts`). A **non-discard** disposition wakes the forebrain.
- **Criticals → hard kill** (`Fiber.interrupt` → transport SIGKILLs the in-container process tree) — the only true preemption, unchanged.

## 6. Host ↔ Runner Wire Protocol

A minimal, versioned NDJSON protocol over the `docker exec -i` pipe. One line = one JSON object. It is **payload-agnostic** — the same protocol drives the OpenCode conscious session and the SDK frontier session.

**Host → runner (stdin):**

| Message | Meaning |
|---|---|
| `{"v":1,"type":"task","text":"<laundered task>"}` | The initial turn. Always first. |
| `{"v":1,"type":"steer","text":"<laundered directive>"}` | A mid-session directive; becomes the next user turn (queue-and-finish — no mid-turn preempt). |
| `{"v":1,"type":"end"}` | Close the session: the runner lets the generator return so the query completes. |

**Runner → host (stdout):**

| Message | Meaning |
|---|---|
| `{"v":1,"type":"event", ...wrapped message}` | A streamed event, fed through the existing normalizer (`normalizeClaude` / `normalizeOpenCode` in `packages/core/src/logging/stream-normalizer.ts`) for logging / state. |
| `{"v":1,"type":"result","status":"completed\|timed_out\|failed","output":"<final text>"}` | The terminal line. |

`task` and `steer` are **structurally identical** — both yield one user turn — which keeps the runner trivial. Run-to-completion is the degenerate case: `task` then `end`.

## 7. Steering Model — One Live Session at a Time

**There is only ever one live tool-using session at a time.** Escalation is always a **handoff**, never parallel (§8) — so the forebrain steers whichever single session is currently active: the **conscious agent** during everyday work, the **frontier worker** during an escalation. The same machinery serves both.

The conscious tier's influence over the frontier worker is expressed **at boundaries**, not via continuous concurrent steering: it **authors the worker's task at handoff** (laundered) and **judges the result at evaluation** (continue / re-escalate / abort, §8). Continuous steering of the active session comes from the **forebrain**.

### Steer cadence: "accumulate, push on a cadence"

During an active session, **each tick**: the hindbrain triages, non-discard events accumulate, and the forebrain runs to keep the situational synthesis current. But a `steer` line is pushed **at most once every `STEER_CADENCE_TICKS`** — a **new knob** alongside the existing `tickIntervalMs` / `orientInterval` (`DEFAULT_TICK_MS` = 30_000, `DEFAULT_ORIENT_INTERVAL` = 5 in `loop.ts`). On a push tick the session gets the **latest** synthesis covering everything accumulated since the last push; the accumulated buffer then clears. This keeps the active session's picture fresh without nudging it every tick.

### Backpressure & coalescing

The host-side steering queue is **coalescing, capacity 1**. Each payload is a complete, self-contained forebrain synthesis, so a newer one fully **supersedes** an un-consumed older one. The cadence throttle bounds *production*; coalescing is the safety net for when the session is slow to *pull* — the SDK / runtime pulls the next generator value only **between turns**, so a long turn can span several cadence ticks, and the session then receives only the freshest brief on its next pull. `task` and `end` are control messages, **exempt** from coalescing.

### Non-goal: concurrent dual-session steering

Explicitly **rejected**: a configuration where the conscious tier is being forebrain-steered *while* it simultaneously steers a running frontier worker (two live tool-using sessions at once). Rejected as **high-complexity for negligible benefit** — sessions are **never live simultaneously** (escalation is a handoff, §8), so the conscious tier never needs to drive a worker concurrently. The single-live-session invariant is what makes the steering model tractable.

## 8. Escalation Model

The frontier worker exists for exactly two purposes — both **sequential handoffs**, never parallel:

1. **Validation.** The conscious agent finishes its work, **then** the frontier worker checks it. (Conscious session ends → worker session starts on the same artifacts.)
2. **Hard-problem rescue.** The conscious agent hands off a problem the local models are failing at; the worker takes over. (Conscious session pauses/ends → worker session starts on the problem.)

In both cases the conscious session is not live while the worker runs — preserving the one-live-session invariant (§7).

### Escalation triggers (belt-and-suspenders — BOTH)

1. **Explicit request from the conscious agent** — a signal/tool the agent emits meaning "validate this" or "I'm stuck." Covers the case where the conscious tier **knows** it needs help.
2. **Auto-escalation by the cortex loop** — on detected repeated failure, or per a validation policy. Covers the case where the conscious tier **doesn't realize** it failed.

Both are needed: the explicit request handles "conscious knows it's stuck"; the auto trigger handles "conscious doesn't realize it failed."

### Handoff sequencing & evaluation

- **Handoff (laundered).** The cortex authors the worker's task from the conscious agent's own account of the problem plus forebrain context — model-generated, never raw inbound (§3). `formatStepTask` (`packages/core/src/cortex/state.ts`) already instructs concise reporting "whether the success condition is met"; the worker task reuses that framing.
- **Evaluation at the boundary.** When the worker session ends, the cortex (conscious-tier evaluation, `runConsciousEvaluate` in `packages/core/src/cortex/tiers.ts`) judges the result and chooses **continue** (fold the work back in, resume the conscious agent), **re-escalate** (the worker also failed — bounded retries), or **abort**.

## 9. Lifecycle, Completion, Timeout, Kill

- **Lifecycle.** A session = one tool-using episode (a conscious-agent work session, or a frontier-worker escalation). `task` → the session runs (one or more turns, possibly receiving `steer` lines) → the agent signals done → host sends `end` → the query returns → runner emits `result` → the cortex evaluates and decides the next move (continue / escalate / replan).
- **Completion signal** (the subtle bit). In streaming-input mode the session does **not** self-terminate — unlike `claude -p`, which exits when done. So the agent must **explicitly signal completion**. `formatStepTask` already instructs the agent to "report concisely what you did and whether the success condition is met"; we make that a **recognizable structured marker** the runner detects in the message stream → runner emits `result` → host sends `end`. This keeps the host in control and avoids racing a `steer` against an ambiguous turn-end. (For the conscious agent, the explicit escalation-request signal is a second recognizable marker the runner surfaces.)
- **Timeout.** The existing Effect race (process exit vs `Effect.sleep(timeoutMs)`) bounds total **session** wall-clock; on expiry → kill → `result` status `timed_out`. The default is `DEFAULT_WORKER_TIMEOUT_MS` (60 minutes) in `loop.ts`.
- **Kill.** Criticals → `Fiber.interrupt(delegationFiber)` → transport SIGKILLs the in-container process tree. Today's hard path, unchanged.

## 10. Testing & Retained Capability

- **Runner unit test (pure).** Feed NDJSON stdin; assert the SDK runner yields the expected `SDKUserMessage`s plus a terminal `result` line.
- **Transport test.** Exercise the refactored process-runner transport against a fake echo runner — no real container — covering both payload shapes.
- **Loop tests.** Extend `packages/core/src/cortex/loop.test.ts` for: in-session hindbrain → forebrain → cadence-throttled `steer`; coalescing; criticals-kill-during-session; the conscious-agent → escalation-handoff → evaluation control flow; and both escalation triggers (explicit request and auto-on-failure). Extend `CyberneticsTest` to capture steer directives.
- **Retained `claude -p`.** A test asserting the dormant raw-`claude -p` payload still runs through the shared transport — proving "retain isolation even if unused." Explicit requirement: the process-isolation machinery is retained even if it ends up unused.
- **Smoke.** Extend the `docs/cortex-smoke.md` end-to-end checklist for a steered conscious-agent session and a real escalation handoff in a real container.

## 11. Open Questions / Future Work

- **Apple `container` revisit.** Re-evaluate once its egress story matures (per-container firewall / domain allowlist or honored `HTTP_PROXY`). Its per-VM isolation and Apple-native footprint are attractive; only the egress gap blocks it (§4).
- **Mid-turn preemption.** Neither the TS Agent SDK nor OpenCode over our transport offers a programmatic mid-turn interrupt (only Python's `ClaudeSDKClient.interrupt()` does). If true mid-turn preemption short of a hard kill becomes necessary, a Python runner is the path — out of scope here.
- **Completion-marker robustness.** The structured completion marker the runner detects depends on the agent emitting it reliably (true for both the conscious agent and the frontier worker). The timeout race is the backstop; marker phrasing/format and detection heuristics need empirical tuning during the smoke pass.
- **`STEER_CADENCE_TICKS` default.** Tune per cadence profile (real-time vs planned-action) against real sessions, the same way `orientInterval` is.
- **Auto-escalation policy.** The exact "repeated failure" detection and validation-policy thresholds for auto-escalation need tuning — too eager wastes frontier budget; too lax lets the conscious tier fail silently.
- **Conscious-agent local model selection.** Which local model is competent enough as a tool-using agent (vs. a tool-less reasoner) is a testbench question; the everyday-work tier is the most demanding local-model role.

## 12. Code Reference Verification

Verified against the codebase on 2026-06-18. All references below were confirmed present unless noted:

- `runTurn` / `TurnConfig`, docker-exec build, OAuth injection (`CLAUDE_CODE_OAUTH_TOKEN`), stream parsing, `Effect.sleep(timeoutMs)` / `Fiber.interrupt` timeout-and-kill race, `normalizeClaude` / `normalizeOpenCode` dispatch — `packages/core/src/core/limbic/hypothalamus/process-runner.ts`. ✓
- `runtimeBinary`, `runtimeBaseArgs`, `AgentRuntime = "claude" | "opencode"`, `--bare` warning — `packages/core/src/core/limbic/hypothalamus/runtime.ts`. ✓ (OpenCode runtime confirmed present, backing the conscious-agent payload.)
- `Cybernetics` tag, `delegate`, `CyberneticsLive`, `CyberneticsTest`, `toDelegationResult` — `packages/core/src/cybernetics/delegate.ts`. ✓
- `DelegationConfig`, `DelegationResult` (`status: "completed" | "timed_out" | "failed"`), `allowedTools` field — `packages/core/src/cybernetics/types.ts`. ✓
- `Directive` type — **not yet present** in `packages/core/src/cybernetics/`; a stated new type to add (not a broken reference). Confirmed absent.
- `runCortex`, `DEFAULT_TICK_MS` (30_000), `DEFAULT_ORIENT_INTERVAL` (5), `DEFAULT_WORKER_TIMEOUT_MS` (60 min), `delegationFiber` / `forkStep` gating — `packages/core/src/cortex/loop.ts`. ✓
- `runHindbrain`, `runForebrain`, `runConsciousDecide`, `runConsciousEvaluate` — `packages/core/src/cortex/tiers.ts`. ✓
- Hindbrain disposition values `discard | accumulate | escalate`, default `accumulate` on parse failure — confirmed in `tiers.ts` (default at `tiers.ts:73`) and `loop.ts` (the non-discard / escalate checks around `loop.ts:232–233`). ✓
- Forebrain output shape `{ headline, whatChanged, sections, metrics }` — confirmed in `tiers.ts`. ✓
- `formatStepTask` and the "report concisely … whether the success condition is met" instruction — `packages/core/src/cortex/state.ts` (`formatStepTask` at `state.ts:35`; instruction at `state.ts:41`). ✓
- `normalizeClaude`, `normalizeOpenCode` — both exported from `packages/core/src/logging/stream-normalizer.ts` (`normalizeClaude` at line 15, `normalizeOpenCode` at line 69). ✓
- `loop.test.ts`, `CyberneticsTest` usage — `packages/core/src/cortex/loop.test.ts`. ✓
- Smoke checklist — `docs/cortex-smoke.md`. ✓
- `@anthropic-ai/claude-agent-sdk` — **confirmed absent** from all `package.json` files (a stated new dependency for the frontier-worker `sdk-runner.js`, not a broken reference).
