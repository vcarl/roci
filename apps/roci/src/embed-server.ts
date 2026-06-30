import { Effect } from "effect"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { CharacterLog, logToConsole, logError } from "@roci/core/logging/log-writer.js"
import { LLM_ENV_VAR, DEFAULT_LLM_ENV_DIRNAME } from "@roci/core/services/mlx-backend.js"

/**
 * Resilient sibling launcher for the host long-term-memory embeddings server
 * (Subteam B / M3). It spawns `scripts/embed-server/serve-embeddings.py`
 * (mlx-embeddings, bge-small/384) bound to 127.0.0.1:8084 ALONGSIDE the mlx tier
 * servers — intentionally OUTSIDE the `MODEL_TIER_SPECS` / mlx-backend machinery,
 * which is hardwired to the `mlx_lm.server` binary + a chat-completions probe.
 * The in-container `memory` CLI reaches it via the existing host.docker.internal
 * rewrite (already firewall-permitted).
 *
 * It is BEST-EFFORT: a missing python env / model / port must NOT crash
 * `roci start`. On any failure it logs loud and continues — long-term memory then
 * degrades gracefully (`memory remember`/`search` throw a tool error the agent
 * reads; the promotion hook logs-and-skips), which is already the designed
 * fallback behavior.
 */

export const EMBED_PORT = 8084
export const EMBED_MODEL = "mlx-community/bge-small-en-v1.5-bf16"
/** Env var overriding the python interpreter used to run the embed server. */
export const EMBED_PYTHON_ENV = "ROCI_EMBED_PYTHON"
/** The python interpreter name we look for in `<venv>/bin` and on PATH. */
export const EMBED_PYTHON_BIN = "python3"
/**
 * Readiness window — we do NOT block start on a slow model load; this only bounds
 * how long we wait before logging an INFORMATIONAL ready/not-ready line. Widened
 * modestly (10×500ms ≈ 5s) so the common warm-disk load reports "ready" rather
 * than the misleading "not ready yet"; the real cold-start fix is the embed
 * client's retry/backoff, not this probe.
 */
export const EMBED_READY_ATTEMPTS = 10
export const EMBED_READY_DELAY_MS = 500

export function embedServerScriptPath(projectRoot: string): string {
  return path.resolve(projectRoot, "scripts", "embed-server", "serve-embeddings.py")
}

export function embedHealthUrl(port: number = EMBED_PORT): string {
  return `http://127.0.0.1:${port}/health`
}

/**
 * The outcome of resolving which python runs the embed server. Mirrors mlx's
 * `MlxResolution`: `found` carries the `command` to execute (an explicit override,
 * an absolute venv python, or the bare `python3`) and, when a venv was used, the
 * `<venv>/bin` dir to PREPEND to PATH so the interpreter's own child resolution
 * works without activation. `!found` carries the venv bin dir we looked in, for
 * the actionable error.
 */
export type EmbedPythonResolution =
  | { readonly found: true; readonly command: string; readonly pathPrepend?: string }
  | { readonly found: false; readonly searchedBinDir: string }

/**
 * Decide which python to spawn the embed server with, purely — mirrors
 * `resolveMlxCommand` so a normal `roci start` brings the embed server up against
 * the model venv with NO manual `source ~/llm-env/bin/activate`. Injects `env`,
 * `homedir`, and an existence check so it is unit-testable without touching the
 * real filesystem.
 *
 * Resolution order:
 *  1. `$ROCI_EMBED_PYTHON` (explicit override) — used verbatim, no PATH prepend.
 *  2. `<venvRoot>/bin/python3` where venvRoot = `$ROCI_LLM_ENV || ~/llm-env`. If it
 *     exists, use its ABSOLUTE path and prepend `<venvRoot>/bin` to PATH.
 *  3. Otherwise a bare `python3` resolvable on PATH (already-activated shell, or a
 *     system install) — bare name, no prepend.
 *  4. Otherwise not found — caller logs the actionable message and continues.
 */
export function resolveEmbedPython(
  env: Record<string, string | undefined>,
  homedir: string,
  fileExists: (p: string) => boolean,
): EmbedPythonResolution {
  const override = env[EMBED_PYTHON_ENV]
  if (override && override.length > 0) {
    return { found: true, command: override }
  }
  const llmEnvOverride = env[LLM_ENV_VAR]
  const venvRoot =
    llmEnvOverride && llmEnvOverride.length > 0
      ? llmEnvOverride
      : path.join(homedir, DEFAULT_LLM_ENV_DIRNAME)
  const binDir = path.join(venvRoot, "bin")
  const venvPython = path.join(binDir, EMBED_PYTHON_BIN)
  if (fileExists(venvPython)) {
    return { found: true, command: venvPython, pathPrepend: binDir }
  }
  // PATH fallback so an already-activated shell or a system install still works;
  // we don't HARD-require the venv.
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter((d) => d.length > 0)
  for (const dir of pathDirs) {
    if (fileExists(path.join(dir, EMBED_PYTHON_BIN))) {
      return { found: true, command: EMBED_PYTHON_BIN }
    }
  }
  return { found: false, searchedBinDir: binDir }
}

