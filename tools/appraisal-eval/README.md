# Appraisal eval harness (hindbrain / observe)

An **offline** eval harness for the hindbrain per-event appraisal tier. It
replays REAL captured event payloads through the REAL local hindbrain model with
a candidate `observe.md` prompt, scores the appraisals, and prints a metrics
report — so prompt/code variants can be compared quantitatively **before** any
live `./roci start`.

Nothing here runs the game. It spawns its own throwaway `mlx_lm.server`, makes
`N × K` chat-completions calls, and tears the server down.

## Usage

```fish
# baseline: current observe.md, 3 samples/fixture, mlx on :8091
bun tools/appraisal-eval/run.ts

# score a candidate prompt variant
bun tools/appraisal-eval/run.ts --prompt /path/to/observe-candidate.md

# more samples, different port / results file
bun tools/appraisal-eval/run.ts --samples 5 --port 8092 --results tools/appraisal-eval/results/variantA.json
```

### CLI flags

| flag | default | meaning |
| --- | --- | --- |
| `--prompt <path>` | `packages/core/src/brain/limbic/prompts/observe.md` | candidate observe.md to score |
| `--fixtures <path>` | `tools/appraisal-eval/fixtures.jsonl` | fixture set |
| `--samples <n>` | `3` | samples (K) per fixture |
| `--port <n>` | `8091` | port for the harness's own mlx server (must be free) |
| `--results <path>` | `tools/appraisal-eval/results/baseline.json` | full per-sample results JSON |
| `--model <id>` | `mlx-community/Qwen3.5-2B-4bit` (from `DEFAULT_CORTEX_MODELS.hindbrain`) | mlx model id |
| `--python <path>` | `/Users/vcarl/llm-env/bin/mlx_lm.server` | mlx server entrypoint |

The mlx server is spawned in its own process group and killed in a `finally`
block plus `SIGINT`/`SIGTERM` handlers; the runner verifies the port is clear on
exit and prints `teardown ok — port clear`.

## Regenerating the fixture set

```fish
python3 tools/appraisal-eval/curate.py   # rewrites fixtures.jsonl from the log
```

`curate.py` reads `players/vcarl/logs/events.jsonl`, pulls the `{{event}}` and
`{{waitState}}` slots verbatim out of real observe exchanges in the 2026-07-13
window, and tags each with expected bounds. One fixture is **synthetic** (a
combat frame — the window has no real hostile payload) and clearly marked
`synthetic:true`.

### Fixture schema (`fixtures.jsonl`, one JSON object per line)

```jsonc
{
  "id": "hull-halluc-loggedin-0904",
  "category": "hull-hallucination",
  "source_ts": "2026-07-13T09:04:47.639Z",   // null for synthetic
  "event": "type: logged_in\n{...}",          // EXACTLY as the runtime rendered it
  "waitState": "None — not currently waiting.",
  "expected": {
    "disposition_one_of": ["discard", "accumulate"],
    "weight_range": [0, 2],
    "drive_one_of": [null, "sustenance"],
    "must_not_contain_in_reason": ["damage", "attack", ...],
    "escalate_allowed": false
  },
  "dedup_eligible": false,      // present on dedup fixtures
  "synthetic": false,           // present on the combat probe
  "old_2b_response": "{...}"     // what the OLD prompt's 2B produced (reference)
}
```

Categories: `hull-hallucination`, `ship-arrival-as-nearby`,
`status-message-flavor`, `faction-arrival`, `fuel-full`, `fuel-low-genuine`,
`navigation-arrival`, `dedup-eligible`, `dedup-chain`, `notable-chat`,
`weight-spread`, `genuine-threat`.

## Metrics

Written to the results JSON and printed as a report. `N` fixtures × `K` samples.

- **schema-valid %** — raw model text parsed to a plain JSON object carrying
  `disposition`/`weight`/`reason`.
- **drive:"null"-string %** — model emitted the *string* `"null"` for `drive`
  (a real failure mode seen in the logs) rather than JSON `null`.
- **fabrication rate** — on `must_not_contain_in_reason` fixtures, fraction of
  samples whose reason contains a forbidden term (a fabricated damage/threat
  claim). Term list mirrors `DAMAGE_CLAIM_RE` in `brain/stem/state.ts`.
- **category-error rate** — fraction of samples whose `drive` is disallowed by
  the fixture's category (e.g. tagging a benign arrival `safety`).
- **escalation false-positive %** — on `escalate_allowed:false` fixtures,
  fraction of samples that escalate (disposition `escalate`, `interrupt:true`,
  or `weight ≥ 4`).
- **guard clamped / downgraded %** — how often the runtime's post-model guards
  (`guardAppraisal`: control-plane clamp, unsupported-threat downgrade) WOULD
  fire. A diagnostic: high clamp % means the prompt is still producing output
  the mechanical guard has to rescue.
- **weight histogram + entropy** — distribution of clamped weights 0–5 and its
  Shannon entropy (spread).
- **drive histogram** — usage per drive value.
- **mean reason length** (chars).
- **echo rate (≥90%)** — fraction of reasons whose token-containment against any
  worked-example reason in the prompt is ≥ 0.9 (the model parroting an example).
- **overall pass %** and **per-category pass %** — a sample passes its fixture
  when disposition ∈ allowed, weight ∈ range, drive ∈ allowed, no forbidden
  term, and no escalation false-positive.

