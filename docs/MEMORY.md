# Long-Term Memory

Characters have two memory tiers with different lifetimes and storage models:

- **Working memory** — the character's diary, kept coherent and bounded by the
  hippocampus. It is rewritten and culled every cycle, so it never grows without
  limit. See the hippocampus section of
  [LIMBIC.md](../packages/core/src/brain/limbic/LIMBIC.md).
- **Long-term memory** — an append-only, per-character vector store. Rows are
  embedded and never updated or deleted; the point is durable episodic ground
  truth that survives the working-memory cull.

This document is the architecture reference for the long-term tier. It spans a
host embeddings server, an in-container CLI + sqlite-vec database, an Effect
store seam, and a pre-cull promotion hook. For the engine that drives the
characters see [CORTEX.md](CORTEX.md); the long-term `memory` CLI is the
structural sibling of the `frontier` delegation tool documented there.

## 1. The two tiers

| | Working memory | Long-term memory |
|---|---|---|
| Storage | the diary text file (`players/<name>/me/`) | sqlite-vec db `players/<name>/me/longterm.db` |
| Lifetime | rewritten + culled every cycle | append-only; rows never updated/deleted |
| Bound | `DIARY_TARGET_LINES = 150` (`brain/limbic/hippocampus/dream.ts:29`) | unbounded log of record |
| Owner | hippocampus `dream` (reflection phase) | the in-container `memory` CLI (hippocampus-owned) |

Working memory is compressed by the unified `dream.execute()` — one module, three
sequential turns: consolidate (the per-cycle narrative rewrite) then cull the diary
toward 150 lines then cull secrets — run from `runReflection`
(`core/orchestrator/planned-action.ts`). Because the cull is destructive, raw episodic
detail that should outlive it is copied into long-term memory *before* the rewrite
(see §5).

## 2. The store (`LongtermStore`)

The host-side seam is the `LongtermStore` Effect service
(`packages/core/src/brain/limbic/hippocampus/memory/longterm-store.ts`), with the production layer
`LongtermStoreLive` (`longterm-store.ts:98`, `R = Docker`). It exposes exactly
three operations, all used by the promotion hook:

- `readMark` — read the bounded promotion high-water mark.
- `writeMark` — persist the mark after the cull.
- `promote` — bulk-promote new raw diary entries; returns the count.

Every operation shells the in-container `memory` CLI over `docker exec`
(`longterm-store.ts:104-138`). It never opens the db from the host: the sqlite-vec
file **Bus-errors when opened by host-side bun on macOS**, so the db is touched
only inside the container (`longterm-store.ts:9-24`). `promote` passes each entry
as a base64 line on stdin (`printf '%s\n' … | memory promote`) because
`Docker.exec` has no stdin seam and base64 tokens are shell-safe
(`longterm-store.ts:127-137`). The CLI resolves its db against the in-container
player cwd `/work/players/<name>` (`longterm-store.ts:91`).

Failures map to a plain `Error` and the caller wraps them in
`catchAll`→`logError` — the whole tier is best-effort.

## 3. The `memory` CLI

The CLI is a generated **bun** script (not bash): it uses `bun:sqlite` +
`loadExtension`, with a shebang pointing at the absolute bun path
(`#!/home/node/.bun/bin/bun`, `memory-cli.ts:66`) because bun is not on PATH under
`bash -lc`. `buildMemoryCliScript` (`memory-cli.ts:52`) interpolates the
unit-tested SQL builders from `memory-sql.ts` at generate time so the schema and
insert shapes can never drift from the TS source.

It exposes six verbs (dispatch at `memory-cli.ts:145-206`):

| Verb | Purpose |
|---|---|
| `remember "<text>" [--tags a,b] [--source s]` | embed + append a row; prints the new id |
| `search "<query>" [-k N] [--tags …]` | top-k nearest neighbours as NDJSON (one object per line, with a `score`) |
| `recent [-n N]` | most-recent N rows, no embedding |
| `promote` | (internal) bulk-promote base64 stdin lines with `source='promotion'`; prints the count |
| `mark-get` | (internal) print the opaque promotion high-water mark, or nothing |
| `mark-set <json>` | (internal) persist the high-water mark verbatim |

`remember`/`search`/`recent` are agent-facing — the conscious OpenCode mind calls
them directly as Bash tool calls. `promote`/`mark-get`/`mark-set` are the internal
verbs the `LongtermStore` seam drives. The argv text is **model-authored**: the
laundering invariant (shared with `frontier`) requires the agent to author its own
query/text and never paste raw inbound event text (`memory-cli.ts:45-50,67-69`).

Installation mirrors `frontier`: the script is base64-piped to
`/usr/local/bin/memory` (`MEMORY_CLI_PATH`, `memory-cli.ts:17`) by
`provisionMemoryCli` (`memory-cli.ts:224-235`), invoked once from
`ConsciousThought.provision` (`conscious-thought.ts:115`). It is provisioned
**as root** (`{ user: "root" }`, `memory-cli.ts:233`) because `/usr/local/bin` is
root-owned and the container's default user is `node`; the installed file ends up
`root:root 0755`, which `node` can execute, and the db lives in node-owned
`players/<name>/me/` so writes work. A provisioning failure propagates and is
logged loud (best-effort), rather than surfacing later as a silent "command not
found".

The db opens in WAL mode and loads the baked sqlite-vec extension with an explicit
entrypoint (`db.loadExtension(VEC_EXT, "sqlite3_vec_init")`, `memory-cli.ts:91`) —
bun's filename-derived default `sqlite3_vec0_init` does not match the extension's
`sqlite3_vec_init`. The extension is baked into the image at
`/usr/local/lib/vec0.so` (`VEC_EXTENSION_PATH`, `memory-cli.ts:19`).

