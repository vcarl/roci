# Memory Provenance — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every long-term memory an objective, write-site-assigned trust-tier (`provenance`), rerank recall by it, and annotate each injected memory line with its provenance + age — so unverified inferences stop being recalled and rendered as settled fact.

**Architecture:** The memory store is a per-character sqlite-vec db driven by a *generated* in-container bun CLI. `provenance` is derived from a single pure taxonomy (`classify(source)`) unit-tested in TS and interpolated into the generated CLI (the same generate-time reuse the SQL builders use). One new DB column carries it; a guarded `ALTER TABLE` migration backfills existing dbs. Retrieval over-fetches, then a pure host-side `rerank(hits, k)` sorts by `relevance × reputationWeight(provenance)` and truncates to `k`. The injection formatter annotates each line with provenance + coarse age.

**Scope note — this is Phase 1 of 3** (see `docs/superpowers/specs/2026-07-21-memory-provenance-salience-design.md` §7). Phase 1 = provenance only; **no salience, no recency/decay term yet** (recency returns in Phase 3 as salience-modulated decay). Phase 1 is independently shippable. The `formatRecall(…, nowMs, …)` signature and the `memory-rank.ts` module are introduced here in shapes that Phase 3 extends.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Effect (`Clock`), vitest, sqlite-vec via `bun:sqlite` (generated CLI), Docker exec.

## Global Constraints

- **Base branch:** `feat/memory-provenance` (forked from `main` 65fa41c). Work in the worktree `/Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance`. Paths below are relative to that worktree root.
- **Memory module dir:** `packages/core/src/brain/limbic/hippocampus/memory/` (abbreviated `MEM/`).
- **ESM imports:** every relative import specifier ends in `.js`.
- **Provenance enum (exact, ordered high→low trust):** `grounded | episodic | inferred | asserted`.
- **Source→provenance map (exact, binding):** `observe→grounded`, `orient→inferred`, `evaluate→inferred`, `decide→inferred`, `promotion→episodic`, `conscious→asserted`, unknown→`asserted`.
- **Reputation weights (exact):** grounded 1.0 · episodic 0.85 · inferred 0.6 · asserted 0.45.
- **Rerank over-fetch factor:** `RERANK_OVERFETCH = 4`.
- **Legacy-row migration default (exact):** `provenance='episodic'`.
- **Test command (single file):** `pnpm vitest --run <path>`. **Package suite:** `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory`. **Typecheck (no cache):** `pnpm nx run @roci/core:typecheck --skip-nx-cache`.
- **Every commit is green:** each task ends with the full memory suite passing AND `@roci/core` typechecking (tests included). The pre-commit hook runs a full nx build; do not use `--no-verify` on a code task.
- **Commits:** conventional-commit style; end the body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Do not touch:** the `{{synthesis}}`/macro surface (`macro.ts`), prompt templates (`skills/*.md`), or CLI override flags. Provenance is derived from `source`, never model-graded.

---

## File Structure

**New files**
- `MEM/memory-provenance.ts` — `Provenance` type, `SOURCE_PROVENANCE`, `PROVENANCE_DEFAULT`, `classify`, `MIGRATION_COLUMNS`. (Task 1)
- `MEM/memory-provenance.test.ts` (Task 1)
- `MEM/memory-rank.ts` — `RERANK_OVERFETCH`, `REPUTATION_WEIGHT`, `reputationWeight`, `compositeScore`, `rerank`. (Task 4)
- `MEM/memory-rank.test.ts` (Task 4)

**Modified files**
- `MEM/memory-sql.ts` — add `provenance` to schema/insert/knn SQL. (Task 2)
- `MEM/memory-cli.ts` — interpolate taxonomy + migration; classify at write; emit column. (Task 3)
- `MEM/memory-format.ts` — carry `provenance` through `MemoryRow` + `formatResults`. (Task 3)
- `MEM/longterm-store.ts` — add `provenance` to `MemoryHit`. (Task 4)
- `MEM/memory-gateway.ts` — over-fetch + rerank in `recall`; annotate `formatRecall`. (Task 4)
- Their `.test.ts` siblings.

**Task order (each commit green):** Task 1 taxonomy → Task 2 SQL column → Task 3 CLI+formatter (write path) → Task 4 provenance-aware recall (MemoryHit + rank + gateway, one cohesive commit) → Task 5 integration verify. The write path (2-3) precedes the read path (4) because the SQL/CLI files never reference `MemoryHit`/`formatRecall`; `MemoryHit`'s new required field, the rank module, the `formatRecall` signature change, and the gateway test rewrite are mutually dependent and land together.

