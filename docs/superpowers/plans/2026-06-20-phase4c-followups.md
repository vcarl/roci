# Phase 4c Follow-ups — TDD Implementation Plan

## Goal

Three independent follow-up items closing out Phase 4c of the cortex/frontier work:

1. **Frontier model selection** — let the conscious mind pick the frontier worker's
   model per `frontier start` invocation (optional `--model <name>` selector),
   defaulting to the configured frontier model (config-sourced, was hardcoded
   `"sonnet"`). Teach the agent the new selector in its agent markdown.
2. **Delete the dormant cybernetics subsystem** — `cybernetics/` is superseded by
   `frontier-cli.ts`; nothing depends on it at runtime. Remove the source, tests,
   barrel exports, and the one app-wiring reference.
3. **Tidy cosmetic mid-file test imports** — hoist the mid-file `import`s in
   `conscious-thought.test.ts` to the top-of-file import block (no behavior change).

## Architecture

- The generated `frontier` CLI is **bash embedded in a TS template literal**
  (`packages/core/src/conscious/frontier-cli.ts`). There are THREE escaping layers
  the implementer must respect: TS template literal → bash double-quoted strings →
  python string literals inside `python3 -c "..."`. Match the existing escaping idiom
  exactly (read the current file before editing).
- Runtime values cross into the **detached** worker via the **environment**
  (`FRONTIER_D`, `FRONTIER_BUDGET_S`), never by splicing into the
  `setsid bash -c '...'` child source. The new model selector follows the same
  pattern (`FRONTIER_MODEL`) — this is the injection-safe invariant established by
  the hardening; preserve it.
- The cortex loop (`packages/core/src/cortex/loop.ts`) provisions the conscious agent
  once before the first tick; it passes `frontierModel` into
  `consciousThought.provision({...})`. The default is sourced from the loop's
  `workerModels?: ModelConfig` (reasoning tier → `"opus"`).
- `cybernetics/` is dead: the cortex loop does not depend on `Cybernetics` at runtime,
  and `frontier-cli.ts` reuses nothing from it. Only live references are the app
  wiring (`apps/roci/src/cli.ts`) and the core barrel (`packages/core/src/index.ts`).

## Tech Stack

- TypeScript ES modules (`.js` import specifiers), Effect 3.19, vitest 3.2.
- nx 22 monorepo (pnpm). Four projects: `@roci/core`, `domain-github`,
  `domain-spacemolt`, `apps/roci`.
- Single test file: `npx vitest run packages/core/src/<path>.test.ts`.
- Full suite: `npx vitest run`.
- Build all four: `npx nx run-many -t build`.

## Global Constraints

- Commit trailer EXACTLY as the final line of every commit message:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Build ALL FOUR projects (`npx nx run-many -t build`: @roci/core + domain-github +
  domain-spacemolt + apps/roci) for any task touching app wiring (cli.ts), the cortex
  loop, or the conscious requirement channel. Single test file:
  `npx vitest run packages/core/src/<path>.test.ts`. Full suite: `npx vitest run`.
- NEVER emit `--bare` in claude worker flags. Worker flags stay
  `-p --permission-mode bypassPermissions ... --model <m>`.