### Schema

`memory-sql.ts` builds three tables (`buildSchemaSql`, `memory-sql.ts:27`), all
`IF NOT EXISTS` (re-created idempotently on every invocation):

- `memories` — the append-only log of record (`id`, `ts`, `source`, `tags`,
  `text`). Rows are never updated or deleted.
- `memories_vec` — the `vec0` virtual table indexing the embedding, keyed by the
  same id (`embedding FLOAT[384]`).
- `meta` — a 1-row key/value table holding the opaque promotion high-water mark
  (key `promote_mark`, `PROMOTE_MARK_KEY`).

KNN search bakes `k` as a SQL literal (sqlite-vec requires `k = <constant>`); only
the query vector is bound (`MATCH ?`). A tag filter over-fetches by `TAG_OVERFETCH`
(8×) and post-filters in JS, because sqlite-vec can't AND an arbitrary tag
predicate with `k` (`memory-sql.ts:78-97`, `memory-cli.ts:112-117`).

## 4. Embeddings

Embeddings are produced by a standalone **host** server, deliberately outside the
mlx tier-server machinery (`apps/roci/src/embed-server.ts`):

- Binds `127.0.0.1:8084` (`EMBED_PORT`, `embed-server.ts:23`) and serves an
  OpenAI-shape `POST /v1/embeddings`.
- Runs `mlx-community/bge-small-en-v1.5-bf16` (`EMBED_MODEL`,
  `embed-server.ts:24`), which emits **384-dim** vectors (`EMBED_DIM = 384`,
  `memory-sql.ts:20`) — the single constant the vec0 table and the embed-response
  validator both key off.
- The script lives at `scripts/embed-server/serve-embeddings.py` and POSTs plain
  text with **no instruction prefix** (proven for bge-small).

The in-container CLI reaches it over the host gateway: the loopback base URL is
rewritten `127.0.0.1` → `host.docker.internal` by `embedEndpoint`
(`memory-embed.ts:20`, via `hostInternalBaseUrl`), the same rewrite the conscious
provider's host URL uses, and already firewall-permitted.

`roci start` launches the server **best-effort**: `launchEmbedServer(PROJECT_ROOT)`
(`cli.ts:132`, impl `embed-server.ts:77`). A missing python env / model / port
must not crash `roci start`; on any failure it logs loud and continues, and
long-term memory degrades gracefully (`memory remember`/`search` throw a tool
error the agent reads; the promotion hook logs-and-skips). It is launched outside
`MODEL_TIER_SPECS` / `mlx-backend.ts` because that topology is hardwired to the
`mlx_lm.server` binary and a chat-completions readiness probe, keyed by the
`CortexTier` cognition union — an embeddings server is a different binary with a
different probe and is not part of cognition.

## 5. Pre-cull promotion

Raw episodic detail is copied into long-term memory before the working-memory cull
destroys it. `runReflection` (`core/orchestrator/planned-action.ts:36`) runs the
promotion **first** (`planned-action.ts:59-78`), then `consolidate`, then `dream`,
then re-baselines the mark (`planned-action.ts:104-120`).

The `brain/loop` engine only **appends** `\n\n`-separated entries to the diary during a
session, so the diary left by the previous reflection is a verbatim **prefix** of
the current one. The hook exploits this with a bounded high-water mark — the
length + sha256 of the previously-marked diary — to isolate exactly the new
appends with no full-history scan and no re-promotion across cycles
(`longterm-store.ts:26-60`):

- `diaryMark(diary)` → `{ len, hash }` (`longterm-store.ts:43`).
- `newSinceMark(diary, mark)` → the entries appended since the mark
  (`longterm-store.ts:55`). The normal path returns `splitDiaryEntries(diary.slice(mark.len))`.
  If the prefix doesn't match (external rewrite, fresh db over an existing diary),
  it promotes the **whole** diary and re-baselines — anti-loss beats occasional
  duplication, and the caller logs it loud.

The mark is computed and validated entirely host-side (node crypto) and stored
opaquely in the db's `meta` table; the CLI never interprets it, so there is no
cross-runtime hashing contract. Promoted rows are written with `source='promotion'`
(`memory-cli.ts:198`). The whole hook is best-effort: any embed/write failure logs
loud (`kind:error`) and does not block consolidate/cull.

## 6. Operational note — the embed-server dormancy gotcha

The embed server's interpreter defaults to plain `python3`: `resolveEmbedPython`
returns the `ROCI_EMBED_PYTHON` env value if set, else `"python3"`
(`embed-server.ts:39-42`). But `serve-embeddings.py` imports `mlx_embeddings`,
which is installed in the host MLX virtualenv (`~/llm-env`, the documented
Apple-Silicon location used by `mlx-backend.ts` for the tier servers —
`mlx-backend.ts:30,35`), **not** in the system `python3`. When `roci start` is run
without `ROCI_EMBED_PYTHON` pointing at the `~/llm-env` interpreter, the spawn's
import fails, the best-effort launcher logs and continues, and long-term memory
stays **dormant** — `remember`/`search` raise tool errors and the promotion hook
logs-and-skips every cycle.

This is current behavior as written. The fix is operational (set
`ROCI_EMBED_PYTHON` to the `~/llm-env` interpreter, or activate that venv before
`roci start`) and is tracked as a runbook item, not a code change in this
document. Do not "fix" the default here.
