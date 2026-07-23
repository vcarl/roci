# Container CLIs package — extract the in-container `memory` + `wm` binaries so the tested code IS the shipped code

**Status:** proposal (maintainer has approved the direction; open questions in §8 need answers before phase 3)
**Date:** 2026-07-22
**Scope:** a new leaf package owning both in-container CLIs; `@roci/core` depends on it, never the reverse.

---

## 1. Motivation

Both in-container binaries are today emitted as **template strings** built on the host and base64-piped into the container. The runtime code that actually executes in the agent's container is therefore *not* the code the unit tests exercise. Two failure modes follow:

### 1a. `memory` — hand-copied duplicates that silently drift
`buildMemoryCliScript` (`packages/core/src/brain/limbic/hippocampus/memory/memory-cli.ts:54-229`) interpolates *some* tested builders verbatim (no-drift) but **re-implements others by hand inside the script body**. The tested TS and the shipped JS are separate source:

| Concern | Shipped (in the string) | Tested mirror | Status |
|---|---|---|---|
| KNN SQL | `knnSql` (`memory-cli.ts:128-133`) | `buildKnnSql` (`memory-sql.ts:90-99`) | **hand-copied; `buildKnnSql` never wired** |
| NDJSON render / score | `fmt` (`memory-cli.ts:134-140`) | `formatResults` + `scoreFromDistance` (`memory-format.ts:49-65,40-42`) | hand-copied |
| tag split | `splitTags` (`memory-cli.ts:125-127`) | `splitTags` (`memory-format.ts:26-32`) / `parseTags` (`memory-args.ts:22-27`) | hand-copied |
| arg parsing | `takeFlag`/`intOr` (`memory-cli.ts:141-155`) | `takeFlag`/`parseIntFlag`/`parseMemoryArgs` (`memory-args.ts:30-87`) | hand-copied |
| provenance | `classify` (`memory-cli.ts:108-110`) | `classify` (`memory-provenance.ts:29-31`) | hand-copied |
| embed call | `embed` (`memory-cli.ts:112-123`) | `embed` (`memory-embed.ts:91-144`) | **hand-copied AND missing the cold-start retry** |
| embed-response validation | inline in `embed` (`memory-cli.ts:120-121`) | `parseEmbedResponse` (`memory-format.ts:73-94`) | **hand-copied AND weaker** (no finite-element check) |

No-drift-by-construction (interpolated via `JSON.stringify` at generate time): `buildSchemaSql`, `buildInsertSql`, `buildVecInsertSql`, `buildMetaGetSql`, `buildMetaSetSql`, `MEMORY_USAGE`, `SOURCE_PROVENANCE`, `PROVENANCE_DEFAULT`, `MIGRATION_COLUMNS`.

**The `buildKnnSql` "never-wired" story.** `buildKnnSql` is fully unit-tested (`memory-sql.test.ts`, 8 assertions across provenance/dims/tag-overfetch) but is **imported by nothing except its own test** (verified: `grep buildKnnSql` over `src` matches only `memory-sql.ts` and `memory-sql.test.ts`). The generator imports the other five builders but *not* this one — it ships `knnSql` instead. Every KNN query the agent actually runs is the untested hand-copy. A green `buildKnnSql` test proves nothing about production.

**The `embed` retry gap is the sharpest live risk.** `memory-embed.ts`'s tested `embed()` carries 7-attempt capped-backoff cold-start tolerance (a bge-small server that 503s / refuses connection while loading its model — see `memory-embed.ts:25-62`). The shipped `embed` in the string has **no retry** — one `fetch`, throw on failure. The very cold-start case the tested code was written to survive is the case the shipped code does not handle.

