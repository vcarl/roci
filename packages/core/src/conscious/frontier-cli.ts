import { Effect } from "effect"
import { runtimeBaseArgs, type AnyModel } from "../core/limbic/hypothalamus/runtime.js"
import { endLine } from "../core/limbic/hypothalamus/sdk-payload.js"
import { Docker } from "../services/Docker.js"

/** Where the generated CLI is installed inside the container (on PATH). */
export const FRONTIER_CLI_PATH = "/usr/local/bin/frontier"
/** Per-handle run dirs are `${FRONTIER_RUN_DIR}-<id>`; shared container fs so a later turn reattaches. */
export const FRONTIER_RUN_DIR = "/tmp/frontier"

/**
 * The `claude` worker invocation flags. Reuses runtimeBaseArgs (the single
 * source of truth for `-p --permission-mode bypassPermissions --model <m>`),
 * then adds streaming-input mode so the worker reads NDJSON (taskLine/steerLine/
 * endLine) from the fifo. NEVER passes --bare.
 */
export function buildFrontierWorkerFlags(model: AnyModel): string {
  const base = runtimeBaseArgs("claude", model) // -p --permission-mode bypassPermissions --model <m>
  return [
    ...base,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ].join(" ")
}

/**
 * Generate the `frontier` bash CLI: handle-based, async, steerable.
 *
 *   id=$(frontier start "<task>")   launch detached worker, print handle id
 *   frontier poll  "$id"            print accumulated out + a `status:` line
 *   frontier steer "$id" "<nudge>"  append a steer line to the fifo
 *   frontier wait  "$id"            append end, block, print final out + `status:`
 *
 * State for handle <id> lives in ${FRONTIER_RUN_DIR}-<id>/ on the shared
 * container fs, so a later conscious turn (a different docker-exec process)
 * reattaches by id. The worker is detached (setsid) and file-backed.
 *
 * Laundering (Vector-A): $1/$2 args are model-authored tool arguments (the
 * task and steer directives), never raw inbound event text.
 *
 * Live fifo behavior is verified via the orchestrator runbook (docs/cortex-smoke.md),
 * not unit tests — the unit tests assert the script string shape only.
 */
