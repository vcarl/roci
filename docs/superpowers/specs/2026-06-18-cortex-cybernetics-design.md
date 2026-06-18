# Cortex / Cybernetics Redesign

> **Status:** Design approved, pending spec review. Next step: implementation plan via `writing-plans`.
> **Date:** 2026-06-18
> **Branch:** `cortex-cybernetics-redesign`

## 1. Context & Problem

The harness was built when `claude -p` was a stateless, single-shot, tool-using turn executor. Every cognitive capability the agent lacked was therefore reimplemented *outside* the model:

- A 30s external tick loop (because the model couldn't run continuously)
- An OODA chain — observe / orient / decide / evaluate — run as **four separate `claude -p --no-tools` calls per tick**
- An external plan/step/budget state machine (because the model couldn't plan its own work)
- A custom subagent-manager, a brain/body split, kill-and-restart interrupts, "operating skills" as prompt templates, and `dream` memory compression

Claude Code has since become a persistent, self-directing agent: it observes/orients/plans/acts/self-evaluates internally, spawns its own subagents, loads skills, compacts context, and resumes sessions. The harness's cognition layer now **duplicates the agent loop the runtime already runs internally** — and the current code makes it worse: `channel-session.ts` runs a native Claude agent *inside* a session **and** an external 4-call-per-tick OODA brain *driving it from outside*. That is the most expensive possible shape.

A background verification of `claude --channels` (CLI `2.1.181`) found: the flags exist and the MCP channel plumbing connects and accepts pushes (HTTP 200), but **the session did not stay alive to consume pushed events** in print mode — the persistence model the channel-session design depends on is unproven here. The live `session-runner.ts` also omits the required `--dangerously-load-development-channels` flag and has a port mismatch.

### The reframe

Split cognition from execution along a metaphor stack:

- **Limbic** — reflex/relay. World-interface: events → state. (Largely kept.)
- **Cortex** — deliberation, run on **inspectable local models** on known hardware (Apple Silicon M5, 128GB). This is the persistent character.
- **Cybernetics** — frontier models as prosthetics the cortex *reaches for*: Claude Code doing real work, and genuinely hard reasoning. "It uses Claude Code to do work, the same way a person does."

The cortex is a cheap, local, auditable controller; cybernetics is the expensive, capable worker it delegates to. Moving cognition onto local models eliminates the duplication: the two layers stop being redundant and become controller ↔ worker.

## 2. Goals & Non-Goals

**Goals**
- Replace external-cognition-on-Claude with a **local-model cortex** optimized for M5 / 128GB.
- Structure cognition as a **filter/escalation ladder** (hindbrain → forebrain → conscious → cybernetics), not a fixed pipeline.
- Make local-vs-remote model hosting a **config choice** via an OpenAI-compatible provider seam — primary build target is local hosting; OpenRouter/etc. are deliberate swap-ins.
- Delegate real work to Claude Code via **spawn-per-task** (proven), not channels.
- Reuse the limbic world-interface, interrupt rules, logging, and `dream`.

**Non-goals (now)**
- No dependence on `claude --channels` / research-preview flags.
- No mid-task steering of a running delegation (see Parked Questions).
- No "society of mind" deliberation in the conscious tier yet (see Parked Questions).
- No automatic remote failover for local model failures (see §6).

## 3. Architecture & Topology

One persistent **cortex** process per character, on the host. It holds identity and situational state, runs the escalation ladder over local models, and lives for the whole session. When it decides real work is needed, it spawns a **cybernetic** worker (Claude Code) in Docker for a scoped task, reads the result, and folds it into state.

```
HOST (Apple Silicon, Metal)                         DOCKER (roci-<domain>)
┌───────────────────────────────────────┐          ┌──────────────────────┐
│ Orchestrator (per character: a fiber) │          │  sandboxed worktrees │
│  ┌──────────────────────────────────┐ │          │  firewall, repos     │
│  │ WORLD INTERFACE (reused limbic)  │ │          │  ┌────────────────┐  │
│  │  WS / GraphQL → EventProcessor   │ │   spawn  │  │ claude -p      │  │
│  │  → domain State                  │ │ per task │  │ (cybernetics,  │  │
│  └──────────────┬───────────────────┘ │ ───────► │  │  ephemeral)    │  │
│                 ▼                     │  result  │  └────────────────┘  │
│  ┌──────────────────────────────────┐ │ ◄─────── └──────────────────────┘
│  │ CORTEX (escalation ladder)       │ │
│  │  hindbrain → forebrain →         │ │          LOCAL MODEL SERVING (host)
│  │  conscious → [delegate]          │ │  OpenAI  ┌──────────────────────┐
│  │  holds character + situation     │ │  /v1 API │ MLX / llama-server   │
│  └──────────────┬───────────────────┘ │ ────────►│ (one inference at a  │
│                 └─────────────────────┼─────────►│  time; testbench rig)│
└───────────────────────────────────────┘          └──────────────────────┘
```

**Three meaningful boundaries:**
- **Host ↔ Docker = cortex ↔ cybernetics.** The brain is local and yours; the prosthetic is sandboxed. Local MLX/llama.cpp require host Metal and *cannot* run in the Linux container — so the process topology falls naturally on this seam.
- **Cortex ↔ model-serving = a plain OpenAI-compatible HTTP call.** The cortex asks an endpoint for a completion from the model mounted for a given tier. Weight loading / residency / swapping is the serving layer's concern (reuses the testbench MLX/llama-server supervisor).
- **World-interface ↔ cortex = existing `EventProcessor` → `State`.** Kept as-is.

## 4. Components

**a) Cortex tiers** — three modules, identical shape, different prompt + model + cadence. Each is a near-pure function `(situation, state) → structured decision`: render prompt template → call a model handle → parse structured output → return typed result.
- `hindbrain` → `{ disposition: pass | note | wake, weight }`
- `forebrain` → `{ headline, whatChanged, sections, metrics }`
- `conscious` → `{ action: act | wait | delegate | done, ... }`

Tiers hold only a tier name; they don't know which model backs them or where it runs.

**b) Model provider seam** — makes local-vs-remote a config choice:
```
ModelHandle = { tier, provider, baseUrl, model, params }
provider ∈ { mlx | llamacpp | openai-compatible }   // openrouter/anthropic/etc = openai-compatible
```
`ModelClient` takes a `ModelHandle` and performs an OpenAI-style chat completion. Local and remote differ only by `baseUrl` + auth. **This replaces `runtime.ts`'s claude/opencode binary split** — "which HTTP endpoint," not "which CLI binary."

