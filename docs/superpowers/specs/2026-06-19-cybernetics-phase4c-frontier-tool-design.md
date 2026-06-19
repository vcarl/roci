# Cybernetics Phase 4c — Frontier Delegation as a Steerable Bash Tool

> **Status:** Design approved (user), pending spec review → implementation plan via `writing-plans`.
> **Date:** 2026-06-19
> **Branch:** `worktree-steering` (continues Phases 3 + 4a + 4b; kept, not merged)
> **Base:** `fbdf3a2` (Phase 4b complete)

## 1. Context & Problem

The master design (`docs/superpowers/specs/2026-06-18-cortex-cybernetics-design.md` §3–§5) describes the escalation ladder `hindbrain → forebrain → conscious → cybernetics`, where the **conscious** tier was a local model deciding `act | wait | delegate | done`, and **cybernetics** was a frontier Claude Code worker the conscious tier *delegates* to ("the work + hardest reasoning", §8).

**Phase 4b changed the conscious tier's nature.** It reworked `cortex/loop.ts` so the conscious tier is now itself a tool-using OpenCode session on a *local* model that **executes** plan steps (`loop.ts:73`: "Each plan step is executed by the conscious agent (local LLM in an OpenCode session with full tool access)"), steerable in-session via `formatSteerDirective` → `pendingDirective`. The frontier rung — `cybernetics/delegate.ts` (a host-side Effect that does `docker exec claude -p`, run-to-completion or steerable) — was **deliberately left dormant**: the 4b spec §2 states *"`Cybernetics` retains its single `delegate` method (the frontier escalation path). In 4b it is dormant… reintroduced into the loop in 4c."* The 4b spec §10 defers to 4c: *"Frontier escalation (validate / rescue handoff). Re-wiring `delegate` / `Cybernetics` back into the loop."*

The master design ladder is settled (frontier rung *on top of* the local conscious executor — not a replacement; 4b settled that). What the docs left open is **how the local conscious session signals escalation**.

### The reframe (this spec's central decision)

The master-design metaphor is that cybernetics is *"Claude Code… the same way a person uses it"* (§2) — a prosthetic the cortex **reaches for**. Treating escalation as the *orchestrator routing a step to a frontier worker* contradicts that metaphor: it makes the frontier an alternative **mind** the loop chooses between, not a **tool** the mind uses.

So: **frontier delegation is a tool the conscious OpenCode mind invokes inline — like any other tool — not an orchestrator-mediated route.** The conscious mind reaches for a `frontier` command via its existing Bash tool when a sub-task exceeds its reach, watches the worker's output, steers it, and folds the result into its own reasoning. The orchestrator does not mediate; the escalation lives entirely inside a conscious turn.

This is feasible with **zero new infrastructure** (all verified):
- The conscious OpenCode session and the frontier `claude -p` worker already run **in the same container** (`process-runner.ts` — both via `docker exec -w /work/players/<name>`); `claude` is on PATH there.
- `CLAUDE_CODE_OAUTH_TOKEN` is already injected into the container env by `buildExecArgs` (`process-runner.ts`), inherited by the OpenCode session and any subprocess it spawns — so the worker authenticates with no new wiring.
- The OpenCode session has blanket tool access (`opencode.jsonc` `permission: { "*": "allow" }`, `opencode-config.ts`), so a Bash-invoked command needs no allow-listing.

**No MCP.** Per standing preference, the capability is exposed as a bash/subprocess invocation, never an MCP server or custom-tool plugin.

## 2. Goals & Non-Goals

**Goals**
- Expose frontier delegation as a **bash CLI** (`frontier`) the conscious OpenCode agent calls inline, idiomatically, like any other tool.
- Make the delegation **steerable** by the conscious mind, using the worker's **partial output** as steering feedback (the mind watches the work and nudges).
- Reuse Phase 2/3's **wire protocol** (`taskLine`/`steerLine`/`endLine` NDJSON) intact; relocate only the *driver* from a host Effect to an in-container bash CLI.
- Wire `ConsciousThoughtLive` into the live runtime (the latent Phase-4b integration gap).
- Keep laundering (Vector-A): every task/steer string handed to the worker is model-generated (authored by the conscious LLM), never raw inbound event text.

