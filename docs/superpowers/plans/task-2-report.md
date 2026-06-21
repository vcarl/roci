# Task 2 Report: `terminalCause` field in run-digest

## Files Changed

- `apps/roci/src/qa/digest.ts` — Added `terminalCause: string | null` to `RunDigest` interface; added `TERMINAL_RANK` and `TERMINAL_CAUSE` lookup tables; added internal `RunDigestInternal` interface with `_terminalRank: number` to track current cause rank across folds; updated `emptyDigest` to initialize both fields; updated `foldDigest` to compute/propagate `terminalCause` and `_terminalRank`.
- `apps/roci/src/qa/digest.test.ts` — Added four new tests under `describe("terminalCause", ...)`.
- `apps/roci/src/qa/baseline.test.ts` — Updated the manual `RunDigest` fixture helper to include `terminalCause: null` (required by the new field on the interface; TypeScript caught this at compile time).

## Exact Test Cases Added (digest.test.ts)

1. `"FATAL_ERROR anomaly sets terminalCause to its summary"` — folding `[SESSION_START, FATAL_ERROR]` yields `terminalCause` containing `"tier=conscious"`.
2. `"FATAL_ERROR wins over subsequent PROCESS_DIED (precedence)"` — folding `[SESSION_START, FATAL_ERROR, PROCESS_DIED]` still yields `terminalCause` containing `"tier=conscious"` (FATAL_ERROR rank 3 beats PROCESS_DIED rank 2).
3. `"PROCESS_DIED-only sets terminalCause to its summary"` — folding `[SESSION_START, PROCESS_DIED]` yields `terminalCause` containing `"session process 45107 exited"`.
4. `"no terminal records yields terminalCause null"` — folding `[SESSION_START, STALL]` yields `terminalCause === null`.

## Pre-existing Tests Updated

- `apps/roci/src/qa/baseline.test.ts` — The `digest()` helper constructed a `RunDigest` object without `terminalCause`. TypeScript `tsc --noEmit` flagged this as `TS2741` (missing required property). Added `terminalCause: null` to the fixture. No logic change; purely a type-correctness fix expected when a new required field is added.

## Test Commands & Results

```
pnpm vitest --run apps/roci/src/qa/digest.test.ts
# 7 tests passed (4 new + 3 existing)

pnpm vitest --run apps/roci/src/qa/
# 29 tests passed across 6 test files — no regressions

pnpm tsc --noEmit -p apps/roci/tsconfig.json
# no errors
```

## Implementation Note

The `_terminalRank: number` internal field is stored on the digest object (typed as `RunDigestInternal`, a private extension of `RunDigest`) but not exposed in the public `RunDigest` interface. This keeps the fold pure (same input → same output) without requiring a separate rank argument or global mutable state. External consumers see only `terminalCause: string | null`.

## Concerns

None. Implementation is straightforward and all tests pass cleanly.

---

## Fix: _terminalRank leak

### Problem

`monitor.ts` serialized the raw `digest` object with `JSON.stringify(digest, null, 2)`, and `_terminalRank` is an enumerable own property on the internal `RunDigestInternal` type, so it leaked into every `run-digest.json` output as `"_terminalRank": 3`.

### Changes

**`apps/roci/src/qa/digest.ts`** — Added and exported `toPublicDigest(d: RunDigest): RunDigest` immediately before `foldDigest`. It destructures `_terminalRank` off the internal shape and returns the remaining fields as a plain `RunDigest`:

```ts
export function toPublicDigest(d: RunDigest): RunDigest {
  const { _terminalRank: _, ...rest } = d as RunDigestInternal
  return rest
}
```

The fold logic and `RunDigestInternal` internals are unchanged — `_terminalRank` is still threaded through the fold for precedence tracking; it is only stripped at the serialization boundary.

**`apps/roci/src/qa/monitor.ts`** — Updated the single `writeFile` call in `finalise()` to serialize `toPublicDigest(digest)` instead of raw `digest`. Also added `toPublicDigest` to the import. There is only one place the digest is written to disk.

**`apps/roci/src/qa/digest.test.ts`** — Added a new `describe("toPublicDigest", ...)` block with one test that:
- Folds a sequence ending in `FATAL_ERROR` (so `_terminalRank` is set to 3 on the internal object)
- (a) Asserts `pub.terminalCause` still contains `"tier=conscious"`
- (b) Asserts `Object.prototype.hasOwnProperty.call(pub, "_terminalRank") === false`
- (c) Asserts `JSON.stringify(pub)` does not contain the substring `"_terminalRank"`

### Test Command Output

```
pnpm vitest --run apps/roci/src/qa/digest.test.ts
✓ |roci| src/qa/digest.test.ts (8 tests) 2ms
Test Files  1 passed (1)
     Tests  8 passed (8)

pnpm vitest --run apps/roci/src/qa/
✓ |roci| src/qa/render.test.ts (2 tests) 1ms
✓ |roci| src/qa/baseline.test.ts (4 tests) 1ms
✓ |roci| src/qa/feed.test.ts (6 tests) 2ms
✓ |roci| src/qa/markers.test.ts (7 tests) 2ms
✓ |roci| src/qa/digest.test.ts (8 tests) 2ms
✓ |roci| src/qa/ingest.test.ts (3 tests) 2ms
Test Files  6 passed (6)
     Tests  30 passed (30)
```
