# Long-term memory design — append-only vector store + subprocess retrieval tool

**Status:** design / investigation spec. **No code written.** Awaiting human review.
**Date:** 2026-06-30
**Subteam:** B — Long-term memory (Thread 3 of the limbic/cortex refinement).
**Worktree:** `/Users/vcarl/workspace/roci/.claude/worktrees/dream-sequence`
(branch `worktree-dream-sequence`). All file:line references verified against the
rebased post-A tree on 2026-06-30; the analysis warned numbers shift between
branches, so the seam citations below supersede the analysis doc's.

**Scope (charter decision 3, binding):** keep `DIARY.md` as working memory
(unchanged); add an **append-only long-term store backed by a vector DB**;
expose retrieval to the conscious agent as a **subprocess tool, NOT MCP**; the
conscious agent has **write** access. Candidate tech `sqlite-vec`, validate.

Code appears only as tiny illustrative fragments. This is a design document.

---

## TL;DR for the reviewer

- **Feasibility crux (RESOLVED, GREEN).** The conscious agent already invokes an
  in-container bash subprocess tool — `frontier` — that is the *exact* pattern a
  retrieval tool follows: a script base64-piped to `/usr/local/bin/<tool>` (on
  PATH), provisioned idempotently before each loop, and documented to the agent
  in its agent-markdown system prompt. A `memory` CLI is a near-perfect clone of
  that mechanism. No new transport, no MCP. See §2.
- **Deployment (RESOLVED, GREEN with one gap).** The host `players/` dir is
  bind-mounted read-write at `/work/players` in the container, so a SQLite db
  file under `players/<name>/me/` is reachable from **both** host and container.
  The container is `node:20` Debian with **bun**, node 20, and python3. The
  in-container firewall **allows `host.docker.internal`**, and the conscious
  model server is already reached that way (`host.docker.internal:8083/v1`,
  OpenAI-compatible). **The gap:** there is **no embeddings endpoint anywhere in
  the stack today** — the host servers are `mlx_lm.server`, which serves
  chat/completions only. Embedding source is the one genuinely open decision and
  needs a spike. See §3 and §6.
- **The store is greenfield.** No `sqlite-vec`, `better-sqlite3`, `bun:sqlite`,
  or any vector/embedding dependency exists in the repo today (grepped). Nothing
  to migrate; everything is additive.
- **Top 3 decisions needing a human call:** (D2) embedding source, (D4) whether
  to add a pre-cull promotion hook, (D1) the SQLite/vec binding + runtime. See
  "Decisions needing a call" at the end.

---

## 1. Current state — code-grounded map

### 1.1 Where memory lives (the working-memory tier — do NOT change)

- **The store:** plain markdown files under `players/<name>/me/`, accessed via
  the `CharacterFs` service (`services/CharacterFs.ts:23-37`):
  `readDiary/writeDiary` → `DIARY.md` (`:66-72`), `readSecrets/writeSecrets` →
  `SECRETS.md` (`:74-80`), plus read-only `readBackground` (`background.md`),
  `readValues` (`VALUES.md`), `readDrives` (`DRIVES.md`), `readPalette`. Every
  reader is `readFileOr(path, fallback)` — **whole-file, swallow-to-fallback**
  (`:59-63`). `makeCharacterConfig` pins `dir = players/<name>/me`
  (`:116-124`).