**Non-Goals (now)**
- No MCP, no OpenCode custom-tool plugin, no opencode-config tool/mcp schema changes.
- No orchestrator-mediated routing of steps to the frontier (rejected reframe).
- No forebrain/world steering *past* the conscious mind directly into the frontier worker — steering is **layered** (forebrain→conscious exists from 4b; conscious→frontier is new; nobody reaches past the mind into its tool).
- No deletion of the now-dormant host-side `cybernetics/delegate.ts` Effect in this phase (flagged for later cleanup).
- No "society of mind" / multi-model deliberation (still parked, master design §10).

## 3. The Tool Contract

A `frontier` CLI on PATH in the container, **handle-based and asynchronous** (async is forced by steering: a single blocking call cannot be steered by its own caller, and a blocked conscious turn cannot also receive forebrain steers):

```
id=$(frontier start "<scoped, self-contained task>")   # launch detached worker, print a handle id
frontier poll  "$id"     # print accumulated partial output so far + status (running|done|failed)
frontier steer "$id" "<nudge>"                          # push a steering directive mid-run
frontier wait  "$id"     # block until the worker finishes; print final output (plain text) to stdout
```

- **Output is plain text on stdout** (no structured envelope). `poll`/`wait` print the worker's streamed assistant text; status is conveyed on a separate line or via exit code so the agent can read output as a normal command result.
- The conscious agent's usage loop: `start` → (`poll` → reason → optionally `steer`)\* → `wait`. It watches the work unfold and nudges based on what it sees — the feedback loop the user asked for.
- **Run-to-completion convenience** (optional): a `frontier run "<task>"` = `start` + `wait` for the non-steered case. Decide during planning whether to include it or keep the surface minimal (`start`/`poll`/`steer`/`wait` only).

## 4. Driver Mechanism

Reuse the Phase 2/3 streaming-session wire protocol; relocate the driver into the container via a **named pipe**.