/**
 * The actionable text logged when no python can be found to run the embed server.
 * Names the venv location, both env-var overrides, and where we looked, so the
 * operator can fix it — long-term memory then activates on the next start.
 */
export function embedPythonNotFoundMessage(searchedBinDir: string): string {
  return (
    `embed server python (${EMBED_PYTHON_BIN}) not found; long-term memory will be unavailable. ` +
    `Activate your model venv (source ~/${DEFAULT_LLM_ENV_DIRNAME}/bin/activate) before running roci, ` +
    `or set ${EMBED_PYTHON_ENV}=/path/to/python (or ${LLM_ENV_VAR}=/path/to/venv). ` +
    `Looked in: ${searchedBinDir} and PATH.`
  )
}

/**
 * Pure spec for spawning the embed server from a resolved python. When the
 * resolution carries a `pathPrepend` (the venv bin dir), we prepend it to PATH in
 * the env overlay so the interpreter's own child resolution works without
 * activation — same as the mlx spawn seam. `basePath` is the PATH to extend
 * (defaults to the live process PATH; injectable for tests).
 */
export function buildEmbedServerSpawn(
  projectRoot: string,
  resolution: Extract<EmbedPythonResolution, { found: true }>,
  basePath: string = process.env.PATH ?? "",
): { command: string; args: string[]; env: Record<string, string> } {
  const overlay: Record<string, string> = { EMB_PORT: String(EMBED_PORT), EMB_MODEL: EMBED_MODEL }
  if (resolution.pathPrepend) {
    overlay.PATH = `${resolution.pathPrepend}${path.delimiter}${basePath}`
  }
  return {
    command: resolution.command,
    args: [embedServerScriptPath(projectRoot)],
    env: overlay,
  }
}

// ---------------------------------------------------------------------------
// Synchronous orphan-reaper for the embed server child — mirrors the mlx RESIDENT
// reaper in `packages/core/src/services/mlx-backend.ts` (`reapResidentServers`).
//
// The embed server is a session-long host process, exactly like the resident mlx
// server, so it gets the same guard: a module-level registry + a synchronous
// group-kill reaper wired into the SIGTERM/SIGINT/exit handlers in
// `apps/roci/src/main.ts`. This reaps the child on shutdown even when no Effect
// finalizer can run — a tsx double-fork SIGKILL race, or a fatal teardown before
// the orchestrator's shutdown block is attached. The child is spawned `detached`
// (and `unref()`d), so it is its own process-group leader (PGID === pid) and a
// single group signal reaps it; the matching `unref()` is what lets the parent's
// event loop drain and exit instead of hanging on the live child.
interface EmbedServerEntry {
  readonly pid: number
  readonly pgid: number
}

/** Module-level registry of live embed server child pids (keyed by pid). */
const embedServers = new Map<number, EmbedServerEntry>()

/**
 * Record a spawned embed server child so the synchronous reaper can group-kill it
 * on shutdown. `pgid` is the process group to signal (PGID === pid for our
 * detached spawn).
 */
export function registerEmbedServer(pid: number, pgid: number): void {
  embedServers.set(pid, { pid, pgid })
}

/** Remove a child from the registry (on normal, finalizer-driven teardown). */
export function unregisterEmbedServer(pid: number): void {
  embedServers.delete(pid)
}

/** Test-only view of the currently tracked embed server pids (insertion order). */
export function _embedServerPids(): ReadonlyArray<number> {
  return [...embedServers.keys()]
}

/**
 * The injectable synchronous signal function the reaper drives. Defaults to
 * `process.kill`. `target` is a NEGATIVE pgid (group target). Throws on
 * ESRCH/EPERM, which the reaper swallows. Injected by tests to assert the group
 * target without signalling a real process.
 */
export type SyncKill = (target: number, signal: NodeJS.Signals) => void

const defaultSyncKill: SyncKill = (target, signal) => {
  process.kill(target, signal)
}

/**
 * SYNCHRONOUSLY reap every tracked embed server child by group signal. Defaults to
 * SIGKILL (the signal-handler backstop, runs inside the tsx ~30ms window); pass
 * SIGTERM for a graceful Effect-shutdown teardown. Swallows ESRCH (already gone)
 * and any other per-target error so one dead target can't abort reaping the rest.
 * Clears the registry so a second call (e.g. the SIGTERM handler then the 'exit'
 * backstop, or the Effect shutdown then a signal handler) is an idempotent no-op.
 */
