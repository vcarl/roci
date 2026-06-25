# Identity-gen model evaluation notes

How to judge `generateArtifact` output so alternate conscious-model choices can be compared.

## Harness

The gated smoke test at `packages/core/src/core/identity-gen/generate.smoke.test.ts` is the
one-shot evaluation harness. It runs `generateArtifact("background", ...)` against the live
conscious tier and asserts `text.length > 200`. Use it to collect a single sample per model run:

```sh
# Requires mlx_lm.server on PATH and a conscious server running (e.g. activate the llm-env venv).
ROCI_IDENTITY_SMOKE=1 pnpm vitest run packages/core/src/core/identity-gen/generate.smoke.test.ts
```

For a full interactive run of all five artifact steps, use the setup wizard:

```sh
roci setup
```

This drives the wizard against the conscious tier interactively — accept/edit/regenerate/skip each
step, and the final files land in `players/<name>/me/`.

## Per-artifact quality rubric

Score each artifact on a 1–5 scale. Aim for ≥ 3 across all five before considering a model
acceptable for identity generation.

### background
- **Description-specific** (5): prose is visibly shaped by the provided character description — unique details, no generic protagonist framing.
- **Length** (5): 300–800 words. Under 200 is a hard fail (the smoke assertion catches this).
- **Coherent voice** (5): consistent narrative register that matches the character type; avoids CV/resume prose.

### values
- **Count** (5): 5–10 values listed.
- **Concrete, non-platitude** (5): each value is specific to this character — not "honesty", "loyalty" in the abstract but grounded in how _this_ character enacts it.
- **Background-grounded** (5): references or echoes the approved background; not independent invention.

### palette
- **Format** (5): exactly 4–6 rows; each row is exactly 5 emoji followed by ` → ` and a one-line gloss.
- **Thematic coherence** (5): emoji clusters feel deliberately chosen for the character's aesthetic, not random.
- **Gradient feel** (5): rows progress in mood/intensity — dark-to-bright, cold-to-warm, or some other legible arc.

### diary
- **Character-fit structure** (5): the diary form reflects the character's nature (a spy uses terse field reports; an archivist uses catalogue entries; a wanderer uses timestamped waypoints). A generic "Dear Diary" stub is a hard fail.
- **Values reflected** (5): at least one diary entry motif maps to an approved value.
- **Not a template** (5): no placeholder text; entries read as if written in-character.

### summary
- **Length** (5): exactly 4 sentences.
- **Narrative completeness** (5): covers who, how they think, what motivates them, and their operating style in those four sentences.
- **Voice match** (5): the summary could plausibly be an excerpt from the background.

## Compare-models procedure

1. Identify the candidate model. The current default conscious model is defined at
   `packages/core/src/model/handles.ts:92` inside `DEFAULT_CORTEX_MODELS.conscious`:
   ```typescript
   conscious: {
     tier: "conscious",
     provider: "mlx",
     baseUrl: "http://127.0.0.1:8083/v1",
     model: "mlx-community/Qwen3.5-122B-A10B-4bit",
     params: { temperature: 0.7, maxTokens: 8192 },
   },
   ```

2. To test an alternate model without changing the default, pass a `CortexModelOverlay` to
   `applyOverlay` (exported from `packages/core/src/model/handles.ts`). In a quick script:
   ```typescript
   import { DEFAULT_CORTEX_MODELS, applyOverlay } from "./packages/core/src/model/handles.js"
   const testModels = applyOverlay(DEFAULT_CORTEX_MODELS, {
     conscious: { model: "mlx-community/SomeOtherModel-4bit", baseUrl: "http://127.0.0.1:8083/v1" },
   })
   // Pass testModels as the third arg to generateArtifact(step, prompt, testModels)
   ```
   Or edit `DEFAULT_CORTEX_MODELS.conscious.model` directly for a local comparison run.

3. Serve the candidate model on port 8083 (the conscious port), then run the smoke:
   ```sh
   ROCI_IDENTITY_SMOKE=1 pnpm vitest run packages/core/src/core/identity-gen/generate.smoke.test.ts
   ```

4. For a richer sample, run `roci setup` with the same character description for both models
   and score all five artifacts against the rubric above.

5. Record the per-artifact rubric scores in a table:

   | Model | background | values | palette | diary | summary | notes |
   |-------|-----------|--------|---------|-------|---------|-------|
   | Baseline (Qwen3.5-122B-A10B-4bit) | … | … | … | … | … | |
   | Candidate | … | … | … | … | … | |

   A model passes evaluation when every artifact scores ≥ 3 and no hard-fail conditions trigger
   (background under 200 chars, diary is a generic stub, summary ≠ 4 sentences).
