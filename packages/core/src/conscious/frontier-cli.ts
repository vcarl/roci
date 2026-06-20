import { runtimeBaseArgs, type AnyModel } from "../core/limbic/hypothalamus/runtime.js"
import { endLine } from "../core/limbic/hypothalamus/sdk-payload.js"

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
  // The task/steer text is substituted at RUN time from $1/$2 via a tiny json escaper,
  // keeping framing identical to the sdk-payload.ts builders (single source of truth).
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

cmd="\${1:-}"; shift || true
case "$cmd" in
  start)
    task="\${1:-}"
    id="$(date +%s%N)-$RANDOM"
    d="$(dir_for "$id")"
    mkdir -p "$d"
    mkfifo "$d/in.fifo"
    : > "$d/out"
    # Detached worker: reads NDJSON from the fifo, tees streamed assistant text to out.
    # setsid + redirect so it survives this docker-exec process (cross-turn reattach).
    setsid bash -c '
      d="'"$d"'"
      ( timeout "$(( '"$BUDGET_MS"' / 1000 ))" claude ${flags} < "$d/in.fifo" > "$d/raw" 2>&1; echo $? > "$d/rc" ) &
      worker=$!
      # extract assistant text lines into out as they stream (best-effort tee)
      tail -F "$d/raw" 2>/dev/null | while IFS= read -r line; do
        printf "%s\\n" "$line" | python3 -c "import json,sys;
try:
  o=json.loads(sys.stdin.read())
  t=o.get(\\"text\\") or (o.get(\\"message\\",{}) or {}).get(\\"text\\")
  import sys as s
  print(t) if t else None
except Exception: pass" >> "$d/out" 2>/dev/null || true
      done &
      # keep the fifo open for writers (steer/wait); the writer fd holder:
      exec 9> "$d/in.fifo"
      printf "%s" "$(task_line "'"$task"'")" >&9 2>/dev/null || true
      wait "$worker"
    ' >/dev/null 2>&1 &
    # record the fifo write fd path via a side helper file for steer/wait
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
    steer_line "$directive" > "$d/in.fifo"
    echo "status: running"
    ;;
  wait)
    id="\${1:-}"; d="$(dir_for "$id")"
    if [ ! -d "$d" ]; then echo "status: failed"; exit 0; fi
    end_line() { printf '${END}\\n'; }
    [ -p "$d/in.fifo" ] && end_line > "$d/in.fifo" || true
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
