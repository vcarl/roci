# Challenge Generators — Social Networks & Financial Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Procedurally generate `code_exec` challenges (with computed ground truth + companion python checkers) for two conscious-tier cognitive families — social relational networks (allegiance & culpability) and financial models (insolvency & breakeven) — into the `llm-bench` corpus.

**Architecture:** Pure, seeded TypeScript generators in `src/gen/` (vitest-tested, biome-linted) build a scenario, compute its ground truth, render a prose prompt that asks the model to emit `answer = <value>` in a python block, and emit a companion `<name>.test.py` that asserts on `answer`. A CLI shim in `scripts/` assembles a difficulty-banded curriculum, **self-checks every generated challenge by running its checker against the generator's own reference answer via `python3`** (exactly as the harness runs it against model output), then writes the suite YAML + checkers into `challenges/`. Determinism (mulberry32 seeded per challenge) makes the committed corpus idempotent.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import suffixes), Effect `Schema` (for suite validation), `yaml` (serialization), vitest, biome, tsx (CLI runner), python3 (checker execution + self-check).

## Global Constraints

- **Working repo:** `/Users/vcarl/workspace/testbench/llms` (the `llm-bench` framework — a **separate git repo** from the roci worktree). Run ALL `npm`/`git`/`tsx` commands from there. This plan document lives in the roci repo; everything it builds lives in `testbench/llms`.
- **Code style (biome-enforced via husky pre-commit):** match existing `src/` — **semicolons, double quotes, 2-space indent**, NodeNext ESM with `.js` import suffixes. No `any`; prefer `readonly`. (Note: this is the *opposite* of the roci repo's no-semicolon style — do not carry roci habits here.)
- **Gates before every commit:** `npm run typecheck` (tsc) and `npm run lint` (`biome check src/ && bash scripts/lint-strict.sh`) must pass. The husky pre-commit runs them; do not bypass with `--no-verify`.
- **Tests:** `npm test` runs the whole vitest suite. Single file: `npx vitest run src/gen/<file>.test.ts`. Generator logic + tests live under `src/gen/` so the existing `vitest run` and `biome check src/` cover them.
- **python3 must be on PATH.** Both the `code_exec` scorer and the generator self-check shell out to `python3 -c`.
- **Commit messages end EXACTLY with:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Stage explicit paths** (`git add <path>`), **never `git add -A`**.
- **The generated corpus is committed** (deterministic → git-stable): `challenges/social_network.yaml`, `challenges/financial_model.yaml`, and all `challenges/*.test.py` companions.
- **The grading contract:** every generated challenge is `scorer: code_exec`. The prompt ends with a fixed instruction to output one python code block assigning `answer`. The companion `.test.py` is **bare asserts referencing `answer` — it must NOT print the `ALL_TESTS_PASSED` marker** (the harness appends it) and must raise on a wrong answer. Checkers normalize `answer` so a model may return either a scalar or a list/set where a set is expected.

---

### Task 1: Generator scaffolding — seeded RNG + schema-validated emitter

**Files:**
- Create: `src/gen/rng.ts`
- Create: `src/gen/emit.ts`
- Test: `src/gen/rng.test.ts`, `src/gen/emit.test.ts`

**Interfaces:**
- Produces:
  - `mulberry32(seed: number): () => number`, `randInt(rng, lo, hi): number`, `pick<T>(rng, arr): T`, `sample<T>(rng, arr, k): T[]`
  - `interface GeneratedChallenge { name; category; tier; prompt; tags?; checkerSource; referenceAnswerPy }` (all `readonly`)
  - `interface SuiteSpec { id; version; passThreshold; challenges }`
  - `buildSuite(spec: SuiteSpec): { yaml: string; checkerFiles: { name; content }[] }` (pure, schema-validates, throws on duplicate `name`)
  - `writeSuite(spec: SuiteSpec, outDir: string): void`

- [ ] **Step 1: Write the failing tests**

`src/gen/rng.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mulberry32, randInt, pick, sample } from "./rng.js";

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });
  it("differs across seeds", () => {
    expect(mulberry32(1)()).not.toEqual(mulberry32(2)());
  });
  it("produces values in [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("helpers", () => {
  it("randInt stays within inclusive bounds", () => {
    const r = mulberry32(3);
    for (let i = 0; i < 100; i++) {
      const v = randInt(r, 2, 5);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(5);
    }
  });
  it("sample returns k distinct elements", () => {
    const r = mulberry32(9);
    const got = sample(r, ["a", "b", "c", "d", "e"], 3);
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
  });
  it("pick returns a member", () => {
    const r = mulberry32(9);
    expect(["x", "y", "z"]).toContain(pick(r, ["x", "y", "z"]));
  });
});
```

`src/gen/emit.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import { parse } from "yaml";
import { Challenge } from "../schema/challenge.js";
import { buildSuite, type GeneratedChallenge } from "./emit.js";

const sample: GeneratedChallenge = {
  name: "demo_one",
  category: "demo",
  tier: 1,
  prompt: "Answer it. Assign `answer`.",
  tags: ["TODO", "demo"],
  checkerSource: 'assert answer == 1, "got " + repr(answer)',
  referenceAnswerPy: "answer = 1",
};

describe("buildSuite", () => {
  it("emits schema-valid suite YAML", () => {
    const { yaml } = buildSuite({ id: "demo", version: 1, passThreshold: 0.8, challenges: [sample] });
    const decoded = Schema.decodeUnknownSync(Challenge)(parse(yaml));
    expect(decoded.id).toBe("demo");
    expect(decoded.items[0]?.scorer).toBe("code_exec");
    expect((decoded.items[0] as { testFile: string }).testFile).toBe("demo_one.test.py");
  });
  it("emits one checker file per challenge, newline-terminated", () => {
    const { checkerFiles } = buildSuite({ id: "demo", version: 1, passThreshold: 0.8, challenges: [sample] });
    expect(checkerFiles).toEqual([
      { name: "demo_one.test.py", content: 'assert answer == 1, "got " + repr(answer)\n' },
    ]);
  });
  it("rejects duplicate challenge names", () => {
    expect(() =>
      buildSuite({ id: "demo", version: 1, passThreshold: 0.8, challenges: [sample, sample] }),
    ).toThrow(/duplicate/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/gen/rng.test.ts src/gen/emit.test.ts`
Expected: FAIL — modules `./rng.js` / `./emit.js` not found.

- [ ] **Step 3: Implement `src/gen/rng.ts`**

```ts
/** Deterministic PRNG (mulberry32) — same seed → same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [lo, hi] inclusive. */
export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** One member of `arr`. */
export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

/** `k` distinct members via a partial Fisher–Yates shuffle. */
export function sample<T>(rng: () => number, arr: readonly T[], k: number): T[] {
  const pool = [...arr];
  const n = Math.min(k, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    const tmp = pool[i] as T;
    pool[i] = pool[j] as T;
    pool[j] = tmp;
  }
  return pool.slice(0, n);
}
```

- [ ] **Step 4: Implement `src/gen/emit.ts`**

```ts
import { Schema } from "effect";
import { stringify } from "yaml";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { Challenge } from "../schema/challenge.js";

/** A single generated challenge: a code_exec item plus its python checker and
 *  the generator's own computed answer (used by the self-check). */
export interface GeneratedChallenge {
  readonly name: string;
  readonly category: string;
  readonly tier: number;
  readonly prompt: string;
  readonly tags?: readonly string[];
  /** Bare-assert python referencing `answer`; no marker print (harness appends). */
  readonly checkerSource: string;
  /** The generator's reference answer as a python statement, e.g. `answer = 3`. */
  readonly referenceAnswerPy: string;
}

export interface SuiteSpec {
  readonly id: string;
  readonly version: number;
  readonly passThreshold: number;
  readonly challenges: readonly GeneratedChallenge[];
}

export interface CheckerFile {
  readonly name: string;
  readonly content: string;
}

const decodeChallenge = Schema.decodeUnknownSync(Challenge);

/** Pure: assemble + schema-validate a suite; return serialized YAML + checker files. */
export function buildSuite(spec: SuiteSpec): { yaml: string; checkerFiles: CheckerFile[] } {
  const seen = new Set<string>();
  for (const c of spec.challenges) {
    if (seen.has(c.name)) throw new Error(`duplicate challenge name: ${c.name}`);
    seen.add(c.name);
  }
  const items = spec.challenges.map((c) => ({
    name: c.name,
    category: c.category,
    tier: c.tier,
    prompt: c.prompt,
    scorer: "code_exec" as const,
    testFile: `${c.name}.test.py`,
    ...(c.tags ? { tags: c.tags } : {}),
  }));
  const challenge = { id: spec.id, version: spec.version, passThreshold: spec.passThreshold, items };
  decodeChallenge(challenge); // throws on any schema violation
  const yaml = stringify(challenge);
  const checkerFiles = spec.challenges.map((c) => ({
    name: `${c.name}.test.py`,
    content: c.checkerSource.endsWith("\n") ? c.checkerSource : `${c.checkerSource}\n`,
  }));
  return { yaml, checkerFiles };
}

/** Side-effecting: write the suite YAML + all checker files into `outDir`. */
export function writeSuite(spec: SuiteSpec, outDir: string): void {
  const { yaml, checkerFiles } = buildSuite(spec);
  writeFileSync(path.join(outDir, `${spec.id}.yaml`), yaml);
  for (const f of checkerFiles) writeFileSync(path.join(outDir, f.name), f.content);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/gen/rng.test.ts src/gen/emit.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd /Users/vcarl/workspace/testbench/llms
npm run typecheck && npm run lint
git add src/gen/rng.ts src/gen/rng.test.ts src/gen/emit.ts src/gen/emit.test.ts
git commit -m "feat(gen): seeded RNG + schema-validated challenge emitter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Social graph model + generator

**Files:**
- Create: `src/gen/social/graph.ts`
- Test: `src/gen/social/graph.test.ts`

**Interfaces:**
- Consumes: `mulberry32`, `randInt`, `pick`, `sample` (Task 1)
- Produces:
  - `type EdgeKind = "kin" | "debt" | "loyalty" | "betrayal"`
  - `interface Edge { from; to; kind: EdgeKind; weight: number }` (signed: betrayal < 0)
  - `interface SocialGraph { agents: readonly string[]; edges: readonly Edge[] }`
  - `interface SocialKnobs { agentCount; edgeDensity; indirectionDepth; conflictingLoyalties }`
  - `generateSocialGraph(seed: number, knobs: SocialKnobs): SocialGraph`

- [ ] **Step 1: Write the failing test**

`src/gen/social/graph.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { generateSocialGraph, type SocialKnobs } from "./graph.js";

const knobs: SocialKnobs = {
  agentCount: 6,
  edgeDensity: 0.4,
  indirectionDepth: 3,
  conflictingLoyalties: true,
};

describe("generateSocialGraph", () => {
  it("is deterministic for a seed", () => {
    expect(generateSocialGraph(11, knobs)).toEqual(generateSocialGraph(11, knobs));
  });
  it("honors agentCount and uses distinct names", () => {
    const g = generateSocialGraph(11, knobs);
    expect(g.agents).toHaveLength(6);
    expect(new Set(g.agents).size).toBe(6);
  });
  it("only emits edges between real agents, never self-loops", () => {
    const g = generateSocialGraph(11, knobs);
    const set = new Set(g.agents);
    for (const e of g.edges) {
      expect(set.has(e.from)).toBe(true);
      expect(set.has(e.to)).toBe(true);
      expect(e.from).not.toBe(e.to);
    }
  });
  it("omits betrayal edges when conflictingLoyalties is false", () => {
    const g = generateSocialGraph(11, { ...knobs, conflictingLoyalties: false });
    expect(g.edges.some((e) => e.kind === "betrayal")).toBe(false);
    expect(g.edges.every((e) => e.weight > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/gen/social/graph.test.ts`
Expected: FAIL — `./graph.js` not found.

- [ ] **Step 3: Implement `src/gen/social/graph.ts`**

```ts
import { mulberry32, randInt, pick, sample } from "../rng.js";

export type EdgeKind = "kin" | "debt" | "loyalty" | "betrayal";

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  /** Signed weight in [-1, -0.2] ∪ [0.2, 1.0]; betrayal is the only negative kind. */
  readonly weight: number;
}

export interface SocialGraph {
  readonly agents: readonly string[];
  readonly edges: readonly Edge[];
}

export interface SocialKnobs {
  readonly agentCount: number;
  /** Fraction of ordered agent pairs that get an edge, 0..1. */
  readonly edgeDensity: number;
  /** Max path length used by affinity reasoning (Task 3). */
  readonly indirectionDepth: number;
  /** Inject betrayal (negative) edges to manufacture near-ties. */
  readonly conflictingLoyalties: boolean;
}

const NAME_POOL = [
  "Mara", "Doss", "Rill", "Veda", "Okot", "Sable", "Pell", "Nyx",
  "Corin", "Wren", "Tace", "Bly", "Ider", "Mox", "Senna", "Hale",
] as const;

const KIND_SIGN: Record<EdgeKind, 1 | -1> = { kin: 1, debt: 1, loyalty: 1, betrayal: -1 };

export function generateSocialGraph(seed: number, knobs: SocialKnobs): SocialGraph {
  const rng = mulberry32(seed);
  const agents = sample(rng, NAME_POOL, knobs.agentCount);
  const positiveKinds: readonly EdgeKind[] = ["kin", "debt", "loyalty"];
  const allKinds: readonly EdgeKind[] = ["kin", "debt", "loyalty", "betrayal"];
  const edges: Edge[] = [];
  for (const from of agents) {
    for (const to of agents) {
      if (from === to) continue;
      if (rng() > knobs.edgeDensity) continue;
      const kind = pick(rng, knobs.conflictingLoyalties ? allKinds : positiveKinds);
      const magnitude = randInt(rng, 1, 5) / 5; // 0.2 .. 1.0
      edges.push({ from, to, kind, weight: KIND_SIGN[kind] * magnitude });
    }
  }
  return { agents, edges };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/gen/social/graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd /Users/vcarl/workspace/testbench/llms
npm run typecheck && npm run lint
git add src/gen/social/graph.ts src/gen/social/graph.test.ts
git commit -m "feat(gen): social relational-graph generator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Signed path-affinity engine

**Files:**
- Create: `src/gen/social/affinity.ts`
- Test: `src/gen/social/affinity.test.ts`

**Interfaces:**
- Consumes: `SocialGraph`, `Edge` (Task 2)
- Produces: `pathAffinity(graph, source, target, maxDepth, kinds?): number` — Σ over simple directed paths source→target of length ≤ maxDepth of the product of signed edge weights; `kinds` optionally restricts which edge kinds are traversable.

- [ ] **Step 1: Write the failing test**

`src/gen/social/affinity.test.ts` (tiny hand-verifiable graphs):
```ts
import { describe, it, expect } from "vitest";
import type { SocialGraph } from "./graph.js";
import { pathAffinity } from "./affinity.js";

// A →(0.5) B →(-0.4) C, plus A →(0.2) C direct.
const g: SocialGraph = {
  agents: ["A", "B", "C"],
  edges: [
    { from: "A", to: "B", kind: "loyalty", weight: 0.5 },
    { from: "B", to: "C", kind: "betrayal", weight: -0.4 },
    { from: "A", to: "C", kind: "loyalty", weight: 0.2 },
  ],
};

describe("pathAffinity", () => {
  it("sums direct + indirect signed products up to depth", () => {
    // direct 0.2  +  A→B→C (0.5 * -0.4 = -0.2)  =  0.0
    expect(pathAffinity(g, "A", "C", 3)).toBeCloseTo(0.0, 10);
  });
  it("respects maxDepth (depth 1 sees only the direct edge)", () => {
    expect(pathAffinity(g, "A", "C", 1)).toBeCloseTo(0.2, 10);
  });
  it("filters by edge kind when given", () => {
    // Only loyalty edges traversable → the betrayal hop is gone, leaving direct 0.2.
    expect(pathAffinity(g, "A", "C", 3, new Set(["loyalty"]))).toBeCloseTo(0.2, 10);
  });
  it("returns 0 when unreachable", () => {
    expect(pathAffinity(g, "C", "A", 3)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/gen/social/affinity.test.ts`
Expected: FAIL — `./affinity.js` not found.

- [ ] **Step 3: Implement `src/gen/social/affinity.ts`**

```ts
import type { SocialGraph } from "./graph.js";

function adjacency(graph: SocialGraph, kinds?: ReadonlySet<string>) {
  const adj = new Map<string, Array<{ to: string; weight: number }>>();
  for (const a of graph.agents) adj.set(a, []);
  for (const e of graph.edges) {
    if (kinds && !kinds.has(e.kind)) continue;
    adj.get(e.from)?.push({ to: e.to, weight: e.weight });
  }
  return adj;
}

/**
 * Sum over all *simple* directed paths source→target with length ≤ maxDepth of
 * the product of signed edge weights. Exponential in depth, but depths are small
 * (≤ ~4) and graphs are tiny, so this is fine.
 */
export function pathAffinity(
  graph: SocialGraph,
  source: string,
  target: string,
  maxDepth: number,
  kinds?: ReadonlySet<string>,
): number {
  const adj = adjacency(graph, kinds);
  const visited = new Set<string>([source]);
  let total = 0;
  const walk = (node: string, depth: number, product: number): void => {
    if (node === target && depth > 0) {
      total += product;
      return; // endpoint reached; do not route through the target
    }
    if (depth >= maxDepth) return;
    for (const { to, weight } of adj.get(node) ?? []) {
      if (visited.has(to)) continue;
      visited.add(to);
      walk(to, depth + 1, product * weight);
      visited.delete(to);
    }
  };
  walk(source, 0, 1);
  return total;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/gen/social/affinity.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd /Users/vcarl/workspace/testbench/llms
npm run typecheck && npm run lint
git add src/gen/social/affinity.ts src/gen/social/affinity.test.ts
git commit -m "feat(gen): signed path-affinity engine for social reasoning

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Social ground truth + challenge builders (allegiance, culpability)

**Files:**
- Create: `src/gen/social/groundtruth.ts`
- Create: `src/gen/social/challenges.ts`
- Test: `src/gen/social/groundtruth.test.ts`, `src/gen/social/challenges.test.ts`

**Interfaces:**
- Consumes: `SocialGraph`/`generateSocialGraph`/`SocialKnobs` (Task 2), `pathAffinity` (Task 3), `GeneratedChallenge` (Task 1)
- Produces:
  - `allegiance(graph, z, a, b, depth): string[]` — argmax of signed affinity; tie → both, sorted
  - `mostCulpable(graph, actor, depth, actorBase?): string[]` — argmax set over all agents, sorted
  - `socialChallenge(seed: number, knobs: SocialKnobs, band: number, index: number): GeneratedChallenge` — picks a question type, builds prompt + checker + reference answer

- [ ] **Step 1: Write the failing tests**

`src/gen/social/groundtruth.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { SocialGraph } from "./graph.js";
import { allegiance, mostCulpable } from "./groundtruth.js";

// Z is loyal to A (0.8) and slightly to B (0.2) → sides with A.
const g1: SocialGraph = {
  agents: ["Z", "A", "B"],
  edges: [
    { from: "Z", to: "A", kind: "loyalty", weight: 0.8 },
    { from: "Z", to: "B", kind: "loyalty", weight: 0.2 },
  ],
};

// Puppet-master: P has strong loyalty-sway over the actor X; bystander Q has none.
const g2: SocialGraph = {
  agents: ["X", "P", "Q"],
  edges: [{ from: "P", to: "X", kind: "loyalty", weight: 0.9 }],
};

describe("allegiance", () => {
  it("sides with the higher-affinity target", () => {
    expect(allegiance(g1, "Z", "A", "B", 2)).toEqual(["A"]);
  });
  it("returns both (sorted) on a genuine tie", () => {
    const tie: SocialGraph = {
      agents: ["Z", "A", "B"],
      edges: [
        { from: "Z", to: "A", kind: "loyalty", weight: 0.5 },
        { from: "Z", to: "B", kind: "loyalty", weight: 0.5 },
      ],
    };
    expect(allegiance(tie, "Z", "A", "B", 2)).toEqual(["A", "B"]);
  });
});

describe("mostCulpable", () => {
  it("names a sway-holder who exceeds the actor's base", () => {
    // P's influence-affinity to X = 0.9 < actorBase 1.0 → actor is most culpable.
    expect(mostCulpable(g2, "X", 2, 1.0)).toEqual(["X"]);
  });
  it("lets a strong-enough puppet-master out-score the actor", () => {
    // With a low actorBase, the influencer wins.
    expect(mostCulpable(g2, "X", 2, 0.5)).toEqual(["P"]);
  });
});
```

`src/gen/social/challenges.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { socialChallenge } from "./challenges.js";

const knobs = { agentCount: 6, edgeDensity: 0.5, indirectionDepth: 3, conflictingLoyalties: true };

describe("socialChallenge", () => {
  it("is deterministic and has a stable unique name", () => {
    const a = socialChallenge(100, knobs, 2, 7);
    const b = socialChallenge(100, knobs, 2, 7);
    expect(a).toEqual(b);
    expect(a.name).toMatch(/^social_(allegiance|culpability)_b2_s0007$/);
  });
  it("asks the model to assign `answer` and ships a checker that references it", () => {
    const c = socialChallenge(100, knobs, 2, 7);
    expect(c.prompt).toMatch(/answer/);
    expect(c.checkerSource).toMatch(/answer/);
    expect(c.referenceAnswerPy).toMatch(/^answer = /);
    expect(c.checkerSource).not.toMatch(/ALL_TESTS_PASSED/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/gen/social/groundtruth.test.ts src/gen/social/challenges.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/gen/social/groundtruth.ts`**

```ts
import type { SocialGraph } from "./graph.js";
import { pathAffinity } from "./affinity.js";

const EPS = 1e-9;

/** Z sides with whichever of {a, b} has higher signed path-affinity; tie → both. */
export function allegiance(
  graph: SocialGraph,
  z: string,
  a: string,
  b: string,
  depth: number,
): string[] {
  const fa = pathAffinity(graph, z, a, depth);
  const fb = pathAffinity(graph, z, b, depth);
  if (Math.abs(fa - fb) <= EPS) return [a, b].sort();
  return [fa > fb ? a : b];
}

/** Influence flows along loyalty/debt edges (who holds sway). */
const INFLUENCE_KINDS = new Set(["loyalty", "debt"]);

/**
 * Culpability for a deed done by `actor`: the actor carries `actorBase`; every
 * other agent's culpability is their signed influence-affinity *toward* the
 * actor over loyalty/debt edges — so a hidden puppet-master can out-score the
 * actor. Returns the argmax set (ties included), sorted.
 */
export function mostCulpable(
  graph: SocialGraph,
  actor: string,
  depth: number,
  actorBase = 1.0,
): string[] {
  const score = new Map<string, number>();
  for (const x of graph.agents) {
    score.set(x, x === actor ? actorBase : pathAffinity(graph, x, actor, depth, INFLUENCE_KINDS));
  }
  const max = Math.max(...score.values());
  return [...score.entries()]
    .filter(([, v]) => Math.abs(v - max) <= EPS)
    .map(([k]) => k)
    .sort();
}
```

- [ ] **Step 4: Implement `src/gen/social/challenges.ts`**

```ts
import { generateSocialGraph, type SocialGraph, type SocialKnobs, type EdgeKind } from "./graph.js";
import { allegiance, mostCulpable } from "./groundtruth.js";
import { mulberry32, pick, sample } from "../rng.js";
import type { GeneratedChallenge } from "../emit.js";

const ANSWER_INSTRUCTION =
  "Reason briefly if you wish, then give your final answer as a single Python code block " +
  "that assigns a variable named `answer`. Output nothing after that block.";

const KIND_PHRASE: Record<EdgeKind, string> = {
  kin: "is kin to",
  debt: "owes a debt to",
  loyalty: "is loyal to",
  betrayal: "betrayed",
};

function strength(weight: number): string {
  const m = Math.abs(weight);
  if (m >= 0.8) return "deeply";
  if (m >= 0.5) return "notably";
  return "slightly";
}

function describeGraph(graph: SocialGraph): string {
  return graph.edges
    .map((e) => `- ${e.from} ${strength(e.weight)} ${KIND_PHRASE[e.kind]} ${e.to}.`)
    .join("\n");
}

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

function pyList(names: readonly string[]): string {
  return `[${names.map((n) => JSON.stringify(n)).join(", ")}]`;
}

/** Checker: normalize `answer` to a set and compare to the expected set. */
function setChecker(expected: readonly string[]): string {
  const lit = `{${expected.map((n) => JSON.stringify(n)).join(", ")}}`;
  return [
    "_ans = set(answer) if isinstance(answer, (list, set, tuple)) else {answer}",
    `assert _ans == ${lit}, "got " + repr(_ans)`,
  ].join("\n");
}

const DEEDS = ["the sabotage at the docks", "the betrayal of the council", "the theft of the seal"];

export function socialChallenge(
  seed: number,
  knobs: SocialKnobs,
  band: number,
  index: number,
): GeneratedChallenge {
  const graph = generateSocialGraph(seed, knobs);
  const rng = mulberry32(seed ^ 0x9e3779b9); // independent stream for question choice
  const qtype = pick(rng, ["allegiance", "culpability"] as const);
  const relationships = describeGraph(graph);

  if (qtype === "allegiance") {
    const [z, a, b] = sample(rng, graph.agents, 3) as [string, string, string];
    const expected = allegiance(graph, z, a, b, knobs.indirectionDepth);
    const prompt =
      `Relationships:\n${relationships}\n\n` +
      `In an open conflict between ${a} and ${b}, whose side does ${z} take? ` +
      `If ${z} is genuinely torn between them, name both. ${ANSWER_INSTRUCTION}`;
    return {
      name: `social_allegiance_b${band}_s${pad(index)}`,
      category: "social",
      tier: band,
      prompt,
      tags: ["TODO", "social-network", "allegiance"],
      checkerSource: setChecker(expected),
      referenceAnswerPy: `answer = ${pyList(expected)}`,
    };
  }

  const actor = pick(rng, graph.agents);
  const deed = pick(rng, DEEDS);
  const expected = mostCulpable(graph, actor, knobs.indirectionDepth);
  const prompt =
    `Relationships:\n${relationships}\n\n` +
    `${actor} carried out ${deed}. Considering who held sway over ${actor}, ` +
    `who is most culpable for it? If several share culpability equally, name all of them. ` +
    `${ANSWER_INSTRUCTION}`;
  return {
    name: `social_culpability_b${band}_s${pad(index)}`,
    category: "social",
    tier: band,
    prompt,
    tags: ["TODO", "social-network", "culpability"],
    checkerSource: setChecker(expected),
    referenceAnswerPy: `answer = ${pyList(expected)}`,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/gen/social/groundtruth.test.ts src/gen/social/challenges.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd /Users/vcarl/workspace/testbench/llms
npm run typecheck && npm run lint
git add src/gen/social/groundtruth.ts src/gen/social/groundtruth.test.ts src/gen/social/challenges.ts src/gen/social/challenges.test.ts
git commit -m "feat(gen): social allegiance + culpability ground truth and challenge builder

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Financial model + generator

**Files:**
- Create: `src/gen/financial/model.ts`
- Test: `src/gen/financial/model.test.ts`

**Interfaces:**
- Consumes: `mulberry32`, `randInt`, `sample` (Task 1)
- Produces:
  - `interface Entity { name; startingCash; monthlyRevenue; monthlyCost }`
  - `interface Transfer { from; to; amount }`
  - `interface FinancialModel { entities; transfers; horizon; pricedEntity; units; price }`
  - `interface FinancialKnobs { entityCount; horizon; transferDensity; distractorCount }`
  - `simulate(model, priceOverride?): Map<string, number[]>` — name → end-of-month balances (length = horizon)
  - `generateFinancialModel(seed, knobs): FinancialModel`

- [ ] **Step 1: Write the failing test**

`src/gen/financial/model.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { simulate, generateFinancialModel, type FinancialModel } from "./model.js";

// One entity: starts 100, +0 base revenue, priced revenue 10*5=50/mo, cost 60/mo
// → net -10/mo → balances 90, 80, 70 ...
const m: FinancialModel = {
  entities: [{ name: "Solo", startingCash: 100, monthlyRevenue: 0, monthlyCost: 60 }],
  transfers: [],
  horizon: 3,
  pricedEntity: "Solo",
  units: 5,
  price: 10,
};

describe("simulate", () => {
  it("rolls monthly balances with priced revenue", () => {
    expect(simulate(m).get("Solo")).toEqual([90, 80, 70]);
  });
  it("applies a price override", () => {
    // price 14 → priced revenue 70/mo → net +10/mo → 110, 120, 130
    expect(simulate(m, 14).get("Solo")).toEqual([110, 120, 130]);
  });
});

describe("generateFinancialModel", () => {
  it("is deterministic and honors knobs", () => {
    const knobs = { entityCount: 4, horizon: 12, transferDensity: 0.3, distractorCount: 2 };
    const a = generateFinancialModel(5, knobs);
    expect(a).toEqual(generateFinancialModel(5, knobs));
    expect(a.entities).toHaveLength(4);
    expect(a.horizon).toBe(12);
    expect(a.entities.some((e) => e.name === a.pricedEntity)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/gen/financial/model.test.ts`
Expected: FAIL — `./model.js` not found.

- [ ] **Step 3: Implement `src/gen/financial/model.ts`**

```ts
import { mulberry32, randInt, sample } from "../rng.js";

export interface Entity {
  readonly name: string;
  readonly startingCash: number;
  readonly monthlyRevenue: number;
  readonly monthlyCost: number;
}

export interface Transfer {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

export interface FinancialModel {
  readonly entities: readonly Entity[];
  readonly transfers: readonly Transfer[];
  readonly horizon: number;
  /** The entity whose revenue includes price * units (the breakeven lever). */
  readonly pricedEntity: string;
  readonly units: number;
  readonly price: number;
}

export interface FinancialKnobs {
  readonly entityCount: number;
  readonly horizon: number;
  /** Fraction of ordered entity pairs that get a monthly transfer. */
  readonly transferDensity: number;
  /** Extra unused parameters in the prose that do not affect the answer. */
  readonly distractorCount: number;
}

const ENTITY_POOL = [
  "Division Alpha", "Division Beta", "Division Gamma", "Division Delta",
  "Division Epsilon", "Division Zeta", "Division Eta", "Division Theta",
] as const;

/** Returns name → array of end-of-month balances (length = horizon). */
export function simulate(model: FinancialModel, priceOverride?: number): Map<string, number[]> {
  const price = priceOverride ?? model.price;
  const balances = new Map<string, number>();
  const series = new Map<string, number[]>();
  for (const e of model.entities) {
    balances.set(e.name, e.startingCash);
    series.set(e.name, []);
  }
  for (let month = 0; month < model.horizon; month++) {
    for (const e of model.entities) {
      const priced = e.name === model.pricedEntity ? price * model.units : 0;
      balances.set(e.name, (balances.get(e.name) ?? 0) + e.monthlyRevenue + priced - e.monthlyCost);
    }
    for (const t of model.transfers) {
      balances.set(t.from, (balances.get(t.from) ?? 0) - t.amount);
      balances.set(t.to, (balances.get(t.to) ?? 0) + t.amount);
    }
    for (const e of model.entities) series.get(e.name)?.push(balances.get(e.name) ?? 0);
  }
  return series;
}

export function generateFinancialModel(seed: number, knobs: FinancialKnobs): FinancialModel {
  const rng = mulberry32(seed);
  const names = sample(rng, ENTITY_POOL, knobs.entityCount);
  const entities: Entity[] = names.map((name) => ({
    name,
    startingCash: randInt(rng, 200, 800),
    monthlyRevenue: randInt(rng, 0, 40),
    monthlyCost: randInt(rng, 40, 120),
  }));
  const transfers: Transfer[] = [];
  for (const from of names) {
    for (const to of names) {
      if (from === to) continue;
      if (rng() > knobs.transferDensity) continue;
      transfers.push({ from, to, amount: randInt(rng, 5, 30) });
    }
  }
  const pricedEntity = names[0] as string;
  return {
    entities,
    transfers,
    horizon: knobs.horizon,
    pricedEntity,
    units: randInt(rng, 3, 12),
    price: randInt(rng, 8, 20),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/gen/financial/model.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd /Users/vcarl/workspace/testbench/llms
npm run typecheck && npm run lint
git add src/gen/financial/model.ts src/gen/financial/model.test.ts
git commit -m "feat(gen): multi-entity financial model + monthly simulator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Financial ground truth + challenge builders (insolvency, breakeven)

**Files:**
- Create: `src/gen/financial/groundtruth.ts`
- Create: `src/gen/financial/challenges.ts`
- Test: `src/gen/financial/groundtruth.test.ts`, `src/gen/financial/challenges.test.ts`

**Interfaces:**
- Consumes: `FinancialModel`/`simulate`/`generateFinancialModel`/`FinancialKnobs` (Task 5), `GeneratedChallenge` (Task 1)
- Produces:
  - `insolvencyMonth(model): number` — first 1-based month any entity ends negative; `0` if none within horizon
  - `breakevenPrice(model, priceHi?): number` — smallest integer price keeping the priced entity non-negative across the horizon; `priceHi` if unreachable
  - `financialChallenge(seed, knobs, band, index): GeneratedChallenge`

- [ ] **Step 1: Write the failing tests**

`src/gen/financial/groundtruth.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { FinancialModel } from "./model.js";
import { insolvencyMonth, breakevenPrice } from "./groundtruth.js";

// Starts 100, net -60/mo (priced revenue 0) → negative at month 2 (100, 40, -20).
const sinking: FinancialModel = {
  entities: [{ name: "Solo", startingCash: 100, monthlyRevenue: 0, monthlyCost: 60 }],
  transfers: [],
  horizon: 4,
  pricedEntity: "Solo",
  units: 0,
  price: 0,
};

describe("insolvencyMonth", () => {
  it("finds the first month an entity goes negative (1-based)", () => {
    expect(insolvencyMonth(sinking)).toBe(3); // 100, 40, -20 → month 3
  });
  it("returns 0 when solvent through the horizon", () => {
    const solid = { ...sinking, entities: [{ ...sinking.entities[0]!, monthlyCost: 10 }] };
    expect(insolvencyMonth(solid)).toBe(0);
  });
});

describe("breakevenPrice", () => {
  it("finds the smallest integer price avoiding insolvency", () => {
    // units 5, cost 60, start 100, horizon 4: need price*5 >= 60 → price >= 12.
    const m: FinancialModel = { ...sinking, units: 5, price: 0 };
    expect(breakevenPrice(m, 100)).toBe(12);
  });
});
```

`src/gen/financial/challenges.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { financialChallenge } from "./challenges.js";

const knobs = { entityCount: 4, horizon: 12, transferDensity: 0.3, distractorCount: 2 };

describe("financialChallenge", () => {
  it("is deterministic with a stable unique name", () => {
    const a = financialChallenge(200, knobs, 3, 4);
    const b = financialChallenge(200, knobs, 3, 4);
    expect(a).toEqual(b);
    expect(a.name).toMatch(/^financial_(insolvency|breakeven)_b3_s0004$/);
  });
  it("asks for `answer` and ships a numeric-tolerance checker", () => {
    const c = financialChallenge(200, knobs, 3, 4);
    expect(c.prompt).toMatch(/answer/);
    expect(c.checkerSource).toMatch(/abs\(answer/);
    expect(c.referenceAnswerPy).toMatch(/^answer = /);
    expect(c.checkerSource).not.toMatch(/ALL_TESTS_PASSED/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/gen/financial/groundtruth.test.ts src/gen/financial/challenges.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/gen/financial/groundtruth.ts`**

```ts
import { simulate, type FinancialModel } from "./model.js";

/** First 1-based month any entity ends negative; 0 if solvent through horizon. */
export function insolvencyMonth(model: FinancialModel): number {
  const series = simulate(model);
  for (let month = 0; month < model.horizon; month++) {
    for (const balances of series.values()) {
      if ((balances[month] ?? 0) < 0) return month + 1;
    }
  }
  return 0;
}

function pricedStaysSolvent(model: FinancialModel, price: number): boolean {
  const series = simulate(model, price);
  return (series.get(model.pricedEntity) ?? []).every((b) => b >= 0);
}

/**
 * Smallest integer price keeping the priced entity non-negative across the whole
 * horizon. Solvency is monotonic in price, so a linear scan suffices; returns
 * `priceHi` if even that price is insufficient.
 */
export function breakevenPrice(model: FinancialModel, priceHi = 1000): number {
  for (let p = 0; p <= priceHi; p++) {
    if (pricedStaysSolvent(model, p)) return p;
  }
  return priceHi;
}
```

- [ ] **Step 4: Implement `src/gen/financial/challenges.ts`**

```ts
import {
  generateFinancialModel,
  type FinancialModel,
  type FinancialKnobs,
} from "./model.js";
import { insolvencyMonth, breakevenPrice } from "./groundtruth.js";
import { mulberry32, pick, randInt } from "../rng.js";
import type { GeneratedChallenge } from "../emit.js";

const ANSWER_INSTRUCTION =
  "Reason briefly if you wish, then give your final answer as a single Python code block " +
  "that assigns a numeric variable named `answer`. Output nothing after that block.";

const DISTRACTORS = [
  "industry CPI is 3.1% annually",
  "the head office occupies 12,000 sq ft",
  "the logo was last refreshed 2 years ago",
  "staff satisfaction polls at 78%",
  "the fiscal year starts in April",
];

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

function describeModel(model: FinancialModel, distractorCount: number, rng: () => number): string {
  const lines = model.entities.map((e) => {
    const priced =
      e.name === model.pricedEntity
        ? ` It sells ${model.units} units/month at a set price.`
        : "";
    return `- ${e.name}: starts with $${e.startingCash}, earns $${e.monthlyRevenue}/month in other revenue, spends $${e.monthlyCost}/month.${priced}`;
  });
  const transfers = model.transfers.map(
    (t) => `- Each month, ${t.from} pays $${t.amount} to ${t.to}.`,
  );
  const distractors: string[] = [];
  for (let i = 0; i < distractorCount; i++) distractors.push(`- Note: ${pick(rng, DISTRACTORS)}.`);
  return [...lines, ...transfers, ...distractors].join("\n");
}

/** Numeric checker with absolute tolerance. */
function numericChecker(expected: number, tol: number): string {
  return `assert abs(answer - ${expected}) < ${tol}, "got " + repr(answer)`;
}

export function financialChallenge(
  seed: number,
  knobs: FinancialKnobs,
  band: number,
  index: number,
): GeneratedChallenge {
  const model = generateFinancialModel(seed, knobs);
  const rng = mulberry32(seed ^ 0x85ebca6b);
  const qtype = pick(rng, ["insolvency", "breakeven"] as const);
  const body = describeModel(model, knobs.distractorCount, rng);

  if (qtype === "insolvency") {
    const month = insolvencyMonth({ ...model, units: 0, price: 0 }); // ignore priced lever here
    const prompt =
      `A group of divisions share cash as follows:\n${body}\n\n` +
      `In which month (counting the first month as 1) does the FIRST division run out of cash ` +
      `(end the month with a negative balance)? If none do within ${model.horizon} months, answer 0. ` +
      `${ANSWER_INSTRUCTION}`;
    return {
      name: `financial_insolvency_b${band}_s${pad(index)}`,
      category: "financial",
      tier: band,
      prompt,
      tags: ["TODO", "financial-model", "insolvency"],
      checkerSource: numericChecker(month, 0.5),
      referenceAnswerPy: `answer = ${month}`,
    };
  }

  const price = breakevenPrice(model);
  const prompt =
    `A group of divisions share cash as follows:\n${body}\n\n` +
    `What is the lowest whole-dollar unit price at which ${model.pricedEntity} stays solvent ` +
    `(never ends a month negative) for all ${model.horizon} months? ${ANSWER_INSTRUCTION}`;
  return {
    name: `financial_breakeven_b${band}_s${pad(index)}`,
    category: "financial",
    tier: band,
    prompt,
    tags: ["TODO", "financial-model", "breakeven"],
    checkerSource: numericChecker(price, 0.5),
    referenceAnswerPy: `answer = ${price}`,
  };
}
```

Note the `randInt` import is used by neither builder directly but keep the import list to exactly what is referenced — remove `randInt` from the import if biome flags it unused. (It is referenced only if you extend distractors; if unused, drop it.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/gen/financial/groundtruth.test.ts src/gen/financial/challenges.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd /Users/vcarl/workspace/testbench/llms
npm run typecheck && npm run lint
git add src/gen/financial/groundtruth.ts src/gen/financial/groundtruth.test.ts src/gen/financial/challenges.ts src/gen/financial/challenges.test.ts
git commit -m "feat(gen): financial insolvency + breakeven ground truth and challenge builder

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Self-check — round-trip every checker against its reference answer via python3

**Files:**
- Create: `src/gen/selfcheck.ts`
- Test: `src/gen/selfcheck.test.ts`

**Interfaces:**
- Consumes: `GeneratedChallenge` (Task 1)
- Produces: `selfCheck(c: GeneratedChallenge, pythonBin?): string | null` — runs `referenceAnswerPy + checkerSource + print(marker)` under python3 exactly as the harness runs it against model output; returns `null` on pass, an error string on failure.

- [ ] **Step 1: Write the failing test** (requires python3 on PATH — same dependency as the `code_exec` scorer)

`src/gen/selfcheck.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { selfCheck } from "./selfcheck.js";
import type { GeneratedChallenge } from "./emit.js";

const base: GeneratedChallenge = {
  name: "sc_demo",
  category: "demo",
  tier: 1,
  prompt: "",
  checkerSource: 'assert abs(answer - 42) < 0.5, "got " + repr(answer)',
  referenceAnswerPy: "answer = 42",
};

describe("selfCheck", () => {
  it("returns null when the reference answer satisfies the checker", () => {
    expect(selfCheck(base)).toBeNull();
  });
  it("returns an error when the reference answer fails the checker", () => {
    expect(selfCheck({ ...base, referenceAnswerPy: "answer = 1" })).toMatch(/sc_demo/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/gen/selfcheck.test.ts`
Expected: FAIL — `./selfcheck.js` not found.

- [ ] **Step 3: Implement `src/gen/selfcheck.ts`**

```ts
import { execFileSync } from "node:child_process";
import type { GeneratedChallenge } from "./emit.js";

const MARKER = "ALL_TESTS_PASSED";

/**
 * Run a challenge's checker against the generator's OWN reference answer, the
 * same way the harness will run it against model output: concatenate the answer
 * assignment, the checker asserts, and a marker print, then exec under python3.
 * Returns null on pass, or an error string describing the mismatch.
 */
export function selfCheck(c: GeneratedChallenge, pythonBin = "python3"): string | null {
  const program = `${c.referenceAnswerPy}\n\n${c.checkerSource}\nprint(${JSON.stringify(MARKER)})\n`;
  try {
    const out = execFileSync(pythonBin, ["-c", program], { encoding: "utf8", timeout: 10_000 });
    return out.includes(MARKER) ? null : `self-check marker missing for ${c.name}`;
  } catch (e) {
    return `self-check failed for ${c.name}: ${(e as Error).message}`;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/gen/selfcheck.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd /Users/vcarl/workspace/testbench/llms
npm run typecheck && npm run lint
git add src/gen/selfcheck.ts src/gen/selfcheck.test.ts
git commit -m "feat(gen): python3 round-trip self-check for generated challenges

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: CLI — assemble the curriculum, self-check, write + commit the corpus

**Files:**
- Create: `scripts/gen-challenges.ts`
- Modify: `challenges/social_network.yaml`, `challenges/financial_model.yaml`, `challenges/*.test.py` (generated outputs — committed)

**Interfaces:**
- Consumes: `socialChallenge` (Task 4), `financialChallenge` (Task 6), `selfCheck` (Task 7), `writeSuite`/`SuiteSpec` (Task 1)
- Produces: a runnable generator (`tsx scripts/gen-challenges.ts`) that emits both suites or exits non-zero if any self-check fails.

- [ ] **Step 1: Implement `scripts/gen-challenges.ts`**

```ts
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { socialChallenge } from "../src/gen/social/challenges.js";
import { financialChallenge } from "../src/gen/financial/challenges.js";
import { selfCheck } from "../src/gen/selfcheck.js";
import { writeSuite, type GeneratedChallenge, type SuiteSpec } from "../src/gen/emit.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHALLENGES_DIR = path.resolve(HERE, "../challenges");

const SOCIAL_BANDS = [
  { agentCount: 5, edgeDensity: 0.4, indirectionDepth: 2, conflictingLoyalties: false },
  { agentCount: 6, edgeDensity: 0.5, indirectionDepth: 3, conflictingLoyalties: true },
  { agentCount: 8, edgeDensity: 0.55, indirectionDepth: 4, conflictingLoyalties: true },
];

const FINANCIAL_BANDS = [
  { entityCount: 2, horizon: 8, transferDensity: 0.0, distractorCount: 1 },
  { entityCount: 4, horizon: 12, transferDensity: 0.3, distractorCount: 2 },
  { entityCount: 6, horizon: 18, transferDensity: 0.5, distractorCount: 3 },
];

const INSTANCES_PER_BAND = 6;

function buildSocial(): GeneratedChallenge[] {
  const out: GeneratedChallenge[] = [];
  SOCIAL_BANDS.forEach((knobs, b) => {
    for (let i = 0; i < INSTANCES_PER_BAND; i++) {
      out.push(socialChallenge(1_000_000 + b * 1000 + i, knobs, b + 1, i));
    }
  });
  return out;
}

function buildFinancial(): GeneratedChallenge[] {
  const out: GeneratedChallenge[] = [];
  FINANCIAL_BANDS.forEach((knobs, b) => {
    for (let i = 0; i < INSTANCES_PER_BAND; i++) {
      out.push(financialChallenge(2_000_000 + b * 1000 + i, knobs, b + 1, i));
    }
  });
  return out;
}

function selfCheckAll(challenges: readonly GeneratedChallenge[]): void {
  const errors = challenges.map((c) => selfCheck(c)).filter((e): e is string => e !== null);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    throw new Error(`${errors.length} self-check failure(s); refusing to write corpus`);
  }
}

function main(): void {
  const social = buildSocial();
  const financial = buildFinancial();

  // Self-check BEFORE writing so a broken corpus is never emitted.
  selfCheckAll(social);
  selfCheckAll(financial);

  const socialSpec: SuiteSpec = {
    id: "social_network",
    version: 1,
    passThreshold: 0.8,
    challenges: social,
  };
  const financialSpec: SuiteSpec = {
    id: "financial_model",
    version: 1,
    passThreshold: 0.8,
    challenges: financial,
  };
  writeSuite(socialSpec, CHALLENGES_DIR);
  writeSuite(financialSpec, CHALLENGES_DIR);
  console.log(
    `wrote ${social.length} social + ${financial.length} financial challenges to ${CHALLENGES_DIR}`,
  );
}

main();
```

- [ ] **Step 2: Run the generator**

Run: `cd /Users/vcarl/workspace/testbench/llms && npx tsx scripts/gen-challenges.ts`
Expected: prints `wrote 18 social + 18 financial challenges …`; creates `challenges/social_network.yaml`, `challenges/financial_model.yaml`, and 36 `challenges/*.test.py` files. If any self-check fails, it exits non-zero and writes nothing — fix the offending builder before continuing.

- [ ] **Step 3: Validate the corpus parses in the harness**

Run: `cd /Users/vcarl/workspace/testbench/llms && ./bench list-prompts`
Expected: the new `social_network` and `financial_model` suites' items appear in the aggregated listing (no schema/load error). If `./bench` needs a build first, follow the repo README's build step, then re-run.

- [ ] **Step 4: Spot-run one suite against a configured model (optional sanity, not a gate)**

Run: `cd /Users/vcarl/workspace/testbench/llms && ./bench submit --config <some-config-id> --challenge challenges/social_network.yaml --archive-dir /tmp/bench-social`
Expected: it runs end-to-end and scores; you do not need any particular pass rate — this only confirms the prompts + checkers execute through the real harness. (Pick any config id from `configs.yaml`.)

- [ ] **Step 5: Verify idempotence**

Run: `npx tsx scripts/gen-challenges.ts && git status --short challenges/`
Expected: re-running produces NO diff in `challenges/` (deterministic seeds → byte-identical output). If there is a diff, a generator is using a non-seeded source of randomness — fix before committing.

- [ ] **Step 6: Lint, typecheck, commit the generator + the corpus**

```bash
cd /Users/vcarl/workspace/testbench/llms
npm run typecheck && npm run lint
git add scripts/gen-challenges.ts challenges/social_network.yaml challenges/financial_model.yaml challenges/social_allegiance_*.test.py challenges/social_culpability_*.test.py challenges/financial_insolvency_*.test.py challenges/financial_breakeven_*.test.py
git commit -m "feat(gen): generate social-network + financial-model challenge corpus

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes (for the executor)

- **Spec coverage:** §3.1 social (allegiance via signed-graph balance ✓, culpability via backward influence ✓; "benefit/flow" intentionally deferred per the user's "social + financial first, allegiance & culpability" scoping). §3.2 financial (insolvency ✓, breakeven ✓; "best cost cut" deferred). The two deferred question types reuse this machinery and can be a fast-follow.
- **Grading primitive:** every challenge is `code_exec` — the only programmatic-checker primitive emittable via the inline YAML loader. Embedding/LLM-judge are out of scope (framework roadmap), so the irreducibly-fuzzy §3.5 dream-synthesis family is NOT in this plan.
- **Set-of-answers** (spec §3.1) is handled by `setChecker`, which normalizes `answer` to a set before comparison and accepts a scalar or a list.
- **Determinism:** every challenge derives from one explicit seed; question-type/role selection uses a second derived stream so it cannot perturb graph/model generation. Names encode band + index and are asserted unique by `buildSuite`.
- **No placeholders:** all code is complete. The one conditional note is the possibly-unused `randInt` import in `financial/challenges.ts` — drop it if biome flags it.
- **Type consistency:** `GeneratedChallenge`/`SuiteSpec` (Task 1) are the single contract every builder and the CLI use; `socialChallenge`/`financialChallenge` both return `GeneratedChallenge`; `writeSuite` consumes `SuiteSpec`.
