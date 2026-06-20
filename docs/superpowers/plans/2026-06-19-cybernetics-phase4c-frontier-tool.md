# Cybernetics Phase 4c — Frontier Delegation Bash Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan. Each task ends with an independently testable deliverable and an exact commit. Do not skip the failing-test step. Build all four projects for any task touching app wiring or the conscious requirement channel.

**Goal:** Expose frontier (Claude Code) delegation as an in-container, handle-based, steerable `frontier` bash CLI that the conscious OpenCode mind invokes inline like any other tool, and close the latent Phase-4b runtime gap by wiring `ConsciousThoughtLive` into the live service layer.

**Architecture:** A host TypeScript function generates the `frontier` bash-CLI script string (reusing the existing `claude`-flag construction from `payload.ts`/`runtime.ts` and the NDJSON wire builders `taskLine`/`steerLine`/`endLine` from `sdk-payload.ts`), unit-tested as a string exactly like `buildProviderConfigJson`. A provisioning step writes that script into the container (base64 → `bash -lc` → file → `chmod 0o755`), mirroring `provisionConsciousProvider`, and is invoked from `ConsciousThought.provision` alongside the existing conscious provisioning. The conscious agent learns the tool via an appended section in `buildCharacterAgentMarkdown`. No orchestrator routing is added — the escalation lives entirely inside a conscious turn, and the dormant host-side `cybernetics/` machinery is left untouched.

**Tech Stack:** TypeScript (ES modules, `.js` import specifiers), Effect 3.19 (`Effect`/`Layer`/`Context.Tag`), `@effect/platform` `Docker` service, vitest 3.2, nx 22 monorepo (pnpm). Bash (CLI script) targeting the container image with `claude` on PATH, `mkfifo`, `setsid`/`nohup`, `base64`.

## Global Constraints

- Commit trailer EXACTLY: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Build command (ALL FOUR projects: core + domain-github + domain-spacemolt + apps/roci): `npx nx run-many -t build`
- Single unit-test file: `npx vitest run packages/core/src/<path>.test.ts`
- All unit tests: `npx vitest run`
- NEVER pass `--bare` with `claude -p`. Worker flags use `-p --permission-mode bypassPermissions --model <model>` (exactly as `runtimeBaseArgs(runtime: "claude", model)` produces).
- Laundering (Vector-A): the `start` task and every `steer` directive are model-generated tool arguments authored by the conscious LLM — never raw inbound event text. This is structural (no runtime check); the plan must not pass raw world text to the worker.
- No MCP. The capability is a bash CLI / subprocess only — no OpenCode tool/mcp schema changes, no `opencode.jsonc` edits.
- Build ALL FOUR projects for any task touching app wiring or the conscious requirement channel (Task 1, Task 5) — a core-only build misses the `ConsciousThoughtLive` requirement gap surfaced only when `apps/roci` is type-checked.
- Do NOT modify or delete the dormant `cybernetics/{delegate,steering,result,types}.ts` machinery this phase (spec §7). Reuse only the wire/payload helpers, never the host `delegate` Effect. `CyberneticsLive` stays composed.
- Do NOT remove the `.claude/worktrees/agent-sdk` worktree. Run all commands in `/Users/vcarl/workspace/roci/.claude/worktrees/agent-sdk`.
- Docs-only commits may use `--no-verify`. Code commits run the normal hooks.
- Surface decisions (spec §10): include `frontier run` blocking alias = NO (surface stays `start/poll/steer/wait`). `poll`/`wait` status = a final `status: <running|done|failed|timed_out>` line on stdout after the output. Timeout knob = reuse the existing per-worker `workerTimeoutMs` budget baked into `start` (no new knob this phase).

---

### Task 1: Wire `ConsciousThoughtLive` into the live runtime

Closes the latent Phase-4b gap: `runCortex` does `yield* ConsciousThought` (loop.ts:82) but the layer was never exported or provided, so the live app cannot satisfy the requirement. `CyberneticsLive` (cli.ts:631) and `DockerLive` (cli.ts:625) are already present — leave both.

**Files:**
- Modify: `packages/core/src/index.ts:83-89` (Cortex export block) — add a `ConsciousThought` export block.
- Modify: `apps/roci/src/cli.ts:13` (import) and `apps/roci/src/cli.ts:624-632` (`serviceLayer`) — add `ConsciousThoughtLive`.
- Test: `packages/core/src/conscious/conscious-thought.test.ts` (exists) — add an export-presence assertion; the real proof is the all-projects build.

**Interfaces:**
- Consumes: `ConsciousThought` (Context.Tag), `ConsciousThoughtLive` (`Layer.Layer<ConsciousThought>`) from `packages/core/src/conscious/conscious-thought.ts` (both already defined there).
- Produces: `index.ts` re-exports `{ ConsciousThought, ConsciousThoughtLive, ConsciousThoughtTest }` and `type { ConsciousTurnConfig, ProvisionOpts }`; `serviceLayer` gains `ConsciousThoughtLive`.