- **The working-memory manager (hippocampus):**
  - **Per-step append** — the conscious agent's diary turn is appended in the
    cortex loop: `runDiaryTurn` at `cortex/loop.ts:497`, then read-existing +
    concatenate + write at `cortex/loop.ts:518-520` (`readDiary` →
    `existing ? existing+"\n\n"+entry : entry` → `writeDiary`). Unbounded growth
    within a session.
  - **Consolidate** (`hippocampus/consolidate.ts:37-81`): reads whole diary +
    whole values (`:50-51`), rewrites `DIARY.md` into coherent narrative
    (`writeDiary` at `:71`). `noTools: true`, model role `dinner`/smart, runs
    in-container via `runTurn`. May grow the file.
  - **Dream cull** (`hippocampus/dream.ts:71-186`): reads whole diary + secrets
    + background (`:78-80`), culls `DIARY.md` toward `DIARY_TARGET_LINES = 150`
    (`:16`) with a hard never-grows clamp (`:123-139`), then culls `SECRETS.md`
    similarly (`:161-176`). **Destructive full rewrite.**
  - Both are orchestrated by `runReflection`
    (`core/orchestrator/planned-action.ts:34-65`): `consolidate.execute` then
    `dream.execute`, each `catchAll`→`logError` (post-C fail-loud, best-effort
    continuation). **This is the natural cull-promotion hook (see §5 / D4) and
    it is NOT in the hot `cortex/loop.ts`.**

### 1.2 The read seams the survey flagged as retrieval candidates

All currently whole-file injection, no retrieval (verified, post-A line numbers):

| Seam | Site (post-A) | Analysis doc said |
|---|---|---|
| Forebrain orient, **idle** path: background/values/diary | `cortex/loop.ts:316-318` | `loop.ts:225` |
| Forebrain orient, **in-session** path: background/values/diary | `cortex/loop.ts:410-412` | (same) |
| Consolidate read (diary+values) | `consolidate.ts:50-51` | `consolidate.ts:50` |
| Dream culls read (diary+secrets+background) | `dream.ts:78-80` | `dream.ts:78-79` |

The diary reads in the loop go through `readOrEmpty(...)` (the post-C fail-loud
wrapper). **These seams are retrieval-injection candidates for a *later* phase —
they are NOT in B's core scope** (the charter lists them as "optionally backing
later"). B's core is the new tier + the subprocess tool + write paths; wiring
retrieval into these read seams is a follow-on once the corpus exists. The
analysis is explicit that retrieval "earns its keep later" — the active pain is
destructive forgetting, not prompt overflow (diary is culled to ~150 lines so it
always fits).

### 1.3 The risk this tier addresses (from the analysis, Thread 3)

The cull is a **destructive full rewrite with no raw log** — `DIARY.md` is the
only copy; once culled, episodic detail is gone irreversibly. Best practice is
the inverse: keep an append-only raw episodic log as ground truth, treat the
culled diary as a derived view. The long-term store IS that ground-truth
substrate. (Charter decision 4 keeps secrets culling intentional; this tier does
not change cull *behavior* — it optionally *promotes before* the cull, §5.)

---

## 2. FEASIBILITY CRUX (#2) — how the conscious agent invokes a subprocess tool today

**RESOLVED — the pattern exists and is clean.** This was the gating unknown; it
gates nothing now.

**How the conscious agent runs.** The conscious mind is an **opencode** session
launched inside the Docker container over the shared `docker exec` transport:
`docker exec -i -w /work/players/<name> <containerId> bash -c "<innerCmd>"`
(`hypothalamus/process-runner.ts:26-37`, `:175-225`), where `<innerCmd>` is
`opencode run --agent conscious -m <label> --title … <prompt>`
(`hypothalamus/payload.ts:164-185`). The agent is `mode: primary` with
`permission: {"*": "allow"}` (`conscious/opencode-config.ts:43-62`,
Dockerfile pre-seed `/home/node/.opencode/config.json`), so it has **full tool
access including bash** inside the container.

**The existing subprocess-tool precedent — `frontier`.** This is the template a
retrieval tool copies almost verbatim:

1. **Generation:** `buildFrontierCliScript()` returns a bash script string
   (`conscious/frontier-cli.ts:54-185`).
2. **Provisioning:** `provisionFrontierCli()` base64-pipes that script to
   `/usr/local/bin/frontier` and `chmod 0755` it, idempotent, error-channel
   `never` (`frontier-cli.ts:194-205`). Called from the conscious provisioning
   block `provisionImpl` at `conscious/conscious-thought.ts:98-101`, alongside
   `provisionConsciousProvider` and `writeCharacterAgentFile`.
