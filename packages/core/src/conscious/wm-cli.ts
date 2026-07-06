import { Effect } from "effect"
import { Docker, type DockerError } from "../services/Docker.js"
import { installContainerCli } from "./install-cli.js"
import { applyWmMutation, parseWmFile, renderWmMarkdown } from "./wm-core.js"

/** Where the generated CLI is installed inside the container (on PATH). */
export const WM_CLI_PATH = "/usr/local/bin/wm"
/** Store paths relative to the in-container cwd /work/players/<name> — the
 * same convention as memory's DEFAULT_DB_PATH (memory-cli.ts). */
export const WM_JSON_REL = "me/wm.json"
export const WM_MD_REL = "me/WM.md"

export const WM_USAGE = [
  "usage:",
  '  wm todo "<text>" [--parent <id>]   create a todo (prints the new id)',
  "  wm done <id>                       mark a todo done",
  "  wm discard <id>                    drop a todo without doing it (kept for later review)",
  "",
  "There is no `wm list` — your current todo tree is always visible as WM.md in your context.",
].join("\n")

/**
 * Generate the `wm` bun CLI (spec §2): a plain-JSON working-memory store with
 * three verbs and NO `list` (visibility comes from automatic injection). Every
 * mutation atomically (write-tmp-then-rename) rewrites me/wm.json AND
 * re-renders me/WM.md, which opencode re-reads and injects on every LLM
 * request via the project `instructions` config.
 *
 * Structurally mirrors memory-cli.ts: a script base64-piped to
 * /usr/local/bin/wm, provisioned idempotently AT CONTAINER STARTUP (no lazy
 * provisioning in the cortex loop). The pure core — parseWmFile /
 * applyWmMutation / renderWmMarkdown — is embedded VERBATIM at generate time
 * via Function.prototype.toString on the unit-tested wm-core functions, the
 * same no-drift rationale as memory-cli's JSON.stringify'd SQL builders: the
 * container CLI cannot diverge from the host state machine because they ARE
 * the same functions (wm-core.ts's embedding contract keeps them
 * self-contained).
 *
 * Agent mutations are journaled into wm.json's pendingDeltas; the harness
 * drains the journal onto step-end episode records (spec §2: all wm mutations
 * are recorded in episodes-transition.jsonl).
 *
 * Tmp-name collision safety: two writers touch wm.json (this CLI in-container,
 * wm-store.ts on the host over the shared mount). A pid-only tmp suffix is not
 * unique across processes/hosts sharing a pid namespace (e.g. containerized
 * pid 1) or across rapid re-invocations reusing a pid; the tmp name is
 * pid+random so two concurrent writers never collide on the same tmp path
 * (see wm-store.ts's matching writeAtomic).
 */
export function buildWmCliScript(): string {
  const usageLit = JSON.stringify(WM_USAGE)
  const jsonRelLit = JSON.stringify(WM_JSON_REL)
  const mdRelLit = JSON.stringify(WM_MD_REL)
  return `#!/home/node/.bun/bin/bun
// Working-memory CLI (generated; do not edit — see conscious/wm-cli.ts).
// Plain JSON store at me/wm.json; every mutation atomically re-renders
// me/WM.md, which opencode injects into your context on every request.
import * as fs from "node:fs";

const WM_JSON = ${jsonRelLit};
const WM_MD = ${mdRelLit};
const USAGE = ${usageLit};

${parseWmFile.toString()}

${applyWmMutation.toString()}

${renderWmMarkdown.toString()}

function readStore() {
  try {
    return parseWmFile(fs.readFileSync(WM_JSON, "utf8"));
  } catch {
    return parseWmFile("");
  }
}

// Atomic write-via-rename on the container side (spec §2 Store). The tmp
// suffix is pid+random (not pid-only): two writers of this same file — this
// CLI and the host's wm-store.ts — share the mount, and a pid-only suffix can
// collide across processes/hosts (e.g. containerized pid 1) or across rapid
// re-invocations reusing a pid.
function writeAtomic(file, text) {
  const tmp = file + ".tmp." + process.pid + "." + crypto.randomUUID();
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function persist(file) {
  writeAtomic(WM_JSON, JSON.stringify(file, null, 2));
  writeAtomic(WM_MD, renderWmMarkdown(file));
}

const argv = process.argv.slice(2);
const verb = argv[0];

let mutation = null;
if (verb === "todo") {
  let parent = null;
  const rest = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--parent" && i + 1 < argv.length) { parent = argv[i + 1]; i++; }
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) { console.error(USAGE); process.exit(2); }
  mutation = { verb: "todo", text: rest[0], parent: parent };
} else if (verb === "done" || verb === "discard") {
  if (argv.length !== 2) { console.error(USAGE); process.exit(2); }
  mutation = { verb: verb, id: argv[1] };
} else {
  console.error(USAGE);
  process.exit(2);
}

const result = applyWmMutation(readStore(), mutation, "agent", new Date().toISOString());
if (!result.ok) {
  console.error("wm: " + result.error);
  process.exit(1);
}
// Journal the agent mutation for the harness to drain into the episode log
// at the next step boundary (spec §2).
const next = result.file;
next.pendingDeltas = next.pendingDeltas.concat([result.delta]);
persist(next);
if (mutation.verb === "todo") console.log(result.delta.id);
`
}

/**
 * Install the generated `wm` CLI into the container (idempotent; root exec —
 * see install-cli.ts). The error channel PROPAGATES (DockerError): the caller
 * (orchestrator startup) logs it loud and continues, so a breakage shows up
 * in logs instead of only as a later "command not found" the agent hits.
 */
export function provisionWmCli(containerId: string): Effect.Effect<void, DockerError, Docker> {
  return installContainerCli(containerId, WM_CLI_PATH, buildWmCliScript())
}