**Steps:**

- [ ] Write a failing test asserting the new exports exist. Append to `packages/core/src/conscious/conscious-thought.test.ts`:
  ```ts
  import * as core from "../index.js"
  describe("index re-exports ConsciousThought", () => {
    it("exports ConsciousThought tag and ConsciousThoughtLive layer", () => {
      expect(core.ConsciousThought).toBeDefined()
      expect(core.ConsciousThoughtLive).toBeDefined()
    })
  })
  ```
  (Ensure `import { describe, it, expect } from "vitest"` is present at the top — it already is.)
- [ ] Run it expecting FAIL: `npx vitest run packages/core/src/conscious/conscious-thought.test.ts` — expect `AssertionError: expected undefined to be defined` (or `core.ConsciousThought` is `undefined`).
- [ ] Add the export block to `packages/core/src/index.ts` immediately after the Cortex block (after line 89):
  ```ts
  // Conscious tier — local-model OpenCode executor session
  export { ConsciousThought, ConsciousThoughtLive, ConsciousThoughtTest } from "./conscious/conscious-thought.js"
  export type { ConsciousTurnConfig, ProvisionOpts } from "./conscious/conscious-thought.js"
  ```
- [ ] Run it expecting PASS: `npx vitest run packages/core/src/conscious/conscious-thought.test.ts`.
- [ ] Add `ConsciousThoughtLive` to the import on `apps/roci/src/cli.ts:13`:
  ```ts
  import { ModelClientLive, CyberneticsLive, ConsciousThoughtLive } from "@roci/core"
  ```
- [ ] Add `ConsciousThoughtLive` to `serviceLayer` (`apps/roci/src/cli.ts:624-632`), after `CyberneticsLive`:
  ```ts
  const serviceLayer = Layer.mergeAll(
    DockerLive,
    oauthTokenLayer,
    CharacterFsLive,
    projectRootLayer,
    characterLogLayer,
    ModelClientLive,
    CyberneticsLive,
    ConsciousThoughtLive,
  )
  ```