3. **Discovery:** the agent learns the tool from its **agent-markdown system
   prompt** — `buildCharacterAgentMarkdown()` appends a "Frontier
   (heavy-lifting) tool" section documenting `frontier start|poll|steer|wait`
   (`opencode-config.ts:70-94`). The conscious agent calls it via its Bash tool.
4. **Cross-turn state:** frontier state lives on the shared container fs
   (`/tmp/frontier-<id>`) so a later docker-exec turn reattaches
   (`frontier-cli.ts:8-9`).

**Implication for B:** a `memory` retrieval/write tool is a structurally
identical addition — a generated `/usr/local/bin/memory` CLI, provisioned in the
same `provisionImpl` block, documented in the same agent markdown. **No MCP, no
new transport, no change to the hot loop.** This is the single most important
finding: the crux is green.

---

## 3. DEPLOYMENT & EMBEDDING FEASIBILITY (#3)

### 3.1 Shared volume — CONFIRMED

`containerMounts` bind-mounts host `players/` → `/work/players` **read-write**
(`domain-spacemolt/src/config.ts:13-18`; identical in `domain-github`). `docker
create -v host:container` (`services/Docker.ts:114-150`). So a db file at host
`players/<name>/me/longterm.db` is the same file as `/work/players/<name>/me/
longterm.db` in the container. **Both the host harness and the in-container CLI
can open it.** (Concurrency caveat: SQLite WAL mode + the fact that writes are
infrequent makes cross-process access safe; see D5/risks.)

### 3.2 Container runtime & toolchain — CONFIRMED

`node:20` Debian (`domain-spacemolt/src/docker/Dockerfile:1`). Installed:
**bun** (`:82-84`, `/home/node/.bun/bin` on PATH), node 20, python3, jq, git,
procps. Claude Code + opencode global. A `/work/bin` dir already does `bun
install` of an in-container helper (`:153-156`) — a **second precedent** for
bundling an in-container tool with deps. Host harness runtime is **node ≥20 via
pnpm** (root `package.json`: `engines.node ">=20"`, `packageManager pnpm`). Note
the asymmetry: **host = node/pnpm, container = node *and* bun.**

### 3.3 Network / firewall — CONFIRMED, constrains embedding choices

The container runs `init-firewall.sh` (default-deny egress). Allowlist:
github ranges, `registry.npmjs.org`, `api.anthropic.com`, `platform.claude.com`,
statsig (`domain-github/.../init-firewall.sh:94-114`). **HuggingFace and
models.dev are NOT allowed.** But the host gateway **is**:
`host.docker.internal` and the host /24 are explicitly accepted
(`:129-134`). Consequence:
- An in-container embedder **cannot download a model at runtime** → it must be
  **baked into the image** if embedding runs in-container.
- An in-container CLI **can reach a host embeddings server** at
  `host.docker.internal:<port>` (the conscious provider already does exactly
  this — `opencode-config.ts:34-40` rewrites loopback → `host.docker.internal`).

### 3.4 The embedding gap — UNCONFIRMED, needs a spike

There is **no embeddings endpoint in the stack today** (grepped: zero
`/v1/embeddings`, zero `embedding`-model references in code). The host model
servers are `mlx_lm.server --model <id> --port <p>`
(`services/mlx-backend.ts:275-276`, `buildMlxArgs`), serving
`/v1/chat/completions` and `/v1/completions` only — **mlx_lm.server does not
implement `/v1/embeddings`** (UNCONFIRMED against the exact pinned version, but
true for all known mlx_lm releases). So "use the existing model server for
embeddings" is **not** available off the shelf. Embedding source is a real
decision (D2) with a required spike (§6).

### 3.5 sqlite-vec in this stack — UNCONFIRMED, needs a spike

