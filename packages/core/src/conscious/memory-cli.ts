import { Effect } from "effect"
import { Docker, type DockerError } from "../services/Docker.js"
import {
  EMBED_DIM,
  TAG_OVERFETCH,
  PROMOTE_MARK_KEY,
  buildSchemaSql,
  buildInsertSql,
  buildVecInsertSql,
  buildMetaGetSql,
  buildMetaSetSql,
} from "./memory-sql.js"
import { embedEndpoint } from "./memory-embed.js"
import { MEMORY_USAGE } from "./memory-args.js"

/** Where the generated CLI is installed inside the container (on PATH). */
export const MEMORY_CLI_PATH = "/usr/local/bin/memory"
/** Where the linux-arm64 sqlite-vec extension is baked into the image. */
export const VEC_EXTENSION_PATH = "/usr/local/lib/vec0.so"
/** Default per-character db path, relative to the in-container cwd (/work/players/<name>). */
export const DEFAULT_DB_PATH = "me/longterm.db"

export interface MemoryCliOpts {
  /** Host embed server base URL (loopback ok — rewritten to host.docker.internal at generate time). */
  embedBaseUrl: string
  /** Override the db path (default `me/longterm.db`, relative to cwd). */
  dbPath?: string
  /** Override the baked extension path (default `/usr/local/lib/vec0.so`). */
  vecExtensionPath?: string
}

/**
 * Generate the `memory` bun CLI: an append-only sqlite-vec store with a subprocess
 * interface. Structurally mirrors `frontier-cli.ts` — a script base64-piped to
 * `/usr/local/bin/memory`, provisioned idempotently, documented to the agent.
 *
 *   memory remember "<text>" [--tags a,b]      append + embed; prints the new id
 *   memory search   "<query>" [-k N] [--tags …] top-k NDJSON (one object per line)
 *   memory recent   [-n N]                      most-recent N entries (no embed)
 *   memory promote                              (internal) bulk-promote base64 stdin lines, source='promotion'
 *   memory promoted-hashes                      (internal) sha256 of each promoted text, one per line (host dedup)
 *
 * This is a BUN script (not bash): it uses `bun:sqlite` + `loadExtension`. bun is
 * not on PATH under `bash -lc`, so the shebang points at the absolute bun path.
 *
 * Laundering (Vector-A, same note frontier carries): the argv text is
 * model-authored — the conscious agent authors the query/text itself, it must
 * never paste raw inbound event text. The static SQL builders are interpolated at
 * GENERATE time (JSON.stringify) so the schema/insert shapes can't drift from the
 * unit-tested TS builders; the KNN SQL is rebuilt at RUN time because `k` varies.
 */
