# Model Configuration

Roci runs **two distinct model systems**:

1. **The cortex MLX tier topology** — the live engine. Three local OpenAI-compatible
   servers (hindbrain / forebrain / conscious) back the `brain/stem` engine. This is where the
   bulk of model traffic goes. See [Cortex MLX Tiers](#cortex-mlx-tiers) below.
2. **The legacy tier-based `resolveModel` system** — `fast`/`smart`/`reasoning` tiers
   that role-based callers resolve through. The live roles are the reflection-cycle
   stages (hippocampus): see the table below.

The `Role` type union in `model-config.ts` lists exactly the live roles:

| Role | Stage | Default resolution |
|------|-------|--------------------|
| `dreamCompression` | per-cycle diary consolidate + cull (`dream.execute`) | the local conscious-tier mlx model (explicit `roles` entry in `DEFAULT_MODEL_CONFIG`) |
| `retrospect` | per-cycle meso retrospect — skill proposals | `smart` tier (no `roles` entry) |
| `synthesisBootstrap` | one-time SYNTHESIS.md self-model seed (fires only while the file is absent/empty) | `smart` tier (no `roles` entry) |
| `macro` | every-Nth-cycle growth stimulation — adjudicate/synthesize/narrate | `reasoning` tier (no `roles` entry) |

The former `dinner` (consolidate) role was collapsed into `dreamCompression` when the two memory
passes were unified into one step, and the older OODA/brain/scaffold roles
(`brainPlan`/`brainInterrupt`/`brainEvaluate`, `diarySubagent`, `scaffold*`, `ooda*`) and the
`timeoutSummary` role were removed along with the architectures that consumed them, so there
are no other configurable role knobs.

## Cortex MLX Tiers

The `brain/stem` engine drives three cognition tiers, each served by a local MLX server on its
own port. The single source of truth for which model answers each tier and where is
`DEFAULT_CORTEX_MODELS` in `packages/core/src/model/handles.ts` (`:54-130`).
`packages/core/src/services/model-tier-spec.ts` (`MODEL_TIER_SPECS`) **derives** each
spec's model and base URL from that handle and adds spawn-only metadata (port, lifecycle,
timeout); it cross-checks the port against the handle's base URL so the two can never
drift.

| Tier | Port | Default model | Provider | Lifecycle | Spawn timeout |
|------|------|---------------|----------|-----------|---------------|
| `hindbrain` | 8081 | `mlx-community/Qwen3.5-2B-4bit` | `mlx` | `per-phase` | 120s |
| `forebrain` | 8082 | `mlx-community/Qwen3.5-9B-4bit` | `mlx` | `per-phase` | 180s |
| `conscious` | 8083 | `mlx-community/gemma-4-31b-it-8bit` | `mlx` | `resident` | 600s |

- **Lifecycle** — the `conscious` tier is `resident` (it can lose the cold-load race for
  minutes), while the lighter `hindbrain`/`forebrain` tiers are `per-phase` (load in
  seconds). Timeouts are generous headroom over observed cold-load times.
- **Thinking-OFF on the structured tiers** — `hindbrain` and `forebrain` must emit
  parseable JSON every tick, so both disable chain-of-thought via
  `extraBody: { chat_template_kwargs: { enable_thinking: false } }` (the Qwen3.5 chat
  templates gate reasoning on this kwarg; `mlx_lm.server` forwards it from the request
  body). With thinking ON these models ran the monologue to the token cap and never closed
  the JSON. The `conscious` tier omits the kwarg entirely — `gemma-4-31b-it` is an
  instruction model with no `enable_thinking` gate.
- **No constrained decoding** — `response_format` / JSON-schema enforcement is **not**
  supported on the `mlx` provider (`mlx_lm` silently ignores the key). The loop relies on a
  tolerant JSON extractor instead.

`handles.ts` exposes `resolveHandle(config, tier)` to look up a tier's `ModelHandle`; the
serving topology (which ports, on-demand loading) is configured externally, not by these
modules.

## Legacy Tier-Based Resolution

