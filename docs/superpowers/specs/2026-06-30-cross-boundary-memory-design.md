# Cross-boundary memory capture + auto-recall

**Date:** 2026-06-30
**Status:** Design approved, pending spec review

## Problem

The long-term memory system (`LongtermStore`, per-character SQLite + sqlite-vec) has
two gaps:

1. **Structured conclusions are lost.** The only automatic writer is the session-end
   reflection (`runReflection`, `packages/core/src/core/orchestrator/planned-action.ts:59-80`),
   which bulk-promotes the new tail of the *diary prose* into memory — untyped, untagged,
   `source="promotion"`. The rich **structured** outputs the phases already produce
   (orient `sections`/`whatChanged`, evaluate `judgment`/`reasoning`, the chosen plan,
   hindbrain appraisals) only reach memory incidentally, if they happened to surface in
   diary prose.
2. **Recall is effectively a no-op.** The in-container `memory search`/`recent` CLI exists
   and the conscious OpenCode agent is *told* about it
   (`packages/core/src/conscious/opencode-config.ts:93-110`), but **nothing automatically
   injects recalled memories into any prompt**, and there is no host-side retrieval Effect
   at all. Orient/decide/evaluate never see past memories.

We are **not** changing the existing bulk-diary promotion (it is intentionally left alone).
This design adds a higher-fidelity structured-capture path and the missing recall path.

## Principle

**Information a phase bothered to structure and hand across a boundary to the next phase is
memorable by default.** Salience is inherent in the architecture — no new salience model,
no threshold gate, no extra distillation call. The one negative signal is the hindbrain's
`"discard"` disposition (`Disposition = "discard" | "accumulate" | "escalate"`,
`packages/core/src/skills/types.ts:6`): discarded events never cross a boundary
(`packages/core/src/cortex/state.ts:170`), so they are never remembered. Everything
structured that survives triage and crosses a boundary gets remembered.

## Architecture

### `MemoryGateway` — one new injectable Effect

A new `Context.Tag` service that owns all memory *policy*, layered on top of `LongtermStore`
(which owns docker/CLI *shelling*). Provisioned eagerly at container startup beside
`LongtermStore` (`apps/roci/src/orchestrator.ts:169-176`) — never lazily in the loop
(per the no-hot-loading-core-infra constraint).

```
MemoryGateway {
  // Capture: normalize payload -> text, derive tags, discard-filter, dedup, write.
  remember(containerId, char, source, payload): Effect<void, Error>

  // Recall (the read path that does not exist today): shell `memory search`,
  // parse NDJSON, return ranked hits.
  recall(containerId, char, query, opts?: { k?: number; tags?: string[] }):
    Effect<ReadonlyArray<{ text: string; score: number; tags: string[] }>, Error>
}
```

`LongtermStore` gains two shelling Effects to back the gateway:

- `remember(containerId, char, { text, tags, source })` → shells `memory remember "<text>"
  --tags a,b --source <phase>`. Requires adding a `--source` flag to the generated in-container
  `memory remember` verb (small change in the CLI generator); **fallback** if we want to avoid
  touching CLI generation: encode the phase as a `phase:<name>` tag and leave `source="remember"`.
  Leaning toward `--source` for clean attribution/auditing.
- `recall(containerId, char, query, opts)` → shells `memory search "<query>" -k N [--tags …]`,
  parses the NDJSON output (one hit per line), returns ranked hits.

All tagging, discard-filtering, dedup, query construction, and char-capping live in
`MemoryGateway`. `loop.ts` only makes thin `remember`/`recall` calls.

### Capture — five boundary taps in `loop.ts`

`source` (or `phase:` tag) distinguishes structured memories from the bulk-diary dump.