---

### Task 1: Provenance taxonomy (pure)

**Files:**
- Create: `packages/core/src/brain/limbic/hippocampus/memory/memory-provenance.ts`
- Test: `packages/core/src/brain/limbic/hippocampus/memory/memory-provenance.test.ts`

**Interfaces:**
- Produces: `type Provenance = "grounded"|"episodic"|"inferred"|"asserted"`, `const SOURCE_PROVENANCE: Record<string, Provenance>`, `const PROVENANCE_DEFAULT: Provenance`, `function classify(source: string): Provenance`, `const MIGRATION_COLUMNS: ReadonlyArray<{ name: string; ddl: string }>`.

- [ ] **Step 1: Write the failing test**

Create `memory-provenance.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { classify, SOURCE_PROVENANCE, PROVENANCE_DEFAULT, MIGRATION_COLUMNS } from "./memory-provenance.js"

describe("classify", () => {
  it("maps each known source to its binding provenance tier", () => {
    expect(classify("observe")).toBe("grounded")
    expect(classify("promotion")).toBe("episodic")
    expect(classify("orient")).toBe("inferred")
    expect(classify("decide")).toBe("inferred")
    expect(classify("evaluate")).toBe("inferred")
    expect(classify("conscious")).toBe("asserted")
  })
  it("falls back to asserted for an unknown source", () => {
    expect(classify("mystery")).toBe("asserted")
    expect(classify("")).toBe(PROVENANCE_DEFAULT)
  })
  it("SOURCE_PROVENANCE has an entry for every cortex write source", () => {
    for (const s of ["observe", "orient", "evaluate", "decide", "promotion", "conscious"]) {
      expect(SOURCE_PROVENANCE[s]).toBeDefined()
    }
  })
})

describe("MIGRATION_COLUMNS", () => {
  it("adds provenance with the legacy backfill default", () => {
    const prov = MIGRATION_COLUMNS.find((c) => c.name === "provenance")
    expect(prov).toBeDefined()
    expect(prov!.ddl).toContain("ADD COLUMN provenance")
    expect(prov!.ddl).toContain("DEFAULT 'episodic'")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-provenance.test.ts`
Expected: FAIL — cannot resolve `./memory-provenance.js`.

- [ ] **Step 3: Write the implementation**

Create `memory-provenance.ts`:

```ts
/**
 * Memory provenance taxonomy (design 2026-07-21 §1).
 *
 * `provenance` is an OBJECTIVE trust-tier derived from the write path — never a
 * model self-report (a confabulating model is confident in its confabulations).
 *
 * Single source of truth: unit-tested here AND interpolated verbatim into the
 * generated in-container `memory` CLI (memory-cli.ts), the same generate-time
 * reuse the SQL builders use, so the two can never drift.
 */

/** Trust-tier, ordered high→low: grounded > episodic > inferred > asserted. */
export type Provenance = "grounded" | "episodic" | "inferred" | "asserted"

/** Unknown / self-authored sources get the lowest-trust default. */
export const PROVENANCE_DEFAULT: Provenance = "asserted"

/** Objective source→tier map. Keys are the `source` strings the write paths use. */
export const SOURCE_PROVENANCE: Record<string, Provenance> = {
  observe: "grounded",
  orient: "inferred",
  evaluate: "inferred",
  decide: "inferred",
  promotion: "episodic",
  conscious: "asserted",
}

/** Derive the trust tier for a memory from the source that wrote it. */
export function classify(source: string): Provenance {
  return SOURCE_PROVENANCE[source] ?? PROVENANCE_DEFAULT
}

/**
 * Idempotent migration columns for dbs created before provenance existed.
 * `ALTER TABLE ADD COLUMN` has no `IF NOT EXISTS`, so the CLI guards each with a
 * `PRAGMA table_info` presence check. The `DEFAULT` backfills legacy rows to the
 * safe-but-not-privileged episodic tier. (A list of one today; Phase 3 adds `dims`.)
 */
export const MIGRATION_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "provenance", ddl: "ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'episodic'" },
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-provenance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/brain/limbic/hippocampus/memory/memory-provenance.ts packages/core/src/brain/limbic/hippocampus/memory/memory-provenance.test.ts
git commit -m "feat(memory): provenance trust-tier taxonomy (classify + migration col)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: SQL builders — schema, insert, KNN column

**Files:**
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-sql.ts` (`buildSchemaSql` ~27-48, `buildInsertSql` ~64-66, `buildKnnSql` ~88-97)
- Test: `packages/core/src/brain/limbic/hippocampus/memory/memory-sql.test.ts`

