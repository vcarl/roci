# Local, Interactive Character Creation — Design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Surface:** `roci setup` / character scaffolding

## Summary

Replace the current character-creation path — a one-shot, Claude-in-a-throwaway-container
scaffold with silent template fallback — with an **orchestrator-driven, step-by-step wizard**
that:

1. generates each identity artifact with a **local mlx model** (no Claude, no container),
2. lets the operator **review / edit / regenerate** each artifact before moving on, with later
   steps informed by approved earlier ones,
3. emits the new **5-emoji-gradient palette** format, and
4. seeds **DIARY.md** with a character-fitting structure the model designs.

If the local model is unreachable or returns empty content, the wizard **fails hard** with a
clear error — it does not write boilerplate and report success.

## Motivation

- **Replace Claude with a local model.** Character creation is the last scaffold path still
  reaching frontier Claude (`claude -p --model sonnet` inside a `roci-scaffold-*` container,
  gated on `.oauth-token`). The project already runs local mlx tiers for the cortex loop; creation
  should use them too. This is a replacement, not a fallback — Claude is removed from this path.
- **Silent fallback masks broken setups.** Today, any generation failure is swallowed
  (`character-scaffold.ts:193,225`) and the wizard writes placeholder templates while reporting
  "AI generation failed, using templates" — or worse, a half-filled character. The QA run that
  motivated this work found `players/kvothe` with unfilled boilerplate `background.md`/`VALUES.md`,
  exactly this masked-failure mode. We want truthful failure instead.
- **One-shot generation can't be tuned or collaborated on.** The single combined
  `---BACKGROUND---/---VALUES---/---PALETTE---` prompt (`character-scaffold.ts:49-69`) produces all
  three artifacts in one call with no opportunity for human feedback. Splitting into per-artifact
  steps unlocks both interactive review and easy prompt fine-tuning.
- **Richer emotional palette.** The current 2-emoji pole-pair palette works well; we want each
  axis expressed as a 5-emoji gradient so the character can paint finer-grained feeling.
- **Diary should start with usable structure.** `DIARY.md` is seeded today as a bare `# Diary`
  header. A character-fitting structure gives the cortex stable slots to read and maintain.

## Current state (what we're replacing)

`packages/core/src/core/character-scaffold.ts`:

- `scaffoldCharacter()` resolves `scaffoldIdentity` → `"smart"` → `"sonnet"` (Claude) and
  `scaffoldSummary` → `"fast"` → `"haiku"` (`:113-114`).
- With a `characterDescription`, it `Effect.acquireUseRelease`s a temp Docker container
  (`:129-225`): builds the domain image, creates+starts the container, runs `init-firewall.sh`,
  calls `runTurn` twice (identity via combined-delimiter prompt, then a 4-sentence summary),
  then stops+removes the container.
- `buildIdentityPrompt` (`:40-69`) emits the combined-delimiter prompt; `parseIdentityOutput`
  (`:71-81`) regex-splits the three sections.
- Every failure path falls back to templates via `Effect.catchAll` (`:193,213,225`) and the file
  loop never overwrites existing files (`:258-266`).
- Requires services `Docker | CommandExecutor | CharacterLog | OAuthToken`.

`packages/core/src/core/palette.ts`: `TEMPLATE_PALETTE` is five 2-emoji pole-pair lines;
`paletteFile()` wraps a body in the `# Palette` header + guide comment.

