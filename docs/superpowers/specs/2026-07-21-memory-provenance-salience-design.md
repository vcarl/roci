# Memory provenance & salience — trust-tier + character-weighted salience decay for LongtermStore

**Status:** design spec. **No code written.** Awaiting human review.
**Date:** 2026-07-21
**Base:** branch `feat/memory-provenance`, forked from `main` (65fa41c). Memory
subsystem lives under `packages/core/src/brain/limbic/hippocampus/memory/`;
identity generation under `packages/core/src/core/` (`character-scaffold.ts`,
`identity-gen/`) and `packages/core/src/services/CharacterFs.ts`. All file:line
references re-resolved against `main`'s tree on 2026-07-21.
**Supersedes** `2026-07-13-memory-provenance-freshness-design.md` (the
fixed-enum "perishability" framing). Provenance is unchanged from that version;
the freshness axis is replaced by **character-weighted salience**.

Code appears only as tiny illustrative fragments. This is a design document.

---

## TL;DR for the reviewer

- **Problem (unchanged).** A fabricated body self-report was stored, generalized
  into a standing rule, and re-injected into every episode's prompts **as settled
  fact** for ~5 hours — because retrieval ranks on semantic distance alone and the
  injection seam renders only the memory's text, discarding every trust and
  recency signal. (2026-07-07 vcarl incident; Bug #2.)
- **Two orthogonal signals.**
  - **Provenance** — an OBJECTIVE trust-tier (`grounded > episodic > inferred >
    asserted`) derived from the write path, never model-graded. Handles the
    laundering bug directly: an `inferred`-tier hallucination gets low reputation
    however salient it feels.
  - **Salience** — how strongly *this character* reacts to *this memory's* kind of
    stimulus. Drives a memory's **decay rate**: salient memories persist, trivial
    ones fade. This is the freshness axis, reborn as a continuous,
    character-defined function rather than a 3-value enum.
- **Salience is character psychology.** Each character authors a **salience
  profile** at creation (a new identity-gen step, sibling to `PALETTE.md` /
  `DRIVES.md`): a weight per stimulus dimension — the core drives + domain drive
  as a fixed spine, plus up to 2 model-named character-specific dimensions. This
  fills a real gap: today drives have per-character *prose* but no per-character
  *weighting*.
- **Memories carry a dimensional signature.** The per-event `weight` (0–5) that
  the hindbrain already computes against the drive vocabulary — and currently
  **throws away** — becomes the memory's salience signature. `salienceWeight =
  character.salience[drive] × (weight/5)`; a memory's half-life is a smooth
  function of it.
- **Ranking.** `composite = relevance × reputationWeight(provenance) ×
  recency(age, halfLife(salienceWeight))`, then annotate each injected line with
  provenance + age.
- **Phased.** Phase 1 = provenance (independent). Phase 2 = the character salience
  profile (identity-gen). Phase 3 = per-memory salience signature + salience-decay
  ranking (consumes both). See §7.
- **Out of scope:** the reputation feedback loop, the `{{synthesis}}`/macro
  surface, prompt-instruction edits beyond the inline annotation, and (v1)
  per-memory scoring of the character's *extra* dimensions — see §6.

---

## Scope

**In:** provenance trust-tier (columns, objective classify, rerank); a new
character salience-profile identity-gen step + storage + parse + read; capture of
the discarded observe `weight`/`drive` as a per-memory salience signature;
salience-modulated decay in a host-side rerank; inline provenance+age annotation
of injected memory lines; schema migration; unit tests.

**Out:** Layer C reputation feedback; `{{synthesis}}`/macro provenance; rewriting
the `"You recall"` / `"Relevant memories"` labels or adding prompt-instruction
prose; per-memory model-scoring of the character's *extra* (non-drive) dimensions
(the profile captures them, but v1 memories only score on drive dimensions — see
§3/§6); self-graded confidence.

**Two subsystems, phased.** This spec spans the memory module AND a new
identity-generation step. §7 sequences them so each phase is independently
shippable and testable.

---

## The seams this attaches to (re-resolved against `main`, 2026-07-21)

Memory-module paths under `packages/core/src/brain/limbic/hippocampus/`
(abbreviated `…/hippocampus/`); loop at `brain/stem/loop.ts`.

**Provenance / memory (Phase 1 & 3):**
- `MemoryHit` (`…/memory/longterm-store.ts:63`), `MemoryWrite`
  (`…/memory/memory-gateway.ts:7`).
- SQL builders (`…/memory/memory-sql.ts`): `buildSchemaSql:27`, `buildInsertSql:64`,
  `buildKnnSql:88`. Generated CLI (`…/memory/memory-cli.ts`) + NDJSON mirror
  (`…/memory/memory-format.ts`).
- Write extractors (`…/memory/memory-gateway.ts:20-61`); `observeMemories:20`
  **currently drops `observe.weight`** (only `disposition`/`drive` reach tags).
- Recall + injection: `store.recall` → CLI `knnSql`; `formatRecall`
  (`…/memory/memory-gateway.ts:79`) renders only `h.text`; callers
  `…/hippocampus/identity-context.ts:118`, `brain/stem/loop.ts:384`/`:923`.

**Salience profile / identity generation (Phase 2):**
- `character-scaffold.ts:87-181` (`scaffoldCharacter` — 6 sequential model-gen
  steps: background → values → palette → drives → diary → summary, each via
  `runStep` with an operator accept/regenerate/skip review loop).
- `identity-gen/prompts.ts` (per-step prompt builders; `buildPalettePrompt:43`,
  drives-personalization `:58`), `identity-gen/generate.ts:30` (`generateArtifact`
  — returns `res.text.trim()`, **no structured parsing today**).
- `core/palette.ts` (`TEMPLATE_PALETTE`, the per-character reference-frame pattern
  to mirror), `brain/limbic/hypothalamus/drives.ts` (`TEMPLATE_DRIVES`,
  `CORE_DRIVE_NAMES:22`, `parseDriveNames:43`, `renderDriveLines:36`).
- `CharacterFs.ts:44` (`CharacterConfig`), read surface `:52-67`
  (`readPalette`/`readDrives`/…), scaffold-only write of the `me/*.md` files.
- Drive taxonomy: core `safety/sustenance/agency` (`drives.ts:17-22`) + one domain
  drive appended per `DomainConfig` (`voyage` — `domain-spacemolt/src/config.ts:138`;
  `stewardship` — `domain-github/src/config.ts:264`).
- The stimulus signal: `ObserveResult.weight: number` (0–5) + `ObserveResult.drive`
  (closed vocabulary, unknown→null) in `skills/types.ts`.

---

## §1. Provenance (trust-tier) — unchanged from the 2026-07-13 spec

Objective, write-site-assigned, model-independent.

```
provenance: 'grounded' | 'episodic' | 'inferred' | 'asserted'
```

Source→provenance map (the CLI derives it from `source`, one source of truth
interpolated into the generated CLI):

| source | provenance | rationale |
|---|---|---|
| `observe`   | grounded | world-state, derived from real events |
| `promotion` | episodic | raw experiential diary record |
| `orient`    | inferred | momentary situational synthesis |
| `decide`    | inferred | plan reasoning |
| `evaluate`  | inferred | per-step judgment |
| `conscious` | asserted | agent self-authored, unvalidated |
| unknown     | asserted | conservative default |

One new `provenance` column; `reputationWeight`: grounded 1.0 · episodic 0.85 ·
inferred 0.6 · asserted 0.45.

---

## §2. Character salience profile (NEW identity-gen step)

A per-character, model-authored artifact — the structural sibling of `PALETTE.md`
(how the character *feels*) and `DRIVES.md` (what the character cares about).
Salience answers **how strongly this character reacts to each kind of stimulus.**

**Dimensions** = the drive taxonomy as a fixed spine + up to 2 model-named extras:
- Core: `safety`, `sustenance`, `agency` (always).
- Domain: the one domain drive (`voyage` / `stewardship`), injected like `DRIVES.md`.
- Extras: 0–2 character-specific dimensions the model names to capture this
  character's psyche (e.g. a haunted character adds `reputation`).

**Artifact:** `players/<name>/me/SALIENCE.md` — a reviewable, parseable line format
mirroring how `DRIVES.md` is regex-parsed (`parseDriveNames`). Each line:
`- <dimension>: <0.0-1.0>  # <short gloss in the character's voice>`. Example:

```
- safety: 0.9        # she flinches at every threat; danger dominates her attention
- sustenance: 0.4    # resource pressure barely registers until it's dire
- agency: 0.7        # being blocked or controlled cuts deep
- voyage: 0.3        # the mission is a means, not a hunger
- reputation: 0.8    # (extra) how others see her is load-bearing to her identity
```

**Generation:** a new `IdentityStep` (`salience`), a `buildSaliencePrompt` sibling
to `buildPalettePrompt`, run by `scaffoldCharacter` after `drives` (it depends on
the approved drives + values + background), through the same `runStep`
accept/regenerate/skip operator loop. Written to disk by `character-scaffold.ts`
alongside the other `me/*.md` files; a `salienceFile(body)` wrapper mirrors
`paletteFile`/`drivesFile`.

**Parse + read:** `parseSalience(md): Record<string, number>` (pure, unit-tested,
mirrors `parseDriveNames`) — one line → `{dimension: score}`, clamped to [0,1],
unknown/malformed lines dropped. `CharacterFs.readSalience(char)` reads
`SALIENCE.md`, with a `TEMPLATE_SALIENCE` graceful-degradation default (all core +
domain drives at a neutral 0.5, no extras) so a character created before this step
still ranks sanely.

**This is the first structured (numeric) identity-gen artifact.** It stays
human-reviewable prose-with-numbers (not raw JSON) to fit the existing operator
review loop; the numbers are parsed host-side.

---

## §3. Per-memory salience signature (write path)

A memory's own dimensional signature — how strongly it hit each stimulus
dimension — captured at write time from signals the tiers already produce.

**Source of the signature:** the hindbrain's `ObserveResult` already carries
`drive` (which drive the event bore on) and `weight` (0–5 intensity) — and
`observeMemories` currently **discards `weight`**. We capture it:

- **observe-writes:** `dims = { [drive]: weight / 5 }` (a single-dimension vector;
  empty when `drive` is null). Computed in the `observeMemories` extractor (it has
  `observe.weight`/`observe.drive`), threaded on `MemoryWrite.dims`, stored as a
  JSON `dims TEXT` column.
- **non-observe writes** (orient/decide/evaluate/promotion/conscious): no dims →
  stored null. These are handled by **provenance** (they are the inference/asserted
  memories); at recall they take a **neutral salience** (§4), so salience doesn't
  need to carry them.

**salienceWeight** (computed host-side at recall, per hit, against the character's
profile from §2):

```
salienceWeight(memory, salience) =
    memory.dims is empty  →  NEUTRAL_SALIENCE            // e.g. 0.4
    else                  →  Σ_d memory.dims[d] × salience[d]  /  Σ_d salience[d]   over d ∈ keys(memory.dims)
```

For v1's single-drive observe dims this reduces to the interpretable
`salience[drive] × (weight/5)` — *how much the character cares about that drive*
× *how hard the event hit it*, ∈ [0,1].

**Extras caveat (v1):** memory `dims` only ever populate drive dimensions (from
`observe.drive`), so the character's *extra* dimensions contribute nothing to any
memory's `salienceWeight` yet. They are captured in the profile (§2) and shape
future work; per-memory scoring of extras is out of scope for v1 (§6).

---

## §4. Salience-modulated decay + composite ranking

Salience enters ranking **as the decay-rate knob** (per the design decision:
"decay is informed by salience; more salient memories decay more slowly"). It is
NOT a separate multiplicative term — a fresh trivial memory and a fresh salient
memory rank equally *when fresh*; the difference is staying power as they age.

```
halfLife(s)  = HALF_LIFE_MIN × (HALF_LIFE_MAX / HALF_LIFE_MIN) ^ s     // s = salienceWeight ∈ [0,1]
recency(age,s) = 0.5 ^ (age / halfLife(s))
composite    = relevance(1/(1+distance)) × reputationWeight(provenance) × recency(age, s)
```

- `s=0` → `halfLife = HALF_LIFE_MIN` (trivial memory, fast fade); `s=1` →
  `HALF_LIFE_MAX` (deeply salient, near-permanent). Geometric interpolation gives
  a smooth continuum replacing the old fast/slow/none enum.
- Relevance stays the dominant term; the other factors are bounded ≤ 1, so we
  down-weight low-trust / faded memories without surfacing irrelevant ones.

Retrieval over-fetches `k × RERANK_OVERFETCH`, computes `composite` per hit
host-side (it needs `now` and the character salience profile), sorts desc,
truncates to `k`. Pure `rerank(hits, now, salience, knobs)` — unit-testable.

**Knobs (design §9, experimentally tunable — the explicit ask):** `HALF_LIFE_MIN`,
`HALF_LIFE_MAX`, `NEUTRAL_SALIENCE`, `reputationWeight` spread, `RERANK_OVERFETCH`.
First guesses: `HALF_LIFE_MIN ≈ 1 h`, `HALF_LIFE_MAX ≈ 30 d`, `NEUTRAL_SALIENCE ≈
0.4`, `RERANK_OVERFETCH = 4`. All live at one site in `memory-rank.ts`.

---

## §5. Injection surface

`formatRecall` renders only `h.text` today. Annotate each line with provenance +
coarse age (age makes the salience-decay visible; salience itself stays implicit
in ordering):

```
- (grounded · ~2m ago) Ship status shows docked at First Step
- (inferred · ~5h ago) The nav readout may be unreliable
```

**Scope boundary (binding):** change only the *data in the line*. Do NOT rewrite
the `"You recall"` / `"Relevant memories"` labels or author prompt-instruction
prose — that is the separate prompt-quality track.

---

## §6. Explicitly out of scope for v1

- **Per-memory scoring of extra dimensions.** Memory `dims` come from
  `observe.drive` only, so the character's model-named extras don't yet weight any
  memory. Capturing them (§2) is the substrate; scoring memories against them (a
  richer write-time signal) is later work.
- **Layer C — reputation feedback** (corroborate/contradict over time).
- **`{{synthesis}}`/macro surface** (`macro.ts` reads memories into `SYNTHESIS.md`;
  `renderMemoryHits` already shows `source:` and could later show provenance).
- **Prompt-template/instruction edits** beyond §5's annotation.
- **Retro-scoring existing memories.** Legacy rows get null dims (neutral
  salience) and `episodic`/... provenance defaults via migration; no backfill.

---

## §7. Phasing / implementation order

Three phases, each independently shippable and testable:

- **Phase 1 — Provenance (memory module, self-contained).** Columns + objective
  `classify(source)` + CLI stamps/migrates/emits + `MemoryHit.provenance` + rerank
  by `relevance × reputationWeight` (no salience term yet; recency omitted or
  uniform). Ships trust-aware recall on its own. *(This is ~the old plan's Tasks
  1-4, minus perishability.)*
- **Phase 2 — Character salience profile (identity-gen, self-contained).** The
  `salience` `IdentityStep` + `buildSaliencePrompt` + `TEMPLATE_SALIENCE` +
  `salienceFile` + `scaffoldCharacter` wiring + `parseSalience` +
  `CharacterFs.readSalience`. Deliverable: a scaffolded character gets a reviewed
  `SALIENCE.md`; `parseSalience` round-trips. No memory-ranking dependency.
- **Phase 3 — Salience-decay ranking (joins them).** `dims TEXT` column;
  `observeMemories` captures `{drive: weight/5}`; CLI stores/emits `dims`;
  `MemoryHit.dims`; `salienceWeight` + `halfLife` + salience-modulated `recency`
  in `memory-rank.ts`; gateway loads the profile (`readSalience`, parsed) and
  feeds it into `rerank`; inline annotation (§5).

Each phase is its own implementation plan. Phase 1 can merge before Phases 2-3
exist. Phase 3 depends on both 1 and 2.

---

## §8. Testing

Pure-function unit tests, matching the fake-store style:

- **Provenance (P1):** `classify` mapping; SQL column shape; CLI script embeds
  classify/migration/emit; `reputationWeight` ordering; migration idempotency
  guard present.
- **Salience profile (P2):** `parseSalience` (well-formed lines → map, clamp to
  [0,1], drop malformed, core+domain dims present, ≤2 extras); `TEMPLATE_SALIENCE`
  parses; `buildSaliencePrompt` includes drives + values context; `scaffoldCharacter`
  writes `SALIENCE.md` (fake generator).
- **Salience ranking (P3):** `observeMemories` captures `{drive: weight/5}` and
  drops it when drive is null; `salienceWeight` (single-drive reduction; neutral
  when dims empty); `halfLife` monotonic in `s` (s=0→MIN, s=1→MAX); `recency`
  0.5 at one half-life; `rerank` — a salient memory outlives a trivial one at
  equal relevance as age grows; relevance still dominates when trust/salience
  equal; `formatRecall` annotation.

No live sqlite-vec ranking test (consistent with current coverage); knob
validation is behavioral via a QA run (§9).

---

## §9. Open decisions / knobs to validate

- **Decay knobs** (`HALF_LIFE_MIN/MAX`, `NEUTRAL_SALIENCE`) are first-guesses and
  the explicit target of experimental tuning. Validate in a roci QA run: do
  salient memories persist and trivial ones fade at psychologically plausible
  rates? Tune the single knob site.
- **Salience score interpretation:** should salience *also* directly boost rank
  (not only slow decay), so a highly-salient memory is more prominent even when
  fresh? v1 says decay-only (per the design decision); revisit if QA shows salient
  memories under-surfacing early.
- **Profile read cost:** `readSalience` per recall (3 call sites). If measurable,
  cache the parsed profile per character in the gateway.
- **Extras activation:** when/how memories get scored on the character's extra
  dimensions (the natural Phase 4).