**Interfaces:**
- Produces: `buildSchemaSql()` emits a `provenance` column; `buildInsertSql()` binds 5 columns `(ts, source, tags, text, provenance)`; `buildKnnSql()` SELECT includes `provenance`.

- [ ] **Step 1: Write the failing test**

Append to `memory-sql.test.ts` (after the existing `buildSchemaSql` describe):

```ts
describe("buildSchemaSql — provenance column", () => {
  it("declares provenance with the legacy-safe default", () => {
    expect(buildSchemaSql()).toContain("provenance TEXT NOT NULL DEFAULT 'episodic'")
  })
})

describe("buildInsertSql — provenance column", () => {
  it("inserts five columns in a fixed order with five binds", () => {
    const sql = buildInsertSql()
    expect(sql).toContain("(ts, source, tags, text, provenance)")
    expect(sql).toContain("VALUES (?, ?, ?, ?, ?)")
  })
})

describe("buildKnnSql — provenance column", () => {
  it("selects provenance alongside the ranked row", () => {
    expect(buildKnnSql(5)).toContain("m.provenance AS provenance")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-sql.test.ts`
Expected: FAIL on the three new assertions.

- [ ] **Step 3: Update `buildSchemaSql`**

Replace the `memories` table tail — these two lines:

```ts
    `  text TEXT NOT NULL`,
    `);`,
```

with:

```ts
    `  text TEXT NOT NULL,`,
    `  provenance TEXT NOT NULL DEFAULT 'episodic'`,
    `);`,
```