| Boundary | Site (`loop.ts`) | What is written | `source` | Tags derived from |
|---|---|---|---|---|
| Hindbrain observe → escalation | per event, after `appraiseTick` (`state.ts:150-182`); `accumulatedEvents` set at `loop.ts:309` | per-event `reason` for **all non-`discard`** results (`accumulate` + `escalate`); skip the deterministic `INERT_APPRAISAL` path (`loop.ts:92-99`) | `observe` | `drive`, disposition |
| Orient → decide | after `runForebrain` returns (5a `loop.ts:321-327`, 5b `:417-424`) | each `sections[]` entry (heading + body) and `whatChanged` | `orient` | section heading, `confidence` |
| Decide → execution | after the plan is produced | plan goal + per-step intents | `decide` | — |
| Evaluate → loop | after `runConsciousEvaluate` (6a `loop.ts:470-485`) | `judgment` + `reasoning` | `evaluate` | `judgment` |

**Hindbrain volume decision:** capture **all non-`discard`** observe reasons
(`accumulate` + `escalate`) — the literal reading of the principle. This is the
highest-volume source and the longterm store is **append-only (no cull)**, so this relies
on dedup to absorb repeats. See Risks; `escalate`-only is a one-line dial if volume becomes
a problem.

**Dedup:** `MemoryGateway` keeps a rolling set of normalized-text hashes (per character,
per session). A candidate matching a recent hash is skipped before writing. Cheap,
in-process, no extra embedding call — mechanism, not a salience judgment, so it stays true
to "remembered by default."

### Recall — two injection points

- **Conscious tier (decide + evaluate):** robust (gemma 31B, 16k budget). Query built from
  orient `headline` + current task; `recall(query, { k: 5 })`; rendered as a
  "Relevant memories" block appended to the prompt.
- **Orient (forebrain):** fragile (Qwen 9B, *thinking off*, 1024-token budget, prone to JSON
  runaway). Query from `accumulatedEvents` + `emotionalWeight`; `recall(query, { k: 2 })`
  with a **hard ~300-char cap**, rendered as a one-line "You recall:" snippet.
  Deterministic top-2 + cap so it cannot destabilize the JSON output.

Recall happens in `loop.ts` (where the query context lives); recalled text is passed into the
tier callers / prompt builders as an extra input, keeping `tiers.ts` callers free of
persistence concerns.

## Data model (unchanged store, new attribution)

`memories(id, ts, source, tags, text)` + `memories_vec` (384-dim bge-small embedding),
per character at `players/<name>/me/longterm.db`. Existing `source` values:
`promotion | conscious | remember`. New values written by capture:
`observe | orient | decide | evaluate` (via the `--source` flag, or `phase:` tags as fallback).

## Testing

- **`MemoryGateway` unit tests:** tag derivation per source; `discard` results produce no
  write; dedup skips a repeated normalized text; `recall` parses NDJSON into ranked hits;
  orient recall respects the ~300-char cap.
- **Loop tests:** each boundary calls `remember` with the expected `source`; a `discard`
  observe event yields no `remember` call; recalled memories appear in the conscious prompt
  and a capped snippet in the orient prompt.
- Follow the existing fake-store pattern from `planned-action.test.ts:62-80` for an
  in-memory `MemoryGateway`/`LongtermStore` double.

## Risks & open items

- **Append-only growth (primary risk).** Capturing all non-`discard` hindbrain reasons into
  a store with no cull will grow it steadily. Dedup + recall ranking manage *relevance* but
  not *size*. Mitigations, in order of preference: (a) the `escalate`-only dial; (b) a future
  retention/pruning pass on the longterm store (out of scope here, flagged as follow-up).
- **Forebrain fragility.** Orient recall injection is the riskiest piece; the hard char cap
  and top-2 limit exist specifically to protect the thinking-off JSON output. If orient JSON
  reliability regresses, orient injection is the first thing to disable (conscious recall is
  independent and safe).
- **CLI `--source` flag.** Minor change to the generated `memory` CLI; the `phase:` tag
  fallback avoids it entirely if we'd rather not touch CLI generation.
- **Overlap with bulk promotion.** Structured captures and the diary dump will sometimes
  describe the same event at different fidelity. That's acceptable — `source` lets recall and
  audits tell them apart; we are not deduping across the two paths.