export function buildMemoryCliScript(opts: MemoryCliOpts): string {
  const dbPathLit = JSON.stringify(opts.dbPath ?? DEFAULT_DB_PATH)
  const vecExtLit = JSON.stringify(opts.vecExtensionPath ?? VEC_EXTENSION_PATH)
  const embedUrlLit = JSON.stringify(embedEndpoint(opts.embedBaseUrl))
  const schemaLit = JSON.stringify(buildSchemaSql())
  const insertLit = JSON.stringify(buildInsertSql())
  const vecInsertLit = JSON.stringify(buildVecInsertSql())
  const metaGetLit = JSON.stringify(buildMetaGetSql())
  const metaSetLit = JSON.stringify(buildMetaSetSql())
  const markKeyLit = JSON.stringify(PROMOTE_MARK_KEY)
  const usageLit = JSON.stringify(MEMORY_USAGE)

  // The body below is RUNTIME bun/JS. It deliberately avoids backticks and `${}`
  // so the only interpolations are the TS-level `${...Lit}`/constants here.
  return `#!/home/node/.bun/bin/bun
// Long-term memory CLI (generated; do not edit — see conscious/memory-cli.ts).
// Append-only sqlite-vec store. Laundering: the argv text is model-authored —
// author the query/text yourself, never paste raw inbound event text.
import { Database } from "bun:sqlite";

const DB_PATH = ${dbPathLit};
const VEC_EXT = ${vecExtLit};
const EMBED_URL = ${embedUrlLit};
const EMBED_DIM = ${EMBED_DIM};
const TAG_OVERFETCH = ${TAG_OVERFETCH};
const SCHEMA = ${schemaLit};
const INSERT_SQL = ${insertLit};
const VEC_INSERT_SQL = ${vecInsertLit};
const META_GET_SQL = ${metaGetLit};
const META_SET_SQL = ${metaSetLit};
const PROMOTE_MARK_KEY = ${markKeyLit};
const USAGE = ${usageLit};

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

async function embed(text) {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text }),
  });
  if (!res.ok) throw new Error("embed failed: HTTP " + res.status);
  const j = await res.json();
  const e = j && j.data && j.data[0] ? j.data[0].embedding : null;
  if (!Array.isArray(e) || e.length !== EMBED_DIM) throw new Error("bad embed shape");
  return e;
}

function splitTags(raw) {
  return (raw || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}
function knnSql(k, hasTags) {
  const ek = hasTags ? k * TAG_OVERFETCH : k;
  return "SELECT m.id AS id, m.ts AS ts, m.source AS source, m.tags AS tags, m.text AS text, v.distance AS distance "
    + "FROM memories_vec v JOIN memories m ON m.id = v.id "
    + "WHERE v.embedding MATCH ? AND k = " + ek + " ORDER BY v.distance";
}
function fmt(rows, withScore) {
  return rows.map(function (r) {
    const o = { id: r.id, ts: r.ts, source: r.source, tags: splitTags(r.tags), text: r.text };
    if (withScore && r.distance != null) o.score = 1 / (1 + r.distance);
    return JSON.stringify(o);
  }).join("\\n");
}
function takeFlag(arr, names) {
  const rest = [];
  let value;
  for (let i = 0; i < arr.length; i++) {
    if (names.indexOf(arr[i]) !== -1 && i + 1 < arr.length) { value = arr[i + 1]; i++; }
    else rest.push(arr[i]);
  }
  return { value: value, rest: rest };
}
function intOr(raw, dflt) {
  if (raw == null) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) { console.error(USAGE); process.exit(2); }
  return n;
}

const argv = process.argv.slice(2);
const verb = argv[0];
const args = argv.slice(1);

if (verb === "remember") {
  const a1 = takeFlag(args, ["--tags"]);
  const a2 = takeFlag(a1.rest, ["--source"]);
  const text = a2.rest[0];
  if (!text) { console.error(USAGE); process.exit(2); }
  const tags = a1.value ? splitTags(a1.value).join(",") : null;
  const source = a2.value || "conscious";
  const vec = await embed(text);
  const db = openDb();
  const info = db.prepare(INSERT_SQL).run(new Date().toISOString(), source, tags, text);
  const id = Number(info.lastInsertRowid);
  db.prepare(VEC_INSERT_SQL).run(id, JSON.stringify(vec));
  console.log(String(id));
} else if (verb === "search") {
  const a1 = takeFlag(args, ["-k"]);
  const a2 = takeFlag(a1.rest, ["--tags"]);
  const query = a2.rest[0];
  if (!query) { console.error(USAGE); process.exit(2); }
  const k = intOr(a1.value, 5);
  const wantTags = a2.value ? splitTags(a2.value) : [];
  const vec = await embed(query);
  const db = openDb();
  let rows = db.query(knnSql(k, wantTags.length > 0)).all(JSON.stringify(vec));
  if (wantTags.length > 0) {
    rows = rows.filter(function (r) {
      const have = splitTags(r.tags);
      return wantTags.some(function (t) { return have.indexOf(t) !== -1; });
    }).slice(0, k);
  }
  console.log(fmt(rows, true));
} else if (verb === "recent") {
  const a1 = takeFlag(args, ["-n"]);
  const n = intOr(a1.value, 10);
  const db = openDb();
  const rows = db.query("SELECT id, ts, source, tags, text FROM memories ORDER BY id DESC LIMIT " + n).all();
  console.log(fmt(rows, false));
} else if (verb === "mark-get") {
  // Print the bounded promotion high-water mark (opaque host-computed JSON) or nothing.
  const db = openDb();
  const row = db.query(META_GET_SQL).get(PROMOTE_MARK_KEY);
  if (row && row.value) console.log(row.value);
} else if (verb === "mark-set") {
  // Persist the high-water mark verbatim (argv[1] is a host-authored JSON string).
  const db = openDb();
  db.prepare(META_SET_SQL).run(PROMOTE_MARK_KEY, args[0] || "");
} else if (verb === "promote") {
  const input = await Bun.stdin.text();
  const lines = input.split("\\n").map(function (s) { return s.trim(); }).filter(Boolean);
  const db = openDb();
  let n = 0;
  for (const b64 of lines) {
    const text = Buffer.from(b64, "base64").toString("utf8");
    const vec = await embed(text);
    const info = db.prepare(INSERT_SQL).run(new Date().toISOString(), "promotion", "promotion", text);
    db.prepare(VEC_INSERT_SQL).run(Number(info.lastInsertRowid), JSON.stringify(vec));
    n++;
  }
  console.log(String(n));
} else {
  console.error(USAGE);
  process.exit(2);
}
`
}

/**
 * Write the generated `memory` CLI into the container and make it executable.
 * Base64-pipes the script to sidestep shell quoting.
 *
 * Runs AS ROOT (`{ user: "root" }`): `/usr/local/bin` is root-owned and the
 * container's default user is `node`, so provisioning as `node` would
 * `Permission denied`. The installed file ends up `root:root 0755` — `node` can
 * execute it, and the db lives in node-owned `players/<name>/me/`, so writes work.
 *
 * The error channel PROPAGATES (DockerError): unlike the old swallow-to-void, a
 * provisioning failure must surface. The caller (`provisionImpl`) logs it loud and
 * continues (best-effort), so a future breakage shows up in logs instead of only
 * as a later "command not found" the agent silently hits.
 */
export function provisionMemoryCli(
  containerId: string,
  opts: MemoryCliOpts,
): Effect.Effect<void, DockerError, Docker> {
  const script = buildMemoryCliScript(opts)
  const b64 = Buffer.from(script).toString("base64")
  const sh = `echo ${b64} | base64 -d > ${MEMORY_CLI_PATH} && chmod 0755 ${MEMORY_CLI_PATH}`
  return Effect.gen(function* () {
    const docker = yield* Docker
    yield* docker.exec(containerId, ["bash", "-lc", sh], { user: "root" })
  })
}