`sqlite-vec` is a loadable SQLite extension (C, prebuilt per-platform), with
language bindings for node (`better-sqlite3` + the `sqlite-vec` npm package),
python, and bun (`bun:sqlite` has `db.loadExtension()`). The project uses **none
of these today** — greenfield. Unknowns to confirm empirically:
- Does the `sqlite-vec` loadable extension load under **`bun:sqlite`** inside the
  `node:20`/linux-arm64-or-amd64 container? (bun is the lowest-friction
  in-container runtime; `bun:sqlite` is built-in, no native build step.)
- node 20 has **no** `node:sqlite` (that's node 22+), so a node-side path needs
  `better-sqlite3` (native build) — heavier. (Relevant only if the writer/CLI
  is node rather than bun.)
- macOS-arm64 *host* loadability (for the promotion hook / any host-side writer)
  — the host is Apple Silicon.

---

## 4. DECISION: storage tech

**Options.**

- **(A) `sqlite-vec` (single embedded db file), accessed via `bun:sqlite`.**
  One file under `players/<name>/me/`, in the bind mount. Extension loaded with
  `db.loadExtension()`. Append-only table + a `vec0` virtual table for the
  embedding. CPU-friendly brute-force KNN, ample for a single character's
  lifetime corpus (thousands, not millions, of rows).
  - *Pro:* charter's named candidate; zero server; one file co-located with the
    diary; bun built-in driver (no native compile); right-sized per the analysis
    ("graph DB is wrong-sized; embedded store is the right size").
  - *Con:* extension-load must be proven in-container (D1 spike); brute-force
    KNN is O(n) per query (fine at this scale).
- **(B) `sqlite-vec` via node `better-sqlite3`.** Same store, node driver.
  - *Pro:* host harness is node, so a host-side promotion writer is native.
  - *Con:* `better-sqlite3` is a native module needing a build in the image;
    heavier than bun's built-in. Two drivers if the CLI is bun and the hook is
    node.
- **(C) A different vector store (Chroma / LanceDB / a host vector server).**
  - *Pro:* richer features.
  - *Con:* a server to run + firewall holes; over-sized for one low-entity
    character; contradicts the analysis's explicit sizing guidance. Rejected.

**RECOMMENDATION: (A) `sqlite-vec` + `bun:sqlite`,** with the file at
`players/<name>/me/longterm.db` (WAL mode). The in-container `memory` CLI is a
**bun** script (matches the `frontier`/`/work/bin` precedent and avoids a native
build). If a host-side promotion hook is added (D4), it shells out to the *same*
bun CLI rather than embedding a second node driver — one writer implementation,
one schema, invoked from both sides. **Gated on the D1 spike** (extension load
under `bun:sqlite` in-container).

---

## 5. DECISION: write paths (incl. whether to add cull-promotion)

Two write routes, not mutually exclusive:

- **Route 1 — explicit conscious-agent write (charter-required).** The `memory`
  CLI exposes a write verb the agent calls deliberately, e.g.
  `memory remember "<text>" [--tags a,b]`. This is the charter's "conscious agent
  has write access; not all write paths need to be visible in code" — the write
  happens entirely inside the container via the agent's Bash tool.
- **Route 2 — pre-cull promotion hook (the analysis's core-risk fix).** The
  destructive cull (`dream.ts`) is the point where episodic detail is lost
  forever. `runReflection` (`planned-action.ts:34-65`) runs `consolidate` then
  `dream`; a promotion step would, **before** `dream.execute` culls, read the
  current diary and append the (new-since-last-promotion) entries into the
  long-term store as ground truth.

**Options for Route 2.**

- **(D4-i) Add the promotion hook now.** Promote diary entries to long-term
  before the cull, so the raw episodic log survives destructive compression.
  Directly fixes the analysis's #1 risk. Sits in `planned-action.ts` (NOT the
  hot loop). Out-of-scope says don't change cull *behavior* — a *read-before*
  promotion adds a read, it doesn't change what the cull does, so it is
  arguably in-bounds; **flag for the human** (the charter scope line is
  ambiguous here, §"Open scope ambiguities").
- **(D4-ii) Defer it; ship Route 1 only.** Minimal, unambiguously in-scope. The
  conscious agent is responsible for choosing to persist anything durable.
  Risk: if the agent doesn't call `remember`, the cull still loses detail — the
  core risk is unaddressed.
- **(D4-iii) Promotion as a verb the consolidate prompt can call.** Let the
  consolidate model emit `memory remember …` for entries it judges worth
  keeping. Couples persistence to model judgment (same fragility the analysis
  warns about for the cull).

**RECOMMENDATION: ship Route 1 (explicit `remember`) as the in-scope core, and
(D4-i) add a *deterministic* pre-cull promotion hook** — but only after the
human confirms it's in-bounds. Route 1 satisfies the charter literally; (D4-i)
is what actually retires the destructive-forgetting risk the whole thread is
about, and it is deterministic (not model-judged) so it doesn't reintroduce the
cull's blind-forgetting failure mode. If the human rules (D4-i) out of scope,
ship Route 1 alone and file (D4-i) as the immediate follow-up. **Dedup is
required** for (D4-i): promote only entries appended since the last promotion
(track a high-water mark — a timestamp or a content hash — in the db).

---

## 6. DECISION: embedding source (the one with a hard spike)

**Options.**

- **(E1) Host embeddings server, reached at `host.docker.internal:<port>`.**
  Run a dedicated embeddings server natively on the host (e.g. a llama.cpp
  `--embedding` server with a small GGUF embed model like `nomic-embed-text` or
  `bge-small`, or a python sentence-transformers / FastAPI server). The
  in-container `memory` CLI POSTs `{text}` → gets a vector. Mirrors the existing
  conscious-provider architecture exactly (host-native model server, container
  reaches it via the allowed host gateway).
  - *Pro:* matches the established "model servers run native on host" pattern
    (MEMORY: local model server runs native on host); no model baked into the
    image; firewall already allows the route; embedding model swappable without
    a container rebuild; one embed server shared by all characters/containers.
  - *Con:* a new host server to bring up (extend the `roci`/mlx topology with an
    embeddings tier; mlx_lm.server can't do it, so it's a *different* server
    binary — llama.cpp or a python server); a network round-trip per embed
    (fine — embeds are infrequent: on `remember` and on query, not per tick).
- **(E2) In-container CPU embedder, model baked into the image.** Bundle a small
  ONNX/GGUF embed model + a runner (transformers.js / `fastembed` / llama.cpp)
  into the Dockerfile; embed locally with no network.
  - *Pro:* fully self-contained; no host dependency; no per-embed network hop.
  - *Con:* bloats the image; the firewall blocks runtime model fetch so it MUST
    be baked (and re-baked to change models); CPU embed latency in-container
    UNCONFIRMED; duplicates a capability the host is better positioned to serve.
- **(E3) No learned embeddings — lexical/FTS retrieval (sqlite FTS5) only.**
  Skip embeddings entirely for v1; use full-text search over the append-only
  log.
  - *Pro:* zero embedding infra; ships immediately; FTS5 is built into SQLite.
  - *Con:* not "a vector DB" (charter decision 3 names a vector DB); no semantic
    recall. Viable as a *fallback* if the embedding spike disappoints, or as a
    hybrid (FTS5 + vec).

**RECOMMENDATION: (E1) host embeddings server,** because it matches the stack's
"models run native on host, container reaches host" architecture and keeps the
image lean and the embed model swappable. **But this is gated on a spike** (§7):
embedding/retrieval *quality* on this character-memory corpus is unproven, and
the host embed server is net-new infra. Carry **(E3) FTS5 as the documented
fallback** (mirrors how Subteam A carried a leaner fallback) — if the spike
shows poor semantic recall or the host server is too costly to operate, ship
hybrid-with-FTS or FTS-only and revisit vectors later. The analysis itself says
retrieval "earns its keep later," so an FTS-first v1 is defensible.

---

## 7. SPIKES REQUIRED BEFORE BUILDING (spike-before-build discipline)

Subteam A's spike caught a dead signal (the 2B can't do abstract-emergency
interrupts) before code was wired around it. B has analogous model-/infra-
dependent uncertainty. **Run these before writing implementation:**