**c) Cybernetics delegation** — `delegate(task) → result`. Spawns `claude -p` in the Docker container (scoped task, stream-json out, run-to-completion), captures a structured result. The only thing that crosses into Docker. Reuses today's container/OAuth/exec plumbing, minus channel machinery.
- Distinct from (b): a tier backed by a *remote model* is still a one-shot completion (the cortex thinking with borrowed weights); **cybernetics is agentic** (Claude Code with tools, doing work).

**d) Reused as-is** — world interface (`EventProcessor` → `State`), interrupt rules (amygdala) as the reflex that can preempt, logging (JSONL + console), `dream`, character identity files.

**e) Cortex state** — the persistent object the host process owns: current situation, active plan/intent, wait-state, accumulated observations, emotional weight, escalation bookkeeping (loaded models, last-orient tick, cooldowns).

**Module boundaries:** `cortex/{hindbrain,forebrain,conscious}.ts`, `model/client.ts` + `model/handles.ts`, `cybernetics/delegate.ts`, and the untouched `limbic/` world-interface beneath.

## 5. Data Flow

The cortex *is* the loop — each layer only wakes the one above it.

```
        world events (WS / GraphQL poll) → EventProcessor → State   (async, continuous)
                  ▼
   HINDBRAIN   triage → pass | note | WAKE (+weight)      always resident; most events die here
                  │ WAKE (or N notes accrued, or staleness timer)
                  ▼
   FOREBRAIN   headline / whatChanged / metrics           resident; synthesizes situation
                  │ material change, or no active plan, or plan stale
                  ▼
   CONSCIOUS   decide: act | wait | DELEGATE | done        loaded on demand (big MoE)
                  │ DELEGATE(scoped task)
                  ▼
   CYBERNETICS (Docker)  claude -p, run-to-completion → structured result
                  ▼
   CONSCIOUS evaluates result → update state/diary → loop
```

- **Escalation, not pipeline:** a quiet world never wakes the forebrain; routine-but-noteworthy wakes the forebrain but not consciousness; only a real decision point lights up the expensive tier; only real work crosses into Docker.
- **Never goes blind:** a staleness timer forces a forebrain synthesis every N cycles absent a wake; accumulated "note" events also eventually trigger one. Tunable per cadence (real-time vs planned-action).
- **Residency:** hindbrain + forebrain stay **resident** (~20GB combined at 4-bit); the conscious MoE is **loaded on demand and kept warm** behind an idle-unload timer. Only one model *infers* at a time, so 128GB holds weights, not contended compute. The conscious tier is deliberately slower-to-start. Testbench load-time + tok/s measurements tune the idle timer and tier assignments.
- **Amygdala cuts the line:** interrupt rules evaluate every cycle independent of the ladder. A critical world event can jump straight to conscious, or **abort an in-flight delegation** and re-decide.
- **Reflexes stay live during delegation:** while Claude Code works in Docker, the hindbrain keeps triaging; the cortex doesn't escalate further until the result returns (or it aborts).