The one live `resolveModel` caller resolves a *role* to a concrete model string through a
three-tier table.

### Tiers

| Tier | Default Model | Purpose |
|------|--------------|---------|
| `fast` | `haiku` | Routine tasks, well-defined scope, deterministic outcomes |
| `smart` | `sonnet` | Tasks requiring judgment, ambiguity, complex reasoning |
| `reasoning` | `opus` | Planning, evaluation, complex multi-step reasoning |

### The live roles

| Role | Resolution | Where it runs |
|------|-----------|---------------|
| `dreamCompression` | Defaults to the raw string `local/mlx-community/gemma-4-31b-it-8bit` (NOT a tier), set in `DEFAULT_MODEL_CONFIG.roles` (`model-config.ts`). Called with default tier `"smart"` as the fallback (`dream.ts`). | The unified per-cycle reflection memory compression in the hippocampus — consolidate + diary/secrets cull, all three turns on this one role. Runs on the **opencode** runtime against the local conscious-tier mlx server (port 8083); **Claude is never invoked in this path.** The literal MUST equal `consciousModelLabel(DEFAULT_CORTEX_MODELS.conscious)`. On turn failure the step degrades gracefully — it keeps the original diary/secrets and continues. |
| `retrospect` | No `roles` entry — resolves to the `smart` tier (`retrospect.ts`). | The per-cycle meso retrospect (hippocampus): grades the just-ended cycle's episode streams against the skill index and appends skill create/revise/retire proposals. Tool-less; a failed turn proposes nothing and never fails the reflection. |
| `synthesisBootstrap` | No `roles` entry — resolves to the `smart` tier (`synthesis-bootstrap.ts`). | The one-time SYNTHESIS.md self-model seed (hippocampus): fires only while the file is absent/blank, synthesizing an initial first-person self-model from background/values/diary. Gated on file content, so it never overwrites a real self-model; a failed turn writes nothing. |
| `macro` | No `roles` entry — resolves to the `reasoning` tier (`macro.ts`). | The every-Nth-reflection growth stimulation (hippocampus): a tool-less frontier turn adjudicates accumulated skill proposals, rewrites the bounded SYNTHESIS.md, and appends a diary growth note; the harness applies the document. A failed turn leaves proposals pending for the next macro cycle. |

### Resolution

`resolveModel(config, role, defaultTier)` (`model-config.ts`) resolves a role to a
concrete model string. A role override is a **tier name or model string**:

1. If the role has an explicit override in `config.roles`:
   - an override that exactly matches a tier name (`"fast"` | `"smart"` | `"reasoning"`)
     resolves to that tier's model (e.g. `roles: { macro: "reasoning" }` follows
     whatever `tiers.reasoning` is set to);
   - any other string is used verbatim as a raw model string
     (e.g. `"local/mlx-community/gemma-4-31b-it-8bit"`).
2. Otherwise, look up `defaultTier` in `config.tiers`.

Validation follows resolution: `assertValidModelConfig` accepts a tier name in a role
position (legal-by-design indirection) and validates what it resolves to — a tier-name
role override pointing at a broken tier value fails on the `tiers.<tier>` entry, not
the role.

### Configuration

Model config is loaded from `.roci/models.json` at the project root:

```json
{
  "tiers": {
    "fast": "haiku",
    "smart": "sonnet",
    "reasoning": "opus"
  },
  "roles": {
    "dreamCompression": "local/mlx-community/gemma-4-31b-it-8bit"
  }
}
```

CLI tier overrides take precedence over the file:

```bash
./roci start <char> --fast haiku --smart sonnet --reasoning opus
```

Priority: CLI flags > `.roci/models.json` > built-in defaults.

### Merging

`loadModelConfig` (`apps/roci/src/cli.ts`) layers the sources by shallow-merging plain
objects:
- Tiers are merged key-by-key (later source wins per-key)
- Roles are merged additively (later source adds or overrides individual roles)

This allows partial overrides without specifying the full config.

## Model → runtime dispatch (single source of truth)