1. **[BLOCKER] sqlite-vec loads under `bun:sqlite` in-container (D1).** In a
   throwaway scratch dir: `bun` script that opens a db, `loadExtension` the
   `sqlite-vec` build for the container's arch, creates a `vec0` table, inserts
   and KNN-queries a handful of vectors. Run it **inside the actual container
   image** (`docker exec`), not just on the host. Pass/fail: extension loads and
   a KNN query returns ranked rows. If it fails under bun, fall back to D-option
   (B) (`better-sqlite3`, native build) or (E3) FTS5.
2. **[BLOCKER] Embedding source + quality (D2/E1).** Stand up the candidate host
   embed server (e.g. llama.cpp `--embedding` with `nomic-embed-text` or
   `bge-small`). From inside the container, embed ~20–40 representative diary
   entries + a handful of queries; eyeball top-k retrieval relevance
   (planted-fact recall, drop-of-noise). Measure embed latency per call. Pass:
   semantically related entries rank above unrelated noise; latency is
   negligible vs. the turn budget (embeds are infrequent). If quality is poor →
   try a different embed model or fall back to (E3)/hybrid. (This mirrors the
   §1.3 "retrieval quality is the uncertain axis" risk.)
3. **[CONFIRM] Cross-process SQLite safety.** Confirm WAL-mode concurrent access
   from the host hook (if D4-i) and the in-container CLI doesn't corrupt or
   deadlock (writes are infrequent + serialized in practice, but verify).
