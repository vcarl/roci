# brain/ boundary enforcement — grep guards → CI-enforced Biome lint

- **Status:** DECIDED, not yet implemented. Follow-on to `2026-07-03-brain-limbic-cortex-restructure-design.md` (Effort 1, layout only — merged/pending-merge on `feat/wm` tip `b7b4ca6`).
- **Scope guard:** this is an *enforcement-mechanism* change only. No directory moves, no behavior change, no new invariant. The invariant enforced here is exactly the one Effort 1 established (§3.1 of the restructure spec): limbic and cortex never import each other; layer-neutral infra never imports up into cortex.

---

## 1. Goal

Promote the `brain/` layer-boundary guards — today ad-hoc `grep` checks run by hand at task boundaries (see `FINAL LAYERING GUARD SET` in the Effort 1 SDD ledger) — into a Biome lint rule that runs automatically wherever `biome lint` runs, so a `limbic⇎cortex` or infra⇏cortex violation fails the build instead of depending on someone remembering to grep for it.

## 2. Background

Effort 1 reorganized `@roci/core` (`packages/core`) into `packages/core/src/brain/{loop,transport,limbic,cortex}` plus neutral `src/{model,services}` (and non-orchestrator `src/core`). The load-bearing invariant carried forward unchanged from that restructure:

> `brain/limbic/**` and `brain/cortex/**` never import each other. Layer-neutral infra (`brain/transport`, `services`, `model`, non-orchestrator `core`) never imports UP into `brain/cortex`. `brain/loop` is the conductor and is exempt — it legitimately imports both layers to mediate the orient→decide handoff.

Verified state of the tree this design is built against:

- Cross-directory imports today are relative, with the extension kept, e.g. `../limbic/thalamus/event-processor.js` (confirmed live in `packages/core/src/brain/loop/loop.ts`).
- The repo lints with a single root `biome.json`, `"$schema": ".../2.4.6/schema.json"`, via `biome lint .`. No `overrides` key exists yet. No ESLint anywhere.
- `lint/style/noRestrictedImports` is a **stable** Biome rule; it matches the *literal import specifier string* and can be scoped per path via Biome `overrides`.
- Runtime is native Node ESM: `tsc` → `dist/`, `tsx` for dev, `vitest` for tests. `packages/core/package.json` has no `imports` field today; `packages/core/vitest.config.ts` has no `resolve` block today. Zero path aliases exist anywhere in the repo.

Because the guard today matches on relative-path fragments by hand, it (a) isn't enforced anywhere automatically and (b) can't cleanly become a Biome rule as-is — Biome's `noRestrictedImports` matches specifier strings, and a bare relative fragment like `../cortex/` is ambiguous (it means something different depending on how many directories deep the importing file sits). The fix is to first give cross-layer imports one stable string to match on.

## 3. Architecture — three pieces, in dependency order

### Piece 1 — `#brain/*` package-private subpath alias

Introduce a Node subpath import so every import whose target resolves under `src/brain/**` can be written `#brain/<rest>.js` regardless of how deep the importing file lives. This is the stable string Piece 3's lint rule matches on.

Proven resolution recipe (spike-verified across all four toolchains this repo uses — tsc, vitest, tsx dev, built dist):

```json
// packages/core/package.json — order-sensitive
"imports": {
  "#brain/*": { "roci-src": "./src/brain/*", "default": "./dist/brain/*" }
}
```

```ts
// packages/core/vitest.config.ts — net-new resolve block
resolve: {
  alias: [{
    find: /^#brain\/(.*)\.js$/,
    replacement: fileURLToPath(new URL("./src/brain/$1.ts", import.meta.url)),
  }],
}
```