`packages/core/src/skills/observe.md` (`:31-36`): the **consumer-side** instruction telling the
hindbrain how to read `{{palette}}` and paint `emotionalWeight` ("lean toward a pole … more emoji
for a stronger feeling"). **There is no parser for the palette** — the body is injected verbatim
into the prompt (`cortex/tiers.ts:79`) and read semantically. The palette format change is
therefore a prompt/format change, not a parser change.

`apps/roci/src/setup/guided-setup.ts`: collects name + description via `@effect/cli` `Prompt`,
calls `scaffoldCharacter()`, logs the summary. No per-field review loop.

## Design

### Architecture

- **Reach the model directly over HTTP**, reusing the cortex path: `ModelClient.complete(handle,
  messages)` under `ModelService.withTier` (see `cortex/tiers.ts:55-64`). No throwaway container,
  no `runTurn`, no `Docker`/`OAuthToken` dependency on this path. The `Effect.acquireUseRelease`
  container block (`character-scaffold.ts:129-225`) is deleted.
- **Model:** Use the same model as the conscious thought part of the codebase. Our final report should include notes on how to evaluate this output to compare alternate model choices.
- **Hard-fail:** if the tier can't be acquired (`ReadinessError`/`SpawnError`) or any step returns
  empty `content`, the wizard surfaces a clear, typed error and stops. No silent template write.
- **Module split (design-for-isolation):** extract prompt building + the local-model call into a
  new `packages/core/src/core/identity-gen/` module exposing pure per-artifact prompt builders and
  a thin generator that calls `ModelClient`. `character-scaffold.ts` becomes the orchestration +
  file-writing layer. This keeps prompts isolated and individually testable/tunable (see
  Follow-ups).

### Step sequence

Each step's prompt includes the **approved** artifacts from prior steps, so the character stays
coherent across documents.

1. **Background** — from name + description + domain `backgroundHints`.
2. **Values** — sees approved background + domain `valuesHints`.
3. **Palette** — sees approved background + values; emits the new gradient format.
4. **Diary skeleton** — sees approved background + values; the model designs a diary *structure*
   that fits the character (see Diary below).
5. **Summary** — the existing 4-sentence identity summary, from the approved background.

`SECRETS.md` remains a bare seed (`# Secrets`), unchanged.

### Per-step review loop

After each generated artifact, the wizard presents it and offers (via `@effect/cli` `Prompt`):

- **[a]ccept** — keep as-is, advance.
- **[e]dit** — open the text for hand-editing; the edited version becomes the approved artifact and
  feeds forward.
- **[r]egenerate** — re-roll with an optional free-text **feedback note** that is appended to the
  step's prompt to steer the new generation.
- **[s]kip** — write the plain seed template for this artifact instead of a generated one (an
  explicit operator choice, distinct from a silent failure fallback).

Approved artifacts and any edits/feedback carry forward into later steps' prompt context.

### Palette format: 5-emoji axis gradient + intensity

Each row stays a single emotional **axis**, now expressed as **5 emoji** stepping from one pole
through the middle to the other, with a `poleA → poleB` gloss. Keep ~4–6 rows. Example body:

```
🌊 💧 😶 🌤️ ☁️   # sinking → soaring
😱 😟 😐 🙂 😌   # panic → calm
🔥 😤 😐 🧘 🥶   # fury → numb
```

The reader paints `emotionalWeight` by **picking a position along the gradient** and **repeating an
emoji for intensity** (e.g. `😟😟😟` = deep toward panic), mixing axes when a feeling is tangled.

Files touched:

- `palette.ts` — `TEMPLATE_PALETTE` → gradient rows; `paletteFile()` header guide → the
  pick-position + repeat-for-intensity explanation.
- `skills/observe.md` (`:31-36`) — update the read-the-palette instruction and the inline examples
  to the gradient model. Check `skills/orient.md` for any palette reference and align it.
- `skills/types.ts` — update the `emotionalWeight` doc comment from "pole-lean = position" to the
  gradient semantics.
- `identity-gen` palette prompt builder — ask for 4–6 five-emoji gradient axes in this format.

### Diary: model-designed structure

The diary step prompts the model to **design a diary structure in keeping with the character's
values**, rather than imposing fixed sections. The prompt offers **8 example structures** as a
menu to choose from or adapt, e.g.:

1. Standing sections (Relationships / Open Threads / Grudges & Debts) + a dated Running Log.
2. A ship's/captain's log — chronological, terse, operational.
3. A field naturalist's catalog — cataloged finds/observations with annotations.
4. A ledger of debts and favors owed/owing.
5. A confessional — private reflections addressed to someone.
6. A maintenance log — systems, faults, fixes, recurring worries.
7. A coded manifest / smuggler's shorthand.
8. A star-chart / route annotation system.

The model picks or adapts one that fits, and seeds it with character-appropriate placeholder
structure (and may pre-fill standing slots from the approved background). Output is reviewable like
the other steps. The fixed 8 are inspiration, not an enum — the model may blend them.

### Error handling

- Tier acquisition failure or empty `content` at any step → typed error, wizard stops with a clear
  message naming the failed step. No partial/boilerplate character is written silently.
- `[s]kip` is the *only* path to a plain template for an artifact, and it is an explicit operator
  action.
- Existing-file protection is retained: the wizard never overwrites a file that already exists.

## Files changed / added

| File | Change |
| --- | --- |
| `packages/core/src/core/identity-gen/` (new) | Per-artifact prompt builders (background, values, palette, diary, summary) + a thin `ModelClient`-based generator. Pure, individually testable. |
| `packages/core/src/core/character-scaffold.ts` | Remove container/`Docker`/`OAuthToken`/`runTurn` path; orchestrate the per-step generators; hard-fail instead of template fallback; keep file-writing + existing-file protection. |
| `packages/core/src/core/palette.ts` | Gradient `TEMPLATE_PALETTE`; updated header guide. |
| `packages/core/src/skills/observe.md` | Gradient read-instruction + examples. |
| `packages/core/src/skills/orient.md` | Align any palette reference. |
| `packages/core/src/skills/types.ts` | `emotionalWeight` doc comment → gradient semantics. |
| `apps/roci/src/setup/guided-setup.ts` | Per-step review/edit/regenerate/skip loop; thread approved artifacts forward. |
| model config (`model-config.ts` / handle spec) | Define the local creation tier/handle; drop the `scaffoldIdentity→smart→sonnet` Claude mapping. |
| tests | See below. |

## Testing

- **Prompt builders** (pure): each builder includes the expected fields and approved-prior context;
  snapshot the structure (not exact prose).
- **Palette format:** `TEMPLATE_PALETTE` parses as 4–6 rows of 5 emoji + gloss; `paletteFile()`
  header carries the intensity note.
- **Review-loop state machine:** accept / edit / regenerate(+feedback) / skip transitions, and that
  approved/edited artifacts feed forward into later prompts. Drive with a **mockable `ModelClient`**
  (no live mlx needed in unit tests).
- **Hard-fail:** an unreachable tier or empty `content` produces the typed error and writes no
  files (beyond an explicit skip).
- A live, model-dependent smoke (gated, like the existing mlx smokes) generates one character
  end-to-end against a real local tier.

## Out of scope

- The non-interactive / CI character-creation path and the `setup`-hangs-on-registration-code
  issue the QA found (separate known issue).
- An opencode-agent version of creation (the in-container `--agent` route). We chose
  orchestrator-driven direct-HTTP instead.
- Any domain `setupCharacter` changes (SpaceMolt registration code, GitHub PAT/repos).

## Follow-ups (not gating)

- **Prompt fine-tuning pass.** Once the wizard works end-to-end, review the exact generation
  prompts for each step and tune them. The `identity-gen` module keeps each prompt as an isolated,
  readable builder specifically to make this easy. This is a planned follow-up, **not** a gate on
  landing the working implementation.
- Empirically confirm the pinned local creation model on prose quality.