Metrics are computed on the **model's own appraisal** (`parseOr` → `appraise`,
i.e. after the mechanical clamp/validation that always runs, but BEFORE the
`guardAppraisal` downgrades). This is deliberate: the eval measures what the
*prompt* elicits from the model, not what the safety net rescues. Guard-fire
rates are reported separately so you can see how much the guard is compensating.

## Determinism

The runtime hindbrain call uses `temperature 0.05` (not 0) and sends no seed, so
output is not bit-deterministic. The harness matches that exactly and reports
across `K` samples rather than asserting a single deterministic answer. Raise
`--samples` for tighter estimates.

## Assembly fidelity — how this mirrors the runtime

The harness imports the SAME pure functions the runtime uses (no
reimplementation) directly from `packages/core/src`, run under `bun`:

| runtime seam (`brain/limbic/tiers-limbic.ts` → `runHindbrain`) | harness |
| --- | --- |
| loop composes the model-facing text: inserts the domain **STATUS digest** under the snapshot event's `type:` line (`brain/stem/loop.ts` submit seam, `renderer.formatEventDigest(type, state)` + `composeDigestedEventText`) | imports the SAME `formatEventDigest` (domain `event-digest.ts`) and `composeDigestedEventText`, reconstructing the fixture's `state` through the SAME `spaceMoltEventProcessor.processEvent` reducer — no hand-written digest, no hand-rolled state |
| `skills.observe.render({ event, waitState, palette, drives, axes })` | `loadSkillSync(promptPath).render({ event, waitState, palette, drives, axes })` — same `loadSkillSync`, same template engine |
| `axes` ← `renderAxisBlock(config.axes)`, where `loop.ts` derives the specs once per run via `buildAxisSpecs(drives, palette)` | same `buildAxisSpecs` + `renderAxisBlock` imports, over the same `DRIVES`/`PALETTE` values — so the axis block is the three core drives plus vcarl's five palette axes |
| `config.palette` ← `readPalette` (`players/vcarl/me/PALETTE.md`) | reads the same file verbatim |
| `config.drives` ← `readDrives`, falls back to `TEMPLATE_DRIVES` (vcarl has no `DRIVES.md`) | imports `TEMPLATE_DRIVES` |
| `parseDriveNames(drives)` | same import |
| `callTier(... "hindbrain" ...)` → `client.complete` body | `POST /v1/chat/completions` with `{ model, messages:[{role:"user",content:prompt}], temperature, max_tokens, stream:false, ...extraBody }`, params read from `DEFAULT_CORTEX_MODELS.hindbrain` (temp 0.05, max_tokens 1024, `chat_template_kwargs:{enable_thinking:false}`) |
| `appraise(parseOr(text, fallback), knownDrives)` | same `parseOr` + `appraise` imports, same fallback object |
| `guardAppraisal(event, raw)` | same import (reported as a diagnostic, not applied to the scored appraisal) |

### Known divergences (documented)

1. **Prompt template version.** The captured exchanges in the log were produced
   by an OLD `observe.md` ("sensory filter" wording). The harness re-renders the
   real event/waitState payloads through whatever `--prompt` points at (default:
   current v4 "fast gut-check"). This is intentional — the whole point is to
   score a candidate prompt against real payloads. The `old_2b_response` field
   on each fixture preserves the OLD prompt's answer for reference.
2. **Own mlx server, fresh port.** The runtime's hindbrain is served on `:8081`
   by a server `roci start` spawns on-demand; the harness spawns an independent
   `mlx_lm.server` on `:8091` (configurable) so it never touches a live run.
   Same model, same generation params.
3. **Server-side sampler defaults.** Only the params the runtime sets
   (`temperature`, `max_tokens`, `stream`, `chat_template_kwargs`) are sent; any
   other `mlx_lm.server` sampler default (top_p, etc.) is whatever that server
   version uses — identical to what the runtime gets, since the runtime sends the
   same minimal body.
4. **Scored pre-guard.** As above, metrics score the model's `appraise`-clamped
   output; the runtime additionally applies `guardAppraisal` before the value
   drives control flow. Guard-fire rates are reported so the gap is visible.
5. **No upstream dedup.** At runtime a mechanical dedup (`countRecentFingerprints`,
   40-tick window) discards most repeats BEFORE the hindbrain. The harness has no
   tick history, so `dedup-eligible` / `dedup-chain` fixtures measure how the
   model would behave if it *did* see the repeat (the `(seen Nx recently)` suffix
   on real events is preserved in the fixture text where present).
6. **Stateless digest reconstruction.** The runtime STATUS digest is built from
   the loop's *accumulated* `GameState`. The harness reconstructs each fixture's
   state by folding ONLY that fixture's event onto a healthy base state (via the
   real `spaceMoltEventProcessor`), so:
   - `full_state` / `logged_in` fixtures carry the ship+location wholesale → their
     digest fuel/hull/dock/location is exact (this is the fuel-low path).
   - `observation_update` fixtures carry no ship fields → their digest fuel/hull
     fall back to the healthy base (100%). Live, those numbers come from the prior
     accumulated `full_state`; the digest's *nearby* clause and location ARE from
     the fixture. The fingerprint is unaffected either way: the loop composes the
     digest AFTER fingerprinting `ev.text`, so the digest never perturbs dedup.
