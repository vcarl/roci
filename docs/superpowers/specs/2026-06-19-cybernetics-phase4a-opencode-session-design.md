# Phase 4a — OpenCode Conscious-Session Transport

> **Status:** Design — pending spec review. Next step: implementation plan via `writing-plans`.
> **Date:** 2026-06-19
> **Branch:** `worktree-steering` (Phase 4 branches from here)
> **Part of:** Phase 4 "cortex loop rework," decomposed into **4a** (this doc — transport substrate) → **4b** (loop rework: wire the live conscious session, consume the steering queue, evaluate-after-turn) → **4c** (escalation + completion policy). Each is its own spec → plan → implement cycle.
> **Builds on:** `docs/superpowers/specs/2026-06-18-cybernetics-agent-sdk-steering-design.md` (§5.4 conscious tier as a tool-using OpenCode agent; §7 steering; §8 escalation).
> **Verified by spike:** `sdd/phase4a-spike-report.md` (session scratch — a throwaway PoC: real two-turn `opencode run --session` round-trip against a local `llama-server`, plus project-local config verification). Every transport-level unknown in this design was confirmed end-to-end before writing it.

## 1. Summary

Phase 4a gives the cortex loop a **resumable, steerable conscious-tier session**: a sequence of `docker exec -w /work/players/<name> opencode run` turns that share one OpenCode session, driven by the **local host model**, with a **per-character system prompt**. Each "turn" is a separate run-to-completion `docker exec` (staying within the existing transport boundary — no daemon, no port publishing) that *continues* the same session via `--session <id>`. This is the **transport substrate only**; wiring it into the tick loop, consuming the Phase 3 steering queue, and evaluate-after-turn are **4b**, and escalation/completion policy is **4c**.

### Why re-invoke-per-turn (Approach A), not a server

OpenCode has no streaming-stdin steering path (the trick the Agent SDK runner uses), so a live conscious session needs *some* multi-turn mechanism. Two were considered:

- **A — re-invoke per turn** (`opencode run --session <id>`): each steer is another `docker exec` that resumes the session. **Chosen.**
- **B — `opencode serve` + HTTP/SSE**: a persistent in-container server driven over exec'd curl.

The agent-SDK-steering spec's §4 *Rejected alternatives* explicitly rejects "a long-lived socket service inside the container … real lifecycle complexity (start/health/restart/teardown) for no benefit over a per-session `docker exec`." Approach B is that shape. Approach A stays within per-session `docker exec`, reuses the existing transport nearly wholesale, and gets the signals B was wanted for **for free**: turn-complete = process exit, failure = non-zero exit / error event. The only thing A gives up is mid-turn live visibility, which soft queue-and-finish steering does not need (the loop only ever acts *between* turns). A is therefore both spec-consistent and smaller.

## 2. What the spike verified (load-bearing facts)

All confirmed against `opencode` 1.17.8 in the `roci-github-sdktest` image, talking to a host `llama-server` (Llama 3.1 8B, OpenAI-compatible) over `host.docker.internal`:

1. **Local-model provider resolves** from an OpenCode config `provider` block (`@ai-sdk/openai-compatible`) pointing at `http://host.docker.internal:8083/v1`. The provider package is **bundled in the opencode binary** — no runtime npm fetch, so **no firewall allowlist change** is needed (reachability to the host model server is internal Docker routing, already permitted).
2. **Session id is capturable.** `opencode run --format json …` emits a `sessionID` field on the **first event line** (`step_start`) and every line after. Format `ses_<…>`.
3. **Session continuity works.** Resuming with `-s <id>` replays the full prior-turn history to the model (verified in the model server's request log, not just inferred from the answer). `-c/--continue` also works but resumes the *most-recent* session — **unsafe under orchestration; rejected.** Use `-s <id>` only.
4. **Project-local config works** in a plain (non-git) cwd — the presence of `opencode.jsonc` is itself the project marker. A project-local `.opencode/agent/<name>.md` supplies a per-character **system prompt** (lands in the model's `system` role) and **wins precedence** over global agent files. (Precedence: project-local `.opencode/agent/*.md` > global agent md > project *inline-JSON* agent — so the **markdown file**, not inline JSON, is the robust choice.)
5. **Sessions are stored** in `~/.local/share/opencode/opencode.db` keyed by project path, so resume must use the **same `-w` working dir** as turn 1.
6. **System prompt has no per-call flag.** `opencode run` has no `--prompt`; injecting prompt text into the message lands in the `user` role (wrong semantics). The system prompt **must** come from an agent definition (`--agent <name>`).

## 3. Runtime model & config scoping

**Container topology.** One long-lived container (discovered by the `roci-crew=true` label) hosts all characters. The host `players/` directory is **bind-mounted** to `/work/players`, and every turn runs `docker exec -w /work/players/<name> …`. So each character is isolated to its own working directory, and that directory is **writable from the host** — config can be provisioned with a plain `writeFileSync`, no `docker exec` round-trip.

OpenCode treats the per-turn cwd (`/work/players/<name>`) as its "project" for both config resolution and session storage. This gives a clean two-tier config scoping:

| Config | Scope | Location | Rationale |
|---|---|---|---|
| **Provider** (host model endpoint) | **Global** | `/home/node/.config/opencode/opencode.jsonc` | Genuinely shared infrastructure — the same `host.docker.internal:<port>` endpoint for every character. Written **once** at container/image setup. Not per-character, so global is correct, not awkward. |
| **System prompt** (character identity) | **Project-local** | `/work/players/<name>/.opencode/agent/<name>.md` | Per-character. Belongs beside the character's existing `me/` identity files, scoped to that character's sessions. Markdown file (wins precedence). |

This is the resolution of the "global config is cross-project / awkward" concern: provider config *is* legitimately cross-project (it's infra); only the system prompt needed project scoping, and it gets it.

### Config-protection (defense-in-depth)

The spike's small test model, confused by OpenCode's tool prompt, once wrote junk into a config file in its writable cwd. The conscious tier is intentionally tool-using, so we cannot blanket-deny writes. Mitigation: after the host writes the project-local agent file, **`chmod` the `.opencode/` config tree read-only** so a confused/malicious turn cannot corrupt its own definition. (The global provider config lives outside any character's working tree, so it is not exposed to this.) This is independent of OpenCode's permission schema and robust regardless of it.

## 4. Components

Each unit has one responsibility, a defined interface, and is independently testable.

### 4.1 Provider config generation (global, one-time)

- **Input:** the cortex `conscious` model handle (`packages/core/src/model/handles.ts` → provider id, baseUrl, model id).
- **Output:** the global `opencode.jsonc` JSON — a single `provider.<id>` block with `npm: "@ai-sdk/openai-compatible"`, `options.baseURL`, and a `models` entry, plus the existing `permission` bypass.
- **Key transform:** rewrite the handle's host loopback (`127.0.0.1:<port>`) to `host.docker.internal:<port>` (the container's route to the host).
- **Where it runs:** container/image setup (one-time per container), writing `/home/node/.config/opencode/opencode.jsonc`. The generation function is pure (handle → JSON string); the write is a thin step.
- **Model label:** stable (`local/<id>`), matching what the agent file's `model:` references. `llama-server` ignores the requested model name and serves its loaded weights, so the label is just OpenCode's internal handle.

### 4.2 Agent file generation (project-local, per character)

- **Input:** the character identity (the same source the other tiers read) + the conscious model label.
- **Output:** `/work/players/<name>/.opencode/agent/<name>.md` — frontmatter (`mode: primary`, `model: local/<id>`) + body = the character's system prompt.
- **Where it runs:** host-side `writeFileSync` into the bind-mounted `players/<name>/.opencode/agent/` during character scaffold/setup; then `chmod` the `.opencode/` tree read-only (§3).
- This closes the OpenCode system-prompt TBD at `payload.ts:84` for the session path.

### 4.3 Session-continuation transport (the core)

A standalone function reusing the existing transport machinery (`buildExecArgs` → `-w /work/players/<name>`, `runTransport`, `normalizeOpenCode` event parsing, the process-exit-vs-timeout fiber race, and the `Fiber.interrupt` → SIGKILL kill path):

```
runOpenCodeSessionTurn(config, resume?: { sessionId: string })
  → Effect<{ result: TurnResult; sessionId: string }, TurnError>
```

- **First turn** (`resume` absent): `opencode run --format json --agent <name> -m local/<id> "<task>"`. Capture `sessionID` from the first JSON event line; return it alongside the result.
- **Resume turn** (`resume` present): `opencode run --format json -s <sessionId> "<directive>"`, same `-w`. No `--agent`/`-m` needed — the session already carries the agent/system context (spike confirmed resume replays it).
- **`-s <id>` only.** `-c/--continue` is never used.
- Returns the captured/echoed `sessionId` every turn so the caller (4b) can thread it.

### 4.4 Routing

4a exposes `runOpenCodeSessionTurn` as a standalone transport function. The existing `delegate` (the frontier-worker / Agent-SDK path) is **untouched** — it remains the escalation transport for 4c. 4b's loop calls `runOpenCodeSessionTurn` directly. This keeps the two tiers' transports cleanly separated.

## 5. Data flow (4a's slice)

1. **Provision (setup time):** generate + write global provider config (§4.1); generate + write project-local agent file, chmod read-only (§4.2).
2. **First conscious turn:** caller invokes `runOpenCodeSessionTurn(config)` → first `opencode run` → returns `{ result, sessionId }`. Caller stores `sessionId`.
3. **Subsequent turns:** caller invokes `runOpenCodeSessionTurn(config, { sessionId })` → resume `opencode run -s <id>` → returns `{ result, sessionId }` (same id).

How the caller *decides* when to take a turn, what directive to pass (from the Phase 3 steering queue), and how it evaluates the result are **4b** concerns. 4a only provides the turn primitive and the session-id handoff.

## 6. Error handling

- **Turn failure** = non-zero exit / error event in the JSON stream. Surfaces as a `TurnError` via the existing exit/timeout race; the hard-kill path (`Fiber.interrupt` → SIGKILL) is unchanged.
- **Provider unreachable** (host model server down) → manifests as a turn error; returned to the caller, not retried inside the transport.
- **Session not found on resume** (stale id, db reset) → detected from OpenCode's error output and surfaced as a distinct, typed failure so the caller (4b) can choose to start a fresh session rather than silently hang. 4a defines the error; 4b owns the recovery policy.

## 7. Testing

**Host-side unit tests** (fake/recording runner, no container):
- Command construction: first turn emits `--agent <name> -m local/<id>`; resume emits `-s <id>` and **omits** `--agent`/`-m`; both carry `-w /work/players/<name>`.
- `sessionID` extraction from a representative first-line JSON event (and that a missing/garbled id is a typed error, not a crash).
- Provider config generation: handle → JSON, including the `127.0.0.1` → `host.docker.internal` rewrite.
- Agent-file generation: identity → markdown (frontmatter `model:` matches the provider label) + the chmod-read-only step.

**Container smoke test** (gated like the Phase 2 SDK smoke, `docs/cortex-smoke.md`): a real two-turn `-s` round-trip against a local `llama-server`, asserting turn 2 recalls turn-1 context — mirroring the spike. Documents how to stand up the local model + config so it is independently runnable.

## 8. Operational notes (carried from the spike into ops docs)

- **Extra title call on turn 1.** A new session's first turn fires an internal OpenCode "title generator" model call — so expect **2 model-server calls on turn 1, 1 per turn after.** Cost/latency only; no correctness impact.
- **Small-model tool over-eagerness.** Small models over-use tools under OpenCode's default tool prompt. The real conscious model is larger; combined with the §3 config-protection chmod, this is contained. Not a transport concern.
- **`host.docker.internal` on non-Desktop Linux** is not defined by default — production deploys there need `--add-host=host.docker.internal:host-gateway` on the container. Fine on Docker Desktop (current dev).
- **Resume requires the same cwd** (`-w /work/players/<name>`) as turn 1, because sessions are keyed by project path in `opencode.db`.

## 9. Scope boundary (what 4a is NOT)

- **Not** loop wiring, tick cadence, or steering-queue consumption (4b).
- **Not** removal of the `!delegationFiber` gates in `loop.ts` (4b).
- **Not** evaluate-after-turn, escalation (validate/rescue), `session.error`-style auto-escalation, or task-done completion-marker detection (4c).
- **Not** any change to `delegate` or the Agent-SDK frontier-worker path.

## 10. Open items for the implementation plan

- Exact OpenCode permission-config schema for the config-protection intent (chmod is the primary, schema-independent guard; a path-scoped `permission` deny is a possible secondary).
- The precise typed-error surface for "session not found on resume" (string match on OpenCode's error output vs. exit code) — to be pinned during implementation against 1.17.8 output.
