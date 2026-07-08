# brain/ Boundary Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the `brain/` layer-boundary guards — today ad-hoc `grep` checks run by hand at task boundaries — into a Biome lint rule that runs automatically wherever `biome lint` runs, so a `limbic⇎cortex` or infra⇏cortex violation fails the build instead of depending on someone remembering to grep for it. This is an **enforcement-mechanism change only**: no directory moves, no behavior change, no new invariant. The invariant enforced is exactly the one the `brain/` restructure established: limbic and cortex never import each other; layer-neutral infra never imports up into cortex; `brain/loop` is the conductor and is exempt.

**Architecture:** Three pieces, in dependency order:
1. A Node subpath import alias `#brain/*` (package-private to `@roci/core`) so every cross-directory import whose target resolves under `packages/core/src/brain/**` can be written as one stable string (`#brain/<rest>.js`) regardless of how deep the importing file lives — this is the string Biome's rule matches on.
2. A jscodeshift codemod that rewrites every existing relative import/export-from specifier in `@roci/core` whose target resolves under `src/brain/**` to that alias, leaving same-directory sibling imports and neutral-to-neutral imports untouched.
3. Biome `noRestrictedImports` `overrides`, one per layer, each banning both the alias form (`#brain/<banned-layer>/**`) and the raw relative escape (`**/<banned-layer>/**`) so the guard can't be evaded by simply not using the alias.

**Tech Stack:** TypeScript (native ESM, `moduleResolution: "bundler"`), Node subpath imports (`package.json` `imports` field, conditional exports), Vitest 3 (`resolve.alias`), jscodeshift 17 (`@babel/parser` `ts` preset), Biome 2.4.6 (`lint/style/noRestrictedImports`, stable), pnpm 9 workspaces, nx 22 (4 projects: `@roci/core`, `@roci/domain-spacemolt`, `@roci/domain-github`, `roci`).

## Global Constraints

- **Scope guard:** enforcement-mechanism change only. No directory moves, no behavior change, no new invariant. Do not relitigate the layer boundaries themselves — they are already correct and clean on this tree (verified below); this plan only makes them Biome-enforced.
- **Base commit:** `21fe584` (design-spec commit, on top of the squashed restructure `780a4de`, itself on `feat/wm` tip `b7b4ca6`). **Branch:** `worktree-historical-reference`. All git via `git -C /Users/vcarl/workspace/roci/.claude/worktrees/historical-reference …`.
- **BASELINE GATE (inherited, flaky — do not gate on an exact count):** a task is clean if (a) `pnpm exec nx run-many -t typecheck --skip-nx-cache` is GREEN on all 4 projects, (b) the task's own touched suite is GREEN, and (c) no test FILE beyond `src/brain/loop/loop.test.ts` and `src/core/orchestrator/planned-action.test.ts` fails (these two are pre-existing, nondeterministic — 16–18 individual test failures across repeated runs; confirmed still true on this exact tree during plan authoring: full suite run showed `Test Files 2 failed | 82 passed | 4 skipped (88)`, `Tests 18 failed | 952 passed | 4 skipped (974)`, both failing files being exactly these two). `--skip-nx-cache` is mandatory — the nx cache can mask a cross-package symbol break.
- **Commit:** `git -C <root> commit --no-verify -m "…"` — `--no-verify` is required because the repo pre-commit hook runs `nx run-many -t build`, which is out of scope for these commits to trigger. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **Proceed autonomously.** User-approved design (2026-07-07); no spec/plan approval gate needed per-task. Do not pause for confirmation between tasks — implement, verify against the gate above, commit, move to the next task.
- **Never commit files under 100% confidence of correctness without running the stated verify commands first** — every step below has been dry-run against this exact tree during plan authoring (not hypothetical); expected outputs quoted are real captured output, not estimates.

## File Structure

