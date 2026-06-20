# Cortex End-to-End Smoke Test Checklist

A reproducible manual checklist for validating the cortex/cybernetics architecture end-to-end: local model tiers (ports 8081–8083) + Docker-based worker delegation + live character session with escalation ladder and log markers.

## Prerequisites

- **macOS with Apple Silicon** (Metal-capable). Cortex models run on the host via MLX or llama.cpp.
- **Docker** running (containers are built and started automatically by the `start` command).
- **Project built**: `npx nx run-many -t build`
- **One character configured** in `config.json` with a domain (e.g., `spacemolt` or `github`).

## Setup: Local Model Servers (Ports 8081–8083)

The cortex tiers require three OpenAI-compatible servers for hindbrain, forebrain, and conscious:

| Port | Tier       | Use         | Default Model                          |
|------|------------|-------------|----------------------------------------|
| 8081 | hindbrain  | Fast triage | `mlx-community/Qwen3.5-9B-4bit`        |
| 8082 | forebrain  | Planning    | `mlx-community/GLM-4.7-Flash-4bit`     |
| 8083 | conscious  | Reasoning   | `mlx-community/Qwen3.5-122B-A10B-4bit` |

### Option A: MLX Server (Recommended — Best Performance)

MLX servers are macOS-native and offer best throughput on Apple Silicon. See `~/workspace/testbench/llms/local-llms.md` for model selection and tuning.

```bash
# Terminal 1: hindbrain (port 8081) — small/fast tier
mlx_lm.server --model mlx-community/Qwen3.5-9B-4bit --port 8081

# Terminal 2: forebrain (port 8082) — medium tier
mlx_lm.server --model mlx-community/GLM-4.7-Flash-4bit --port 8082

# Terminal 3: conscious (port 8083) — large/slow tier
mlx_lm.server --model mlx-community/Qwen3.5-122B-A10B-4bit --port 8083
```

To measure per-tier latency (first-token + total time), use:
```bash
cd ~/workspace/testbench/llms
npx ts-node src/bench.ts --endpoint http://127.0.0.1:8081/v1 --prompt "Hello"
```

### Option B: Ollama (Easier Setup, Lower Throughput)

If MLX is unavailable, Ollama simplifies setup but runs slower:

```bash
# Terminal 1: hindbrain
ollama serve &
ollama run qwen2.5:7b-instruct-q4_0 &

# Terminal 2: forebrain
OLLAMA_HOST=0.0.0.0:11435 ollama serve &
ollama run qwen2.5:14b-instruct-q4_0 &

# Terminal 3: conscious
OLLAMA_HOST=0.0.0.0:11436 ollama serve &
ollama run qwen2.5:72b-instruct-q4_0 &
```

### Option C: llama.cpp (Maximum Flexibility)

See `~/workspace/testbench/llms/llama-cpp-guide.md` for quantization and pinned release installation. Supports partial GPU offloading (layers split between GPU/CPU) if a model barely fits.

## Step 1: Verify Tier Connectivity

Each tier must reach the local model server. Run the model smoke test against each port:

```bash
# Hindbrain (port 8081)
ROCI_MODEL_SMOKE_URL=http://127.0.0.1:8081/v1 \
ROCI_MODEL_SMOKE_MODEL=mlx-community/Qwen3.5-9B-4bit \
npx vitest run packages/core/src/model/client.smoke.test.ts

# Forebrain (port 8082)
ROCI_MODEL_SMOKE_URL=http://127.0.0.1:8082/v1 \
ROCI_MODEL_SMOKE_MODEL=mlx-community/GLM-4.7-Flash-4bit \
npx vitest run packages/core/src/model/client.smoke.test.ts

# Conscious (port 8083)
ROCI_MODEL_SMOKE_URL=http://127.0.0.1:8083/v1 \
ROCI_MODEL_SMOKE_MODEL=mlx-community/Qwen3.5-122B-A10B-4bit \
npx vitest run packages/core/src/model/client.smoke.test.ts
```