export function reapEmbedServers(
  kill: SyncKill = defaultSyncKill,
  signal: NodeJS.Signals = "SIGKILL",
): void {
  for (const { pgid } of embedServers.values()) {
    try {
      kill(-pgid, signal)
    } catch {
      // ESRCH (already gone) / EPERM — best-effort backstop, keep reaping.
    }
  }
  embedServers.clear()
}
// ---------------------------------------------------------------------------

const probeReady = (
  port: number,
  fetchImpl: typeof fetch,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (let i = 0; i < EMBED_READY_ATTEMPTS; i++) {
      const ok = yield* Effect.tryPromise(() => fetchImpl(embedHealthUrl(port))).pipe(
        Effect.map((r) => r.ok),
        Effect.catchAll(() => Effect.succeed(false)),
      )
      if (ok) return true
      yield* Effect.sleep(`${EMBED_READY_DELAY_MS} millis`)
    }
    return false
  })

/**
 * Launch the embed server best-effort. Never fails (error channel `never`): every
 * failure path logs loud and returns. The spawned child is `unref()`d (so it can
 * never pin the parent's event loop open) and registered with the synchronous
 * reaper (`reapEmbedServers`), which the main.ts SIGTERM/SIGINT/exit handlers and
 * the orchestrator's shutdown block drive — so the child is reaped on both clean
 * and fatal shutdown without orphaning on port 8084.
 */
export function launchEmbedServer(
  projectRoot: string,
  deps: {
    fetchImpl?: typeof fetch
    /** Injected python resolver (defaults to the real env/homedir/FS resolution). */
    resolvePython?: () => EmbedPythonResolution
    /** Injected child spawn (defaults to node's `child_process.spawn`). */
    spawnImpl?: typeof spawn
  } = {},
): Effect.Effect<void, never, CharacterLog> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const spawnImpl = deps.spawnImpl ?? spawn
  const resolvePython =
    deps.resolvePython ?? (() => resolveEmbedPython(process.env, os.homedir(), existsSync))
  return Effect.gen(function* () {
    const scriptPath = embedServerScriptPath(projectRoot)
    if (!existsSync(scriptPath)) {
      yield* logToConsole(
        "embed",
        "cli",
        `embed server script not found at ${scriptPath}; long-term memory will be unavailable`,
        "warn",
      )
      return
    }
    // Resolve the interpreter against the model venv (so a normal `roci start`
    // works without activation). If nothing resolves, log loud + continue: a
    // missing python env must NOT crash start — long-term memory degrades.
    const resolution = resolvePython()
    if (!resolution.found) {
      yield* logToConsole("embed", "cli", embedPythonNotFoundMessage(resolution.searchedBinDir), "warn")
      return
    }
    const spec = buildEmbedServerSpawn(projectRoot, resolution)
    const child = yield* Effect.sync(() =>
      spawnImpl(spec.command, spec.args, {
        env: { ...process.env, ...spec.env },
        stdio: "ignore",
        // Detached so the child is its own process-group leader (PGID === pid):
        // the reaper can group-kill it, matching the mlx spawn. Combined with the
        // unref() below this also fully decouples its lifecycle from the parent's.
        detached: true,
      }),
    )
    // A spawn failure (e.g. python3 not on PATH → ENOENT) is delivered async on
    // the 'error' event, NOT thrown by spawn(); swallow it so node doesn't crash.
    child.on("error", (e) => {
      console.error(`[embed] spawn failed (long-term memory unavailable): ${e}`)
    })
    // CRITICAL: unref the child so its ChildProcess handle does NOT keep the
    // parent's event loop referenced. Without this, `roci` could not drain/exit
    // on shutdown and hung ~2m39s on the live embed child (leaking port 8084).
    // Teardown is handled by the synchronous reaper below (wired into main.ts's
    // SIGTERM/SIGINT/exit handlers) AND the orchestrator's Effect shutdown block
    // — NOT by a bare process.once("exit"), which could never fire because the
    // exit it waited on never arrived (the unref-less handle blocked it).
    yield* Effect.sync(() => child.unref())
    // Register for the synchronous reaper. detached → PGID === pid. `pid` is
    // undefined only if the spawn failed synchronously (the 'error' handler above
    // already covers that), so guard before tracking.
    if (typeof child.pid === "number") {
      registerEmbedServer(child.pid, child.pid)
    }

    const ready = yield* probeReady(EMBED_PORT, fetchImpl)
    if (ready) {
      yield* logToConsole("embed", "cli", `embed server ready on 127.0.0.1:${EMBED_PORT} (${EMBED_MODEL})`)
    } else {
      yield* logToConsole(
        "embed",
        "cli",
        `embed server launched on 127.0.0.1:${EMBED_PORT} but not ready yet; long-term memory will activate once it finishes loading (or stays down if its python env is missing)`,
        "warn",
      )
    }
  }).pipe(
    Effect.catchAll((e) =>
      logError("embed", "cli", `embed server launch failed (long-term memory unavailable): ${e}`).pipe(
        Effect.catchAll(() => Effect.void),
      ),
    ),
  )
}
