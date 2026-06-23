# Task 3 Report — DEGRADED_TIER anomaly detector

## Fixture string found

File: `players/kvothe/logs/events.jsonl`, line 22

```
{"timestamp":"2026-06-21T18:07:33.070Z","character":"kvothe","system":"cortex","subsystem":"cortex","kind":"system","message":"hindbrain: undefined undefined"}
```

The exact message field value used as the fixture:

```
hindbrain: undefined undefined
```

The fixture was present in `events.jsonl` — no need to fall back to `session.log`.

## Regex used

```
/^(hindbrain|forebrain|conscious): undefined\b/
```

No deviation from the plan's suggested regex. The real string `hindbrain: undefined undefined` matches at the word boundary after the first `undefined`, and the capture group correctly extracts `hindbrain` as the tier.

## Files changed

- `apps/roci/src/qa/types.ts` — Added `"DEGRADED_TIER"` to `AnomalyType` union.
- `apps/roci/src/qa/feed.ts` — Added DEGRADED_TIER branch in `reduce()` before the `classifyEvent` call, with early-return.
- `apps/roci/src/qa/feed.test.ts` — Added 3 new tests for DEGRADED_TIER (1 positive, 2 negative).

## Test cases

1. `hindbrain: undefined undefined` → emits `DEGRADED_TIER`, severity `"warn"`, `refs.tier === "hindbrain"`. ✓
2. `hindbrain: accumulate 😊😊😊` → no `DEGRADED_TIER` anomaly. ✓
3. `forebrain (in-session): docked — docked` → no `DEGRADED_TIER` anomaly. ✓

## Test command output

```
pnpm vitest --run apps/roci/src/qa/feed.test.ts
✓ src/qa/feed.test.ts (9 tests) 2ms
Tests: 9 passed

pnpm vitest --run apps/roci/src/qa/
✓ src/qa/render.test.ts (2 tests)
✓ src/qa/baseline.test.ts (4 tests)
✓ src/qa/markers.test.ts (7 tests)
✓ src/qa/digest.test.ts (8 tests)
✓ src/qa/feed.test.ts (9 tests)
✓ src/qa/ingest.test.ts (3 tests)
Test Files: 6 passed | Tests: 33 passed
```

## Concerns

None. The fixture was in `events.jsonl` exactly as described, the regex matched without adjustment, and the implementation is minimal (16 lines in feed.ts, no structural changes).