(Only the FIRST `);` — the `memories` table. Leave the `meta` table's `);` untouched.)

- [ ] **Step 4: Update `buildInsertSql`**

Replace:

```ts
  return `INSERT INTO memories (ts, source, tags, text) VALUES (?, ?, ?, ?)`
```

with:

```ts
  return `INSERT INTO memories (ts, source, tags, text, provenance) VALUES (?, ?, ?, ?, ?)`
```

- [ ] **Step 5: Update `buildKnnSql` SELECT**

Replace:

```ts
    `SELECT m.id AS id, m.ts AS ts, m.source AS source, m.tags AS tags, m.text AS text, v.distance AS distance`,
```

with:

```ts
    `SELECT m.id AS id, m.ts AS ts, m.source AS source, m.provenance AS provenance, m.tags AS tags, m.text AS text, v.distance AS distance`,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-sql.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 7: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/brain/limbic/hippocampus/memory/memory-sql.ts packages/core/src/brain/limbic/hippocampus/memory/memory-sql.test.ts
git commit -m "feat(memory): add provenance column to schema/insert/knn SQL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Generated CLI + NDJSON formatter — classify, migrate, emit

**Files:**
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-cli.ts`
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-format.ts`
- Test: `packages/core/src/brain/limbic/hippocampus/memory/memory-cli.test.ts`, `packages/core/src/brain/limbic/hippocampus/memory/memory-format.test.ts`

**Interfaces:**
- Consumes: `SOURCE_PROVENANCE`, `PROVENANCE_DEFAULT`, `MIGRATION_COLUMNS` (Task 1); `buildInsertSql`'s 5-column shape (Task 2).
- Produces: the generated CLI stamps `provenance` (via an embedded `classify`) on every `remember`/`promote` write, migrates pre-existing dbs, and emits `provenance` in `search`/`recent` NDJSON. `formatResults`/`MemoryRow` carry it.

- [ ] **Step 1: Write the failing tests**

Append to `memory-format.test.ts`:

```ts
describe("formatResults — provenance", () => {
  it("emits provenance per row", () => {
    const out = formatResults([
      { id: 1, distance: 0.1, ts: "2026-07-01T00:00:00Z", source: "observe", provenance: "grounded", tags: null, text: "docked" },
    ])
    expect(JSON.parse(out).provenance).toBe("grounded")
  })
})
```

Append to `memory-cli.test.ts` (add `buildMemoryCliScript` to the `./memory-cli.js` import if absent):

```ts
describe("buildMemoryCliScript — provenance", () => {
  const script = buildMemoryCliScript({ embedBaseUrl: "http://127.0.0.1:8090" })
  it("embeds the provenance map, default, and migration columns", () => {
    expect(script).toContain("const PROVENANCE_MAP =")
    expect(script).toContain("const PROVENANCE_DEFAULT =")
    expect(script).toContain("const MIGRATION_COLUMNS =")
    expect(script).toContain('"grounded"')
  })
  it("classifies from source at write time and migrates existing dbs", () => {
    expect(script).toContain("function classify(source)")
    expect(script).toContain("PRAGMA table_info(memories)")
    expect(script).toContain(", prov)")
  })
  it("emits provenance in search/recent output", () => {
    expect(script).toContain("provenance: r.provenance")
    expect(script).toContain("m.provenance AS provenance")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-format.test.ts packages/core/src/brain/limbic/hippocampus/memory/memory-cli.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Update `memory-format.ts`**

Replace `MemoryRow`:

```ts
export interface MemoryRow {
  id: number
  /** vec0 distance; absent for `recent` (no embedding query). */
  distance?: number
  ts: string
  source: string
  /** comma-joined tags, or null/empty when none. */
  tags: string | null
  text: string
}
```

with:

```ts
export interface MemoryRow {
  id: number
  /** vec0 distance; absent for `recent` (no embedding query). */
  distance?: number
  ts: string
  source: string
  /** Objective trust-tier (present post-migration). */
  provenance?: string
  /** comma-joined tags, or null/empty when none. */
  tags: string | null
  text: string
}
```

In `formatResults`, replace the `obj` literal:

```ts
      const obj: Record<string, unknown> = {
        id: r.id,
        ts: r.ts,
        source: r.source,
        tags: splitTags(r.tags),
        text: r.text,
      }
```

with:

```ts
      const obj: Record<string, unknown> = {
        id: r.id,
        ts: r.ts,
        source: r.source,
        provenance: r.provenance,
        tags: splitTags(r.tags),
        text: r.text,
      }
```

- [ ] **Step 4: Update `memory-cli.ts` imports + interpolations**

Add an import (below the `memory-sql.js` import block, ~line 12):

```ts
import { SOURCE_PROVENANCE, PROVENANCE_DEFAULT, MIGRATION_COLUMNS } from "./memory-provenance.js"
```

Inside `buildMemoryCliScript`, after the existing `const usageLit = JSON.stringify(MEMORY_USAGE)` line, add:

```ts
  const provMapLit = JSON.stringify(SOURCE_PROVENANCE)
  const provDefaultLit = JSON.stringify(PROVENANCE_DEFAULT)
  const migrationLit = JSON.stringify(MIGRATION_COLUMNS)
```

- [ ] **Step 5: Inject the taxonomy constants into the script body**

In the returned template string, after `const USAGE = ${usageLit};`, add:

```ts
const PROVENANCE_MAP = ${provMapLit};
const PROVENANCE_DEFAULT = ${provDefaultLit};
const MIGRATION_COLUMNS = ${migrationLit};
```

- [ ] **Step 6: Add the migration to `openDb()` and the `classify` helper**

Replace the `openDb` function in the script body:

```ts
function openDb() {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  // The explicit entrypoint is REQUIRED — bun's filename-derived default
  // (sqlite3_vec0_init) does not match the extension's sqlite3_vec_init.
  db.loadExtension(VEC_EXT, "sqlite3_vec_init");
  db.exec(SCHEMA);
  return db;
}
```

with:

```ts
function openDb() {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  // The explicit entrypoint is REQUIRED — bun's filename-derived default
  // (sqlite3_vec0_init) does not match the extension's sqlite3_vec_init.
  db.loadExtension(VEC_EXT, "sqlite3_vec_init");
  db.exec(SCHEMA);
  // Idempotent migration: ADD COLUMN has no IF NOT EXISTS, so guard on the
  // live column set. New dbs already have the columns (SCHEMA) → no-op.
  const cols = new Set(db.query("PRAGMA table_info(memories)").all().map(function (r) { return r.name; }));
  for (const c of MIGRATION_COLUMNS) { if (!cols.has(c.name)) db.exec(c.ddl); }
  return db;
}

function classify(source) {
  return PROVENANCE_MAP[source] || PROVENANCE_DEFAULT;
}
```

- [ ] **Step 7: Stamp provenance on writes (`remember` + `promote`)**

In the `remember` branch, replace:

```ts
  const vec = await embed(text);
  const db = openDb();
  const info = db.prepare(INSERT_SQL).run(new Date().toISOString(), source, tags, text);
```

with:

```ts
  const vec = await embed(text);
  const db = openDb();
  const prov = classify(source);
  const info = db.prepare(INSERT_SQL).run(new Date().toISOString(), source, tags, text, prov);
```

In the `promote` branch, replace:

```ts
    const vec = await embed(text);
    const info = db.prepare(INSERT_SQL).run(new Date().toISOString(), "promotion", "promotion", text);
```

with:

```ts
    const vec = await embed(text);
    const prov = classify("promotion");
    const info = db.prepare(INSERT_SQL).run(new Date().toISOString(), "promotion", "promotion", text, prov);
```

- [ ] **Step 8: Emit the field (`knnSql`, `fmt`, `recent` SELECT)**

Replace `knnSql`'s returned SELECT string:

```ts
  return "SELECT m.id AS id, m.ts AS ts, m.source AS source, m.tags AS tags, m.text AS text, v.distance AS distance "
    + "FROM memories_vec v JOIN memories m ON m.id = v.id "
    + "WHERE v.embedding MATCH ? AND k = " + ek + " ORDER BY v.distance";
```

with:

```ts
  return "SELECT m.id AS id, m.ts AS ts, m.source AS source, m.provenance AS provenance, m.tags AS tags, m.text AS text, v.distance AS distance "
    + "FROM memories_vec v JOIN memories m ON m.id = v.id "
    + "WHERE v.embedding MATCH ? AND k = " + ek + " ORDER BY v.distance";
```

Replace the `fmt` object:

```ts
    const o = { id: r.id, ts: r.ts, source: r.source, tags: splitTags(r.tags), text: r.text };
```

with:

```ts
    const o = { id: r.id, ts: r.ts, source: r.source, provenance: r.provenance, tags: splitTags(r.tags), text: r.text };
```

Replace the `recent` SELECT:

```ts
  const rows = db.query("SELECT id, ts, source, tags, text FROM memories ORDER BY id DESC LIMIT " + n).all();
```

with:

```ts
  const rows = db.query("SELECT id, ts, source, provenance, tags, text FROM memories ORDER BY id DESC LIMIT " + n).all();
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-format.test.ts packages/core/src/brain/limbic/hippocampus/memory/memory-cli.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/brain/limbic/hippocampus/memory/memory-cli.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-format.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-cli.test.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-format.test.ts
git commit -m "feat(memory): CLI classifies + migrates + emits provenance

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Provenance-aware recall — MemoryHit field, rerank, annotated injection

Lands the read path as one green commit: `MemoryHit.provenance`, the pure `memory-rank` module, the `formatRecall` signature change, the `recall` over-fetch/rerank wiring, and the `memory-gateway.test.ts` rewrite are mutually dependent.

**Files:**
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/longterm-store.ts` (`MemoryHit` ~62-70; add import)
- Create: `packages/core/src/brain/limbic/hippocampus/memory/memory-rank.ts`
- Test: `packages/core/src/brain/limbic/hippocampus/memory/memory-rank.test.ts`
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.ts` (imports; `formatRecall` ~79-84; `recall` ~134-142)
- Modify: `packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.test.ts`

**Interfaces:**
- Consumes: `Provenance` (Task 1); `Clock` (Effect).
- Produces:
  - `MemoryHit` gains `readonly provenance: Provenance`.
  - `memory-rank.ts`: `const RERANK_OVERFETCH = 4`, `function reputationWeight(p: Provenance): number`, `function compositeScore(hit: MemoryHit): number`, `function rerank(hits: ReadonlyArray<MemoryHit>, k: number): MemoryHit[]`. *(Phase 3 will extend `compositeScore`/`rerank` with a salience-decay term + `now`/profile args; Phase 1 ranks on trust alone.)*
  - `memory-gateway.ts`: `function formatAge(ageMs: number): string`, `function formatRecall(hits, label, nowMs, maxChars?)`. **`MemoryGatewayApi.recall` external signature unchanged** — the three call sites (`loop.ts:384,923`, `identity-context.ts:118`) need no edits.

- [ ] **Step 1: Write the failing tests**

Create `memory-rank.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import type { MemoryHit } from "./longterm-store.js"
import { RERANK_OVERFETCH, reputationWeight, compositeScore, rerank } from "./memory-rank.js"

const hit = (over: Partial<MemoryHit>): MemoryHit => ({
  id: 1, ts: "2026-07-21T12:00:00Z", source: "orient",
  provenance: "inferred", tags: [], text: "t", score: 0.5, ...over,
})

describe("reputationWeight", () => {
  it("orders grounded > episodic > inferred > asserted", () => {
    expect(reputationWeight("grounded")).toBeGreaterThan(reputationWeight("episodic"))
    expect(reputationWeight("episodic")).toBeGreaterThan(reputationWeight("inferred"))
    expect(reputationWeight("inferred")).toBeGreaterThan(reputationWeight("asserted"))
  })
})

describe("compositeScore", () => {
  it("multiplies relevance × reputation", () => {
    // grounded (1.0) × score 0.4 = 0.4 ; asserted (0.45) × 0.4 = 0.18
    expect(compositeScore(hit({ provenance: "grounded", score: 0.4 }))).toBeCloseTo(0.4, 6)
    expect(compositeScore(hit({ provenance: "asserted", score: 0.4 }))).toBeCloseTo(0.18, 6)
  })
})

describe("rerank", () => {
  it("a grounded hit outranks an asserted hit at equal relevance", () => {
    const grounded = hit({ id: 1, provenance: "grounded", score: 0.5 })
    const asserted = hit({ id: 2, provenance: "asserted", score: 0.5 })
    expect(rerank([asserted, grounded], 2).map((h) => h.id)).toEqual([1, 2])
  })
  it("relevance still dominates a large trust gap", () => {
    const a = hit({ id: 1, provenance: "asserted", score: 0.95 }) // 0.4275
    const b = hit({ id: 2, provenance: "grounded", score: 0.3 })  // 0.30
    expect(rerank([b, a], 2).map((h) => h.id)).toEqual([1, 2])
  })
  it("truncates to k", () => {
    expect(rerank([hit({ id: 1 }), hit({ id: 2 }), hit({ id: 3 })], 2)).toHaveLength(2)
  })
  it("over-fetch factor is a positive integer > 1", () => {
    expect(Number.isInteger(RERANK_OVERFETCH)).toBe(true)
    expect(RERANK_OVERFETCH).toBeGreaterThan(1)
  })
})
```

Rewrite the `formatRecall` describe in `memory-gateway.test.ts` (existing ~lines 93-102) with:

```ts
describe("formatRecall", () => {
  const NOW = Date.parse("2026-07-21T12:00:00Z")
  const mkHit = (over: Partial<MemoryHit>): MemoryHit => ({
    id: 1, ts: new Date(NOW).toISOString(), source: "orient",
    provenance: "inferred", tags: [], text: "x", score: 0.5, ...over,
  })
  it("returns empty string for no hits", () => {
    expect(formatRecall([], "You recall", NOW)).toBe("")
  })
  it("annotates each line with provenance and coarse age under the label", () => {
    const hits = [
      mkHit({ text: "docked at First Step", provenance: "grounded", ts: new Date(NOW - 2 * 60_000).toISOString() }),
      mkHit({ text: "readout may be unreliable", provenance: "inferred", ts: new Date(NOW - 5 * 3600_000).toISOString() }),
    ]
    const out = formatRecall(hits, "You recall", NOW)
    expect(out).toContain("## You recall")
    expect(out).toContain("- (grounded · ~2m ago) docked at First Step")
    expect(out).toContain("- (inferred · ~5h ago) readout may be unreliable")
  })
  it("still truncates to maxChars with an ellipsis", () => {
    expect(formatRecall([mkHit({ text: "A".repeat(50) })], "You recall", NOW, 20).length).toBeLessThanOrEqual(21)
  })
})

describe("formatAge", () => {
  it("buckets by minute/hour/day and flags unknown", () => {
    expect(formatAge(90_000)).toBe("~2m ago")
    expect(formatAge(5 * 3600_000)).toBe("~5h ago")
    expect(formatAge(3 * 24 * 3600_000)).toBe("~3d ago")
    expect(formatAge(NaN)).toBe("age unknown")
  })
})
```

Update the `./memory-gateway.js` import in that test to include `formatAge`. If the `MemoryGateway` service `describe` further down builds a fake `LongtermStore` whose `recall` returns hit literals, add `provenance: "inferred"` (and keep a valid `ts`) to each so they typecheck; its behavioral assertions still hold.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-rank.test.ts packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.test.ts`
Expected: FAIL — `./memory-rank.js` unresolved; `formatAge` not exported; `formatRecall` old signature.

- [ ] **Step 3: Add the field to `MemoryHit`**

In `longterm-store.ts`, add below the existing imports (after `import { MEMORY_CLI_PATH } from "./memory-cli.js"`):

```ts
import type { Provenance } from "./memory-provenance.js"
```

Replace the `MemoryHit` interface:

```ts
/** A ranked recall hit — one NDJSON line from the in-container `memory search`. */
export interface MemoryHit {
  readonly id: number
  readonly ts: string
  readonly source: string
  readonly tags: ReadonlyArray<string>
  readonly text: string
  readonly score: number
}
```

with:

```ts
/** A ranked recall hit — one NDJSON line from the in-container `memory search`. */
export interface MemoryHit {
  readonly id: number
  readonly ts: string
  readonly source: string
  /** Objective trust-tier derived from `source` at write time (see memory-provenance). */
  readonly provenance: Provenance
  readonly tags: ReadonlyArray<string>
  readonly text: string
  readonly score: number
}
```

(The runtime `recall` already builds hits via `JSON.parse(l) as MemoryHit`; the CLI from Task 3 emits `provenance`, so no parse-code change.)

- [ ] **Step 4: Create `memory-rank.ts`**

```ts
/**
 * Host-side re-ranking for recall (design 2026-07-21 §4, Phase 1).
 *
 * sqlite-vec can only rank by distance, so `recall` over-fetches `k *
 * RERANK_OVERFETCH` nearest hits and this pure function re-orders them by
 *   relevance × reputationWeight(provenance)
 * then truncates to the caller's `k`. Relevance stays dominant (reputation is
 * bounded ≤ 1), so we down-weight low-trust memories without surfacing
 * irrelevant ones. Phase 3 extends compositeScore with a salience-decay term.
 */

import type { Provenance } from "./memory-provenance.js"
import type { MemoryHit } from "./longterm-store.js"

/** Ask the vec index for this many × the caller's k, then re-rank down to k. */
export const RERANK_OVERFETCH = 4

/** Multiplicative trust weight per provenance tier. */
export const REPUTATION_WEIGHT: Record<Provenance, number> = {
  grounded: 1.0,
  episodic: 0.85,
  inferred: 0.6,
  asserted: 0.45,
}

export function reputationWeight(p: Provenance): number {
  return REPUTATION_WEIGHT[p] ?? REPUTATION_WEIGHT.asserted
}

/** relevance(score) × reputation. NaN score → 0. */
export function compositeScore(hit: MemoryHit): number {
  const rel = Number.isFinite(hit.score) ? hit.score : 0
  return rel * reputationWeight(hit.provenance)
}

/** Re-order by composite score (desc) and keep the top `k`. Pure; input untouched. */
export function rerank(hits: ReadonlyArray<MemoryHit>, k: number): MemoryHit[] {
  return hits
    .map((h) => ({ h, s: compositeScore(h) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(0, k))
    .map((x) => x.h)
}
```

- [ ] **Step 5: Update `memory-gateway.ts` — imports, `formatRecall` + `formatAge`, `recall`**

Change the top import:

```ts
import { Context, Effect, Layer } from "effect"
```

to:

```ts
import { Context, Effect, Layer, Clock } from "effect"
```

Add, after the `import type { ObserveResult, … } from "…/skills/types.js"` line:

```ts
import { rerank, RERANK_OVERFETCH } from "./memory-rank.js"
```

Replace `formatRecall`:

```ts
/** Render hits as a prompt block under `label`; "" when no hits. Truncated to maxChars (+ ellipsis). */
export function formatRecall(hits: ReadonlyArray<MemoryHit>, label: string, maxChars?: number): string {
  if (hits.length === 0) return ""
  const block = `\n\n## ${label}\n${hits.map((h) => `- ${h.text}`).join("\n")}`
  if (maxChars && block.length > maxChars) return `${block.slice(0, maxChars)}…`
  return block
}
```

with:

```ts
/** Coarse human age bucket from a millisecond delta. Unknown for NaN/negative. */
export function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "age unknown"
  const min = ageMs / 60_000
  if (min < 1) return "~1m ago"
  if (min < 60) return `~${Math.round(min)}m ago`
  const hr = min / 60
  if (hr < 48) return `~${Math.round(hr)}h ago`
  return `~${Math.round(hr / 24)}d ago`
}

/**
 * Render hits as a prompt block under `label`; "" when no hits. Each line is
 * annotated `- (<provenance> · <age>) <text>` so the model can weigh a grounded
 * observation against an inference. Truncated to maxChars (+ ellipsis).
 */
export function formatRecall(
  hits: ReadonlyArray<MemoryHit>,
  label: string,
  nowMs: number,
  maxChars?: number,
): string {
  if (hits.length === 0) return ""
  const lines = hits.map(
    (h) => `- (${h.provenance} · ${formatAge(nowMs - Date.parse(h.ts))}) ${h.text}`,
  )
  const block = `\n\n## ${label}\n${lines.join("\n")}`
  if (maxChars && block.length > maxChars) return `${block.slice(0, maxChars)}…`
  return block
}
```

Replace the service `recall` implementation:

```ts
      recall: (containerId, char, query, opts) =>
        Effect.gen(function* () {
          const q = query.trim()
          if (!q) return ""
          const hits = yield* store
            .recall(containerId, char, q, { k: opts.k, tags: opts.tags })
            .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<MemoryHit>)))
          return formatRecall(hits, opts.label, opts.maxChars)
        }),