- No MCP — bash CLI / subprocess only; no opencode.jsonc or tool-schema changes.
- Laundering (Vector-A): the `start` task, every `steer` directive, AND the new model
  selector are model-authored tool arguments (the conscious LLM's), never raw inbound
  event text. Pass runtime values into the detached worker via the ENVIRONMENT (like
  the existing `FRONTIER_D`/`FRONTIER_BUDGET_S`), never by splicing into the
  `setsid bash -c '...'` child source — that is the injection-safe pattern the
  hardening established; preserve it.
- Container/player identity is a per-call parameter, never an env var or process
  global. Do NOT add a ROCI_*_CONTAINER-style gate.
- Docs-only commits may use `--no-verify`; code commits run normal hooks.
- Do not weaken existing test assertions to dodge a failure; update them only when the
  behavior genuinely changed, and say why.

---

## Task 1 — Frontier model selection (conscious mind picks; config-sourced default)

The conscious mind picks the frontier worker's model per invocation via an optional
leading `--model <name>` on `frontier start`, defaulting to the configured frontier
model. The default is sourced from the loop config (reasoning tier → `"opus"`), and
the agent markdown teaches the new selector.

### Files

- **Modify** `packages/core/src/conscious/frontier-cli.ts`
  - `buildFrontierWorkerFlags(model)` → `buildFrontierWorkerFlags()` returns the
    STATIC flags WITHOUT `--model` (the model becomes a separate runtime-variable flag).
  - `buildFrontierCliScript({model, timeoutMs})` — bake `DEFAULT_MODEL` = `opts.model`,
    parse optional `--model <name>` in the `start` arm, resolve
    `model="${override:-$DEFAULT_MODEL}"`, pass to the worker via `FRONTIER_MODEL`,
    and compose `--model "$FRONTIER_MODEL"` in the child invocation.
- **Modify** `packages/core/src/conscious/opencode-config.ts`
  - Extend the `buildCharacterAgentMarkdown` frontier section to document
    `frontier start [--model <name>] "<task>"` and model-by-difficulty guidance.
- **Modify** `packages/core/src/cortex/loop.ts`
  - Import the VALUE `DEFAULT_MODEL_CONFIG` (currently type-only import of `ModelConfig`).
  - Replace `frontierModel: "sonnet"` (loop.ts:120) with
    `frontierModel: (config.workerModels ?? DEFAULT_MODEL_CONFIG).tiers.reasoning`.
- **Test** `packages/core/src/conscious/frontier-cli.test.ts` (modify)
- **Test** `packages/core/src/conscious/opencode-config.test.ts` (modify or create;
  check whether it exists in step 4 — if absent, create it)
- **Optional docs touch** `docs/cortex-smoke.md` — mention `--model` selection in the
  frontier section (folded into this task's docs-only commit if it fits cleanly).

### Interfaces

- **Consumes:** `AnyModel` (a model-name string), `runtimeBaseArgs("claude", model)`
  (the single source of truth for `-p --permission-mode bypassPermissions --model <m>`),
  `ModelConfig` + `DEFAULT_MODEL_CONFIG` from `../core/model-config.js`,
  `ProvisionOpts.frontierModel: AnyModel`.
- **Produces:** A `frontier` CLI whose `start` arm accepts `[--model <name>]` and runs
  the worker with the selected (or baked-default) model; a config-sourced default
  frontier model in the loop; agent markdown teaching the selector.

### Background — current shape (read before editing)

`buildFrontierWorkerFlags(model)` currently appends `--model <model>` (via
`runtimeBaseArgs`). The script's `start` arm launches the detached worker as:

```
( timeout "$FRONTIER_BUDGET_S" claude ${flags} < "$d/in.fifo" > "$d/raw" 2>&1; echo $? > "$d/rc" ) &
```

where `${flags}` is `buildFrontierWorkerFlags(opts.model)` baked at generate time.
We are splitting `--model` out so the model is a runtime-variable env-sourced flag,
while the static flags stay literal.

### Step 1.1 — RED: static worker flags drop `--model`

Update the `buildFrontierWorkerFlags` unit tests to call it with NO argument and assert
the model flag is gone while stream-json in/out + verbose remain and `--bare` is absent.

Edit `packages/core/src/conscious/frontier-cli.test.ts`. Replace the
`describe("buildFrontierWorkerFlags", ...)` block (lines 13-26) with:

```ts
describe("buildFrontierWorkerFlags", () => {
  const flags = buildFrontierWorkerFlags()
  it("reuses the claude base flags but NOT a baked --model (model is runtime-variable)", () => {
    expect(flags).toContain("-p")
    expect(flags).toContain("--permission-mode bypassPermissions")
    expect(flags).not.toContain("--model")
    expect(flags).not.toContain("--bare")
  })
  it("runs in streaming-input + streaming-output json mode", () => {
    expect(flags).toContain("--input-format stream-json")
    expect(flags).toContain("--output-format stream-json")
    expect(flags).toContain("--verbose")
  })
})
```

Also update the two `buildFrontierCliScript` assertions that call
`buildFrontierWorkerFlags("sonnet")` (test lines 47) — the script no longer embeds a
baked `--model`. Replace the `it("embeds the worker invocation flags", ...)` block
(lines 46-48) with:

```ts
  it("embeds the static worker invocation flags (no baked --model)", () => {
    expect(script).toContain(buildFrontierWorkerFlags())
  })
  it("bakes the provided default model and selects it at runtime via FRONTIER_MODEL", () => {
    expect(script).toContain('DEFAULT_MODEL="sonnet"')
    expect(script).toContain('--model "$FRONTIER_MODEL"')
    expect(script).toContain('FRONTIER_MODEL=')
  })
  it("start parses an optional --model override, defaulting to DEFAULT_MODEL", () => {
    expect(script).toContain('--model)')
    expect(script).toContain('override="${override:-$DEFAULT_MODEL}"')
  })
```

Run it — expect RED (type error / `buildFrontierWorkerFlags` called with no arg, plus
the new assertions fail):

```
npx vitest run packages/core/src/conscious/frontier-cli.test.ts
```

Expected output: failures in `buildFrontierWorkerFlags` (arg count / `--model` still
present) and the new `buildFrontierCliScript` assertions.

### Step 1.2 — GREEN: split `--model` out of the static flags

Edit `packages/core/src/conscious/frontier-cli.ts`. Replace `buildFrontierWorkerFlags`
(lines 11-27) with the no-arg static-flags version:

```ts
/**
 * The STATIC `claude` worker invocation flags — everything EXCEPT `--model`.
 * The model is runtime-variable (selected per `frontier start` and passed into the
 * detached worker via FRONTIER_MODEL), so it is composed separately in the script.
 * Streaming-input mode so the worker reads NDJSON (taskLine/steerLine/endLine) from
 * the fifo. NEVER passes --bare.
 */
export function buildFrontierWorkerFlags(): string {
  // runtimeBaseArgs requires a model; we strip the trailing `--model <m>` pair here so
  // the model can be supplied at runtime. The remaining base flags are the invariant
  // `-p --permission-mode bypassPermissions` set (single source of truth).
  const base = runtimeBaseArgs("claude", "sonnet").slice(0, -2) // drop "--model" + its value
  return [
    ...base,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ].join(" ")
}
```

> Note: `runtimeBaseArgs("claude", m)` returns
> `["-p", "--permission-mode", "bypassPermissions", "--model", m]`; `.slice(0, -2)`
> drops the trailing `--model`/`<m>` pair, leaving the model-free base. This keeps
> `runtimeBaseArgs` as the single source of truth without exporting a new helper
> (DRY/YAGNI — no second function).

### Step 1.3 — GREEN: bake DEFAULT_MODEL, parse `--model`, select via FRONTIER_MODEL

Still in `frontier-cli.ts`, in `buildFrontierCliScript`:

First, near the top of the function body (where `const flags = ...` is), the
`buildFrontierWorkerFlags` call now takes no arg, and add a baked default-model
constant. Replace:

```ts
  const flags = buildFrontierWorkerFlags(opts.model)
  const budgetMs = String(opts.timeoutMs)
```

with:

```ts
  const flags = buildFrontierWorkerFlags()
  const budgetMs = String(opts.timeoutMs)
  const defaultModel = opts.model
```

Then bake `DEFAULT_MODEL` into the script header. Replace:

```bash
RUN_ROOT_PREFIX="${FRONTIER_RUN_DIR}"
BUDGET_MS=${budgetMs}
```

with:

```bash
RUN_ROOT_PREFIX="${FRONTIER_RUN_DIR}"
BUDGET_MS=${budgetMs}
DEFAULT_MODEL="${defaultModel}"
```

> Escaping note: `${FRONTIER_RUN_DIR}`, `${budgetMs}`, and `${defaultModel}` are TS
> template-literal interpolations (TS values spliced at generate time). `DEFAULT_MODEL`
> is a model-name alias like `opus`/`sonnet`/`haiku` (no special chars), so embedding it
> as a bash double-quoted literal is safe — it is the baked default, NOT a per-call
> runtime arg.

Now update the `start)` arm to parse the optional `--model` selector and pass the
resolved model into the detached worker via `FRONTIER_MODEL`. Replace the entire
`start)` case (current lines 84-125) with:

```bash
  start)
    # Optional leading `--model <name>` selector (model-authored tool arg, laundered).
    override=""
    if [ "\${1:-}" = "--model" ]; then
      shift
      override="\${1:-}"; shift || true
    fi
    model="\${override:-\$DEFAULT_MODEL}"
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
    # \$d, the budget, and the resolved model cross the boundary via the ENVIRONMENT
    # (no quote-splicing of runtime values into the child source).
    FRONTIER_D="$d" FRONTIER_BUDGET_S="$(( BUDGET_MS / 1000 ))" FRONTIER_MODEL="$model" setsid bash -c '
      d="$FRONTIER_D"
      ( timeout "$FRONTIER_BUDGET_S" claude ${flags} --model "$FRONTIER_MODEL" < "$d/in.fifo" > "$d/raw" 2>&1; echo $? > "$d/rc" ) &
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
        if not t:
            items=(o.get(\\"message\\",{}) or {}).get(\\"content\\") or []
            t=\\\"\\\\n\\\".join(i[\\"text\\"] for i in items if isinstance(i,dict) and i.get(\\"type\\")==\\"text\\" and i.get(\\"text\\"))
        if t: print(t, flush=True)
    except Exception: pass" >> "$d/out" 2>/dev/null &
      # keep the fifo open for writers (steer/wait); the writer fd holder:
      exec 9> "$d/in.fifo"
      cat "$d/task.ndjson" >&9 2>/dev/null || true
      wait "$worker"
    ' >/dev/null 2>&1 &
    printf '%s' "$id"
    ;;
```

> Escaping checklist for this block (THREE layers):
> - **TS template literal layer:** `\${1:-}`, `\${override:-\$DEFAULT_MODEL}`, the
>   `\`bash -c\`` backticks, and `\$d` are escaped so they survive into the emitted bash
>   verbatim (they must NOT be evaluated at TS generate time). `${flags}` is a *real* TS
>   interpolation (spliced now). Match the existing file's escaping exactly — the
>   surrounding arms already use `\${1:-}` / `\$d` this way.
> - **bash layer:** `model="${override:-$DEFAULT_MODEL}"` (after TS un-escaping) resolves
>   the override or falls back to the baked default. `FRONTIER_MODEL="$model"` carries it
>   into the child via the environment.
> - **python layer:** unchanged from the existing extractor — do not touch its `\\"`
>   escapes.

### Step 1.4 — RED→GREEN: teach the agent the `--model` selector

First check whether an opencode-config test file exists:

```
ls packages/core/src/conscious/opencode-config.test.ts
```

If it exists, append the new `describe` below to it. If it does NOT exist, create
`packages/core/src/conscious/opencode-config.test.ts` with:

```ts
import { describe, it, expect } from "vitest"
import { buildCharacterAgentMarkdown } from "./opencode-config.js"

describe("buildCharacterAgentMarkdown frontier section", () => {
  const md = buildCharacterAgentMarkdown({ systemPrompt: "You are Ada." })
  it("teaches the optional --model selector on frontier start", () => {
    expect(md).toContain('frontier start [--model <name>]')
  })
  it("guides the mind to pick a model by difficulty/cost", () => {
    expect(md).toMatch(/haiku|sonnet/)
    expect(md).toContain("opus")
  })
  it("keeps the laundering instruction (never paste raw event text)", () => {
    expect(md).toContain("never paste raw incoming event text")
  })
})
```

Run it — expect RED (the `--model` selector is not yet documented):

```
npx vitest run packages/core/src/conscious/opencode-config.test.ts
```

Then edit `packages/core/src/conscious/opencode-config.ts`. Replace the `frontier`
array (lines 55-69) with:

```ts
  const frontier = [
    "",
    "## Frontier (heavy-lifting) tool",
    "",
    "When a sub-task exceeds your local reach (hard reasoning, large code work),",
    "reach for the `frontier` bash command — a stronger Claude Code worker you drive:",
    "",
    "- `id=$(frontier start [--model <name>] \"<scoped, self-contained task>\")` — launch it; prints a handle id.",
    "- `frontier poll \"$id\"` — print its partial output so far plus a `status:` line.",
    "- `frontier steer \"$id\" \"<nudge>\"` — push a course-correction mid-run.",
    "- `frontier wait \"$id\"` — block until done; prints the final output and `status:`.",
    "",
    "Pick a model by difficulty/cost: a smaller model (`haiku` or `sonnet`) for light",
    "sub-tasks, `opus` for hard reasoning. Omit `--model` to use the configured default.",
    "",
    "Loop: start → (poll → reason → optionally steer)* → wait. Watch the work and nudge.",
    "Author the task and every steer yourself — never paste raw incoming event text.",
  ].join("\n")
```

Re-run the opencode-config test — expect GREEN:

```
npx vitest run packages/core/src/conscious/opencode-config.test.ts
```

### Step 1.5 — GREEN: source the default frontier model from loop config

Edit `packages/core/src/cortex/loop.ts`. Change the type-only model-config import
(line 17) to also import the value:

```ts
import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "../core/model-config.js"
```

Then replace `frontierModel: "sonnet",` (line 120) with:

```ts
      frontierModel: (config.workerModels ?? DEFAULT_MODEL_CONFIG).tiers.reasoning,
```

> The existing provisioning test (`conscious-thought.test.ts`) passes
> `frontierModel: "sonnet"` directly to `provision({...})`, so it is unaffected by the
> default change. The loop's default is now `"opus"` (reasoning tier) — the provisioning
> test only asserts `FRONTIER_CLI_PATH` is written, which holds for any model.

### Step 1.6 — Verify: full build + suite

Run the full frontier test file first:

```
npx vitest run packages/core/src/conscious/frontier-cli.test.ts
```

Expected: all GREEN.

This task touches the cortex loop + the conscious provisioning channel, so build all
four projects and run the full suite:

```
npx nx run-many -t build
npx vitest run
```

Expected: all four projects build; full suite green.

### Step 1.7 — Optional docs touch (folded in, only if it fits cleanly)

If `docs/cortex-smoke.md` has a frontier section, add one line noting the `--model`
selector (e.g. `frontier start --model opus "<task>"`). This is a docs-only edit; it
may be combined into this task's commit. The bash CLI cannot execute on the host — live
behavior is verified via the `docs/cortex-smoke.md` runbook; do NOT add an env-gated
container test for this.

### Step 1.8 — Commit

```
git add packages/core/src/conscious/frontier-cli.ts \
        packages/core/src/conscious/frontier-cli.test.ts \
        packages/core/src/conscious/opencode-config.ts \
        packages/core/src/conscious/opencode-config.test.ts \
        packages/core/src/cortex/loop.ts \
        docs/cortex-smoke.md
git commit -m "feat(cortex/frontier): conscious-selectable frontier model with config-sourced default

frontier start gains an optional leading --model <name> selector, passed into
the detached worker via FRONTIER_MODEL (env, not source-spliced). Static worker
flags drop the baked --model; the model becomes the only runtime-variable flag.
Loop default frontier model now sourced from workerModels reasoning tier (opus),
replacing the hardcoded sonnet. Agent markdown teaches the selector.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> If `docs/cortex-smoke.md` was NOT touched, drop it from `git add`. Code is in this
> commit, so run normal hooks (no `--no-verify`).

### Deliverable

`frontier start [--model <name>] "<task>"` runs the worker on the selected model
(falling back to the config-sourced default `opus`), the agent markdown teaches the
selector, and all four projects build with the full suite green.



---

## Task 2 — Delete the dormant cybernetics subsystem

`cybernetics/` is superseded by `frontier-cli.ts`. The cortex loop does NOT depend on
`Cybernetics` at runtime, and `frontier-cli.ts` reuses nothing from it. Remove the
source files, test files, barrel exports, and the one app-wiring reference.

> **Verification gate (no RED unit test).** Deletions have no failing unit test to
> drive them. The verification gate is instead: (a) a clean `git grep` showing no live
> `Cybernetics` import/reference remains, and (b) all four projects build + the full
> suite green. State this explicitly — this is the RED→GREEN equivalent for a deletion.

### Files

- **Delete (source):**
  - `packages/core/src/cybernetics/delegate.ts`
  - `packages/core/src/cybernetics/steering.ts`
  - `packages/core/src/cybernetics/result.ts`
  - `packages/core/src/cybernetics/types.ts`
- **Delete (tests):**
  - `packages/core/src/cybernetics/delegate.test.ts`
  - `packages/core/src/cybernetics/delegate.smoke.test.ts`
  - `packages/core/src/cybernetics/steering.test.ts`
  - `packages/core/src/cybernetics/result.test.ts`
  - (the whole `packages/core/src/cybernetics/` dir — there is no `index.ts` there;
    `rm -rf` the dir after the file removals.)
- **Modify** `packages/core/src/index.ts` — remove the three barrel export lines (78-81).
- **Modify** `apps/roci/src/cli.ts` — remove `CyberneticsLive` from the import (line 13)
  and from `serviceLayer` (line 631).
- **Modify** `packages/core/src/conscious/conscious-thought.ts` — the doc comment at
  line 142 references `CyberneticsTest in cybernetics/delegate.ts`, which will dangle
  after deletion. Update that comment line so it no longer points at deleted code.

### Interfaces

- **Consumes:** nothing new.
- **Produces:** a smaller core barrel and app service layer; no `cybernetics/` module.

### Step 2.1 — Establish the baseline (pre-deletion grep)

Confirm the live reference set matches the verified blast radius:

```
git grep -n "cybernetics\|Cybernetics" -- packages apps
```

Expected live references: `apps/roci/src/cli.ts:13` + `:631`,
`packages/core/src/index.ts:78-81`, the doc comment at
`packages/core/src/conscious/conscious-thought.ts:142`, and the `cybernetics/*` files
themselves. (Anything else is a surprise — investigate before deleting.)

### Step 2.2 — Remove the app-wiring reference

Edit `apps/roci/src/cli.ts`. Change the import (line 13) from:

```ts
import { ModelClientLive, CyberneticsLive, ConsciousThoughtLive } from "@roci/core"
```

to:

```ts
import { ModelClientLive, ConsciousThoughtLive } from "@roci/core"
```

And remove the `CyberneticsLive,` line from the `serviceLayer` `Layer.mergeAll(...)`
(line 631):

```ts
const serviceLayer = Layer.mergeAll(
  DockerLive,
  oauthTokenLayer,
  CharacterFsLive,
  projectRootLayer,
  characterLogLayer,
  ModelClientLive,
  ConsciousThoughtLive,
)
```

### Step 2.3 — Remove the core barrel exports

Edit `packages/core/src/index.ts`. Delete these four lines (78-81):

```ts
// Cybernetics — frontier-model worker delegation
export type { DelegationConfig, DelegationResult } from "./cybernetics/types.js"
export { toDelegationResult } from "./cybernetics/result.js"
export { Cybernetics, CyberneticsLive, CyberneticsTest } from "./cybernetics/delegate.js"
```

(Leave the surrounding `model/*` exports above and the `Cortex` section below intact.)

### Step 2.4 — Fix the dangling doc reference

Edit `packages/core/src/conscious/conscious-thought.ts` line 142. It currently reads:

```ts
 * Mirrors `CyberneticsTest` in `cybernetics/delegate.ts`.
```

Replace with a self-contained description (the cybernetics module no longer exists):

```ts
 * The Test layer returns a caller-supplied canned TurnResult without touching transport.
```

> Read the surrounding comment first to confirm the exact line text before editing — it
> may have leading whitespace / be part of a multi-line block.

### Step 2.5 — Delete the cybernetics module

```
rm -rf packages/core/src/cybernetics
```

### Step 2.6 — Verification gate: clean grep + build + suite

```
git grep -n "cybernetics\|Cybernetics" -- packages apps
```

Expected: NO live import/reference. Any remaining hits must be incidental
(comments/docs only) — there should be none after Step 2.4. If `git grep` returns
nothing, that is the pass condition.

This task touches app wiring + the core barrel, so build all four and run the full suite:

```
npx nx run-many -t build
npx vitest run
```

Expected: all four projects build (no unresolved `./cybernetics/*` imports); full suite
green (the four cybernetics test files are gone, so their count drops — that is expected).

### Step 2.7 — Commit

```
git add -A
git commit -m "chore(core): delete dormant cybernetics subsystem (superseded by frontier-cli)

cybernetics/ is superseded by conscious/frontier-cli.ts; nothing depends on it at
runtime. Remove the four source files + four tests, the core barrel exports, the
CyberneticsLive app wiring, and a dangling doc reference in conscious-thought.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Code change → run normal hooks (no `--no-verify`).

### Deliverable

`git grep` shows no live `Cybernetics` reference, the `cybernetics/` module is gone, and
all four projects build with the full suite green.



---

## Task 3 — Tidy cosmetic mid-file test imports (T1a/T4a)

`conscious-thought.test.ts` has `import` statements wedged between `describe` blocks
(line 142, and lines 150-155). Hoist them into the top-of-file import block. Purely
cosmetic — no behavior change; the test must stay green.

### Files

- **Modify (test only)** `packages/core/src/conscious/conscious-thought.test.ts`

### Interfaces

- **Consumes / Produces:** nothing — internal test-file import hygiene only.

### Step 3.1 — Hoist the mid-file imports

Edit `packages/core/src/conscious/conscious-thought.test.ts`.

The mid-file imports are:

- Line 142: `import * as core from "../index.js"`
- Lines 150-155:
  ```ts
  import { ConsciousThoughtLive } from "./conscious-thought.js"
  import { FRONTIER_CLI_PATH } from "./frontier-cli.js"
  import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
  import { mkdtempSync } from "node:fs"
  import { tmpdir } from "node:os"
  import nodePath from "node:path"
  ```

First, **merge them into the existing top imports** (lines 1-8). Two merges are needed:

- `./conscious-thought.js` is already imported at the top
  (`import { ConsciousThought, ConsciousThoughtTest } from "./conscious-thought.js"`) —
  add `ConsciousThoughtLive` to that existing named import rather than adding a second
  `from "./conscious-thought.js"` line (avoid a duplicate-source import).

Replace the top import block (lines 1-8):

```ts
import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import { ConsciousThought, ConsciousThoughtTest } from "./conscious-thought.js"
import { CharacterLog } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { Docker } from "../services/Docker.js"
import type { TurnResult } from "../core/limbic/hypothalamus/types.js"
```

with:

```ts
import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { CommandExecutor } from "@effect/platform"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { ConsciousThought, ConsciousThoughtTest, ConsciousThoughtLive } from "./conscious-thought.js"
import { FRONTIER_CLI_PATH } from "./frontier-cli.js"
import { CharacterLog } from "../logging/log-writer.js"
import { OAuthToken } from "../services/OAuthToken.js"
import { Docker } from "../services/Docker.js"
import { DEFAULT_CORTEX_MODELS } from "../model/handles.js"
import * as core from "../index.js"
import type { TurnResult } from "../core/limbic/hypothalamus/types.js"
```

Then **delete** the now-redundant mid-file import lines:

- Delete line 142: `import * as core from "../index.js"` (and the blank line that
  separated it from the preceding `describe` block, if any).
- Delete lines 150-155 (the six-line import block before the
  `describe("ConsciousThought.provision writes the frontier CLI", ...)` block).

The two `describe` blocks themselves (`index re-exports ConsciousThought` and
`ConsciousThought.provision writes the frontier CLI`) stay exactly where they are — only
their preceding `import` lines move to the top.

### Step 3.2 — Verify still green

```
npx vitest run packages/core/src/conscious/conscious-thought.test.ts
```

Expected: GREEN, same number of tests as before (cosmetic move, no behavior change).

> Single-file test-only change — no need to build all four or run the full suite here.

### Step 3.3 — Commit

```
git add packages/core/src/conscious/conscious-thought.test.ts
git commit -m "test(conscious): hoist mid-file imports to top of conscious-thought.test (T1a/T4a)

Cosmetic: move the import statements wedged between describe blocks into the
top-of-file import block. No behavior change; test stays green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Deliverable

`conscious-thought.test.ts` has all imports at the top of the file and the test file
passes unchanged.



---

## Self-Review

### Spec-coverage map (each design point → task/step)

| Design point | Where realized |
| --- | --- |
| `frontier start [--model <name>]` selector parsed in `start` arm | Task 1, Step 1.3 |
| Resolve `model="${override:-$DEFAULT_MODEL}"`; pass via `FRONTIER_MODEL` env | Task 1, Step 1.3 |
| `buildFrontierWorkerFlags` returns STATIC flags, no `--model`; test updated | Task 1, Steps 1.1–1.2 |
| Static flags keep stream-json in/out + verbose; no `--bare` | Task 1, Steps 1.1–1.2 |
| Script composes `--model "$FRONTIER_MODEL"` separately; bakes `DEFAULT_MODEL` | Task 1, Step 1.3 |
| Loop default `frontierModel = (workerModels ?? DEFAULT_MODEL_CONFIG).tiers.reasoning` | Task 1, Step 1.5 |
| Add VALUE `DEFAULT_MODEL_CONFIG` to existing model-config import | Task 1, Step 1.5 |
| Agent markdown teaches `--model` + model-by-difficulty; keeps laundering line | Task 1, Step 1.4 |
| CLI string tests (start parses `--model`; `$FRONTIER_MODEL`; baked default; no `--bare`) | Task 1, Steps 1.1–1.3 |
| Agent-markdown test asserts `--model` taught | Task 1, Step 1.4 |
| Existing provisioning test still asserts `FRONTIER_CLI_PATH` (default now opus — fine) | Task 1, Step 1.5 (note) |
| Optional runbook `--model` mention folded into Task 1 docs commit | Task 1, Step 1.7 |
| Remove `CyberneticsLive` from cli.ts import + serviceLayer | Task 2, Step 2.2 |
| Remove three cybernetics barrel export lines from index.ts | Task 2, Step 2.3 |
| Delete four cybernetics source + four cybernetics test files | Task 2, Step 2.5 |
| Fix dangling doc reference in conscious-thought.ts:142 | Task 2, Step 2.4 |
| Deletion verification gate = clean grep + build + suite (stated explicitly) | Task 2, intro + Step 2.6 |
| Hoist mid-file imports (line 142 + 150-155) in conscious-thought.test.ts | Task 3, Step 3.1 |
| That test stays green after the move | Task 3, Step 3.2 |

### Placeholder scan

No `...`, `TODO`, `<elided>`, or "rest unchanged" placeholders in any code block. The
`start)` arm is shown in FULL (not as a diff fragment) because the surrounding bash
escaping is load-bearing. Imports are shown as full replacement blocks.

### Type-consistency check

- `buildFrontierWorkerFlags()` is now zero-arg `(): string`; both its unit test and the
  `buildFrontierCliScript` call site (`const flags = buildFrontierWorkerFlags()`) are
  updated together (Steps 1.1, 1.2). No other caller exists (verified: only
  `frontier-cli.ts` + its test reference it).
- `opts.model: AnyModel` (a model-name string) still flows into the script as the baked
  `DEFAULT_MODEL`; `ProvisionOpts.frontierModel: AnyModel` is unchanged.
- Loop import becomes `import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "../core/model-config.js"` —
  `ModelConfig` stays a type, `DEFAULT_MODEL_CONFIG` is a value. `workerModels?: ModelConfig`
  on `CortexLoopConfig` already exists; `.tiers.reasoning` is `AnyModel`, matching
  `frontierModel: AnyModel`.
- Task 2: after deleting `cybernetics/*`, no `from ".*cybernetics"` import remains
  (cli.ts, index.ts, conscious-thought.ts doc comment all cleaned) — the barrel and app
  layer typecheck without the removed symbols.
- Task 3: `ConsciousThoughtLive` is merged into the existing `./conscious-thought.js`
  named import (no duplicate-source import); all hoisted symbols were already imported
  mid-file, so no new dependency is introduced.

### Build / test commands confirmed

- Single test file: `npx vitest run packages/core/src/conscious/frontier-cli.test.ts`
  (and the `opencode-config` / `conscious-thought` equivalents).
- Build all four: `npx nx run-many -t build` (@roci/core + domain-github +
  domain-spacemolt + apps/roci).
- Full suite: `npx vitest run`.
- Tasks 1 and 2 touch app wiring / the loop / the conscious channel → both run the full
  four-project build + full suite before commit. Task 3 is test-only single-file.
- All commit messages end with the exact trailer
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; all three are
  code/test commits → normal hooks (the only `--no-verify` candidate would be a
  docs-only commit, which none of these are — the optional runbook edit is folded into
  Task 1's code commit).

