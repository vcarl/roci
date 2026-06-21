# Task 1 Report — `FATAL_ERROR` anomaly detector

## Files Changed

- `apps/roci/src/qa/types.ts` — added `"FATAL_ERROR"` to `AnomalyType` union
- `apps/roci/src/qa/feed.ts` — added `FATAL_ERROR` branch in `reduce()` alongside the existing `kind:"error"` branch
- `apps/roci/src/qa/feed.test.ts` — added 3 new test cases

## Test Cases Added (feed.test.ts)

1. **Model-call fatal event** — a `kind:"system"` event with the real crash fixture message
   (`Fatal error: Model call failed [tier=conscious model=mlx-community/Qwen3.5-122B-A10B-4bit ...]`)
   emits one anomaly with `type:"FATAL_ERROR"`, `severity:"error"`, summary containing `tier=conscious`,
   and `refs.tier === "conscious"`.

2. **Generic fatal event** — a `kind:"system"` event `Fatal error: something unexpected`
   emits a `FATAL_ERROR` anomaly whose summary contains `something unexpected`; does not throw.

3. **Guard against over-matching** — a normal `kind:"system"` event (`hindbrain: discard 😐`)
   emits no `FATAL_ERROR` anomaly.

## Test Runs

### Before implementation (confirming failures)
```
❯ |roci| src/qa/feed.test.ts (6 tests | 2 failed)
  ✓ reduce > emits SESSION_START on the very first event
  ✓ reduce > counts a tick per hindbrain pass and stamps transitions with it
  ✓ reduce > emits an ERROR anomaly for kind:error events
  × reduce > emits a FATAL_ERROR anomaly for a model-call fatal system event
    → expected undefined to be 'FATAL_ERROR'
  × reduce > emits a FATAL_ERROR anomaly for a non-model-call fatal system event
    → expected undefined to be 'FATAL_ERROR'
  ✓ reduce > does not emit a FATAL_ERROR anomaly for a normal system event
```

### After implementation (feed.test.ts only)
```
✓ |roci| src/qa/feed.test.ts (6 tests) 2ms
Test Files  1 passed (1)
     Tests  6 passed (6)
```

### Full QA suite
```
✓ |roci| src/qa/render.test.ts (2 tests) 1ms
✓ |roci| src/qa/digest.test.ts (3 tests) 1ms
✓ |roci| src/qa/baseline.test.ts (4 tests) 2ms
✓ |roci| src/qa/feed.test.ts (6 tests) 2ms
✓ |roci| src/qa/markers.test.ts (7 tests) 2ms
✓ |roci| src/qa/ingest.test.ts (3 tests) 1ms

Test Files  6 passed (6)
     Tests  25 passed (25)
```

## Concerns

None. The implementation is minimal (29 lines in feed.ts, 1 line in types.ts) and matches the plan spec exactly. The `SESSION_START` transition is still emitted before the early `return` because the FATAL_ERROR branch is placed after the `started` block but before the `classifyEvent` call, which is the correct order per the existing pattern.