Which runtime binary a turn runs on — the frontier `claude` CLI or the local
`opencode` runtime (mlx / other providers) — is decided by ONE authoritative
function, `modelRuntime()` in
`packages/core/src/model/runtime.ts`. Both the dispatch path
(`runtimeBinary` / `selectRuntime`) and config-load validation
(`assertValidModelConfig` in `model-config.ts`) call it, so the two can never
disagree. This closes the "two config sources of truth silently disagree" class of
bug (a legal override routing a Claude-only turn to the local model, or vice-versa).

```typescript
type AnyModel = ClaudeModel | (string & {})  // "opus" | "sonnet" | "haiku" | any string

function modelRuntime(model: AnyModel): AgentRuntime | undefined  // "claude" | "opencode" | unknown
function runtimeBinary(model: AnyModel): AgentRuntime             // throws on unknown
```

`modelRuntime` recognizes exactly three forms and returns `undefined` for anything
else:

| Model string form | Example | Runtime |
|-------------------|---------|---------|
| Claude tier alias | `opus`, `sonnet`, `haiku` | `claude` (the CLI resolves the alias itself) |
| Fully-qualified `claude-*` id | `claude-opus-4-6` | `claude` |
| Provider/model string (contains `/`) | `local/mlx-community/gemma-4-31b-it-8bit`, `openrouter/anthropic/claude-sonnet-4` | `opencode` |
| **anything else** (bare, provider-less, non-Claude) | `gpt-4o`, `typo-model` | **unknown → config error** |

**Fully-qualified `claude-*` ids are DELIBERATELY accepted and routed to the
`claude` binary** (not rejected in favor of the three aliases). Rationale: a legal
override such as `--tier-reasoning claude-opus-4-6` must run on frontier Claude as
the operator intended, not silently fall to the local model. This is the exact
misroute the single-source-of-truth mapping prevents.

**No silent fallback.** A bare, provider-less non-Claude name (e.g. `gpt-4o`) is
*unknown*, not "route it to opencode": opencode addresses models as
`provider/model`, so such a name resolves to no local model and is not Claude
either. To route a non-Claude provider model, give it its provider prefix
(e.g. `openai/gpt-4o`). Unknown strings are rejected at config load (see below); if
one ever reaches `runtimeBinary` at dispatch it throws (defense-in-depth) rather
than misrouting.

### Config-load validation

`assertValidModelConfig(config)` runs inside `loadModelConfig`
(`apps/roci/src/cli.ts`) after merging defaults → `.roci/models.json` → CLI flags.
Every tier and every defined per-role override must resolve via `modelRuntime`;
otherwise it throws `ModelConfigError` naming each offending key (`tiers.reasoning`,
`roles.macro`, …), its value, and the accepted forms. So a mistyped or Claude-only
override fails loudly at startup instead of misrouting a turn at runtime. This is
how `dreamCompression`'s `local/mlx-community/gemma-4-31b-it-8bit` stays a valid,
first-class local-model label while a typo like `local/…` misspelled or a bare
`opus4` is caught immediately.

## Key Files

| File | Purpose |
|------|---------|
| `packages/core/src/model/handles.ts` | `DEFAULT_CORTEX_MODELS` — the live cortex tier topology (model, provider, baseUrl, params per tier), plus `resolveHandle()` |
| `packages/core/src/services/model-tier-spec.ts` | `MODEL_TIER_SPECS` — per-tier port, lifecycle, and spawn timeout, derived from `handles.ts` |
| `packages/core/src/core/model-config.ts` | Legacy tier types, `resolveModel`, and `assertValidModelConfig` / `ModelConfigError` (load-time model→runtime validation) |
| `packages/core/src/core/model-config.test.ts` | Unit tests for `resolveModel` resolution and `assertValidModelConfig` |
| `packages/core/src/model/runtime.ts` | `modelRuntime()` (single source of truth), `runtimeBinary()`, and `runtimeBaseArgs()` |
| `.roci/models.json` | Per-project legacy model configuration (not checked in) |
</content>
</invoke>