**Expected output:** Each test completes with `✓ returns a non-empty completion`.

**Failure mode:** If a test times out or returns `ModelError: connection refused`, the local model server on that port is unreachable or not running. Check:
- Model server process is running: `ps aux | grep mlx_lm.server` or `ollama`
- Port is listening: `lsof -i :8081` (repeat for 8082, 8083)
- No firewall block: `curl -s http://127.0.0.1:8081/v1/models | head -50`

⚠️ **Critical:** Local model failure is a fail-fast config/dev error. The cortex will surface a `ModelError` and exit — there is no remote fallback to a cloud endpoint. Fix the unreachable local model before proceeding.

## Step 2: Full Build + Test Suite

```bash
# Build all packages
npx nx run-many -t build

# Run full test suite (100 passed, 2 skipped)
npx vitest run
# or
npx nx run-many -t test
```

**Expected output:** `100 passed, 2 skipped` (the 2 skipped are guarded by `ROCI_MODEL_SMOKE_URL` and `ROCI_CYBERNETICS_CONTAINER` env vars, tested in Steps 1 and 4).

**Failure mode:** If unit tests fail, fix before proceeding. Smoke tests are not run by default to avoid requiring GPU + Docker at test-time.

## Step 3: Start a Domain Container

The cybernetics tier (worker delegation) runs `claude -p` inside a Docker container. The `start` command builds the domain image and starts the container automatically — there is no manual `docker build` step.

When you run `start` (Step 5), the orchestrator:
1. Builds the domain image (e.g., `spacemolt-player` or `github-agent`) from the domain's `docker/Dockerfile`.
2. Creates and starts a container named `roci-<domain>` (e.g., `roci-spacemolt` or `roci-github`).

To get the container ID for the cybernetics smoke test (Step 4), start the session first (Step 5), then:

```bash
# List running roci containers
docker ps --filter label=roci-crew

# Or get the ID for a specific domain container
docker ps -q --filter name=roci-spacemolt
```

**Verify the container is running:**
```bash
docker ps | grep roci-spacemolt
```

## Step 4: Cybernetics Delegation Smoke Test

Verify that the cybernetics layer can delegate a trivial task to the worker inside the container:

```bash
ROCI_CYBERNETICS_CONTAINER=$CONTAINER_ID \
ROCI_CYBERNETICS_PLAYER=test-pilot \
npx vitest run packages/core/src/cybernetics/delegate.smoke.test.ts
```

Where `$CONTAINER_ID` is the container ID obtained from `docker ps` (Step 3).

**Expected output:** `✓ runs a trivial task to completion` (the test runs a simple prompt inside the container and expects a status of `completed` or `timed_out`).

**Failure mode:**
- `ROCI_CYBERNETICS_CONTAINER not set`: The env var must be the container ID. Check `docker ps`.
- `claude -p` not available in the container: The container image must have the frontier Claude CLI installed. See the domain's `docker/Dockerfile` for setup.
- Worker timeout: If the test hangs for 120+ seconds and times out, the `claude -p` inside the container may be unresponsive. Check container logs: `docker logs $CONTAINER_ID`.

## Step 5: Live Character Session + Cortex Loop

Now run a live character session and observe the cortex loop ticking through the escalation ladder. The character name must be listed under its domain in `config.json`.

```bash
npx tsx apps/roci/src/main.ts start <character-name> --domain <domain> --tick-interval 15000
```

Replace `<character-name>` and `<domain>` with a real configured character. Example (using `test-pilot` from the `spacemolt` domain in `config.json`):
```bash
npx tsx apps/roci/src/main.ts start test-pilot --domain spacemolt --tick-interval 15000
```

### Expected Log Markers (Cortex OODA Loop)

As the loop ticks, watch for these log lines in order:

1. **Hindbrain triage** — fast classification of events:
   ```
   test-pilot cortex: hindbrain: escalate 5
   ```
   - `disposition`: `discard` (ignore), `wait` (defer), or `escalate` (trigger planning).
   - `emotionalWeight`: 0–10 sentiment score.

2. **Forebrain orientation** — strategic headline:
   ```
   test-pilot cortex: forebrain: test-pilot noticed the player moved north; she's preparing a trap.
   ```

3. **Conscious decision** — planned action:
   ```
   test-pilot cortex: conscious: plan 2 steps to intercept the player.
   ```

4. **Cybernetics delegation** — worker task:
   ```
   test-pilot orchestrator: delegating: Move to grid[5][7] and wait.
   ```
   - Each step in the plan is delegated to the worker in the container.
   - The worker (`claude -p`) runs real domain-specific actions (game moves, git commands, etc.).

5. **Evaluation & escalation ladder**:
   - If a step completes, the loop evaluates and moves to the next step.
   - If events accumulate, hindbrain escalates and the loop re-orients (back to step 2).
   - If a critical interrupt fires, the loop returns `_tag: "Interrupted"` with the alert; the phase machine decides the next phase (typically looping back to active).

### Healthy Run Indicators

- ✅ Loop ticks at regular intervals (every 15 seconds in the example).
- ✅ Hindbrain log appears when events queue up.
- ✅ Forebrain + conscious logs appear when escalating.
- ✅ Delegation logs show tasks being dispatched.
- ✅ No `ModelError` on unreachable local models (if one appears, check Steps 1–2).
- ✅ Worker logs appear in container: `docker logs $CONTAINER_ID | grep -i "claude\|task\|completed"`.

### Failure Modes

| Failure | Symptom | Fix |
|---------|---------|-----|
| **Local model unreachable** | `ModelError: connection refused http://127.0.0.1:8081/v1` | Check model server (Step 1). Cortex exits on model failure. |
| **No loop tick** | No log output. | Verify character config exists in `config.json`. Check character directory `players/<name>/` has required files. |
| **Hindbrain hangs** | Logs stop after first tick. | Model at port 8081 is slow or stuck. Check `lsof -i :8081`. Increase `--tick-interval` to wait longer. |
| **Delegation fails** | Log shows `delegating:` but no worker output. | Container not running (Step 3). Check `docker ps`. Verify container has `/work` mounted. |
| **Worker timeout** | Delegation logs show task but worker never completes. | Set `workerTimeoutMs` higher (default 1 hour) or simplify task. |
| **Critical interrupt fires** | Loop returns `Interrupted` abruptly. | Inspect logs for alert message. This is correct behavior — the amygdala detected a threat. The phase machine will decide the next transition. |

## Step 5b: Frontier Delegation Tool (live)

During a live character session (Step 5), the conscious OpenCode mind can reach
for the in-container `frontier` CLI when a sub-task exceeds its local reach.
The container id and player name are assigned by the orchestrator and threaded
as parameters — there is **no** env var to set (unlike the Step 4 delegate
smoke); the tool is provisioned automatically by `ConsciousThought.provision`
before each tick, idempotently writing `/usr/local/bin/frontier` into the
container.

**Laundering invariant:** the conscious mind authors every task text and steer
directive — no raw inbound event text reaches the worker. All `$1`/`$2` args to
the script are model-generated strings, never spliced from the event queue.

### To verify

1. Run a live session against a domain container (same command as Step 5):
   ```bash
   npx tsx apps/roci/src/main.ts start test-pilot --domain spacemolt --tick-interval 15000
   ```
2. In another terminal, confirm the CLI was provisioned into the container:
   ```bash
   docker exec $(docker ps -q -f name=roci-spacemolt) bash -lc 'test -x /usr/local/bin/frontier && echo OK'
   ```
   → expect `OK`.