### 1b. `wm` — no-drift but by a fragile mechanism
`buildWmCliScript` (`packages/core/src/brain/limbic/wm/wm-cli.ts:50-127`) embeds the tested `parseWmFile` / `applyWmMutation` / `renderWmMarkdown` **verbatim via `Function.prototype.toString()`** (`wm-cli.ts:64-68`). This is no-drift, but rests on an **unenforced no-closure / self-contained contract** (documented in `wm-core.ts:5-15`): the moment any of those functions references a module-level value or import, `.toString()` ships a body that references an undefined name and the CLI breaks at runtime with nothing catching it at build. `wm-core` is *also* imported host-side at runtime (`wm-store.ts:30-38` uses `emptyWmFile`/`parseWmFile`/`pruneSettledTodos`/`renderWmMarkdown`), so the same functions serve two runtimes today with only a comment guarding the boundary.

### 1c. String-scraping tests
Because the shipped artifact is a string, the tests assert on **substrings of source** (`script.toContain('"remember"')`, `script.toContain('loadExtension')`, `memory-cli.test.ts:20-82`; `wm-cli.test.ts:11-33`). These lock the string's *shape*, not the binary's *behavior*. (The `wm` suite does additionally execute the emitted script under `node` — `wm-cli.test.ts:37-114` — but the `memory` suite has no equivalent end-to-end run because the db needs `bun:sqlite` + the linux-arm64 `vec0.so`, neither available to host vitest.)

**Goal:** one package whose source *is* the shipped binary. Bundle it, run its tests against the bundle (or its entrypoints directly), install that exact artifact into the container.

---

## 2. Package design

### 2a. Name
Recommend **`packages/player-tools`** → package name **`@roci/player-tools`** (matches the repo's `@roci/core` scope; plural because it owns two binaries). It reads as exactly what it is: the executables that run *inside* the agent container. Alternatives considered — `@roci/agent-cli` (overloads "agent", which already means the character/session), `@roci/container-bins` (fine, less obvious it's TS-authored). No strong reason to deviate; keep `@roci/player-tools`.

### 2b. What MOVES into the package
Pure, runtime-shared logic + the two entrypoints + the bundle + the tests:

- **memory mirror modules** (currently `.../hippocampus/memory/`): `memory-sql.ts`, `memory-format.ts`, `memory-args.ts`, `memory-provenance.ts`, and the **runtime half of** `memory-embed.ts` — i.e. `embed()`, `backoffDelayMs()`, `EmbedRetryOptions`, `parseEmbedResponse` (re-exported from `memory-format`). See §3 for the `embedEndpoint`/`hostInternalBaseUrl` split.
- **`wm-core.ts`** in full (state machine, parser, renderer). It has zero imports (`wm-core.ts` is self-contained by contract), so it moves cleanly.
- **two new entrypoints** replacing the two `build*CliScript` template strings:
  - `src/memory/main.ts` — the `memory` CLI: `import { Database } from "bun:sqlite"`, argv dispatch (`remember`/`search`/`recent`/`promote`/`mark-get`/`mark-set`), calling the mirror modules directly (`buildKnnSql`, `formatResults`, `parseMemoryArgs`, `classify`, `embed`). This is where the drift dies.
  - `src/wm/main.ts` — the `wm` CLI calling `wm-core` functions directly (no `.toString()`).
- **a bundle script** (§2e) producing two single-file bun artifacts.
- **the tests** for all of the above — the existing `memory-sql.test.ts`, `memory-format.test.ts`, `memory-args.test.ts`, `memory-provenance.test.ts`, `memory-embed.test.ts`, `wm-core.test.ts` move with their subjects. The string-scraping suites (`memory-cli.test.ts` build-string cases, `wm-cli.test.ts:11-33`) are **replaced** by behavioral tests that run the entrypoints/bundle.

### 2c. What STAYS in `@roci/core`
Everything host-side — provisioning, docker exec, and the eager-startup ordering rule that only core knows:

- **`installContainerCli`** (`services/install-cli.ts:14-25`) — generic root-exec base64 installer; not CLI-specific.
- **`provisionMemoryCli` / `provisionWmCli`** — reduced to "read the bundle artifact, `installContainerCli` it" (§2f). They keep `MEMORY_CLI_PATH`, `WM_CLI_PATH`, `DEFAULT_DB_PATH`, `VEC_EXTENSION_PATH`, the `WM_*_REL` constants.
- **the eager-startup rule** in `orchestrator.ts:161-193` (memory `:171-178`, wm `:186-193`, no-lazy rationale `:161-170`) — unchanged; still calls `provision*Cli` right after the container is up.
- **`longterm-store.ts`** in full — the Effect service, `docker exec bash -lc`, `cd /work/players/<name>`, shell-quoting, and the **NDJSON parse at `:194-205`**. It is a *host consumer* of the CLI's output contract, not part of the CLI.
- **`memory-rank.ts`** — host-side post-recall re-ranking over already-parsed `MemoryHit`s; never runs in-container.
- **`host-url.ts`** (`hostInternalBaseUrl`) and **`wm-store.ts`** — host-side. `wm-store.ts` will import `wm-core` *from the new package* (see the circularity trap).

### 2d. Dependency direction — and the circularity trap
Target edge: **`@roci/core` → `@roci/player-tools`** only. The package must depend on *nothing in core*.

The trap is `wm-core`. It is imported host-side at runtime by `wm-store.ts:30-38`. If `wm-core` stayed in core while the package's `wm/main.ts` imported it, the edge would be **package → core**, and combined with core → package (provisioning) that is a **cycle** nx cannot build. Therefore `wm-core` **must move into the package**, and `wm-store.ts` (staying in core) imports it back *from* the package — that edge is core → package, no cycle. Same for every memory mirror module: they move, and any host code that used them (`longterm-store.ts` imports the `Provenance` type from `memory-provenance`; `memory-rank.ts` imports from `memory-format`) imports them from the package.

Verified the package will have no back-edge: `wm-core.ts` has no imports; the memory mirror modules import only each other plus `host-url.ts` (`memory-embed.ts:13`) — and that one import is exactly what §3 severs.

### 2e. Exports map
The package is consumed two ways: **host imports** (core importing the pure mirror modules + types) and **bundle inputs** (the two entrypoints, not imported by anyone — bundled). Proposed `package.json`:

```jsonc
{
  "name": "@roci/player-tools",
  "type": "module",
  "exports": {
    "./memory-sql":        { "import": "./dist/memory/memory-sql.js",        "types": "./dist/memory/memory-sql.d.ts" },
    "./memory-format":     { "import": "./dist/memory/memory-format.js",     "types": "./dist/memory/memory-format.d.ts" },
    "./memory-args":       { "import": "./dist/memory/memory-args.js",       "types": "./dist/memory/memory-args.d.ts" },
    "./memory-provenance": { "import": "./dist/memory/memory-provenance.js", "types": "./dist/memory/memory-provenance.d.ts" },
    "./memory-embed":      { "import": "./dist/memory/memory-embed.js",      "types": "./dist/memory/memory-embed.d.ts" },
    "./wm-core":           { "import": "./dist/wm/wm-core.js",               "types": "./dist/wm/wm-core.d.ts" }
  }
}
```
The two `main.ts` entrypoints are **not** in `exports` (nothing imports them; they are bundle inputs). The bundle artifacts ship under `dist/bundles/` (§2f), copied by the same non-`.ts` copy-assets pass core already uses (`packages/core/scripts/copy-assets.js`).

