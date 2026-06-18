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