3. Watch the session logs for the conscious mind invoking the tool — a Bash
   tool call to `frontier start "<task>"`, followed by one or more
   `frontier poll`/`steer`/`wait` calls on the returned handle id.
4. Confirm each `poll`/`wait` prints a trailing `status:` line
   (`running` | `done` | `timed_out` | `failed`) and that the final `wait`
   output is folded back into the conscious mind's reasoning.

### Healthy indicators

- ✅ `frontier` is on PATH in the container (`test -x /usr/local/bin/frontier` → `OK`).
- ✅ `start` returns a non-empty handle id (a `<epoch_ns>-<random>` string).
- ✅ `poll` or `wait` prints partial or full worker assistant text before the `status:` line.
- ✅ Conscious session continues after `wait` with the worker's result in context.

### Failure modes

| Failure | Symptom | Fix |
|---------|---------|-----|
| **`frontier: command not found`** | Tool call fails immediately with path error. | `ConsciousThought.provision` did not run. Check that `provisionFrontierCli` is called inside `provisionImpl` before the session tick. |
| **`status: failed` immediately on `start`** | Handle is returned but `poll` shows `status: failed` at once. | Worker auth/spawn failure. Verify `CLAUDE_CODE_OAUTH_TOKEN` is present in the container exec env (`process-runner.ts` `buildExecArgs`). |
| **`poll`/`wait` returns `status:` but no worker text** | The status line is present but no assistant output precedes it. | The streamed-output extractor in `frontier-cli.ts` reads top-level `text` and `message.text` JSON fields (lines ~107–115 of the generated script). The real `claude --output-format stream-json` assistant frame nests text under `message.content[].text`. If the body is empty, adjust the Python extractor to also walk `(o.get("message",{}) or {}).get("content",[])` and concatenate `item["text"]` for each `item` where `item.get("type")=="text"`. Validate the fix by capturing a raw `stream-json` sample from inside the container: `docker exec <id> bash -lc 'echo '\''{"v":1,"type":"task","text":"say hi"}'\'' \| claude -p --input-format stream-json --output-format stream-json --permission-mode bypassPermissions --model sonnet 2>/dev/null \| head -20'` — inspect the shape of the assistant event before patching the path. |
| **Steer is dropped (no effect)** | `steer` returns `status: running` but the directive never reaches the worker. | The fifo-write is bounded by a 2-second timeout heuristic (`timeout 2 bash -c 'cat > "$1"'`). A steer arriving while the worker is mid-read on the same fifo may race and be dropped. This is a best-effort semantic; retrying `steer` is safe. |
| **Worker timeout** | `wait` returns `status: timed_out`. | Worker ran past the budget. Increase `frontierTimeoutMs` in the character's domain config, or simplify the delegated task. |

## Step 6: Critical Interrupt Lifecycle

Verify that interrupts trigger correctly and the phase machine transitions appropriately:

1. **Trigger a critical event** during a live session (domain-specific). Example in spacemolt: a player moves into the character's zone.
2. **Observe the log**:
   ```
   test-pilot cortex: Critical: Player entered kill zone.
   ```
   - The loop returns `_tag: "Interrupted"` with `criticals: [{ message: "Player entered kill zone." }]`.
3. **Watch the phase machine** — the orchestrator's phase runner receives the `Interrupted` result and determines the next phase transition (e.g., looping back to active or shutting down, depending on the domain's phase registry).
4. **Verify re-entry**: Hindbrain + forebrain logs appear on the next tick, confirming the loop transitioned back to `active`.

This validates the amygdala interrupt mechanism and the cortex's ability to break ongoing plans when a critical event occurs.

## Phase 2: SDK Frontier-Worker Runner