```

with:

```ts
      recall: (containerId, char, query, opts) =>
        Effect.gen(function* () {
          const q = query.trim()
          if (!q) return ""
          // Over-fetch, then re-rank down to k by relevance × trust.
          const hits = yield* store
            .recall(containerId, char, q, { k: opts.k * RERANK_OVERFETCH, tags: opts.tags })
            .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<MemoryHit>)))
          const now = yield* Clock.currentTimeMillis
          const ranked = rerank(hits, opts.k)
          return formatRecall(ranked, opts.label, now, opts.maxChars)
        }),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory/memory-rank.test.ts packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck (tests included)**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache`
Expected: SUCCESS. Exercises `MemoryHit.provenance` against its only other consumer, `macro.ts` (reads `.source`/`.tags`/`.text`, never constructs a `MemoryHit` literal — must still compile). If `macro.ts` fails, add `provenance` to whatever `MemoryHit` literal it builds — do NOT weaken the interface.

- [ ] **Step 8: Commit**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add packages/core/src/brain/limbic/hippocampus/memory/longterm-store.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-rank.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-rank.test.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.ts \
        packages/core/src/brain/limbic/hippocampus/memory/memory-gateway.test.ts
git commit -m "feat(memory): provenance-aware recall — rerank by trust, annotate lines

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Integration verification

- [ ] **Step 1: Full memory-suite test run**

Run: `pnpm vitest --run packages/core/src/brain/limbic/hippocampus/memory`
Expected: PASS — all files.

- [ ] **Step 2: Full `@roci/core` typecheck without cache**

Run: `pnpm nx run @roci/core:typecheck --skip-nx-cache`
Expected: SUCCESS.

- [ ] **Step 3: Confirm call sites are untouched and correct**

Run: `grep -n "memory.recall" packages/core/src/brain/stem/loop.ts packages/core/src/brain/limbic/hippocampus/identity-context.ts`
Expected: three call sites, each still passing `{ k, label, maxChars? }` — the `MemoryGatewayApi.recall` signature did not change, so no edits were needed.

- [ ] **Step 4: Whole-repo build (the pre-commit gate, run explicitly)**

Run: `pnpm nx run-many -t build --skip-nx-cache`
Expected: SUCCESS across all 4 projects.

- [ ] **Step 5: Sanity-read the generated CLI string**

Run:
```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
pnpm exec tsx -e "import('./packages/core/src/brain/limbic/hippocampus/memory/memory-cli.js').then(m => console.log(m.buildMemoryCliScript({embedBaseUrl:'http://127.0.0.1:8090'})))" 2>/dev/null | grep -nE "classify|MIGRATION_COLUMNS|, prov\)|PRAGMA table_info|provenance: r.provenance" | head
```
Expected: lines showing `classify`, `MIGRATION_COLUMNS`, the two `, prov)` binds, the `PRAGMA table_info` migration, and the `fmt` emit. (If `tsx` is unavailable, the `memory-cli.test.ts` assertions from Task 3 cover the same substrings.)

- [ ] **Step 6: Final commit (only if a fixup was required)**

```bash
cd /Users/vcarl/workspace/roci/.claude/worktrees/memory-provenance
git add -A packages/core/src
git commit -m "chore(memory): integration fixups for provenance rerank

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

If no fixup was needed, skip this step.

---

## Hand-off to Phase 2 / 3

- **Phase 2 (salience profile, identity-gen)** and **Phase 3 (salience-decay ranking)** are separate plans (spec §7). Phase 3 will: add a `dims TEXT` column (extend `MIGRATION_COLUMNS`), capture `observe.weight`/`drive` in `observeMemories`, add `MemoryHit.dims`, and extend `compositeScore`/`rerank` in `memory-rank.ts` with the salience-decay term (`compositeScore(hit, nowMs, salience)` + `halfLife`/`recency`) plus a profile load in the gateway. Phase 1's `memory-rank.ts` and `formatRecall(…, nowMs, …)` were shaped to absorb that with minimal churn (the `nowMs` already flows to `formatRecall`; `rerank` gains `now`/`salience` params).
- **Coverage check (spec → Phase 1 task):** §1 provenance data model → Tasks 1,2,4 · §1 write mapping → Tasks 1,3 · §4 rerank (trust term) → Task 4 · §5 injection annotation → Task 4. (§2 salience profile, §3 dims, §4 salience-decay → Phases 2-3.)
```

