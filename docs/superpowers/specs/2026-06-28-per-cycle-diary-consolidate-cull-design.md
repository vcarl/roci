# Per-cycle diary: consolidate → cull

**Status:** approved design, pre-implementation
**Date:** 2026-06-28

## Problem

The character diary does not maintain a stable size and, in practice, was not
growing at all. Three separate mechanisms touched `DIARY.md` with inconsistent
triggers:

- **Per-step diary append** (core cortex loop) — appends a short reflection
  after every evaluate. *(Added in the immediately-preceding change.)*
- **Dinner phase** (`domain-spacemolt/src/dinner.ts`) — at the social-phase
  boundary, rewrites the whole diary from the session report. Spacemolt-only.
- **Dream compression** (`core/.../hippocampus/dream.ts`) — compresses the
  diary, but only when it exceeds a hard `200`-line gate
  (`DIARY_COMPRESSION_THRESHOLD` / `dreamThreshold`).

Because the dream only fired above 200 lines and the diary rarely reached that,
the cull effectively never ran; and consolidation existed only for spacemolt.

## Goal

A single, domain-agnostic **capture → consolidate → cull** rhythm that keeps
`DIARY.md` hovering near a stable target size, running **every orchestrator
cycle** for all domains.

## Design

### Timescales

```
DURING a session (active cortex loop):
  each step → diary append   [exists]   → accumulates raw, verbose detail

AT the reflection boundary (once per orchestrator cycle, EVERY cycle, all domains):
  1. CONSOLIDATE  prior diary + session's raw appends → coherent entries
  2. CULL (dream) rewrite toward target size, clamped to never grow the file
```

The per-step append remains the raw capture. The boundary pass refines then
trims. Net effect: filesize stabilizes near the target instead of sawtoothing.

### 1. Consolidate pass (new, core)

A dedicated model turn (same `runTurn` + skill-template pattern as `dream`) that
reads the prior diary plus the session's accumulated detail and rewrites it into
coherent narrative entries. This **generalizes the spacemolt `dinner.ts`** logic
into core so every domain gets it.

- Lives in core, invoked from `runReflection`
  (`core/src/core/orchestrator/planned-action.ts`), before the cull.
- New skill prompt file (e.g. `core/src/skills/consolidate.md`).
- May *increase* file size — that is acceptable; the cull reins it in next.

### 2. Cull pass (modify existing dream)

- **Unconditional:** remove the `diaryLines > dreamThreshold` gate in
  `planned-action.ts`. The dream runs every cycle.
- **Targets a stable size:** new constant `DIARY_TARGET_LINES = 150` (tunable),
  replacing `DIARY_COMPRESSION_THRESHOLD = 200`. The cull prompt is instructed
  to compress toward this target.
- **Hard invariant — cull never grows the file.** After the cull model call,
  compare output size to input size; **if the output is larger than the input,
  discard the output and keep the input**, and log a warning. A misbehaving
  model can never inflate the file. (Measured in lines, consistent with the
  target unit.)
- The same never-larger invariant is applied to the `SECRETS.md` compression the
  dream already performs.
- Existing dream-type flavor (normal / good / nightmare selection) and the
  secrets-compression step are **retained**.

### 3. Removals / cleanup

- `domain-spacemolt/src/dinner.ts` and its phase wiring → **removed**, folded
  into the core consolidate pass. Remove the dinner skill/template if unused
  elsewhere.
- The `>200` dream gate in `planned-action.ts` → removed.
- `DIARY_COMPRESSION_THRESHOLD = 200` (spacemolt `phases.ts`) and the github
  `tempo.dreamThreshold = 200` → replaced by `DIARY_TARGET_LINES = 150`.
- Verify no dangling references after dinner removal; spacemolt phase sequence
  must remain valid (the former social/dinner phase boundary still transitions
  correctly).

## Parameters

| Name | Value | Notes |
|------|-------|-------|
| `DIARY_TARGET_LINES` | `150` | stable target the cull compresses toward; tunable constant |
| cull invariant | output lines ≤ input lines | else keep input, log warning |
| boundary model calls | 2 per cycle | consolidate + cull; once per session-ish, modest cost |

## Cost / behavior

- Two model calls per **cycle** (not per step) — once per session-ish.
- Cull is monotonic non-increasing and aims at the target, so filesize
  stabilizes near `DIARY_TARGET_LINES` rather than climbing to a hard cap.

## Testing

- **Consolidate:** produces a non-empty, coherent diary from raw per-step
  appends + prior diary.
- **Cull never-grows invariant (key safety test):** given a model that returns a
  *longer* string than the input, the original diary is kept unchanged and a
  warning is logged.
- **Cull target:** an oversized diary is compressed toward `DIARY_TARGET_LINES`.
- **Gate removal:** the dream fires even on a small (<150-line) diary.
- **Dinner removal:** no dangling references; spacemolt phases still typecheck
  and the phase sequence is intact.

## Out of scope

- Tuning the consolidate/cull prompts for quality beyond "coherent and within
  target" — iterate later against live runs.
- Changing the per-step append behavior (kept as-is).
- Byte/token-based sizing — lines are the unit for now.