Phase 2 adds a frontier-worker runner (`sdk-runner.mjs`) inside the domain container that drives the `@anthropic-ai/claude-agent-sdk` directly over an NDJSON wire protocol. It sits alongside the existing `claude -p` process-isolation path, which is deliberately retained (dormant) rather than removed. In Phase 2 the runner is exercised run-to-completion only; the persistent/streaming steering it is built for arrives in Phase 3. This section documents the wire protocol, the auth finding from Task 1, and the run-to-completion smoke command from Task 7.

### Wire Protocol (NDJSON, `v:1`)

All messages on both directions are newline-delimited JSON objects with a `"v":1` version field. The runner reads stdin and writes stdout; stderr is silent on healthy runs.

**Host → Runner**

| Field | Value | Meaning |
|-------|-------|---------|
| `{"v":1,"type":"task","text":"<prompt>"}` | one user turn | Unit of work; becomes the prompt fed to `query()`. |
| `{"v":1,"type":"steer","text":"<prompt>"}` | one user turn | Structurally identical to `task`; reserved for Phase 3 steering (parsed but never sent in Phase 2). |
| `{"v":1,"type":"end"}` | — | Closes the input stream; the runner's async generator returns, which terminates the `query()` loop. |

**Runner → Host**

| Field | Value | Meaning |
|-------|-------|---------|
| `{"v":1,"type":"event","event":<SDKMessage>}` | one per stream message | Wraps each raw SDK message (`system`/`init`, `rate_limit_event`, `assistant`, etc.). |
| `{"v":1,"type":"result","status":"completed"\|"failed"\|"timed_out","output":"<text>"}` | terminal line | Single line that ends the turn; `status` reflects the SDK `ResultMessage` outcome. |

**Run-to-completion pattern:** send one `task` then immediately send `end`. `task` and `steer` are structurally identical — each becomes one user turn — but in Phase 2 the host never sends `steer`.

**Runner environment variables** (no CLI flags are accepted):

| Variable | Default | Description |
|----------|---------|-------------|
| `ROCI_SDK_MODEL` | — | Passed verbatim to the SDK; model aliases (`sonnet`, `opus`, `haiku`) are accepted as-is. |
| `ROCI_SDK_SYSTEM_PROMPT` | — | System prompt injected into the session. |
| `ROCI_SDK_MAX_TURNS` | `40` | Maximum turns per `query()` call before the runner stops. |

The runner lives in the image at `/home/node/sdk-runner/sdk-runner.mjs`.

### Task 1 Auth Finding

The Agent SDK (`@anthropic-ai/claude-agent-sdk`, pinned to **0.3.183** in the image) authenticates from the **`CLAUDE_CODE_OAUTH_TOKEN`** environment variable. No `ANTHROPIC_API_KEY` is needed. The SDK's `system`/`init` event reports `apiKeySource: "none"`, confirming it is using the OAuth token rather than an API key.

Model aliases work verbatim: `sonnet`, `opus`, and `haiku` are accepted without any alias-to-model-id mapping, so `ROCI_SDK_MODEL` carries `config.model` unchanged.

Observed stream order for a healthy single-turn run: `system`/`init` → `rate_limit_event` → `assistant` → `result`, with zero stderr.

### Run-to-Completion Container Smoke

Build the test image (spacemolt domain shown; the GitHub domain image is built analogously from its own Dockerfile):

```bash
docker build -t roci-spacemolt-sdktest \
  -f packages/domain-spacemolt/src/docker/Dockerfile \
  packages/domain-spacemolt/src/docker
```

Read the OAuth token from `auth-token` and run a trivial task end-to-end:

```bash
TOKEN="$(cat auth-token)"
printf '%s\n%s\n' '{"v":1,"type":"task","text":"Reply with exactly: OK"}' '{"v":1,"type":"end"}' \
| docker run --rm -i \
    -e CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" \
    -e ROCI_SDK_MODEL=sonnet \
    -e ROCI_SDK_SYSTEM_PROMPT="You are a terse assistant." \
    -e ROCI_SDK_MAX_TURNS=1 \
    roci-spacemolt-sdktest node /home/node/sdk-runner/sdk-runner.mjs
```