- [ ] Build all four projects expecting PASS: `npx nx run-many -t build` — this is the real proof the requirement gap is closed (core-only build would not have caught it).
- [ ] Commit:
  ```
  git add packages/core/src/index.ts packages/core/src/conscious/conscious-thought.test.ts apps/roci/src/cli.ts
  git commit -m "feat(cortex): wire ConsciousThoughtLive into live serviceLayer (Phase 4c.1)

Export ConsciousThought/ConsciousThoughtLive from core and add the layer
to apps/roci serviceLayer, closing the latent Phase-4b requirement gap.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

**Deliverable:** All four projects build with the conscious tier's requirement satisfied by the live layer.

---

### Task 2: Generate the `frontier` CLI script string (host code, unit-tested)

Add a host function `buildFrontierCliScript` that emits the bash-CLI text, reusing the `claude` worker flags and the NDJSON wire builders so framing/flags have a single source of truth. The script is unit-tested as a string (the fifo/detached behavior is exercised only by the gated smoke in Task 4 — do NOT attempt to TDD live fifo behavior with unit tests).

**Files:**
- Create: `packages/core/src/conscious/frontier-cli.ts`
- Test: `packages/core/src/conscious/frontier-cli.test.ts`

**Interfaces:**
- Consumes:
  - `taskLine(text: string): string`, `steerLine(text: string): string`, `endLine(): string` from `../core/limbic/hypothalamus/sdk-payload.js` (each returns one NDJSON line, no trailing newline).
  - `runtimeBaseArgs(runtime: "claude", model: AnyModel): string[]` from `../core/limbic/hypothalamus/runtime.js` → returns `["-p", "--permission-mode", "bypassPermissions", "--model", model]`.
  - `type AnyModel` from `../core/limbic/hypothalamus/runtime.js`.
- Produces:
  - `FRONTIER_CLI_PATH = "/usr/local/bin/frontier"` (const string).
  - `FRONTIER_RUN_DIR = "/tmp/frontier"` (const string; per-handle dir is `${FRONTIER_RUN_DIR}-<id>`).
  - `buildFrontierWorkerFlags(model: AnyModel): string` — the `claude` flag string the worker runs with: streaming-input JSON mode reusing `runtimeBaseArgs`. Returns e.g. `-p --permission-mode bypassPermissions --model sonnet --input-format stream-json --output-format stream-json --verbose`.
  - `buildFrontierCliScript(opts: { model: AnyModel; timeoutMs: number }): string` — the full bash script implementing `start|poll|steer|wait`.

**Steps:**

- [ ] Write a failing test file `packages/core/src/conscious/frontier-cli.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest"
  import {
    buildFrontierWorkerFlags,
    buildFrontierCliScript,
    FRONTIER_CLI_PATH,
    FRONTIER_RUN_DIR,
  } from "./frontier-cli.js"
  import { taskLine, steerLine, endLine } from "../core/limbic/hypothalamus/sdk-payload.js"

  describe("buildFrontierWorkerFlags", () => {
    const flags = buildFrontierWorkerFlags("sonnet")
    it("reuses the claude base flags (no --bare)", () => {
      expect(flags).toContain("-p")
      expect(flags).toContain("--permission-mode bypassPermissions")
      expect(flags).toContain("--model sonnet")
      expect(flags).not.toContain("--bare")
    })
    it("runs in streaming-input + streaming-output json mode", () => {
      expect(flags).toContain("--input-format stream-json")
      expect(flags).toContain("--output-format stream-json")
      expect(flags).toContain("--verbose")
    })
  })

  describe("buildFrontierCliScript", () => {
    const script = buildFrontierCliScript({ model: "sonnet", timeoutMs: 600000 })
    it("dispatches the four subcommands", () => {
      expect(script).toContain('start)')
      expect(script).toContain('poll)')
      expect(script).toContain('steer)')
      expect(script).toContain('wait)')
    })
    it("backs handle state in a per-id run dir under the run root", () => {
      expect(script).toContain(FRONTIER_RUN_DIR)
      expect(script).toContain("mkfifo")
      expect(script).toContain("in.fifo")
      expect(script).toContain("out")
    })
    it("detaches the worker so a later turn can reattach", () => {
      // setsid or nohup — detached + file-backed by handle id
      expect(script).toMatch(/setsid|nohup/)
    })
    it("embeds the worker invocation flags", () => {
      expect(script).toContain(buildFrontierWorkerFlags("sonnet"))
    })
    it("frames start as a task line and wait as an end line via the shared builders", () => {
      // start writes taskLine(task); wait appends endLine()
      expect(script).toContain('"type":"task"')
      expect(script).toContain('"type":"steer"')
      expect(script).toContain('"type":"end"')
      // shared builder shapes (laundering note: $1/$2 are model-authored args, never raw events)
      expect(endLine()).toBe('{"v":1,"type":"end"}')
      expect(taskLine("X")).toContain('"type":"task"')
      expect(steerLine("X")).toContain('"type":"steer"')
    })
    it("prints a trailing status line on poll and wait", () => {
      expect(script).toMatch(/status:/)
    })
    it("bakes the wall-clock budget from timeoutMs (no new knob)", () => {
      expect(script).toContain("600000")
    })
  })
  ```
- [ ] Run it expecting FAIL: `npx vitest run packages/core/src/conscious/frontier-cli.test.ts` — expect `Cannot find module './frontier-cli.js'` / `Failed to resolve import`.
- [ ] Create `packages/core/src/conscious/frontier-cli.ts` with the full implementation:
  ```ts
  import { runtimeBaseArgs, type AnyModel } from "../core/limbic/hypothalamus/runtime.js"
  import { taskLine, steerLine, endLine } from "../core/limbic/hypothalamus/sdk-payload.js"

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
   */
  export function buildFrontierCliScript(opts: { model: AnyModel; timeoutMs: number }): string {
    const flags = buildFrontierWorkerFlags(opts.model)
    const budgetMs = String(opts.timeoutMs)
    // taskLine/steerLine/endLine are reused at GENERATE time for the static `end`
    // frame and as a documented contract; the task/steer text is substituted at
    // RUN time from $1/$2 via a tiny json escaper, keeping framing identical.
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
  ```
  Note: the embedded heredoc-style `task_line`/`steer_line`/`end_line` shell functions reproduce the EXACT NDJSON shape of `taskLine`/`steerLine`/`endLine`; the test asserts the static `end` frame equals `endLine()` so drift is caught. The script is the unit under test as a string; live fifo behavior is covered by Task 4's gated smoke.
- [ ] Run it expecting PASS: `npx vitest run packages/core/src/conscious/frontier-cli.test.ts`.
- [ ] Build core to confirm types: `npx nx run build --project=@roci/core` (or `npx nx run-many -t build`).
- [ ] Commit:
  ```
  git add packages/core/src/conscious/frontier-cli.ts packages/core/src/conscious/frontier-cli.test.ts
  git commit -m "feat(conscious): generate frontier bash CLI script (Phase 4c.2)

Host buildFrontierCliScript emits a handle-based, async, steerable bash CLI
reusing runtimeBaseArgs (claude worker flags, never --bare) and the
sdk-payload NDJSON wire shapes. Unit-tested as a string; live fifo behavior
is covered by the gated smoke.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

**Deliverable:** A unit-tested host generator producing the `frontier` CLI script string with correct claude flags, NDJSON framing, and `start/poll/steer/wait` dispatch.

---

### Task 3: Provision the `frontier` CLI into the container

Add a provisioning function mirroring `provisionConsciousProvider`: base64 the script, write it to `FRONTIER_CLI_PATH`, `chmod 0o755`. Returns an Effect requiring `Docker`.

**Files:**
- Modify: `packages/core/src/conscious/frontier-cli.ts` (append `provisionFrontierCli`).
- Test: `packages/core/src/conscious/frontier-cli.test.ts` (append a `provisionFrontierCli` describe block, mirroring the `provisionConsciousProvider` stub-Docker test in `opencode-config.test.ts:54-77`).

**Interfaces:**
- Consumes: `Docker` service from `../services/Docker.js` (`docker.exec(containerId: string, command: string[]): Effect.Effect<string, DockerError>`); `buildFrontierCliScript`, `FRONTIER_CLI_PATH`.
- Produces: `provisionFrontierCli(containerId: string, opts: { model: AnyModel; timeoutMs: number }): Effect.Effect<void, never, Docker>` — base64 → `bash -lc` write → `chmod 0o755`. Error channel `never` (swallowed/idempotent, mirroring `provisionConsciousProvider`'s downstream-failure posture).

**Steps:**

- [ ] Write a failing test (append to `frontier-cli.test.ts`):
  ```ts
  import { Effect, Layer } from "effect"
  import { Docker } from "../services/Docker.js"
  import { provisionFrontierCli } from "./frontier-cli.js"

  describe("provisionFrontierCli", () => {
    it("execs a command that base64-writes the script to the CLI path and chmods it executable", async () => {
      const calls: string[][] = []
      const StubDocker = Layer.succeed(
        Docker,
        Docker.of({
          exec: (_id: string, command: string[]) => {
            calls.push(command)
            return Effect.succeed("")
          },
        } as unknown as typeof Docker.Service),
      )
      await Effect.runPromise(
        Effect.provide(provisionFrontierCli("cabc", { model: "sonnet", timeoutMs: 600000 }), StubDocker),
      )
      const joined = calls.flat().join(" ")
      expect(joined).toContain(FRONTIER_CLI_PATH)
      expect(joined).toContain("base64 -d")
      expect(joined).toContain("chmod 0755")
      const b64 = Buffer.from(buildFrontierCliScript({ model: "sonnet", timeoutMs: 600000 })).toString("base64")
      expect(joined).toContain(b64)
    })
  })
  ```
  (Add `import { Buffer } from "node:buffer"` only if your env requires it — Node globals usually suffice; mirror the existing `opencode-config.test.ts` which uses the global `Buffer`.)
- [ ] Run it expecting FAIL: `npx vitest run packages/core/src/conscious/frontier-cli.test.ts` — expect `provisionFrontierCli is not a function` / import resolution error.
- [ ] Append the implementation to `packages/core/src/conscious/frontier-cli.ts`:
  ```ts
  import { Effect } from "effect"
  import { Docker } from "../services/Docker.js"

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
  ```
  (Move the `import { Effect } from "effect"` and `import { Docker }` lines to the top of the file with the other imports; do not leave mid-file imports.)
- [ ] Run it expecting PASS: `npx vitest run packages/core/src/conscious/frontier-cli.test.ts`.
- [ ] Build core: `npx nx run-many -t build`.
- [ ] Commit:
  ```
  git add packages/core/src/conscious/frontier-cli.ts packages/core/src/conscious/frontier-cli.test.ts
  git commit -m "feat(conscious): provision frontier CLI into container (Phase 4c.3)

provisionFrontierCli base64-writes the generated script to /usr/local/bin
and chmods it 0755, mirroring provisionConsciousProvider. Error channel
never: a Docker failure surfaces downstream as a tool failure.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

**Deliverable:** A unit-tested provisioning Effect that writes the executable `frontier` CLI into the container via the standard base64→file→chmod pattern.

---

### Task 4: Invoke provisioning from `ConsciousThought.provision` + teach the agent

Hook the new provisioning into the conscious provisioning step so the CLI is written once per container alongside the provider/agent files. Extend `ProvisionOpts` with the worker model + budget needed by the generator, and extend `buildCharacterAgentMarkdown` with a concise description of the `frontier start/poll/steer/wait` workflow.

**Files:**
- Modify: `packages/core/src/conscious/opencode-config.ts:50-56` (`buildCharacterAgentMarkdown`) — append a "Frontier tool" section.
- Modify: `packages/core/src/conscious/conscious-thought.ts:29-35` (`ProvisionOpts`) — add `frontierModel`/`frontierTimeoutMs`; and `:69-88` (`provisionImpl`) — call `provisionFrontierCli`.
- Modify: `packages/core/src/cortex/loop.ts` (the `consciousThought.provision({...})` call site) — pass the new fields. (Locate via grep `provision(` in loop.ts.)
- Test: `packages/core/src/conscious/opencode-config.test.ts:45-52` (`buildCharacterAgentMarkdown`) — assert the frontier section is present.
- Test: `packages/core/src/conscious/conscious-thought.test.ts` — assert `provisionImpl` execs the frontier write (stub Docker, assert `FRONTIER_CLI_PATH` in a call).

**Interfaces:**
- Consumes: `provisionFrontierCli(containerId, { model, timeoutMs })` (Task 3); existing `writeCharacterAgentFile`, `provisionConsciousProvider`.
- Produces:
  - `buildCharacterAgentMarkdown(opts: { systemPrompt: string; modelLabel?: string })` — body now ends with a `## Frontier (heavy-lifting) tool` section (the contract text). Signature unchanged.
  - `ProvisionOpts { containerId; char; handle; systemPrompt; frontierModel: AnyModel; frontierTimeoutMs: number }`.
  - `provisionImpl` now also runs `provisionFrontierCli(opts.containerId, { model: opts.frontierModel, timeoutMs: opts.frontierTimeoutMs })`.

**Steps:**

- [ ] Write a failing test for the agent-markdown teaching (append to `opencode-config.test.ts` inside the existing `buildCharacterAgentMarkdown` describe or a new one):
  ```ts
  it("teaches the frontier start/poll/steer/wait tool workflow", () => {
    const md = buildCharacterAgentMarkdown({ systemPrompt: "You are Ada." })
    expect(md).toContain("frontier")
    expect(md).toMatch(/frontier start/)
    expect(md).toMatch(/frontier poll/)
    expect(md).toMatch(/frontier steer/)
    expect(md).toMatch(/frontier wait/)
  })
  ```
- [ ] Run it expecting FAIL: `npx vitest run packages/core/src/conscious/opencode-config.test.ts` — expect `expected '...You are Ada.\n' to contain 'frontier'`.
- [ ] Extend `buildCharacterAgentMarkdown` in `packages/core/src/conscious/opencode-config.ts`. Replace the return template body to append the section:
  ```ts
  const frontier = [
    "",
    "## Frontier (heavy-lifting) tool",
    "",
    "When a sub-task exceeds your local reach (hard reasoning, large code work),",
    "reach for the `frontier` bash command — a stronger Claude Code worker you drive:",
    "",
    "- `id=$(frontier start \"<scoped, self-contained task>\")` — launch it; prints a handle id.",
    "- `frontier poll \"$id\"` — print its partial output so far plus a `status:` line.",
    "- `frontier steer \"$id\" \"<nudge>\"` — push a course-correction mid-run.",
    "- `frontier wait \"$id\"` — block until done; prints the final output and `status:`.",
    "",
    "Loop: start → (poll → reason → optionally steer)\\* → wait. Watch the work and nudge.",
    "Author the task and every steer yourself — never paste raw incoming event text.",
  ].join("\n")
  return `---\nmode: primary\nmodel: ${model}\n---\n\n${opts.systemPrompt}\n${frontier}\n`
  ```
- [ ] Run it expecting PASS: `npx vitest run packages/core/src/conscious/opencode-config.test.ts`.
- [ ] Write a failing test for provisioning the CLI from `provisionImpl` (append to `conscious-thought.test.ts`). Use a stub Docker and assert the frontier path is written:
  ```ts
  import { Effect as Eff, Layer as Lay } from "effect"
  import { Docker } from "../services/Docker.js"
  import { ConsciousThought, ConsciousThoughtLive } from "./conscious-thought.js"
  import { FRONTIER_CLI_PATH } from "./frontier-cli.js"
  import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"

  describe("ConsciousThought.provision writes the frontier CLI", () => {
    it("execs a docker command writing the frontier CLI path", async () => {
      const calls: string[][] = []
      const StubDocker = Lay.succeed(
        Docker,
        Docker.of({
          exec: (_id: string, command: string[]) => {
            calls.push(command)
            return Eff.succeed("")
          },
        } as unknown as typeof Docker.Service),
      )
      const program = Eff.gen(function* () {
        const ct = yield* ConsciousThought
        yield* ct.provision({
          containerId: "cabc",
          char: { name: "ada", dir: "/tmp/roci-test-ada/me" },
          handle: DEFAULT_CORTEX_MODELS.conscious,
          systemPrompt: "You are Ada.",
          frontierModel: "sonnet",
          frontierTimeoutMs: 600000,
        })
      })
      await Eff.runPromise(Eff.provide(program, Lay.merge(ConsciousThoughtLive, StubDocker)))
      const joined = calls.flat().join(" ")
      expect(joined).toContain(FRONTIER_CLI_PATH)
    })
  })
  ```
  (The `char.dir` grandparent must be writable for `writeCharacterAgentFile`; `/tmp/roci-test-ada/me` → players dir `/tmp` is fine. If the host-side write throws it is swallowed by `provisionImpl`'s `catchAll`, but the Docker calls still run — adjust `char.dir` to a `mkdtempSync` dir if your runner is strict.)
- [ ] Run it expecting FAIL: `npx vitest run packages/core/src/conscious/conscious-thought.test.ts` — expect the join not to contain `FRONTIER_CLI_PATH` (provision does not yet write it), plus a TS error that `ProvisionOpts` lacks `frontierModel`.
- [ ] Extend `ProvisionOpts` in `packages/core/src/conscious/conscious-thought.ts:29-35`:
  ```ts
  export interface ProvisionOpts {
    containerId: string
    char: CharacterConfig
    handle: ModelHandle
    systemPrompt: string
    /** Model the frontier worker runs on (e.g. "sonnet"). */
    frontierModel: AnyModel
    /** Wall-clock budget baked into the frontier worker (reuses workerTimeoutMs). */
    frontierTimeoutMs: number
  }
  ```
  Add the imports near the top of the file:
  ```ts
  import type { AnyModel } from "../core/limbic/hypothalamus/runtime.js"
  import { provisionFrontierCli } from "./frontier-cli.js"
  ```
- [ ] Add the frontier provisioning to `provisionImpl` (after the existing `provisionConsciousProvider` line, ~`:83`):
  ```ts
      // Provision the global in-container provider config (requires Docker).
      yield* provisionConsciousProvider(opts.containerId, opts.handle)
      // Provision the frontier CLI (heavy-lifting delegation tool) into the container.
      yield* provisionFrontierCli(opts.containerId, {
        model: opts.frontierModel,
        timeoutMs: opts.frontierTimeoutMs,
      })
  ```
- [ ] Update the `ConsciousThoughtTest` layer's `provision` signature only if TS complains — it is `() => Effect.void as Effect.Effect<void, never, Docker>` and ignores its arg, so it already accepts the wider `ProvisionOpts`. No change expected.
- [ ] Update the loop's provision call site in `packages/core/src/cortex/loop.ts` to pass the two new fields. Find it with `grep -n "provision(" packages/core/src/cortex/loop.ts`; add `frontierModel: <the worker model>` (reuse the worker model the loop already resolves, e.g. from `config.workerModels` / `DEFAULT_CORTEX_MODELS`; if the loop does not currently resolve a frontier model, use `"sonnet"` as the default consistent with `delegate.smoke.test.ts`) and `frontierTimeoutMs: workerTimeoutMs` (the local already computed at loop.ts:88).
- [ ] Run the conscious-thought test expecting PASS: `npx vitest run packages/core/src/conscious/conscious-thought.test.ts`.
- [ ] Build all four projects expecting PASS (loop + app touch the conscious channel): `npx nx run-many -t build`.
- [ ] Run the full unit suite expecting PASS: `npx vitest run`.
- [ ] Commit:
  ```
  git add packages/core/src/conscious/opencode-config.ts packages/core/src/conscious/conscious-thought.ts packages/core/src/cortex/loop.ts packages/core/src/conscious/opencode-config.test.ts packages/core/src/conscious/conscious-thought.test.ts
  git commit -m "feat(conscious): provision frontier CLI in provision() + teach the agent (Phase 4c.4)

ConsciousThought.provision now writes the frontier CLI alongside the
provider/agent files (ProvisionOpts gains frontierModel/frontierTimeoutMs,
threaded from the loop). buildCharacterAgentMarkdown teaches the
start/poll/steer/wait workflow with the laundering reminder.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

**Deliverable:** The conscious mind is provisioned with an executable `frontier` CLI per container and its system prompt describes how/when to use it; all four projects build and the full unit suite passes.

---

### Task 5: Gated container smoke test

A `skipIf`-gated smoke (mirroring `opencode-session.smoke.test.ts` and `delegate.smoke.test.ts`): provision the CLI into a real container, then drive `frontier start → poll → steer → wait` directly via `Docker.exec`, asserting a result returns and a `status:` line is present (and that a `steer` is accepted mid-run).

**Files:**
- Create: `packages/core/src/conscious/frontier-cli.smoke.test.ts`

**Interfaces:**
- Consumes: `provisionFrontierCli`, `FRONTIER_CLI_PATH` (Task 3); `Docker`/`DockerLive` from `../services/Docker.js`; `NodeContext` from `@effect/platform-node`. Env: `ROCI_FRONTIER_CONTAINER` (gate), `ROCI_FRONTIER_PLAYER` (default `test-pilot`).

**Steps:**

- [ ] Create `packages/core/src/conscious/frontier-cli.smoke.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest"
  import { Effect, Layer } from "effect"
  import { NodeContext } from "@effect/platform-node"
  import { Docker, DockerLive } from "../services/Docker.js"
  import { provisionFrontierCli, FRONTIER_CLI_PATH } from "./frontier-cli.js"

  // ROCI_FRONTIER_CONTAINER=<id> npx vitest run packages/core/src/conscious/frontier-cli.smoke.test.ts
  const containerId = process.env.ROCI_FRONTIER_CONTAINER
  const playerName = process.env.ROCI_FRONTIER_PLAYER ?? "test-pilot"

  describe.skipIf(!containerId)("frontier CLI against a real container", () => {
    it("provisions, starts a worker, polls, steers, and waits for a result", async () => {
      const dockerLayer = DockerLive.pipe(Layer.provide(NodeContext.layer))
      const cid = containerId as string
      const wd = `-w /work/players/${playerName}`

      const program = Effect.gen(function* () {
        const docker = yield* Docker
        yield* provisionFrontierCli(cid, { model: "sonnet", timeoutMs: 120000 })
        // start
        const id = (yield* docker.exec(cid, [
          "bash", "-lc",
          `${FRONTIER_CLI_PATH} start "Write the single word: pong. Then wait for further instructions."`,
        ])).trim()
        // poll (status line must be present)
        const polled = yield* docker.exec(cid, ["bash", "-lc", `${FRONTIER_CLI_PATH} poll "${id}"`])
        // steer (must be accepted)
        const steered = yield* docker.exec(cid, [
          "bash", "-lc",
          `${FRONTIER_CLI_PATH} steer "${id}" "Now also print the word: ack."`,
        ])
        // wait for final
        const waited = yield* docker.exec(cid, ["bash", "-lc", `${FRONTIER_CLI_PATH} wait "${id}"`])
        return { id, polled, steered, waited }
      })

      const { id, polled, steered, waited } = await Effect.runPromise(
        Effect.provide(program, dockerLayer),
      )
      expect(id.length).toBeGreaterThan(0)
      expect(polled).toMatch(/status:/)
      expect(steered).toMatch(/status:/)
      expect(waited).toMatch(/status:\s*(done|timed_out|failed)/)
    }, 180_000)
  })
  ```
  (The `wd` local is documentation of the worker's cwd; `provisionFrontierCli` writes to a global path so the working dir does not affect provisioning. Keep or drop `wd` to taste — if dropped, remove the unused local to satisfy lint.)
- [ ] Run it expecting SKIP (no container locally): `npx vitest run packages/core/src/conscious/frontier-cli.smoke.test.ts` — expect `1 skipped` (the `skipIf(!containerId)` gate; this is the expected "failure"/no-op without a container, exactly like `delegate.smoke.test.ts`).
- [ ] Build all four projects: `npx nx run-many -t build`.
- [ ] Commit:
  ```
  git add packages/core/src/conscious/frontier-cli.smoke.test.ts
  git commit -m "test(conscious): gated frontier CLI container smoke (Phase 4c.5)

skipIf-gated on ROCI_FRONTIER_CONTAINER: provisions the CLI, drives
start/poll/steer/wait against a real container, asserting a status line
and a final result. Mirrors delegate/opencode-session smokes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

**Deliverable:** A gated smoke that, given a real container, proves the `frontier` CLI drives a real worker through `start/poll/steer/wait`; skipped (no-op) without a container so CI/local unit runs stay green.

---

### Task 6: Document the smoke in `docs/cortex-smoke.md`

Add the new gated smoke to the smoke runbook so the live verification path (spec §9) is discoverable. Docs-only commit (`--no-verify`).

**Files:**
- Modify: `docs/cortex-smoke.md` — add a row/section for the frontier smoke alongside the existing delegate/opencode-session entries (see the table near `docs/cortex-smoke.md:444`).

**Steps:**

- [ ] Read the existing smoke table (`docs/cortex-smoke.md` around lines 440-450 and the delegate/opencode-session sections) to match formatting.
- [ ] Add an entry: `| N | Frontier CLI | \`ROCI_FRONTIER_CONTAINER=$ID npx vitest run packages/core/src/conscious/frontier-cli.smoke.test.ts\` |` and a short prose section describing the `start/poll/steer/wait` drive and the expected `status:` lines.
- [ ] Commit (docs-only, hooks skipped):
  ```
  git add docs/cortex-smoke.md
  git commit --no-verify -m "docs(cortex): document the frontier CLI smoke (Phase 4c.6)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

**Deliverable:** The frontier smoke is documented in the runbook with its exact gated invocation.

---

## Self-Review

**Spec-coverage map (every spec section → task):**
- §1–§2 (reframe: frontier as an inline tool, no orchestrator routing) → honored structurally; Task 4 confirms no loop routing change beyond passing provision fields (Global Constraint: no orchestrator routing). Verified `cortex/loop.ts` needs only the provision-call extension, not escalation routing.
- §3 (tool contract `start/poll/steer/wait`, plain-text stdout, `status:` line, no `run` alias) → Task 2 generator + tests; surface decision baked into Global Constraints.
- §4 (driver mechanism: fifo, detached `setsid`, `out` file, taskLine/steerLine/endLine reuse, cross-turn file-backed handle, DRY flag construction via `payload.ts`/`runtime.ts` + `sdk-payload.ts`) → Task 2 (`buildFrontierWorkerFlags` reuses `runtimeBaseArgs`; script reuses NDJSON shapes; `endLine()` asserted equal).
- §5 (laundering Vector-A) → Global Constraint + the agent-markdown reminder (Task 4) + the comment in `frontier-cli.ts` (Task 2). No raw event text path exists.
- §6.1 (wire `ConsciousThoughtLive`) → Task 1. §6.2 (generate + provision) → Tasks 2+3+4. §6.3 (teach the agent) → Task 4. §6.4 (gated smoke) → Task 5.
- §7 (disposition of host machinery) → Global Constraint: reuse only `sdk-payload.ts`/`runtime.ts` helpers; do not touch `cybernetics/{delegate,steering,result,types}.ts`; `CyberneticsLive` stays composed. No task modifies those files.
- §8 (error handling: failed/timed_out status, orphaned handles → failed/unknown rather than hang) → Task 2 script (`poll`/`wait` emit `failed` when dir/fifo missing or `rc!=0`; `124` → `timed_out`; `wait` is deadline-bounded).
- §9 (testing: generated-script unit tests, gated smoke, manual live) → Tasks 2/3 unit, Task 5 smoke, Task 6 docs the manual path.
- §10 (open questions decided): `run` alias = no; status encoding = trailing `status:` line; timeout knob = reuse `workerTimeoutMs`. All in Global Constraints. Dormant-machinery cleanup = explicitly deferred (not this phase).
- §11 (decisions log) → reflected in architecture/constraints.

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N" remain. Every step has concrete test code and implementation code. The one judgement call — the loop's frontier-model source in Task 4 — is given an explicit fallback (`"sonnet"`, matching `delegate.smoke.test.ts`) with a grep instruction to locate the call site.

**Type-consistency check:**
- `buildFrontierCliScript(opts: { model: AnyModel; timeoutMs: number })` — defined Task 2, consumed identically in `provisionFrontierCli` (Task 3) and `provisionImpl` (Task 4). ✓
- `provisionFrontierCli(containerId: string, opts: { model: AnyModel; timeoutMs: number }): Effect.Effect<void, never, Docker>` — Task 3, consumed in Task 4 with `{ model: opts.frontierModel, timeoutMs: opts.frontierTimeoutMs }`. ✓
- `ProvisionOpts` gains `frontierModel: AnyModel; frontierTimeoutMs: number` (Task 4) — matches the loop call site and the conscious-thought test args. ✓
- `FRONTIER_CLI_PATH`, `FRONTIER_RUN_DIR`, `buildFrontierWorkerFlags` — defined Task 2, used by name in Tasks 3 (provision/test), 4 (test), 5 (smoke). ✓
- `runtimeBaseArgs("claude", model)` returns `["-p","--permission-mode","bypassPermissions","--model",model]` (verified in `runtime.ts:22-26`) — `buildFrontierWorkerFlags` joins it; tests assert the substrings. ✓
- `Docker.exec(id, command: string[])` signature matches the stub used in both `opencode-config.test.ts` and the new tests. ✓
- `taskLine`/`steerLine`/`endLine` exist in `sdk-payload.ts` (verified) and produce `{"v":1,"type":...}` with no trailing newline; the script's embedded `task_line`/`steer_line`/`end_line` reproduce the same shape, and the test asserts `endLine()` equals the embedded static frame to catch drift. ✓

**Build/test commands (verified against package.json / nx.json / vitest.config.ts):**
- All four projects: `npx nx run-many -t build` ✓ (projects: `@roci/core`, `domain-github`, `domain-spacemolt`, `apps/roci`).
- Single test file: `npx vitest run packages/core/src/<path>.test.ts` ✓ (vitest include `src/**/*.test.ts`; precedent in `docs/cortex-smoke.md`).
- All unit tests: `npx vitest run` ✓.

No issues found requiring inline fixes beyond the explicit fallbacks already written into the steps.