export function buildFrontierCliScript(opts: { model: AnyModel; timeoutMs: number }): string {
  const flags = buildFrontierWorkerFlags(opts.model)
  const budgetMs = String(opts.timeoutMs)
  // endLine() is reused at GENERATE time for the static `end` frame embedded in the script.
  // The task/steer text is json-escaped at RUN time from $1/$2 by the outer shell's
  // json_str (where the text is a safe "$arg"), keeping framing identical to the
  // sdk-payload.ts builders (single source of truth). The detached worker never sees
  // raw task text spliced into its source — it reads the pre-built NDJSON from a file.
  const END = endLine() // {"v":1,"type":"end"}
  // NOTE: keep the embedded shapes in lockstep with sdk-payload.ts builders.
  return `#!/usr/bin/env bash
set -euo pipefail

RUN_ROOT_PREFIX="${FRONTIER_RUN_DIR}"
BUDGET_MS=${budgetMs}

# json-escape a single argument's text into a NDJSON string value
json_str() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}
task_line()  { printf '{"v":1,"type":"task","text":%s}\\n' "$(json_str "$1")"; }
steer_line() { printf '{"v":1,"type":"steer","text":%s}\\n' "$(json_str "$1")"; }
end_line()   { printf '${END}\\n'; }

dir_for() { printf '%s-%s' "$RUN_ROOT_PREFIX" "$1"; }

# Write to the fifo without hanging if no reader (the claude worker) is alive.
# A fifo open-for-write blocks until a reader opens the other end; once the
# worker exits, that never happens, so a naive open-for-write would hang the caller
# forever. Bound it with a short timeout and swallow failure.
fifo_write() {
  # $1 = fifo path; stdin = bytes to write
  timeout 2 bash -c 'cat > "$1"' _ "$1" 2>/dev/null || true
}

cmd="\${1:-}"; shift || true
case "$cmd" in
  start)
    task="\${1:-}"
    id="$(date +%s%N)-$RANDOM"
    d="$(dir_for "$id")"
    mkdir -p "$d"
    mkfifo "$d/in.fifo"
    : > "$d/out"
    # Pre-build the task NDJSON line in THIS shell, where "$task" is a safe arg
    # and task_line/json_str are defined. The detached child below runs under a
    # fresh \`bash -c\` and does NOT inherit these shell functions, and we never
    # splice task text into its source (an apostrophe would break the quoting),
    # so we hand the child a finished file + env vars only.
    task_line "$task" > "$d/task.ndjson"
    # Detached worker: reads NDJSON from the fifo, tees streamed assistant text to out.
    # setsid + redirect so it survives this docker-exec process (cross-turn reattach).
    # \$d and the budget cross the boundary via the ENVIRONMENT (no quote-splicing).
    FRONTIER_D="$d" FRONTIER_BUDGET_S="$(( BUDGET_MS / 1000 ))" setsid bash -c '
      d="$FRONTIER_D"
      ( timeout "$FRONTIER_BUDGET_S" claude ${flags} < "$d/in.fifo" > "$d/raw" 2>&1; echo $? > "$d/rc" ) &
      worker=$!
      # extract assistant text into out as it streams: ONE long-lived python
      # reader over tail -F, parsing each line and flushing so out accumulates
      # incrementally (best-effort; parse errors are ignored).
      tail -F "$d/raw" 2>/dev/null | python3 -u -c "import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try:
        o=json.loads(line)
        t=o.get(\\"text\\") or (o.get(\\"message\\",{}) or {}).get(\\"text\\")
        if t: print(t, flush=True)
    except Exception: pass" >> "$d/out" 2>/dev/null &
      # keep the fifo open for writers (steer/wait); the writer fd holder:
      exec 9> "$d/in.fifo"
      cat "$d/task.ndjson" >&9 2>/dev/null || true
      wait "$worker"
    ' >/dev/null 2>&1 &
    printf '%s' "$id"
    ;;
  poll)
    id="\${1:-}"; d="$(dir_for "$id")"
    if [ ! -d "$d" ]; then echo "status: failed"; exit 0; fi
    cat "$d/out" 2>/dev/null || true
    if [ -f "$d/rc" ]; then
      rc="$(cat "$d/rc")"
      if [ "$rc" = "0" ]; then echo "status: done"; else echo "status: failed"; fi
    else
      echo "status: running"
    fi
    ;;
  steer)
    id="\${1:-}"; directive="\${2:-}"; d="$(dir_for "$id")"
    if [ ! -p "$d/in.fifo" ]; then echo "status: failed"; exit 0; fi
    steer_line "$directive" | fifo_write "$d/in.fifo"
    echo "status: running"
    ;;
  wait)
    id="\${1:-}"; d="$(dir_for "$id")"
    if [ ! -d "$d" ]; then echo "status: failed"; exit 0; fi
    [ -p "$d/in.fifo" ] && end_line | fifo_write "$d/in.fifo" || true
    # block until the worker records a return code, bounded by the budget
    deadline=$(( $(date +%s) + BUDGET_MS / 1000 + 5 ))
    while [ ! -f "$d/rc" ]; do
      [ "$(date +%s)" -ge "$deadline" ] && break
      sleep 1
    done
    cat "$d/out" 2>/dev/null || true
    if [ -f "$d/rc" ]; then
      rc="$(cat "$d/rc")"
      if [ "$rc" = "124" ]; then echo "status: timed_out";
      elif [ "$rc" = "0" ]; then echo "status: done";
      else echo "status: failed"; fi
    else
      echo "status: timed_out"
    fi
    ;;
  *)
    echo "usage: frontier start|poll|steer|wait" >&2
    exit 2
    ;;
esac
`
}

/**
 * Write the generated `frontier` CLI into the container and make it executable.
 * Base64-pipes the script to sidestep shell quoting (mirrors
 * provisionConsciousProvider). Idempotent — safe to run before each loop.
 * Error channel is `never`: a Docker failure is swallowed (a later `frontier`
 * call surfaces it as a tool failure the conscious mind reads, per spec §8).
 */
export function provisionFrontierCli(
  containerId: string,
  opts: { model: AnyModel; timeoutMs: number },
): Effect.Effect<void, never, Docker> {
  const script = buildFrontierCliScript(opts)
  const b64 = Buffer.from(script).toString("base64")
  const sh = `echo ${b64} | base64 -d > ${FRONTIER_CLI_PATH} && chmod 0755 ${FRONTIER_CLI_PATH}`
  return Effect.gen(function* () {
    const docker = yield* Docker
    yield* docker.exec(containerId, ["bash", "-lc", sh])
  }).pipe(Effect.catchAll(() => Effect.void))
}