4. **[CONFIRM] Image-size / build impact** if (E2) is chosen instead of (E1).

Spikes are throwaway (scratchpad), reusable harness, like A's `/tmp/claude-spike`.

---

## 8. DECISION: retrieval interface (the subprocess CLI shape)

Modeled on `frontier` (verb-based bash CLI, documented in agent markdown).

**Proposed CLI (`/usr/local/bin/memory`, a bun script):**

```
memory remember "<text>" [--tags a,b,c]      # append + embed; prints the new id
memory search  "<query>" [-k N] [--tags …]   # top-k; prints ranked results
memory recent  [-n N]                        # most-recent N entries (no embed)
```

- **`search` stdout (recommended): one JSON object per line (NDJSON)** — the
  agent reads structured results, and bun/jq parse it trivially:
  `{"id":…,"score":0.83,"ts":"2026-…","tags":["combat"],"text":"…"}`. (A
  human-readable text mode is a cheap add if preferred; NDJSON is the load-
  bearing default.)
- **Discovery:** add a "Long-term memory" section to
  `buildCharacterAgentMarkdown` (`opencode-config.ts:70-94`) documenting the
  three verbs and when to use them ("recall what you knew earlier in your life";
  "persist something you want to keep past tonight's cull"). Author the query/
  text yourself — never paste raw inbound event text (same laundering note the
  frontier tool carries, `frontier-cli.ts:48-52`).
- **Provisioning:** a `provisionMemoryCli(containerId, opts)` mirroring
  `provisionFrontierCli` (base64 → `/usr/local/bin/memory` → chmod 0755,
  idempotent, error-channel `never`), called in `provisionImpl`
  (`conscious-thought.ts:81-106`) next to `provisionFrontierCli`.

**Embedding access from the CLI:** `search`/`remember` POST text to the host
embed server at `host.docker.internal:<port>` (D2/E1). The base URL is injected
the same way the conscious provider's is — derived from a handle and passed into
the provisioner.

