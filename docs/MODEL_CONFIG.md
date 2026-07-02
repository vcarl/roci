# Model Configuration

Roci runs **two distinct model systems**:

1. **The cortex MLX tier topology** — the live engine. Three local OpenAI-compatible
   servers (hindbrain / forebrain / conscious) back the cortex loop. This is where the
   bulk of model traffic goes. See [Cortex MLX Tiers](#cortex-mlx-tiers) below.
2. **The legacy tier-based `resolveModel` system** — `fast`/`smart`/`reasoning` tiers
   that a handful of role-based callers still resolve through. As of this writing only
   **two** roles actually call `resolveModel` at runtime: `dreamCompression` and `dinner`
   (both in the hippocampus). This system is documented here for those two roles.

The `Role` type union in `model-config.ts` now lists only these two live roles. The former
OODA/brain/scaffold roles (`brainPlan`/`brainInterrupt`/`brainEvaluate`, `diarySubagent`,
`scaffold*`, `ooda*`) and the `timeoutSummary` role were removed along with the architectures
that consumed them, so there are no other configurable role knobs.

## Cortex MLX Tiers

The cortex engine drives three cognition tiers, each served by a local MLX server on its
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

The two live `resolveModel` callers resolve a *role* to a concrete model string through a
three-tier table.

### Tiers

| Tier | Default Model | Purpose |
|------|--------------|---------|
| `fast` | `haiku` | Routine tasks, well-defined scope, deterministic outcomes |
| `smart` | `sonnet` | Tasks requiring judgment, ambiguity, complex reasoning |
| `reasoning` | `opus` | Planning, evaluation, complex multi-step reasoning |

### The two live roles

| Role | Resolution | Where it runs |
|------|-----------|---------------|
| `dreamCompression` | Defaults to the raw string `local/mlx-community/gemma-4-31b-it-8bit` (NOT a tier), set in `DEFAULT_MODEL_CONFIG.roles` (`model-config.ts:32`). Called with default tier `"smart"` as the fallback (`dream.ts:82`). | Memory compression in the hippocampus dream phase. Runs on the **opencode** runtime against the local conscious-tier mlx server (port 8083). The literal MUST equal `consciousModelLabel(DEFAULT_CORTEX_MODELS.conscious)`. On turn failure the dream phase degrades gracefully — it keeps the original diary/secrets and continues. |
| `dinner` | No default override; resolves to the `"smart"` tier (`consolidate.ts:63`). | Social reflection / per-cycle diary consolidation in the hippocampus. |

### Resolution

`resolveModel(config, role, defaultTier)` (`model-config.ts:41`) resolves a role to a
concrete model string:

1. If the role has an explicit override in `config.roles`, use it verbatim as a raw model
   string (e.g. `"local/mlx-community/gemma-4-31b-it-8bit"`)
2. Otherwise, look up `defaultTier` in `config.tiers`

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

## Non-Claude Models

The `AnyModel` type accepts any string, not just Claude model names. When the model string
doesn't match a known Claude model pattern, `runtimeBinary()` selects the `opencode`
runtime instead of `claude`, enabling use of alternative LLM providers. This is how
`dreamCompression`'s `local/mlx-community/gemma-4-31b-it-8bit` string routes to the local
mlx server.

```typescript
type AnyModel = ClaudeModel | (string & {})  // "opus" | "sonnet" | "haiku" | any string

function runtimeBinary(model: AnyModel): AgentRuntime  // "claude" | "opencode"
```

Claude model shorthand (`"opus"`, `"sonnet"`, `"haiku"`) is resolved by the Claude CLI
itself. Full model IDs (e.g., `"claude-opus-4-6"`) are also accepted and passed through.

## Key Files

| File | Purpose |
|------|---------|
| `packages/core/src/model/handles.ts` | `DEFAULT_CORTEX_MODELS` — the live cortex tier topology (model, provider, baseUrl, params per tier), plus `resolveHandle()` |
| `packages/core/src/services/model-tier-spec.ts` | `MODEL_TIER_SPECS` — per-tier port, lifecycle, and spawn timeout, derived from `handles.ts` |
| `packages/core/src/core/model-config.ts` | Legacy tier types and `resolveModel` |
| `packages/core/src/core/model-config.test.ts` | Unit tests for `resolveModel` resolution |
| `packages/core/src/core/limbic/hypothalamus/runtime.ts` | `runtimeBinary()` and `runtimeBaseArgs()` |
| `.roci/models.json` | Per-project legacy model configuration (not checked in) |
</content>
</invoke>