### 2f. nx build ordering + where the artifact lands
- `@roci/player-tools` gets a `build` target. nx `targetDefaults.build.dependsOn: ["^build"]` (`nx.json`) already forces dependencies-first, so core's build waits for the package's build (bundle included). The package's `build` must run **`tsc` (emit `dist/**/*.js` + `.d.ts`) then the bundle step then copy-assets** — mirror core's `"build": "tsc && node scripts/copy-assets.js"`.
- **Bundler.** `bun build` is the natural choice (the runtime is bun; a bun bundle keeps `bun:sqlite`/`node:*` semantics exactly). **But bun is not a declared dependency anywhere** (verified: no `"bun"` in any `package.json`; the root toolchain is pnpm + nx + tsc + vitest + tsx). It is installed *inside the container image* (`domain-spacemolt`/`domain-github` Dockerfiles `:82-84`) but its presence on the **build/CI host is unconfirmed** (open question §8). `esbuild` is likewise **not** a declared devDep — it appears only transitively in `pnpm-lock.yaml`. **Decision needed:** either add `esbuild` as an explicit devDep (portable, no bun-on-host requirement; `--platform=node --format=esm --external:bun:sqlite --external:node:*`, shebang preserved/prepended) or add `bun` to the toolchain and use `bun build`. This spec assumes **esbuild, explicitly declared** unless §8 resolves bun-on-CI is guaranteed.
- **Externals:** `bun:sqlite` and all `node:*` builtins stay external (resolved by the in-container bun at runtime); the bundle inlines only the package's own TS. Result: two files, each starting `#!/home/node/.bun/bin/bun`, e.g. `dist/bundles/memory` and `dist/bundles/wm`.
- **How core locates the bundle.** `provisionMemoryCli`/`provisionWmCli` read the artifact via the package's resolved location. Cleanest: add a tiny host-only export, e.g. `"./bundles/memory-path"` returning `new URL("./memory", import.meta.url)` / `fileURLToPath`, so core never hard-codes a relative `../../node_modules/...` path. Provisioning then becomes `installContainerCli(id, MEMORY_CLI_PATH, readFileSync(memoryBundlePath, "utf8"))`.

---

## 3. Config delivery — env-var contract
Today the only genuinely dynamic, generate-time value is the embed URL: `buildMemoryCliScript` calls `embedEndpoint(opts.embedBaseUrl)` (`memory-cli.ts:57`), and `embedEndpoint` runs the loopback → `host.docker.internal` rewrite (`memory-embed.ts:20-23` via `hostInternalBaseUrl`). `dbPath`/`vecExtensionPath` are overridable but **always default in practice** (`memory-cli.ts:55-56`; `orchestrator.ts:171` passes only `embedBaseUrl`).

A *static bundle cannot bake a per-run value*, so those three move from generate-time interpolation to **runtime env**:

| env var | default (if unset) | who sets it | notes |
|---|---|---|---|
| `MEMORY_EMBED_URL` | — (required) | core provisioning, **already host-rewritten** | final `http://host.docker.internal:8084/v1/embeddings` |
| `MEMORY_DB_PATH` | `me/longterm.db` | unset in practice | relative to cwd |
| `MEMORY_VEC_EXT` | `/usr/local/lib/vec0.so` | unset in practice | baked image path |

The `memory` entrypoint reads `process.env.MEMORY_EMBED_URL ?? throw`, `process.env.MEMORY_DB_PATH ?? "me/longterm.db"`, `process.env.MEMORY_VEC_EXT ?? "/usr/local/lib/vec0.so"`.

**Where the `host.docker.internal` rewrite runs:** it stays **host-side, in core**, at provisioning time. `hostInternalBaseUrl` (`host-url.ts`) is host-only logic and must NOT move into the bundle (moving it would drag a core dependency into the package, and the container has no notion of "loopback vs host gateway"). So the rewrite responsibility splits from today's `embedEndpoint`:
- The **bundle's** embed layer takes an already-final URL (env) and just appends nothing / uses it verbatim — it does NOT call `hostInternalBaseUrl`.
- **Core** composes the final URL when it builds the docker-exec env: `hostInternalBaseUrl(DEFAULT_EMBED_BASE_URL)` + `/embeddings`, passed as `MEMORY_EMBED_URL`.

Delivery mechanism: `docker exec` accepts `-e KEY=VALUE`. `longterm-store.ts`'s exec calls (`readMark`/`writeMark`/`promote`/`remember`/`recall`, `:142-205`) and the provisioning smoke each pass `-e MEMORY_EMBED_URL=...`. (Confirm the `Docker.exec` seam supports env; if not, an `export MEMORY_EMBED_URL=... &&` prefix on the existing `bash -lc` string is the fallback — it already prefixes `cd`.)

---

## 4. Container contract invariants (MUST NOT change)
The migration is a pure refactor of *how the binary is produced*; every observable in-container behavior is frozen:

1. **Install path** `/usr/local/bin/memory`, `/usr/local/bin/wm` (`memory-cli.ts:19`, `wm-cli.ts:7`), root-owned 0755 (`install-cli.ts:20-23`).
2. **Shebang** `#!/home/node/.bun/bin/bun` — bun is not on PATH under `bash -lc`, absolute path is load-bearing (`memory-cli.ts:71`, `wm-cli.ts:54`; asserted `memory-cli.test.ts:24`, `wm-cli.test.ts:15`).
3. **cwd** `/work/players/<name>` (`longterm-store.ts:128,140`); db/wm paths resolve relative to it.
4. **Store paths** `me/longterm.db`, `me/wm.json`, `me/WM.md` (`memory-cli.ts:23`, `wm-cli.ts:10-11`).
5. **NDJSON output** — exact field order `{id, ts, source, provenance, dims, tags, text[, score]}`, `score = 1/(1+distance)`, one object per line, no trailing newline, empty result → empty string (`memory-format.ts:49-65`; the shipped `fmt` `memory-cli.ts:134-140`). **This is byte-parsed at `longterm-store.ts:194-205` — risk #1 (§7).**
6. **Migration-on-open pragma loop** — `PRAGMA journal_mode=WAL` + `busy_timeout=5000`, then the idempotent `PRAGMA table_info(memories)`-guarded `ADD COLUMN` loop over `MIGRATION_COLUMNS` (`memory-cli.ts:93-106`; `memory-provenance.ts:39-44`).
7. **vec0 load** — `db.loadExtension("/usr/local/lib/vec0.so", "sqlite3_vec_init")` — the explicit entrypoint is REQUIRED (bun's filename-derived `sqlite3_vec0_init` default does not match; `memory-cli.ts:97-99`). Extension baked at `domain-spacemolt/src/docker/Dockerfile:156-157` and `domain-github/src/docker/Dockerfile:62-63`, world-readable 0644 for `USER node`.
8. **wm atomic write** — write-tmp(`pid+randomUUID`)-then-rename for both `wm.json` and `WM.md`, and the `pendingDeltas` journal append (`wm-cli.ts:83-124`).

Once the bundle produces byte-identical NDJSON and identical file effects, the host side is untouched.

---

## 5. Phased migration with validation gates
Each phase: files touched · validation · rollback. **The old string path stays live and provisioned until phase 3 passes** — the two coexist so a failure is a no-op.

### Phase 1 — extract entrypoints wired to the mirrors (no bundle yet)
- **Touch:** create `@roci/player-tools` (package.json, tsconfig, project wiring); move the memory mirror modules + `wm-core.ts` + their tests; write `src/memory/main.ts` and `src/wm/main.ts` importing the mirrors directly (incl. `buildKnnSql`, the retrying `embed`, `parseEmbedResponse`). Split `embedEndpoint`'s rewrite per §3. Repoint core's imports of the moved modules (`longterm-store.ts`, `memory-rank.ts`, `wm-store.ts`) to the new package.
- **Validate:** `tsc --noEmit` green across the workspace **with `--skip-nx-cache`** (cross-package moves are exactly the case where nx cache masks a broken downstream); full `vitest --run` green; the moved unit tests pass unchanged; add behavioral tests that execute `src/memory/main.ts` and `src/wm/main.ts` (wm can run under `node` as its test already does, `wm-cli.test.ts:37`). Old `build*CliScript` still present and still provisioned — nothing in-container changed yet.
- **Rollback:** revert the move; the string path never stopped working.

### Phase 2 — bundle step
- **Touch:** add the bundle script + `esbuild` (or bun) devDep; wire `build` to `tsc && bundle && copy-assets`; emit `dist/bundles/{memory,wm}`.
- **Validate:** bundle builds in CI (**this is where the bun-on-host / esbuild-declared question bites — §8**); execute the *bundled* `wm` under node in a test and assert identical WM.md/journal output to the entrypoint; assert both bundles start with the exact shebang and keep `bun:sqlite`/`node:*` external (not inlined). `memory` bundle can only be fully exercised in-container (needs `vec0.so`) — defer its live check to phase 3.
- **Rollback:** drop the bundle target; entrypoints + string path both still work.

### Phase 3 — repoint provisioning (**requires explicit maintainer sign-off**)
- **Touch:** `provisionMemoryCli`/`provisionWmCli` read the bundle artifact instead of calling `build*CliScript`; env-var delivery (§3) added to provisioning and to `longterm-store.ts`'s exec calls.
- **Validate — byte-diff NDJSON against a live container run is MANDATORY before the old path is deleted:** in a real container, run `memory remember` + `memory search` + `memory recent` + `promote`/`mark-get`/`mark-set` through *both* the old string binary and the new bundle against the same db fixture, and assert **byte-identical NDJSON** (field order, `score` formatting, empty-result empty string, trailing-newline behavior) — this is the `longterm-store.ts:194-205` parse contract. Also verify the vec0 load, the migration `ADD COLUMN` loop on a legacy db, and the cold-start retry (kill the embed server, confirm the new binary retries where the old one threw). Only on a clean diff does phase 3 land.
- **Rollback:** provisioning flips back to `build*CliScript` (still present); one-line revert.

### Phase 4 — `wm` rides along
Same repoint for `wm` (lower risk: no NDJSON parse, and its output is already node-executable-tested). Validate WM.md render + `pendingDeltas` journal + atomic-rename identical old-vs-new in a live container. Sign-off can be lighter than phase 3 given no host-side byte contract on `wm` output.

### Phase 5 — delete the string path + scraping tests
- **Touch:** delete `buildMemoryCliScript`, `buildWmCliScript`, and the now-dead in-core mirror copies; delete the string-scraping test cases (`memory-cli.test.ts:20-82` build-string suites, `wm-cli.test.ts:11-33`); keep the provisioning tests (`memory-cli.test.ts:84-119`, `wm-cli.test.ts:116-132`) retargeted at the artifact-reading `provision*Cli`. Delete `knnSql`/`fmt`/`splitTags`/`takeFlag`/`intOr`/`classify`/duplicate-`embed` — they no longer exist anywhere.
- **Validate:** full `vitest --run` + `tsc` `--skip-nx-cache` green; grep confirms no remaining reference to the deleted symbols; one live end-to-end session (QA) exercises real recall.
- **Rollback:** this is the point of no return; do not enter until phase 3/4 have soaked.

---

## 6. Doc updates
- **`packages/core/src/brain/limbic/LIMBIC.md`** — `:79` (`memory-cli.ts` "In-container memory CLI generator"), `:85` (`wm-cli.ts`), `:214`, `:258` describe generation via string/`toString`. Repoint to the new package + "bundle is the shipped artifact" and drop the `.toString()` embedding language for `wm`.
- **`HARNESS.md:288`** names `memory/memory-cli.ts` + `memory/longterm-store.ts` as the memory row — update the path for the CLI half (moved to `@roci/player-tools`); `longterm-store.ts` stays.
- **`packages/core/src/brain/BRAIN.md`** — no current `memory-cli`/`wm-cli` reference found; add a one-line pointer to the new package under the limbic/hippocampus map if BRAIN.md indexes files.
- **`docs/DOMAIN_GUIDE.md` / the two domain Dockerfiles' comments** reference the `memory` CLI + `vec0.so`; no code change, but note the CLI now ships as a bundle so a new domain still just needs `vec0.so` baked + bun in the image.

---

## 7. Risks, ranked
1. **NDJSON byte-drift at the `longterm-store.ts:194-205` seam.** Any difference — field order, `score` float formatting, empty-line handling — silently drops recall hits (the parser `flatMap`s parse failures to `[]`, `:198-204`, so a malformed line is *swallowed*, not thrown). Mitigation: the mandatory phase-3 byte-diff gate; keep `formatResults` as the single source and assert `JSON.stringify` field order matches today exactly.
2. **Bundler/toolchain availability.** Neither bun nor esbuild is a declared host dependency. If CI lacks the chosen bundler, `build` fails workspace-wide. Mitigation: declare `esbuild` explicitly (portable) unless bun-on-CI is confirmed; gate at phase 2.
3. **Behavior *change* smuggled in as a "refactor."** Wiring the *tested* `embed` (with retry) and *tested* `parseEmbedResponse` (finite-element check) actually **changes runtime behavior** vs today's shipped code — this is the desired fix, but it means phase 3 is not a pure no-op and must be validated as a behavior change (cold-start retry test), not assumed identical.
4. **`vec0.so` availability in the test loop.** The `memory` bundle can't be fully exercised by host vitest (needs the baked linux-arm64 extension). Real coverage only exists in-container → phase 3's live run is the *only* place the memory binary is proven end-to-end. Don't let green host tests create false confidence.
5. **Env-delivery seam.** If `Docker.exec` has no `-e` env support, the `export …&&` prefix fallback must be applied consistently to *all* five `longterm-store.ts` exec calls **and** provisioning, or `remember`/`search` hit an unset `MEMORY_EMBED_URL`. Low complexity, easy to miss one call site.
6. **nx cache masking a broken cross-package edge** — the documented gotcha; always validate phase 1/5 with `--skip-nx-cache`.

---

## 8. Open questions (answer before phase 2 / phase 3)
1. **Is bun present on the build/CI host, or only in the container image?** Determines bun-build vs esbuild. (Confirmed: bun is installed in the domain images `Dockerfile:82-84`; **not** declared for the host toolchain.) — blocks phase 2.
2. **Are there NDJSON consumers of `memory` output other than `longterm-store.ts`?** Verified `longterm-store.ts` is the sole parser of `memory search/recent` output in `src` (`memory-rank.ts` consumes the *already-parsed* `MemoryHit[]`; `growth-store.ts` `JSON.parse`s a *different* store, not the memory CLI). Re-confirm no external/QA tooling scrapes the CLI directly before phase 5. — blocks phase 3 sign-off.
3. **Does `Docker.exec` accept per-call env (`-e`)?** Decides env vs `export …&&` prefix delivery (§3/§5). — blocks phase 3.
4. **Bundle location contract:** ship under the package's `dist/bundles/` and resolve via an `import.meta.url` export, or copy into a known runtime dir? Confirm the copy-assets pass picks up non-`.ts` bundle files (core's `copy-assets.js` copies every non-`.ts` file, so a bundle with no extension is copied — verify the extension-less name isn't skipped).

---

### Appendix — corrections vs the prior investigation
- `install-cli.ts` lives at `packages/core/src/services/install-cli.ts` (lines 14-25 correct).
- **`vec0.so` is NOT baked in `.devcontainer/Dockerfile`** — it's in the **domain** Dockerfiles: `domain-spacemolt/src/docker/Dockerfile:156-157` and `domain-github/src/docker/Dockerfile:62-63` (bun install `:82-84` in spacemolt's). The `.devcontainer/Dockerfile` (107 lines) has bun at `:82-84` but no vec0.
- **`esbuild` is NOT a declared devDep** anywhere; it appears only transitively in `pnpm-lock.yaml`. **`bun` is not declared** in any `package.json`. The host toolchain is pnpm + nx + tsc + vitest + tsx.
- `longterm-store.ts` NDJSON parse is at **`:194-205`** (brief said `:194-204`).
- The `memory` CLI's internal verbs are `promote` / `mark-get` / `mark-set`; the old **`promoted-hashes` verb no longer exists** (removed; `memory-cli.test.ts:76` asserts its absence).
- **New drift found beyond the brief's list:** the shipped in-string `embed` (`memory-cli.ts:112-123`) **lacks the cold-start retry** the tested `embed()` has (`memory-embed.ts:91-144`), and its inline embed-response validation is **weaker** than `parseEmbedResponse` (`memory-format.ts:73-94`) — no finite-element check. These are behavior changes phase 3 must validate, not no-ops.
- `wm-core` is imported host-side at **runtime** (not just for types) by `wm-store.ts:30-38` — this is what makes the circularity trap real and forces `wm-core` to move.
- `buildKnnSql` never-wired confirmed: imported only by `memory-sql.test.ts` in all of `src`.