- **`start`**: create `/tmp/frontier-<id>/` with an input FIFO (`mkfifo in.fifo`) and an `out` file. Spawn a **detached** (`setsid`/`nohup`) `claude` in streaming-input mode reading NDJSON from `in.fifo`, writing the initial `taskLine(task)` first, teeing streamed assistant output to `out`. Print `<id>`.
- **`poll`**: `cat out` (accumulated partial output) + a status read (process alive? exit recorded?).
- **`steer`**: append `steerLine(directive)` to `in.fifo`.
- **`wait`**: append `endLine()` to `in.fifo` (ends the session — the runner's input completes → `claude` finishes), block on the worker process, then print final `out` to stdout.

**Cross-turn lifecycle (the key subtlety).** Each conscious *turn* is a separate `docker exec opencode run` process (4b resumes the session by id; the process exits between turns). Therefore the frontier worker **must be detached and its state file-backed by handle id**, so a *later* turn's `frontier poll/steer/wait` — running in a different process — reattaches via `/tmp/frontier-<id>/…`. This falls out of the handle model: the handle is just an id; all state lives on the shared container filesystem.

**Flag/wire construction stays DRY.** The CLI script is **generated by host code** that reuses the `claude` flag construction (`payload.ts`) and the wire-protocol line builders (`sdk-payload.ts`: `taskLine`/`steerLine`/`endLine`), so the worker's invocation flags and NDJSON framing have a single source of truth and are unit-testable on the host (exactly as `buildProviderConfigJson` is tested today). The generated script is written into the container via the same base64→file→`chmod` pattern as `provisionConsciousProvider` (`opencode-config.ts`).

## 5. Laundering (Vector-A)

The `start` task and every `steer` directive are authored by the **conscious LLM** as arguments to a tool it chose to call — inherently model-generated, never raw inbound event text. This satisfies the Vector-A threat model the same way 4b's conscious-session steering does (`cybernetics/types.ts` `Directive`: "a laundered (model-generated) … synthesis"). No raw world text is ever passed to the frontier worker.

## 6. Work Breakdown

1. **Wire `ConsciousThoughtLive` live.** Export `ConsciousThought` + `ConsciousThoughtLive` from `packages/core/src/index.ts`; add `ConsciousThoughtLive` to `serviceLayer` in `apps/roci/src/cli.ts` (~line 624). This closes the latent Phase-4b runtime gap (the live loop does `yield* ConsciousThought` but the layer was never provided). `CyberneticsLive` is already wired (`cli.ts:631`) and `DockerLive` is already present — leave both. Build all four projects (core + 2 domains + app) to surface the requirement.
2. **Generate + provision the `frontier` CLI.** Host code that (a) builds the CLI script string reusing `payload.ts` flag construction + `sdk-payload.ts` wire builders, and (b) a provisioning step that writes it into the container (base64→file→`chmod 0o755`), mirroring `provisionConsciousProvider`. Provisioned once per container alongside the existing conscious provisioning. Unit-test the generated script string.
3. **Teach the agent.** Extend `buildCharacterAgentMarkdown` / the conscious system prompt (`opencode-config.ts`) with a concise description of the `frontier start/poll/steer/wait` workflow and when to reach for it (a sub-task exceeding local reach).
4. **Gated smoke test.** A `skipIf`-gated smoke (mirroring the 4a OpenCode smoke, `delegate.smoke.test.ts`/`opencode-session.smoke.test.ts`): a conscious session runs `frontier start … / poll / wait`, the frontier worker executes and returns; assert a result returns and that one `steer` is consumed mid-run.

## 7. Disposition of Phase-3 Host-Side Machinery

- **Reused:** the wire-protocol/payload helpers (`sdk-payload.ts` line builders, `payload.ts` flag construction) — the new CLI generator consumes them.
- **Dormant (not the vehicle anymore):** the host-side `cybernetics/delegate.ts` `delegate` Effect (the `docker exec claude -p` driver) and `cybernetics/steering.ts` `makeSteeringQueue`/`buildSteeredStdinStream` (host-Effect Queue driver). The driver moves host→container; these are no longer called by the live path.
- **Decision:** leave them untouched in 4c (don't expand scope with deletions), flag for a later cleanup phase. `CyberneticsLive` stays composed (harmless, dormant).

## 8. Error Handling

- **Worker spawn/auth failure** → `poll`/`wait` report `failed` status with the error text on stdout; the conscious mind reads it like any other tool failure and decides retry/replan/abandon (no orchestrator involvement).
- **Worker timeout** → bounded by a wall-clock budget baked into the `start` invocation (reuse the existing per-worker timeout knob); `wait` returns the partial `out` + `timed_out` status.
- **Orphaned handles** → `/tmp/frontier-<id>/` is ephemeral container state; a container restart clears it. A stale `poll`/`wait` on a dead handle reports `failed`/`unknown` rather than hanging.
- **Laundering invariant** is structural (tool args are model-authored); no runtime check needed.

## 9. Testing

- **Generated-script unit tests** (host, no container): assert the CLI script embeds the correct `claude` flags and NDJSON framing (reusing the shared builders), and the provisioning writes it with the right path/permissions — mirrors `opencode-config.test.ts`.
- **Wire-protocol reuse** is already covered by Phase 2/3 tests (`sdk-payload`, `steering.test.ts`); no new coverage needed for the framing itself.
- **Gated end-to-end smoke** (§6.4): real container, `skipIf` on an env flag, asserting a delegation returns and a steer is consumed.
- **Live integration** verified manually per `docs/cortex-smoke.md` (a real container tick where the conscious mind reaches for `frontier`).

## 10. Open Questions / Parked

- Whether to include the `frontier run` (blocking convenience) alias or keep the surface to `start/poll/steer/wait` — decide in the plan.
- Exact `poll` status encoding (separate stdout line vs exit code vs both) — decide in the plan against what reads cleanly for an LLM.
- A dedicated `consciousTurnTimeoutMs` / `frontierTimeoutMs` knob vs reusing `workerTimeoutMs` (`loop.ts:63` notes this as deferred tuning) — decide in the plan.
- Later cleanup phase: delete or repurpose the dormant host-side `cybernetics/delegate.ts` / `steering.ts` Effect machinery.

## 11. Decisions Log

- **Frontier = a tool the mind reaches for, not an orchestrator route** — faithful to the master-design metaphor ("uses Claude Code the way a person does"); keeps the conscious mind in the loop.
- **Bash CLI, no MCP** — standing preference; also matches the project's in-container subprocess model.
- **Async, handle-based** — forced by steering: a blocking call can't be steered by its caller, and a blocked turn can't receive forebrain steers.
- **Layered steering** — forebrain→conscious (from 4b) and conscious→frontier (new); nobody reaches past the mind into its tool. The conscious mind uses the worker's **partial output** (`poll`) as steering feedback.
- **Reuse wire protocol, relocate driver** — Phase 2/3 NDJSON framing survives; only the driver moves host→container (named pipe). Answers the "vestigial machinery" question without a deletion in this phase.
- **Plain-text stdout** — most bash-idiomatic; the agent reads it as a normal command result.