- Vitest needs the `resolve.alias` mirror, not just the condition — setting `resolve.conditions: ["roci-src"]` alone selects the right package.json branch but does not remap the `.js` specifier to real `.ts` source, so resolution still fails. The regex alias sidesteps extension guessing entirely.
- Every from-source Node/tsx runtime (the `./roci` launcher, `apps/roci/package.json`'s `start`/`roci`/`qa-monitor` scripts, anything else invoking `@roci/core` from source) must add `--conditions=roci-src`. The built package runs under plain `node`, which falls through to `default` → `dist/brain/*`.
- `tsc` needs no change: `moduleResolution: "bundler"` matches `default` (no `roci-src` under tsc), resolving to `dist/brain/*.js`, which tsc's own `outDir`/`rootDir` self-package remap resolves back to `src/brain/*.ts` for typechecking.
- **Keep the `.js` in every specifier.** All four toolchains depend on the `.js` → source mapping — vitest's regex alias, and (implicitly) tsc's remap. Never strip it.
- The `#brain/` prefix is byte-identical in source and compiled output (tsc preserves the specifier verbatim), so Piece 3's lint rule can match `#brain/<layer>/` without worrying about src/dist divergence.

### Piece 2 — jscodeshift codemod

Rewrite every import in `@roci/core` whose *target* resolves under `src/brain/**` to the `#brain/*` alias, preserving the `.js` extension.

- **Scope: intra-`@roci/core` only.** The alias is a Node subpath import, which is package-private by construction — it cannot be consumed cross-package. The external `@roci/core/brain/...` deep-imports used by the domain/app packages are untouched; that's a separate, out-of-scope question (§6).
- **Do not convert imports into neutral code.** Imports targeting `src/{model,services,logging,skills,core}` (not under `brain/`) stay relative — `#brain/*` only maps `src/brain/*`, there is no alias for neutral targets in this design.
- **Leave intra-directory imports alone.** A `./sibling.js` import where the target lives in the same directory as the importer stays relative; the alias exists for cross-directory/cross-layer routing, not as a blanket replacement for all relative imports.
- Converts imports in both directions of legitimate traffic — brain-internal (e.g. `cortex/conscious/*` importing `brain/transport/*`) and neutral-into-brain (e.g. `services/CharacterFs.ts` importing `brain/limbic/autonomic/drives.js`, one of the sanctioned exceptions in §5) — the import specifier converts to `#brain/*` even where the edge itself is an allowed exception; only the target-under-`brain/` test decides conversion, not whether the edge is banned.

### Piece 3 — Biome `noRestrictedImports` via per-layer `overrides`

Add `overrides` to `biome.json` (none exist today):

| Override glob (importing file lives here) | Bans |
|---|---|
| `packages/core/src/brain/limbic/**` | importing cortex |
| `packages/core/src/brain/cortex/**` | importing limbic |
| `packages/core/src/brain/transport/**` | importing cortex |
| `packages/core/src/services/**` | importing cortex |
| `packages/core/src/model/**` | importing cortex |
| `packages/core/src/core/**` (excluding `core/orchestrator/**`) | importing cortex |

`brain/loop/**` is deliberately absent from this table — it's the conductor, and legitimately imports both layers.

**Row 6 (`core/**` → cortex) is verify-then-include, not assumed clean.** Effort 1's *verified* guard set was consolidated to three (limbic⇎cortex + `transport`/`services`/`model` → cortex); the `core (non-orchestrator) → cortex` guard appeared in an earlier draft but was not in the final relative-safe set, so its cleanliness is unverified here. The plan MUST grep `core/**` (minus `core/orchestrator/**`) for cortex imports before adding this row: if zero, add it (a free tightening restoring the original 4-guard intent); if non-zero, leave it out and record the specific edge(s) so we understand why `core/` legitimately reaches cortex before deciding to allow or refactor. The other five rows are known-clean from Effort 1 and ship unconditionally.

## 4. Enforcement rules

Each ban above must cover **both** forms, for every row in the table (not just the two brain-internal ones) — or it's evadable by simply not using the alias:

- the alias form — `#brain/cortex/**` / `#brain/limbic/**`
- a raw relative escape — a glob like `**/cortex/**` / `**/limbic/**`, catching anyone who writes `../../cortex/...` instead of going through `#brain/*`

**Open implementation detail, not a design decision** (left for the plan to resolve empirically, not to relitigate): whether Biome's `noRestrictedImports` glob patterns match relative specifier strings directly. If they do, the relative-glob ban is the thing that actually catches a bypass attempt. If Biome can't match a glob against a relative specifier at all, the plan must surface that finding and find whatever *is* supported, rather than silently dropping the relative-form ban and leaving the alias as the only enforced path. The planted-violation step of the verification gate (§6) is where this gets settled — plant both an alias-form and a relative-form violation and confirm both are flagged.

## 5. Allowed exceptions (no config needed)

The sanctioned infra→limbic reads all target **limbic**, and every override in §3 only bans **cortex** — so these pass automatically with no carve-out required:

- `services/CharacterFs.ts` + `core/character-scaffold.ts` → `brain/limbic/autonomic/drives.js`
- `skills/index.ts` (barrel re-export) → `brain/limbic/autonomic/cadence.js`
- `core/domain-bundle.ts` → `brain/limbic/{amygdala,thalamus}` (type-only tag imports)

All three were re-confirmed live in the current tree while writing this spec.

## 6. Verification gate

Done only when all four hold:

1. **Typecheck GREEN** on all 4 nx projects, run with `--skip-nx-cache` (the nx cache can mask a cross-package symbol break).
2. **Full suite at the pre-existing flaky baseline** — only `brain/loop/loop.test.ts` and `core/orchestrator/planned-action.test.ts` may fail (16–18 nondeterministic, per Effort 1's calibration), zero *new* failing test files.
3. **`biome lint` clean on the converted tree, no false positives.** The guards described here are already clean in the current tree (Effort 1 left no violations), so the rule must pass as-is with no exceptions needed beyond §5.
4. **A deliberately planted `limbic→cortex` import is flagged by `biome lint`**, proving the rule bites — then removed, and the tree re-verified clean.

## 7. Out of scope

- **External deep-imports.** Whether/how `@roci/core/brain/...` imports from the domain packages or `apps/roci` should be constrained. `#brain/*` is package-private and cannot address this; it's a separate architectural question.
- **`#model/*` / `#services/*` aliases.** This design only introduces `#brain/*`.
- **The deferred Limbic/Cortex Effect service-facade rewire.** Already deferred to its own follow-up; this effort enforces the existing (facade-less) import graph as-is, it doesn't change how the layers are consumed.

---

## 8. Self-review (inline)

- **Placeholder / TODO scan:** none left. Every file/path claim above (`biome.json`'s current contents, the absence of an `imports` field in `packages/core/package.json`, the absence of a `resolve` block in `vitest.config.ts`, the relative-import style, the three §5 exceptions) was re-checked directly against the tree while writing this spec, not carried over from memory.
- **Internal consistency — "conversion vs. ban" isn't a contradiction.** §3 Piece 2 converts specifiers based purely on *where the target lives* (under `brain/`), while §3 Piece 3 / §5 decide what's *banned* based on layer direction. A converted specifier for a permitted edge (e.g. `services/` → `#brain/limbic/...`) is expected and fine — conversion and enforcement are independent passes over the same string.
- **Scope check:** no directory moves, no behavior change, no new files beyond `biome.json`, `packages/core/package.json`, `packages/core/vitest.config.ts`, and whatever import specifiers the codemod rewrites. Matches §1's "enforcement-mechanism change only" framing.
- **Ambiguity resolved — why `core/orchestrator/**` is excluded from the `core/**` ban.** The orchestrator is the caller that sits above `brain/` entirely (it invokes the loop, memory, and reflection stages) and legitimately reaches into cortex-adjacent modules the same way `brain/loop` does; banning it alongside the rest of `core/` would flag legitimate top-level wiring. This mirrors why `brain/loop/**` itself is exempt in §3.
- **Ambiguity resolved — Piece 3 table lead-in originally implied the dual-form rule only applied to the limbic/cortex rows.** Reworded §4's opening line to state explicitly it applies to all six rows in §3's table, since the infra rows (`transport`/`services`/`model`/`core`) are equally evadable via a relative escape.