## 6. Error Handling

- **Local model unreachable / OOM on load → fail fast, typed and descriptive**, naming tier, handle, and endpoint. A missing local model is a config/ops error, not a runtime condition to paper over. **No automatic remote failover** — that redundant path would rarely execute and rot. Remote providers remain a *deliberate configuration choice*.
- **Parse failures** — prefer **grammar-constrained decoding** (llama.cpp GBNF / MLX) so malformed output is rare. On the residual case, a *logged* safe default per tier (hindbrain → `note`, forebrain → push raw state up, conscious → `wait`), so one bad completion can't kill a long-lived character.
- **Cybernetics delegation failure / timeout** → captured as `{ status: failed, reason }`; the conscious tier evaluates it like any outcome and chooses retry / replan / abandon, with bounded retries.
- **World-interface disconnect** → reconnect with backoff; run on last-known state; hindbrain notes the staleness.
- **Escalation thrash** → cooldowns + emotional-weight damping + the staleness timer as floor.

## 7. Testing

- **The testbench picks the models.** Use the existing `~/workspace/testbench/llms` harness to empirically rank candidates per tier — triage accuracy (hindbrain), synthesis quality (forebrain), decision quality (conscious) — leaning on the Admiral game scorers to choose the SpaceMolt forebrain/conscious on actual gameplay. The design commits to *roles*; the benchmark fills them.
- **Ladder logic** — unit-tested with a mocked `ModelClient`; tiers are near-pure, so escalation transitions, fallbacks, and parse-failure defaults test deterministically without a GPU.
- **Provider parity** — `ModelClient` contract tests against a local endpoint and a mock OpenAI-compatible server, verifying local↔remote swap.
- **Cybernetics** — `delegate` tested against a fake exec returning canned results, plus one real `claude -p` smoke test.
- **End-to-end smoke per domain** — a scripted world-event sequence asserting the ladder escalates as intended and fires a delegation.

## 8. Candidate Models (from testbench `models.yaml`, M5/128GB, 4-bit)

| Tier | Job | Candidates |
|---|---|---|
| Hindbrain | always-on triage + emotional weight | Gemma 4 E4B, Qwen 3.5 9B, Phi-4 14B, Llama-Nemotron Nano 8B |
| Forebrain | situational synthesis | Qwen 3.5 27B, GLM 4.7 Flash 31B-A3B (MoE), Qwen3.5 35B-A3B (MoE), Mistral Small 3.2 24B |
| Conscious | deliberate decide/evaluate/plan | Qwen3.5 122B-A10B (MoE), GPT-OSS 120B-A5B (MoE), QwQ 32B / Magistral / R1-distill (reasoning) |
| Cybernetics | the work + hardest reasoning | Claude Code (frontier), spawned per task |

Final assignments determined empirically by the testbench, not asserted here.

## 9. What's Deleted / Kept

**Deleted:** `claude --channels` usage, `session-runner.ts` / `channel-session.ts` persistence, the brain/body split, OODA-as-4-Claude-calls (`ooda-runner.ts` in its current form), `runtime.ts` binary split, the operating-skill prompt-template machinery as the primary cognition path.

**Kept:** world interface (`EventProcessor` → `State`), interrupt rules (amygdala), logging, `dream`, character identity files, the tier concept from `model-config.ts` (repointed at endpoints).

## 10. Parked Questions (future work)

- **Mid-task interruption instead of abort.** Steering a running Claude Code delegation rather than killing it. This is the one narrow place a *proven* use of `claude --channels` could earn its place — but only after the abort-based spine works and channels' persistence is verified.
- **Society of mind / deliberation in the conscious tier.** Multiple local models propose/critique/vote on hard decisions before committing or escalating (cf. `docs/literature-review-deliberation.md`). An upgrade to the conscious tier once the ladder is real.
- **Residency tuning.** Exact resident set vs. on-demand loading, idle-unload timing — resolved against testbench load-time/throughput numbers.

## 11. Decisions Log

- **Escalation ladder, not pipeline** — most cognition is subconscious; consciousness is the expensive exception. Matches the anatomy and the swap-one-model economics.
- **Spawn-per-task, not channels** — proven path; matches "cortex delegates discrete work to capable hands"; no research-preview dependency.
- **Host cortex / Docker cybernetics** — forced by Metal (local models can't run in the Linux container) and clean: the process topology *is* the metaphor.
- **Model serving is a dumb OpenAI-compatible endpoint** the cortex calls; local-vs-remote is config.
- **Fail fast on missing local models** — no redundant auto-failover path.