**Expected output:** one or more `{"v":1,"type":"event",…}` lines (SDK stream messages), followed by the single terminal line:

```json
{"v":1,"type":"result","status":"completed","output":"OK"}
```

This smoke uses a plain `docker run` (firewall init bypassed) so the container has normal egress to the Anthropic API. The token is read from the `auth-token` file, not `.oauth-token` — never embed a literal token.

**Failure modes:**
- `status: "failed"` or no output: verify `CLAUDE_CODE_OAUTH_TOKEN` is valid and the image was built successfully.
- `Cannot find module '/home/node/sdk-runner/sdk-runner.mjs'`: the image is stale or missing the SDK runner layer — rebuild.
- No `result` line: `ROCI_SDK_MAX_TURNS=1` was not respected, or the runner exited before the generator returned `end` — check that both `task` and `end` lines were sent.

### Phase Scope Note (Phase 3–4 Deferred)

The **steering channel (Phase 3)** and the **cortex loop rework (Phase 4)** are not yet wired. In Phase 2, the `steer` command is parsed by the runner but is never sent by the host — all turns are run-to-completion only (`task` then `end`). The frontier SDK worker is invoked via `runSdkTurn` (host side) for escalation; everyday character work continues to run on the conscious-tier OpenCode agent.

### Steering Channel (Phase 3)

Phase 3 activates the host-side steering path that Phase 2 left dormant: the `steer` wire message is now actually sent. The wire protocol itself is unchanged — `task` and `steer` remain structurally identical (versioned NDJSON, `v:1`; each becomes one user turn), and the runner treats them identically. What changed is host behavior: the host now builds a live stdin stream that interleaves `steer` lines between turns rather than sending a bare `task`/`end` pair.

#### Steering Queue

`makeSteeringQueue()` (in `packages/core/src/cybernetics/steering.ts`) returns a `Queue.sliding(1)` — a coalescing queue with capacity 1. A newer directive supersedes any un-consumed older one before it is delivered. `task` and `end` are control messages emitted directly by the stdin stream; they are never offered onto the queue and are therefore exempt from coalescing.

The `Directive` type is `{ text: string }`. Directives must be model-generated (laundered text) — raw inbound user text is never placed on the queue directly.

#### Dynamic Stdin Stream

`buildSteeredStdinStream(task, queue)` (in `cybernetics/steering.ts`) produces the dynamic stdin for a steerable session:

1. Send the initial `task` line.
2. For each directive offered to the queue, send one `steer` line.
3. When the queue is shut down, send `end` — which closes the input stream and causes the runner's async generator to return, ending the session.

`runSdkSession(config, stdin)` (in `packages/core/src/core/limbic/hypothalamus/process-runner.ts`) runs this stream through the shared transport, unchanged from Phase 2.

#### Routing in `delegate`

`delegate(config, steering)` (in `cybernetics/delegate.ts`) routes to the steerable SDK session when a `Queue.Queue<Directive>` is passed as `steering`. Run-to-completion is the degenerate case: if no queue is provided, or if the queue is shut down before any directive is offered, the session receives only `task` then `end` — identical to Phase 2 behavior.

#### Steering is Soft Queue-and-Finish

Steering never preempts a turn in progress. A directive offered to the queue becomes the next user turn only after the current turn completes. The queue coalesces redundant directives so that a slow turn consuming many offered directives still receives only the most recent one.

#### Host-Side Unit Tests (No Container Required)

The steering layer can be fully exercised without Docker:

```bash
pnpm exec vitest run \
  packages/core/src/cybernetics/steering.test.ts \
  packages/core/src/cybernetics/delegate.test.ts \
  packages/core/src/core/limbic/hypothalamus/process-runner.test.ts
```

#### Phase 4 Scope (Not Yet Built)