| File | Task | Change |
|---|---|---|
| `packages/core/package.json` | 1 | Add `imports` field (`#brain/*` conditional map) |
| `packages/core/vitest.config.ts` | 1 | Add `resolve.alias` regex mirror |
| `packages/core/src/brain/cortex/conscious/session-runner.ts` | 1 | Convert one representative import to `#brain/transport/process-runner.js` (proof-of-concept; the rest convert in Task 3) |
| ~~`./roci`, `apps/roci/package.json`~~ | 1 | **NOT modified — see Task 1 Step 3.** These consume `@roci/core` via `exports → dist`, so they run core from dist and resolve `#brain/*` via `default → dist/brain` with NO `--conditions` flag. Adding the flag would make dist files jump to src (harmful). |
| `scripts/codemods/rewrite-brain-imports.cjs` | 2 | New — the jscodeshift transform |
| `packages/core/src/**` (34 files) | 3 | Codemod-applied import rewrites (full list in Task 2's dry-run report) |
| `packages/core/src/template-domain/interrupt-rules.ts` | 3 | Formatting touch-up (multi-line import collapses to one line — a `biome format` side effect of the shorter alias specifier) |
| `biome.json` | 4 | Add `overrides` (6 per-layer `noRestrictedImports` bans) |

---

## Task 1: `#brain/*` alias infrastructure

Wire the proven subpath-import recipe (spike-verified across tsc/vitest/tsx/dist — see `.superpowers/sdd/spike-resolution-report.md`) and prove it end-to-end on one real cross-directory brain import.

**Files:**
- Modify: `packages/core/package.json` (add `imports`)
- Modify: `packages/core/vitest.config.ts` (add `resolve.alias`)
- Modify: `packages/core/src/brain/cortex/conscious/session-runner.ts` (convert its `../../transport/process-runner.js` import — line 18 — to `#brain/transport/process-runner.js`)
- **NOT modified:** `./roci`, `apps/roci/package.json` — see Step 3 (they consume core from dist, so no condition flag).

- [ ] **Step 1 — add the `imports` field to `packages/core/package.json`.** Current file has no `imports` key; insert it right after `"type": "module",` and before `"exports": {`:
```json
  "type": "module",
  "imports": {
    "#brain/*": {
      "roci-src": "./src/brain/*",
      "default": "./dist/brain/*"
    }
  },
  "exports": {
```
Order is significant: `roci-src` must be listed before `default`.

- [ ] **Step 2 — add the `resolve.alias` mirror to `packages/core/vitest.config.ts`.** Current file:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
});
```
Replace with:
```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^#brain\/(.*)\.js$/,
				replacement: fileURLToPath(new URL("./src/brain/$1.ts", import.meta.url)),
			},
		],
	},
	test: {
		include: ["src/**/*.test.ts"],
	},
});
```
This is the vitest-specific path: setting `resolve.conditions: ["roci-src"]` alone is NOT sufficient (vite doesn't remap the resulting `.js` literal to the real `.ts` source) — the regex alias is required and sidesteps extension guessing entirely.

- [ ] **Step 3 — determine runtime consumption; add `--conditions=roci-src` ONLY to runtimes that load core from SOURCE (none exist today — do NOT touch the launchers).** `--conditions=roci-src` is a **process-global** switch. It is correct only for a runtime that executes `@roci/core`'s *source* `.ts` (where `#brain/*` must hit `src/brain`), and **harmful** for one executing core's built `dist` (where a `#brain/*` inside a dist `.js` must hit `dist/brain`, not jump to `src`).

  **This corrects the spec's/spike's "every from-source runtime" guidance**, which assumed the launchers run core from source. They do not — verify:
  ```
  node -e "console.log(JSON.stringify(require('./packages/core/package.json').exports))"
  ```
  Expected: `{".":{"import":"./dist/index.js",...},"./*":{"import":"./dist/*",...}}` — the `exports` map points every subpath to `dist/` with **no src/dev condition**, and `apps/roci/node_modules/@roci/core` symlinks to `packages/core`. Therefore `./roci`, all `apps/roci` scripts, and the domain packages resolve `@roci/core/*` → `dist/`, run core from **dist**, and resolve `#brain/*` via the imports map's `default → dist/brain/*` branch **with no flag**. Adding `--conditions=roci-src` to them would force dist files to resolve `#brain/*` to `src` — a dist/src mix. **Leave `./roci` and `apps/roci/package.json` unchanged.**

  The only runtime that loads core *source* is `vitest` (core's own tests), handled by the Step 2 `resolve.alias` mirror — not the flag. Re-confirm nothing else runs a `packages/core/src/*.ts` entry directly:
  ```
  grep -rn "node --import tsx\|\btsx\b" --include="*.json" ./roci apps packages . 2>/dev/null | grep -v node_modules | grep -v /dist/
  ```
  Every hit should be either an app launcher that imports core via the `@roci/core` package specifier (→ dist, no flag) or a `tsx` devDep line. If any hit runs a `packages/core/src/**.ts` file *directly* by path, THAT one alone would need `--conditions=roci-src`; none do today. (The imports map keeps a `roci-src` branch anyway as an escape hatch for direct `node --import tsx <core-src>.ts` debugging — proven in Step 7 — which is not a wired entrypoint.)

- [ ] **Step 4 — convert the one representative import.** In `packages/core/src/brain/cortex/conscious/session-runner.ts` line 18, change:
```ts
import { buildExecArgs } from "../../transport/process-runner.js"
```
to:
```ts
import { buildExecArgs } from "#brain/transport/process-runner.js"
```

- [ ] **Step 5 — typecheck.** Run:
```
cd packages/core && npx tsc --noEmit
```
Expected: exit 0, no output (confirmed green during plan authoring with this exact edit — `tsc` resolves `#brain/transport/process-runner.js` via the `default` branch + its own `outDir`/`rootDir` self-package remap back to `src/brain/transport/process-runner.ts`, no `customConditions` needed).

- [ ] **Step 6 — run the touched test.** Run:
```
cd packages/core && npx vitest run src/brain/cortex/conscious/session-runner.test.ts
```
Expected (confirmed during plan authoring):
```
 ✓ src/brain/cortex/conscious/session-runner.test.ts (6 tests) 1ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

- [ ] **Step 7 — tsx dev-runtime smoke test.** Run from `packages/core`:
```
node --import tsx --conditions=roci-src -e "import('./src/brain/cortex/conscious/session-runner.ts').then(() => console.log('RESOLVED OK')).catch(e => { console.error('FAILED', e.message); process.exit(1); })"
```
Expected: `RESOLVED OK` (confirmed during plan authoring). This proves the `roci-src` branch resolves core from source under `node --import tsx` — the direct-core-src *debugging* path, NOT a wired launcher (per Step 3, the launchers consume core dist).

- [ ] **Step 7b — built-app (dist) resolution smoke — the path `./roci` and the packed app ACTUALLY use.** Build core so its dist reflects the one converted import, then confirm a dist `#brain/*` resolves under PLAIN `node` (no flag → `default` → dist):
```
pnpm exec nx build @roci/core --skip-nx-cache
node --input-type=module -e "import('./packages/core/dist/brain/cortex/conscious/session-runner.js').then(() => console.log('DIST #brain OK')).catch(e => { if (e && e.code === 'ERR_MODULE_NOT_FOUND') { console.error('RESOLUTION FAILED', e.message); process.exit(1); } console.log('DIST #brain OK (resolved; module threw past resolution)'); })"
```
Expected: a `DIST #brain OK...` line (the built `session-runner.js` imports `#brain/transport/process-runner.js`, resolved via the imports map's `default` branch to `dist/brain/transport/process-runner.js`). A `RESOLUTION FAILED` / `ERR_MODULE_NOT_FOUND` for a `#brain/*` specifier means the imports map is wrong for the real runtime path — stop and fix before proceeding. This is the verification the launchers depend on, replacing the (incorrect) flag edits.

- [ ] **Step 8 — full typecheck across all 4 nx projects (sanity that nothing else broke).**
```
pnpm exec nx run-many -t typecheck --skip-nx-cache
```
Expected: `NX   Successfully ran target typecheck for 4 projects and 3 tasks they depend on`.

- [ ] **Step 9 — commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "$(cat <<'EOF'
feat(brain): wire #brain/* subpath alias, convert one proof-of-concept import

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: jscodeshift codemod — author + dry-run proof

Write the transform, verify it targets exactly the brain-crossing imports and nothing else, in dry-run only. Applies nothing.

**jscodeshift is not installed anywhere in this repo** (checked `package.json` at root and every workspace package — no `jscodeshift` dependency, no `node_modules/.bin/jscodeshift`). Use `pnpm dlx jscodeshift@17.3.0` (latest stable at plan-authoring time; confirmed via `npm view jscodeshift version`) rather than adding a permanent devDependency — this is a one-time migration tool needed only for Task 2/3, not an ongoing part of the toolchain.

**Files:**
- Create: `scripts/codemods/rewrite-brain-imports.cjs`

- [ ] **Step 1 — create the transform** at `scripts/codemods/rewrite-brain-imports.cjs` (CommonJS `.cjs` extension deliberately — the repo root `package.json` has `"type": "module"`, and jscodeshift loads transforms via `require()`, so a `.cjs` extension sidesteps any ESM/CJS conflict regardless of the ambient `"type"` field):

```js
/**
 * jscodeshift codemod: rewrite @roci/core relative imports whose target
 * resolves under packages/core/src/brain/** to the `#brain/*` subpath alias.
 *
 * Scope: intra-@roci/core only. Leaves intra-directory (`./sibling.js`)
 * imports untouched. Preserves the `.js` extension on every rewritten
 * specifier (all four toolchains depend on it).
 *
 * Run from the REPO ROOT (paths are resolved relative to process.cwd()):
 *   pnpm dlx jscodeshift@17.3.0 --parser=ts --extensions=ts \
 *     -t scripts/codemods/rewrite-brain-imports.cjs --dry packages/core/src
 *
 * Set CODEMOD_REPORT=1 to print a "<file>: <old> -> <new>" line per
 * rewritten specifier (works in both --dry and apply modes).
 */

const path = require("node:path");

const BRAIN_ROOT = path.resolve(process.cwd(), "packages/core/src/brain");

/**
 * Resolve a relative import specifier (ending in `.js`) against the
 * importing file, to its `.ts` source path. Returns null if the specifier
 * isn't a relative `.js` specifier this codemod understands (bare package
 * specifiers, already-aliased `#brain/*` specifiers, non-`.js` specifiers).
 */
function resolveTsTarget(importerAbsPath, specifier) {
	if (!specifier.startsWith(".")) return null;
	if (!specifier.endsWith(".js")) return null;
	const importerDir = path.dirname(importerAbsPath);
	const targetJs = path.resolve(importerDir, specifier);
	return `${targetJs.slice(0, -".js".length)}.ts`;
}

/** True if `absPath` lives under BRAIN_ROOT. */
function isUnderBrain(absPath) {
	const rel = path.relative(BRAIN_ROOT, absPath);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** `#brain/<rest>.js` for a resolved `.ts` target under BRAIN_ROOT. */
function toBrainAlias(targetTsAbsPath) {
	const relTs = path.relative(BRAIN_ROOT, targetTsAbsPath); // e.g. "transport/process-runner.ts"
	const relJs = `${relTs.slice(0, -".ts".length)}.js`;
	return `#brain/${relJs.split(path.sep).join("/")}`;
}

module.exports = function transformer(file, api) {
	const j = api.jscodeshift;
	const root = j(file.source);
	const importerAbsPath = path.resolve(process.cwd(), file.path);
	const importerDir = path.dirname(importerAbsPath);

	let changed = false;

	/** Rewrite one specifier literal node in place if it qualifies. */
	function maybeRewrite(sourceNode) {
		if (!sourceNode || typeof sourceNode.value !== "string") return false;
		const specifier = sourceNode.value;
		const targetTs = resolveTsTarget(importerAbsPath, specifier);
		if (!targetTs) return false;

		// Leave intra-directory (sibling) imports alone.
		if (path.dirname(targetTs) === importerDir) return false;

		// Only convert imports whose target resolves under src/brain/**.
		if (!isUnderBrain(targetTs)) return false;

		const alias = toBrainAlias(targetTs);
		if (process.env.CODEMOD_REPORT) {
			console.log(`${path.relative(process.cwd(), importerAbsPath)}: "${specifier}" -> "${alias}"`);
		}
		sourceNode.value = alias;
		return true;
	}

	// import ... from "..."; import type ... from "...";
	root.find(j.ImportDeclaration).forEach((p) => {
		if (maybeRewrite(p.node.source)) changed = true;
	});

	// export { ... } from "..."; export type { ... } from "...";
	root.find(j.ExportNamedDeclaration).forEach((p) => {
		if (p.node.source && maybeRewrite(p.node.source)) changed = true;
	});

	// export * from "..."; export * as ns from "...";
	root.find(j.ExportAllDeclaration).forEach((p) => {
		if (maybeRewrite(p.node.source)) changed = true;
	});

	return changed ? root.toSource({ quote: "double" }) : null;
};
```

- [ ] **Step 2 — dry run against `packages/core/src`:**
```
CODEMOD_REPORT=1 pnpm dlx jscodeshift@17.3.0 --parser=ts --extensions=ts \
  -t scripts/codemods/rewrite-brain-imports.cjs --dry packages/core/src
```
Expected tail (confirmed during plan authoring, run against this exact tree):
```
 ERR packages/core/src/services/skills-core.test.ts Transformation error (Unterminated string constant. (78:6))
SyntaxError: Unterminated string constant. (78:6)
...
All done. 
Results: 
1 errors
0 unmodified
140 skipped
34 ok
Time elapsed: 0.766seconds
```
- **The 1 error is pre-existing and harmless, not caused by this transform.** `skills-core.test.ts` line 78 contains a literal U+2028 LINE SEPARATOR character inside a `//` comment (it's testing that the parser under test collapses that exact character) — `@babel/parser`'s `ts` preset chokes on it as a raw source byte. Confirmed via `grep -n "^import\|from ['\"]\." packages/core/src/services/skills-core.test.ts`: this file's only relative imports are `./CharacterFs.js` and `./skills-core.js` — both same-directory siblings, so it has **zero** brain-crossing imports to convert. The codemod's inability to parse this one file costs nothing.
- **34 ok, 140 skipped, 0 unmodified** accounts for all 175 `.ts` files under `packages/core/src` (`34+140+1=175`, confirmed via `find packages/core/src -name "*.ts" | wc -l`).

- [ ] **Step 3 — verify nothing was actually written:**
```
git status --porcelain
```
Expected: empty (dry-run only).

- [ ] **Step 4 — reviewer spot-check.** Re-run Step 2's command, redirect to a file, and check for these four real, concrete cases (all confirmed present/absent as stated during plan authoring):
  - **MUST appear** — neutral→limbic cross-dir (one of the design's sanctioned exceptions, §5 of the spec):
    ```
    packages/core/src/services/CharacterFs.ts: "../brain/limbic/autonomic/drives.js" -> "#brain/limbic/autonomic/drives.js"
    ```
  - **MUST appear** — brain-internal cross-dir (cortex→transport):
    ```
    packages/core/src/brain/cortex/conscious/session-runner.ts: "../../transport/process-runner.js" -> "#brain/transport/process-runner.js"
    ```
  - **MUST NOT appear** — same-directory sibling import (`packages/core/src/brain/cortex/conscious/conscious-thought.ts` line 7 is `import { runOpenCodeSessionTurn } from "./session-runner.js"` — both files live in `brain/cortex/conscious/`): grep the report for `conscious-thought.ts` and confirm no line mentions `session-runner.js`.
  - **MUST NOT appear** — neutral-to-neutral, no `brain/` crossing (`packages/core/src/services/model-tier-spec.ts` imports `../model/handles.js`, both neutral dirs): grep the report and confirm `model-tier-spec.ts` never appears at all.
  - **MUST NOT appear** — bare/npm specifiers (`"effect"`, `"@effect/platform"`, etc.): the transform only inspects specifiers starting with `.`, so these are structurally impossible to match; spot-check by confirming no report line's left-hand side lacks a leading `.` or `#`.
  - **KNOWN SCOPE LIMIT — dynamic `import()` is not rewritten.** The transform handles static `import`/`export … from` declarations only, not dynamic `import("…")` call expressions. This is NOT an enforcement hole: Biome's `noRestrictedImports` matches dynamic-import specifiers too (Task 4's planted-violation test uses a dynamic `import("#brain/cortex/…")`), and the relative-form ban (`**/cortex/**`) catches a dynamic relative escape as well — so any cross-layer dynamic import is still flagged whether or not it's aliased. Confirm the scope of what's left relative: `grep -rnE "import\(['\"]\.\.?/" packages/core/src/brain packages/core/src/services packages/core/src/model packages/core/src/core | grep -E "limbic|cortex|transport|loop"` — record any dynamic brain-target imports found (they stay relative by design). If the count is non-trivial and you'd want them aliased for consistency, note it for the controller rather than silently extending the codemod.

- [ ] **Step 5 — commit the transform only** (not any dry-run report file):
```
git -C <root> add scripts/codemods/rewrite-brain-imports.cjs
git -C <root> commit --no-verify -m "$(cat <<'EOF'
feat(brain): author jscodeshift codemod for #brain/* import rewrite (dry-run verified)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: apply codemod + verify

Apply the Task 2 transform for real across `packages/core/src`, fix the one formatting side-effect it produces, then run the full verification gate.

**Files:**
- Modify: the 34 files identified in Task 2's dry-run report (full list obtainable via `git diff --name-only` after Step 1 below)
- Modify: `packages/core/src/template-domain/interrupt-rules.ts` (formatting touch-up, Step 2)

- [ ] **Step 1 — apply the codemod (drop `--dry`):**
```
pnpm dlx jscodeshift@17.3.0 --parser=ts --extensions=ts \
  -t scripts/codemods/rewrite-brain-imports.cjs packages/core/src
```
Expected tail: same stats as the Task 2 dry run — `1 errors / 0 unmodified / 140 skipped / 34 ok` (the same pre-existing `skills-core.test.ts` parse hiccup, still harmless — it has no brain-crossing imports).
```
git diff --stat -- packages/core/src | tail -1
```
Expected: `34 files changed, 107 insertions(+), 107 deletions(-)` (confirmed during plan authoring).

- [ ] **Step 2 — fix the one formatting side effect.** Shortening `../brain/limbic/amygdala/interrupt.js` to `#brain/limbic/amygdala/interrupt.js` in `packages/core/src/template-domain/interrupt-rules.ts` makes a previously-wrapped multi-line import now fit under Biome's 100-char line width; the codemod's printer (recast) does not reflow it, so Biome's formatter wants to collapse it. **Scope the fix to exactly this one file — do NOT run `biome format --write` (or `biome check --write`) broadly across `packages/core/src`,** because this tree has ~166 pre-existing files with unrelated baseline formatting drift (confirmed: `npx biome format --max-diagnostics=500 packages/core/src` reports 166 files with formatting diagnostics even before this codemod runs) — a broad `--write` would silently bundle a repo-wide reformat into this commit. Instead:
```
npx biome format --write packages/core/src/template-domain/interrupt-rules.ts
```
Expected diff:
```diff
 import { Layer } from "effect";
-import type { InterruptRule } from "../brain/limbic/amygdala/interrupt.js";
-import {
-	createInterruptRegistry,
-	InterruptRegistryTag,
-} from "../brain/limbic/amygdala/interrupt.js";
+import type { InterruptRule } from "#brain/limbic/amygdala/interrupt.js";
+import { createInterruptRegistry, InterruptRegistryTag } from "#brain/limbic/amygdala/interrupt.js";
 import type { TemplateSituation, TemplateState } from "./types.js";
```
Confirm no other file needs this treatment: diff the set of files `biome format` flags before vs. after the codemod —
```
npx biome format --max-diagnostics=500 packages/core/src 2>&1 | grep -oE "^packages/core/src/[^ ]+\.ts" | sort -u > /tmp/fmt-after.txt
```
compare against a pre-codemod baseline capture (same command run on a clean tree) with `comm -13 baseline.txt after.txt` — expect exactly one new line, `packages/core/src/template-domain/interrupt-rules.ts` (confirmed during plan authoring: this file was NOT in the pre-codemod baseline list, so it has zero pre-existing formatting issues of its own — the only thing wrong with it is the one this step fixes).

- [ ] **Step 3 — full diff sanity check:**
```
git diff --stat -- packages/core/src | tail -1
```
Expected: `34 files changed, 107 insertions(+), 110 deletions(-)` (the 34 codemod files, one of which — `interrupt-rules.ts` — has 3 extra deleted lines from the collapse).

- [ ] **Step 4 — typecheck all 4 nx projects:**
```
pnpm exec nx run-many -t typecheck --skip-nx-cache
```
Expected: `NX   Successfully ran target typecheck for 4 projects and 3 tasks they depend on`.

- [ ] **Step 5 — full test suite at the flaky baseline:**
```
pnpm exec vitest --run
```
Expected (confirmed during plan authoring on this exact combination of Task 1 + Task 2/3 edits applied together):
```
 Test Files  2 failed | 82 passed | 4 skipped (88)
      Tests  18 failed | 952 passed | 4 skipped (974)
```
Verify the two failing files are exactly the known baseline:
```
pnpm exec vitest --run 2>&1 | grep -E "^\s*FAIL" | sed -E 's/.*\| //' | awk '{print $1}' | sort -u
```
Expected:
```
src/brain/loop/loop.test.ts
src/core/orchestrator/planned-action.test.ts
```
Any other file appearing here is a regression — stop and fix before committing.

- [ ] **Step 6 — commit:**
```
git -C <root> add -A && git -C <root> commit --no-verify -m "$(cat <<'EOF'
refactor(brain): apply #brain/* codemod across @roci/core

Rewrites every relative import/export-from whose target resolves under
src/brain/** to the #brain/* subpath alias (34 files); sibling and
neutral-to-neutral imports are untouched. One formatting collapse
(template-domain/interrupt-rules.ts) from the shortened specifier.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Biome `noRestrictedImports` enforcement

Add per-layer `overrides` to `biome.json`, verify clean on the post-codemod tree, then prove the rule bites with planted violations (both the alias form and the raw relative-escape form), then remove them and re-verify clean.

**Files:**
- Modify: `biome.json` (add `overrides`)

**Resolved during plan authoring — the spec's open implementation detail:** Biome's `noRestrictedImports` `patterns[].group` globs **do** match relative specifier strings directly (confirmed empirically: a `**/cortex/**` group pattern flagged `import("../../cortex/conscious/conscious-thought.js")`). So both the alias-form ban and the relative-escape ban are independently effective — the relative-escape ban is not merely theoretical, it is the one that actually catches someone who bypasses the alias. Also confirmed: `noRestrictedImports` supports both `paths` (exact-match) and `patterns` (glob `group` arrays) — this design uses `patterns`.

**Resolved — override `includes` negation syntax.** A single `!` prefix inside an override's own `includes` array excludes that subpath from the override's scope (distinct from the top-level `files.includes`'s `!!` "hard exclude"). Confirmed empirically: `"includes": ["packages/core/src/core/**", "!packages/core/src/core/orchestrator/**"]` flagged a planted violation in `core/_tmp_probe/violation.ts` but NOT one in `core/orchestrator/_tmp_probe_sub_violation.ts`.

**Resolved — the CANDIDATE 6th override (`core/**` excluding `core/orchestrator/**`).** Per the SDD ledger's verify-then-include rule:
```
grep -rnE "^(import|export).*['\"].*cortex" packages/core/src/core/ | grep -v "core/orchestrator/"
```
Expected: zero output (confirmed during plan authoring — no non-orchestrator `core/` file imports cortex). Since zero, the override IS included as row 6 below.

- [ ] **Step 1 — pre-flight: confirm the tree is clean of the 6 target edges** (this should hold post-Task-3, since the codemod only rewrites specifier strings, not which files import what):
```
echo "cortex->limbic:"; grep -rnE "^(import|export).*['\"].*limbic" packages/core/src/brain/cortex/
echo "limbic->cortex:"; grep -rnE "^(import|export).*['\"].*cortex" packages/core/src/brain/limbic/
echo "infra->cortex:"; grep -rnE "^(import|export).*['\"].*cortex" packages/core/src/brain/transport/ packages/core/src/services/ packages/core/src/model/
echo "core(non-orch)->cortex:"; grep -rnE "^(import|export).*['\"].*cortex" packages/core/src/core/ | grep -v "core/orchestrator/"
```
Expected: all four blocks print nothing after their label (confirmed clean during plan authoring — these are the "RELATIVE-SAFE" guard forms from the SDD ledger, robust to both alias and relative-path specifiers since they match on `import|export ... cortex` / `... limbic` substrings, not the specifier's literal prefix).

- [ ] **Step 2 — add the `overrides` array to `biome.json`.** Current file (post-Task-1/2/3, unchanged by this task except this addition):
```json
{
	"$schema": "https://biomejs.dev/schemas/2.4.6/schema.json",
	"assist": {
		"actions": {
			"source": {
				"organizeImports": "on"
			}
		}
	},
	"formatter": {
		"enabled": true,
		"indentStyle": "tab",
		"lineWidth": 100
	},
	"linter": {
		"enabled": true,
		"rules": {
			"recommended": true
		}
	},
	"files": {
		"includes": ["**/*.ts", "**/*.json", "!!**/.nx", "!!**/node_modules", "!!**/dist"]
	}
}
```
Add `"overrides"` after `"files"`:
```json
{
	"$schema": "https://biomejs.dev/schemas/2.4.6/schema.json",
	"assist": {
		"actions": {
			"source": {
				"organizeImports": "on"
			}
		}
	},
	"formatter": {
		"enabled": true,
		"indentStyle": "tab",
		"lineWidth": 100
	},
	"linter": {
		"enabled": true,
		"rules": {
			"recommended": true
		}
	},
	"files": {
		"includes": ["**/*.ts", "**/*.json", "!!**/.nx", "!!**/node_modules", "!!**/dist"]
	},
	"overrides": [
		{
			"includes": ["packages/core/src/brain/limbic/**"],
			"linter": {
				"rules": {
					"style": {
						"noRestrictedImports": {
							"level": "error",
							"options": {
								"patterns": [{ "group": ["#brain/cortex/**"] }, { "group": ["**/cortex/**"] }]
							}
						}
					}
				}
			}
		},
		{
			"includes": ["packages/core/src/brain/cortex/**"],
			"linter": {
				"rules": {
					"style": {
						"noRestrictedImports": {
							"level": "error",
							"options": {
								"patterns": [{ "group": ["#brain/limbic/**"] }, { "group": ["**/limbic/**"] }]
							}
						}
					}
				}
			}
		},
		{
			"includes": ["packages/core/src/brain/transport/**"],
			"linter": {
				"rules": {
					"style": {
						"noRestrictedImports": {
							"level": "error",
							"options": {
								"patterns": [{ "group": ["#brain/cortex/**"] }, { "group": ["**/cortex/**"] }]
							}
						}
					}
				}
			}
		},
		{
			"includes": ["packages/core/src/services/**"],
			"linter": {
				"rules": {
					"style": {
						"noRestrictedImports": {
							"level": "error",
							"options": {
								"patterns": [{ "group": ["#brain/cortex/**"] }, { "group": ["**/cortex/**"] }]
							}
						}
					}
				}
			}
		},
		{
			"includes": ["packages/core/src/model/**"],
			"linter": {
				"rules": {
					"style": {
						"noRestrictedImports": {
							"level": "error",
							"options": {
								"patterns": [{ "group": ["#brain/cortex/**"] }, { "group": ["**/cortex/**"] }]
							}
						}
					}
				}
			}
		},
		{
			"includes": ["packages/core/src/core/**", "!packages/core/src/core/orchestrator/**"],
			"linter": {
				"rules": {
					"style": {
						"noRestrictedImports": {
							"level": "error",
							"options": {
								"patterns": [{ "group": ["#brain/cortex/**"] }, { "group": ["**/cortex/**"] }]
							}
						}
					}
				}
			}
		}
	]
}
```
`brain/loop/**` is deliberately absent — it's the conductor and legitimately imports both layers.

- [ ] **Step 3 — verify clean on the post-codemod tree (no false positives), scoped to this rule specifically.** `biome lint` on this repo already has ~127 pre-existing diagnostics unrelated to this work (confirmed during plan authoring: `npx biome lint --max-diagnostics=500 packages/core/src` reports 6 errors / 94 warnings / 27 infos at baseline, none of them `noRestrictedImports` — categories are `useImportType`, `useTemplate`, `noNonNullAssertion`, `noExplicitAny`, etc.). So "clean" here means **zero `noRestrictedImports` diagnostics**, not a zero exit code:
```
npx biome lint --max-diagnostics=500 packages/core/src 2>&1 | grep -c "noRestrictedImports"
```
Expected: `0`.

- [ ] **Step 4 — plant both violation forms and confirm each is flagged.** Create two throwaway files:
```
cat > packages/core/src/brain/limbic/_tmp_planted_alias.ts <<'EOF'
export const x = () => import("#brain/cortex/conscious/conscious-thought.js");
EOF
cat > packages/core/src/brain/limbic/_tmp_planted_relative.ts <<'EOF'
export const y = () => import("../../cortex/conscious/conscious-thought.js");
EOF
npx biome lint packages/core/src/brain/limbic/_tmp_planted_alias.ts packages/core/src/brain/limbic/_tmp_planted_relative.ts
```
Expected: both files flagged with `lint/style/noRestrictedImports`, exit code 1 (confirmed during plan authoring — the alias-form file matches BOTH group patterns in the limbic override, so it reports twice; the relative-form file matches only the `**/cortex/**` group, so it reports once — 3 diagnostics total is correct, not a bug).

- [ ] **Step 5 — remove the planted violations and re-verify clean:**
```
rm packages/core/src/brain/limbic/_tmp_planted_alias.ts packages/core/src/brain/limbic/_tmp_planted_relative.ts
npx biome lint --max-diagnostics=500 packages/core/src 2>&1 | grep -c "noRestrictedImports"
```
Expected: `0`.

- [ ] **Step 6 — report which forms Biome actually caught** (fold into the task's completion note for the final whole-branch review): both the `#brain/<layer>/**` alias-form pattern and the `**/<layer>/**` relative-escape pattern independently flag violations; Biome's glob engine does match against raw relative specifier strings, so the relative-escape ban is a real, load-bearing enforcement layer and not just belt-and-suspenders.

- [ ] **Step 7 — commit:**
```
git -C <root> add biome.json && git -C <root> commit --no-verify -m "$(cat <<'EOF'
feat(brain): enforce limbic/cortex layer boundary via Biome noRestrictedImports

Per-layer overrides ban both the #brain/<layer>/** alias form and the raw
**/<layer>/** relative escape, for all 6 rows (limbic bans cortex, cortex
bans limbic, {transport,services,model,core(non-orchestrator)} ban cortex).
brain/loop/** is exempt (conductor). Verified clean on the current tree and
confirmed to flag both planted violation forms before removal.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review (inline)

- **Spec coverage:** all 3 architecture pieces (alias, codemod, Biome overrides) covered; all 4 verification-gate items from the design spec §6 covered (typecheck green, suite at flaky baseline, `biome lint` clean with no false positives, planted-violation proof); the §7 out-of-scope items (external deep-imports, `#model/*`/`#services/*` aliases, the deferred facade rewire) are correctly left untouched by every task above; the §5 sanctioned exceptions (drives/cadence/domain-bundle tags) require no carve-out and none was added.
- **Placeholder scan:** no `TBD`, no "similar to above", no elided code — the codemod is the complete, runnable transform (verified by actually running it against this tree during plan authoring, not sketched); the `biome.json` overrides are the complete file content, not a diff fragment with `...`.
- **Type/name consistency:** `#brain/*` (not `#brain/**` or `@brain/*`) used consistently; `roci-src` condition name consistent across `package.json`, the spike report, and every from-source runtime flag; layer directory names (`limbic`, `cortex`, `transport`, `services`, `model`, `core`) consistent with the live tree (re-verified via `find` and `grep` during authoring, not carried over from the design doc's prose).
- **Every command in this plan was actually executed against this exact worktree during plan authoring** (not estimated): the Task 1 alias recipe (tsc/vitest/tsx all green), the Task 2 codemod (dry-run: 34 ok/140 skipped/1 harmless error), the Task 3 apply + format-scope gotcha (the single-file reflow, and the discovery that a broad `biome format --write` would silently touch 166 unrelated pre-existing files — this is why Task 3 Step 2 insists on file-scoped formatting), the combined Task 1+3 full gate (typecheck green ×4, suite at flaky baseline with the exact two known files failing), and the Task 4 Biome behavior (glob-matches-relative-specifiers, `!`-negation override scoping, and the candidate 6th override's zero-hit grep). All exploratory edits were reverted (`git checkout --`) before this plan was written; the worktree is clean.

**Flag for the controller / Task 2 implementer:** the codemod's `resolveTsTarget` only handles specifiers that are relative (start with `.`) AND end in `.js`. If a future file introduces a relative import without the `.js` extension (none exist today — confirmed by the "0 unmodified" dry-run result meaning every candidate specifier matched this shape), the codemod will silently skip it rather than error. This is the intended, documented behavior (matches the spike's "keep the `.js` extension" gotcha) but is worth a second look if Task 3's dry-run-vs-apply diff ever comes up short against a manual expectation.