---

## 9. DECISION: schema (append-only record shape)

Append-only; rows are never updated or deleted (the whole point — durable ground
truth). Proposed:

```sql
-- the log of record (one row per remembered item)
CREATE TABLE memories (
  id        INTEGER PRIMARY KEY,          -- monotonic rowid
  ts        TEXT NOT NULL,                -- ISO-8601 write time
  source    TEXT NOT NULL,               -- 'conscious' | 'promotion' | …  (provenance)
  tags      TEXT,                        -- comma-joined or JSON array
  text      TEXT NOT NULL                -- the episodic content
);
-- the vector index (sqlite-vec virtual table), keyed by the same id
CREATE VIRTUAL TABLE memories_vec USING vec0(
  id INTEGER PRIMARY KEY,
  embedding FLOAT[<dim>]                 -- <dim> = the embed model's dimension
);
-- optional hybrid lexical fallback (E3) — cheap to add alongside
CREATE VIRTUAL TABLE memories_fts USING fts5(text, content='memories', content_rowid='id');
-- promotion high-water mark (dedup for D4-i): a 1-row meta table or a MAX(ts) query
```

`provenance/source` distinguishes deliberate conscious writes from
promotion-hook writes; `tags` enables `--tags` filtering. Keeping the vector in a
separate `vec0` table (not a column) is the sqlite-vec idiom and lets the
lexical/FTS fallback coexist for a hybrid retrieval if the spike warrants it.

---

## 10. Implementation plan — test-first units (pure helpers first)

Matches the shipped specs' unit-by-unit TDD style. **Gate: spikes §7 pass
first.** None of the core units touch the hot `cortex/loop.ts` (rebase-safe); the
only contended touch is the optional D4-i hook in `planned-action.ts` (medium
contention — C and the reflection path live there).

- **Unit 1 (pure):** schema + query SQL builders — `buildSchemaSql()`,
  `buildInsertSql()`, `buildKnnSql(k, tagFilter)`. String/shape assertions only,
  no db. *(no hot-path touch)*
- **Unit 2 (pure):** CLI arg parser — `parseMemoryArgs(argv)` →
  `{verb, text, query, k, tags}`; usage/error on bad input. *(pure)*
- **Unit 3 (pure):** result formatter — `formatResults(rows)` → NDJSON lines;
  `parseEmbedResponse(json)` → `number[]`. *(pure)*
- **Unit 4:** the `memory` CLI bun script generator `buildMemoryCliScript(opts)`
  + `provisionMemoryCli` — mirror `frontier-cli.ts` (string-shape unit tests for
  the script; provisioning is the swallow-`never` Docker pipe). *(new file under
  `conscious/`)*
- **Unit 5:** embedding client — `embed(text, baseUrl)` POST to the host embed
  server; tested against a stub server (or a recording fake). *(pure-ish, I/O at
  the edge)*
- **Unit 6:** wire provisioning into `provisionImpl`
  (`conscious-thought.ts:98-101` neighborhood) + document the tool in
  `buildCharacterAgentMarkdown` (`opencode-config.ts`). Test: markdown contains
  the verbs; provisioning called. *(no hot-path touch)*
- **Unit 7 (optional, D4-i — only if human approves):** deterministic pre-cull
  promotion in `runReflection` (`planned-action.ts:34-65`) — read diary, diff
  against the high-water mark, append new entries to long-term **before**
  `dream.execute`. Test in `planned-action.test.ts` (existing fakes): a failing
  embed/write logs-loud and does NOT block the cull (best-effort, post-C
  convention). *(medium-contention file; NOT the loop)*