`DEFAULT_STEER_CADENCE_TICKS` (in `cortex/loop.ts`) is defined now but is consumed only in Phase 4. The following are deferred to Phase 4: cadence-throttled production of directives, hindbrain/forebrain running during a session, escalation, completion-marker detection, and an end-to-end steered/real-container smoke test.

## Step 7: Conscious-Session Transport (Phase 4a)

Exercises the resumable OpenCode conscious session against the local conscious model.

**Prereqs:** a host `llama-server` (or MLX server) on the conscious port (8083), and a running roci container (see "Start a Domain Container").

```bash
# Provider config is provisioned into the container by the test; the agent file
# is written under ./players/<name>/.opencode/agent/conscious.md (read-only).
ROCI_OPENCODE_SESSION_CONTAINER=$(docker ps --filter label=roci-crew=true -q | head -1) \
ROCI_OPENCODE_SESSION_PLAYER=test-pilot \
  pnpm --filter @roci/core test opencode-session.smoke
```

**Expected:** the test opens a session (turn 1), resumes it by id (turn 2), and turn 2's output contains the turn-1 codeword — proving session continuity over re-invoke-per-turn. Without the env var the test skips.

**Notes:**
- A new session's first turn fires an extra internal "title" model call (≈2 model calls on turn 1, 1 per turn after).
- On non-Docker-Desktop Linux the container needs `--add-host=host.docker.internal:host-gateway` to reach the host model server.

## Debugging & Observability

### Per-Tier Latency

To measure response time at each tier (important for tuning `--tick-interval`):

```bash
cd ~/workspace/testbench/llms
npx ts-node src/bench.ts \
  --endpoint http://127.0.0.1:8081/v1 \
  --prompt "Your prompt here" \
  --iterations 5
```

Latency scales with model size:
- Hindbrain (small/fast model): lower latency, suitable for high-frequency triage.
- Forebrain (medium model): moderate latency, used for orientation.
- Conscious (large/slow model): highest latency, used for deliberate planning.

Adjust `--tick-interval` so each tier completes before the next tick.

### Container Logs

Worker output is logged to the container:

```bash
docker logs $CONTAINER_ID
docker logs -f $CONTAINER_ID  # Follow in real-time
```

Look for:
- `claude -p` startup and model initialization.
- Task input and output.
- Errors or timeouts.

### State and Log Files

Character logs and identity files are written under the project root:

```bash
# Event log (append-only JSONL)
ls -la players/<character-name>/logs/events.jsonl

# Identity files (background, values, diary)
ls -la players/<character-name>/me/
```

`players/<name>/logs/` holds `events.jsonl` (the running event log).
`players/<name>/me/` holds identity files (`background.md`, `VALUES.md`, `DIARY.md`, `SECRETS.md`).

### Full Debug Mode

Enable verbose logging:

```bash
DEBUG=roci:* npx tsx apps/roci/src/main.ts start <character> --domain <domain>
```

---

## Summary

| Step | Validates | Command |
|------|-----------|---------|
| 1 | Tier connectivity | `ROCI_MODEL_SMOKE_URL=... npx vitest run packages/core/src/model/client.smoke.test.ts` |
| 2 | Build + unit tests | `npx nx run-many -t build && npx vitest run` |
| 3 | Docker container | Started automatically by `start`; use `docker ps --filter label=roci-crew` to find it |
| 4 | Worker delegation | `ROCI_CYBERNETICS_CONTAINER=$ID npx vitest run packages/core/src/cybernetics/delegate.smoke.test.ts` |
| 5 | Live session + loop | `npx tsx apps/roci/src/main.ts start test-pilot --domain spacemolt --tick-interval 15000` |
| 6 | Interrupt lifecycle | Manually trigger critical event during Step 5 session. |

A healthy end-to-end run shows all three cortex tiers firing in sequence, delegating work to the container, and responding to interrupts. If any step fails, inspect the error and failure mode table above.
