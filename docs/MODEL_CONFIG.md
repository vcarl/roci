# Model Configuration

Roci uses a tier-based model configuration system that decouples agent roles from specific model names. This allows tuning model selection per-deployment without changing domain code.

## Tiers

Three tiers map to capability levels:

| Tier | Default Model | Purpose |
|------|--------------|---------|
| `fast` | `haiku` | Routine tasks, well-defined scope, deterministic outcomes |
| `smart` | `sonnet` | Tasks requiring judgment, ambiguity, complex reasoning |
| `reasoning` | `opus` | Planning, evaluation, complex multi-step reasoning |

## Roles

Roles represent specific agent functions. Each role resolves to either a tier name or a raw model string:

| Role | Default Tier | Description |
|------|-------------|-------------|
| `brainPlan` | `reasoning` | Plan generation (decide skill) |
| `brainInterrupt` | `reasoning` | Interrupt-driven replanning |
| `brainEvaluate` | `reasoning` | Step evaluation |
| `diarySubagent` | `smart` | Diary writing and updates |
| `dreamCompression` | `reasoning` | Memory compression (hippocampus) |
| `dinner` | `smart` | Social reflection (SpaceMolt) |
| `timeoutSummary` | `fast` | Summarize timed-out output |
| `scaffoldIdentity` | `smart` | Character identity generation |
| `scaffoldSummary` | `fast` | Summary generation during setup |

## Resolution

`resolveModel(config, role, defaultTier)` resolves a role to a concrete model string:

1. If the role has an explicit override in `config.roles`, use it
   - If the override is a tier name (`"fast"`, `"smart"`, `"reasoning"`), resolve to that tier's model
   - Otherwise treat the override as a raw model string (e.g., `"claude-sonnet-4-5-20250514"`)
2. Otherwise, look up `defaultTier` in `config.tiers`

## Configuration

Model config is loaded from `.roci/models.json` at the project root:

```json
{
  "tiers": {
    "fast": "haiku",
    "smart": "sonnet",
    "reasoning": "opus"
  },
  "roles": {
    "dreamCompression": "smart",
    "brainPlan": "claude-opus-4-6"
  }
}
```

CLI tier overrides take precedence over the file:

```bash
./roci start <char> --fast haiku --smart sonnet --reasoning opus
```

Priority: CLI flags > `.roci/models.json` > built-in defaults.

## Merging

`mergeModelConfig(base, overlay)` merges two configs:
- Tiers are merged key-by-key (overlay wins per-key)
- Roles are merged additively (overlay adds or overrides individual roles)

This allows partial overrides without specifying the full config.

## Non-Claude Models

The `AnyModel` type accepts any string, not just Claude model names. When the model string doesn't match a known Claude model pattern, `runtimeBinary()` selects the `opencode` runtime instead of `claude`, enabling use of alternative LLM providers.

```typescript
type AnyModel = ClaudeModel | (string & {})  // "opus" | "sonnet" | "haiku" | any string

function runtimeBinary(model: AnyModel): AgentRuntime  // "claude" | "opencode"
```

Claude model shorthand (`"opus"`, `"sonnet"`, `"haiku"`) is resolved by the Claude CLI itself. Full model IDs (e.g., `"claude-opus-4-6"`) are also accepted and passed through.

## Operating Skills and Model Tiers

The operating skills system (`packages/core/src/skills/`) uses the tier concept in the decide skill's plan output. When creating a plan, the decide stage assigns each step a tier:

- **`fast`** -- Routine tasks with well-defined scope and deterministic outcomes
- **`smart`** -- Tasks requiring judgment, ambiguity, or complex reasoning

This maps directly to the model config's tier system, allowing the orchestrator to resolve the appropriate model for each step.

## Key Files

| File | Purpose |
|------|---------|
| `packages/core/src/core/model-config.ts` | Types, resolution, and merging logic |
| `packages/core/src/core/model-config.test.ts` | Unit tests for resolution and merging |
| `packages/core/src/core/limbic/hypothalamus/runtime.ts` | `runtimeBinary()` and `runtimeBaseArgs()` |
| `.roci/models.json` | Per-project model configuration (not checked in) |