- **Unit 8 (later phase, explicitly out of B's core):** back the read seams
  (`loop.ts:316-318/410-412`, `consolidate.ts:50`, `dream.ts:78-80`) with a
  retrieval call. **This DOES touch the hot `cortex/loop.ts`** — defer to a
  follow-on once the corpus exists; flagged for rebase-conflict risk.

**Suggested commit order:** units 1–3 (pure helpers) → 4–5 (CLI + embed) → 6
(provisioning + discovery) → 7 (promotion, if approved). Each builds green under
the pre-commit `nx run-many -t build`.

---

## 11. Open risks & scope ambiguities

**Risks.**
- **R1 — embedding infra is net-new and unproven** (§6/§7). The host has no
  embeddings server today; quality and operability are the biggest unknowns.
  Mitigation: spike first; carry FTS5 (E3) as the documented fallback.
- **R2 — sqlite-vec under bun in-container UNCONFIRMED** (§3.5/D1). Mitigation:
  spike; fallback to `better-sqlite3` or FTS5.
- **R3 — cross-process db access** (host hook + in-container CLI on a bind-
  mounted file). WAL + infrequent writes should be safe; confirm (spike #3).
- **R4 — provisioning is best-effort (`never` channel).** Like `frontier`, a
  failed provision surfaces only as a later tool-call failure the agent reads.
  Acceptable (matches house pattern) but means a broken `memory` tool degrades
  silently to "agent can't recall" — worth a loud log if the CLI is absent.
- **R5 — retrieval into read seams touches the hot loop** (Unit 8). Kept out of
  B's core; flagged.

**Scope ambiguities I could not resolve from the docs (need a human call).**
- **S1 — is the D4-i pre-cull promotion hook in scope?** Charter "out of scope:
  changing cull behavior" vs. analysis "the cull is the natural consolidation
  point; keep the raw log append-only." A *read-before-promotion* doesn't change
  what the cull does, but it's adjacent. The handoff says "Likely yes." **Needs
  an explicit yes/no.** (My rec: yes, deterministic, in `planned-action.ts`.)
- **S2 — embedding-server ownership.** (E1) requires extending the host
  `roci`/mlx server topology with an embeddings tier (a non-mlx server binary).
  Is standing up/owning that server in B's scope, or a separate infra task? The
  charter says "what embedding model is available on the host" — implying one
  may need to be *made* available. **Needs a call.**
- **S3 — per-character vs shared store.** Recommendation puts the db under
  `players/<name>/me/` (per-character, matches the diary). Confirm there's no
  desire for a cross-character shared memory (there shouldn't be — identity
  isolation — but it's not stated).

---

## 12. Citations index (verified 2026-06-30, post-A tree)

- Working-memory store: `services/CharacterFs.ts:23-37,59-124`
- Per-step diary append: `cortex/loop.ts:497,518-520`
- Consolidate: `core/limbic/hippocampus/consolidate.ts:37-81` (reads `:50-51`, write `:71`)
- Dream cull: `core/limbic/hippocampus/dream.ts:71-186` (reads `:78-80`, `DIARY_TARGET_LINES :16`, clamp `:123-139`)
- Reflection orchestration (promotion hook site): `core/orchestrator/planned-action.ts:34-65`
- Read seams: forebrain idle `cortex/loop.ts:316-318`, in-session `:410-412`
- **Feasibility crux** — conscious transport: `core/limbic/hypothalamus/process-runner.ts:26-37,175-225`; payload `payload.ts:164-185`
- **Subprocess-tool precedent** — `conscious/frontier-cli.ts:7-9,54-205`; provisioning `conscious/conscious-thought.ts:81-106`; discovery `conscious/opencode-config.ts:70-94`
- Volume mount: `domain-spacemolt/src/config.ts:13-18`; `services/Docker.ts:114-150`
- Container image: `domain-spacemolt/src/docker/Dockerfile:1,82-84,153-156`
- Firewall allowlist: `domain-github/src/docker/init-firewall.sh:94-114,129-134`
- Host model server (no embeddings): `services/mlx-backend.ts:275-276`; handles `model/handles.ts:90-130`
- Host-internal URL rewrite (embed-server access pattern): `conscious/opencode-config.ts:34-40`
```
