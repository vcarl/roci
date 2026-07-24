import { Effect, Scope } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import type { TierSpec } from "./model-tier-spec.js"
import type { ModelBackend } from "./model-backend.js"
import { SpawnError } from "./model-backend.js"
import {
  KillSeam,
  SpawnedProcess,
  makeServerBackend,
} from "./server-process.js"

// The stderr ring, resident-server reaper registry, readiness probe, kill
// finalizer, and their tunables are SHARED with the llama.cpp backend and live in
// `server-process.ts`. They are re-exported here so existing importers (tests,
// the core index, main.ts's reaper) keep their `./mlx-backend.js` entry point.
export {
  STDERR_TAIL_MAX_LINES,
  STDERR_TAIL_MAX_LINE_LEN,
  KILL_GRACE_MS,
  buildProbeRequest,
  registerResidentServer,
  unregisterResidentServer,
  reapResidentServers,
  _residentServerPids,
} from "./server-process.js"
export type { KillSeam, SpawnedProcess, ProbeResult, SyncKill } from "./server-process.js"

// ---------------------------------------------------------------------------
// Resolving the mlx_lm.server runtime.
//
// PROBLEM this fixes: the default spawn seam used to run `mlx_lm.server` as a
// BARE command, inheriting the orchestrator's PATH. On Apple Silicon hosts the
// binary lives in a Python virtualenv the user activates manually
// (`source ~/llm-env/bin/activate`); when `roci` is started WITHOUT that
// activation, PATH lacks `<venv>/bin` and the spawn ENOENTs with a raw, useless
// error. We now resolve the venv binary by absolute path (console-script
// shebangs point at the venv's python, so the absolute path runs without
// activation), fall back to a PATH-resolvable bare command, and emit an
// actionable error when neither is found.

/** The mlx server console-script name (venv `bin/` entry and bare-PATH name). */
export const MLX_SERVER_BIN = "mlx_lm.server"

/**
 * Env var overriding the venv ROOT we look in for `bin/mlx_lm.server`. Follows
 * the repo's `ROCI_` env convention (cf. ROCI_SDK_*). When
 * unset we default to `~/llm-env` (the documented Apple-Silicon location).
 */
export const LLM_ENV_VAR = "ROCI_LLM_ENV"

/** Default venv root (dir name under $HOME) when ROCI_LLM_ENV is unset. */
export const DEFAULT_LLM_ENV_DIRNAME = "llm-env"

/**
 * The outcome of resolving which mlx_lm.server to spawn. `found` carries the
 * `command` to execute (an absolute venv path or the bare name) and, when a venv
 * was used, the `<venv>/bin` dir to PREPEND to PATH so the server's own child
 * resolution works without activation. `!found` carries the venv bin dir we
 * looked in, for the actionable error.
 */
export type MlxResolution =
  | { readonly found: true; readonly command: string; readonly pathPrepend?: string }
  | { readonly found: false; readonly searchedBinDir: string }

/**
 * Decide which mlx_lm.server binary to spawn, purely. Injects `env`, `homedir`,
 * and an existence check so it is unit-testable without touching the real
 * filesystem or spawning a process.
 *
 * Resolution order:
 *  1. `<venvRoot>/bin/mlx_lm.server` where venvRoot = $ROCI_LLM_ENV || ~/llm-env.
 *     If it exists, use its ABSOLUTE path and prepend `<venvRoot>/bin` to PATH.
 *  2. Otherwise, if a bare `mlx_lm.server` is resolvable on PATH (an already
 *     activated shell, or a system install), use the bare name (no prepend).
 *  3. Otherwise, not found — caller maps this to an actionable SpawnError.
 */
export function resolveMlxCommand(
  env: Record<string, string | undefined>,
  homedir: string,
  fileExists: (p: string) => boolean,
): MlxResolution {
  const override = env[LLM_ENV_VAR]
  const venvRoot =
    override && override.length > 0 ? override : path.join(homedir, DEFAULT_LLM_ENV_DIRNAME)
  const binDir = path.join(venvRoot, "bin")
  const venvBin = path.join(binDir, MLX_SERVER_BIN)
  if (fileExists(venvBin)) {
    return { found: true, command: venvBin, pathPrepend: binDir }
  }
  // Fall back to a PATH-resolvable bare command so an already-activated shell or
  // a system install still works; we don't HARD-require the venv.
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter((d) => d.length > 0)
  for (const dir of pathDirs) {
    if (fileExists(path.join(dir, MLX_SERVER_BIN))) {
      return { found: true, command: MLX_SERVER_BIN }
    }
  }
  return { found: false, searchedBinDir: binDir }
}

/**
 * The actionable text surfaced when no mlx runtime can be found — the message an
 * operator actually sees when a model is spawned without a reachable server. It
 * names the activation hint, the env-var override, the install hint, and where we
 * looked.
 */
export function mlxNotFoundMessage(searchedBinDir: string): string {
  return (
    `${MLX_SERVER_BIN} not found. Activate your model venv ` +
    `(source ~/${DEFAULT_LLM_ENV_DIRNAME}/bin/activate) before running roci, ` +
    `or set ${LLM_ENV_VAR}=/path/to/venv. (Install it there with: pip install mlx-lm). ` +
    `Looked in: ${searchedBinDir} and PATH.`
  )
}

/** mlx_lm.server --model <id> --port <p> [spawnArgs…] */
export function buildMlxArgs(spec: TierSpec): ReadonlyArray<string> {
  return ["--model", spec.model, "--port", String(spec.port), ...spec.spawnArgs]
}

export function makeMlxBackend(
  deps: {
    fetchImpl?: typeof fetch
    /**
     * Override the spawn seam. Receives the resolved spec; returns a
     * SpawnedProcess. Defaults to spawning `mlx_lm.server` via CommandExecutor.
     * The returned process's stderr is drained into a bounded tail.
     */
    startProcess?: (spec: TierSpec) => Effect.Effect<SpawnedProcess, unknown, Scope.Scope>
    /**
     * Override the signal seam used by `kill`. Defaults to `process.kill`.
     * Injected by tests to assert the process-group target and SIGTERM→SIGKILL
     * escalation without signalling real processes.
     */
    killSeam?: KillSeam
  } = {},
): Effect.Effect<ModelBackend, never, CommandExecutor.CommandExecutor> {
  return Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor

    // Default spawn seam: resolve mlx_lm.server from the venv (or PATH), start it,
    // and adapt the platform Process to our SpawnedProcess shape (pid + stderr
    // stream). Tests inject their own seam, so the venv/FS resolution lives here,
    // in the default. The pure resolver (resolveMlxCommand) is unit-tested
    // separately without spawning or touching the real filesystem.
    const startProcess =
      deps.startProcess ??
      ((spec: TierSpec): Effect.Effect<SpawnedProcess, unknown, Scope.Scope> =>
        Effect.suspend(() => {
          const resolution = resolveMlxCommand(process.env, os.homedir(), (p) => fs.existsSync(p))
          // Preflight: neither the venv binary nor a PATH-resolvable command was
          // found. Fail with the actionable message instead of a raw ENOENT.
          if (!resolution.found) {
            return Effect.fail(
              new SpawnError(spec.tier, spec.model, mlxNotFoundMessage(resolution.searchedBinDir)),
            )
          }
          // When we resolved the venv binary, prepend `<venv>/bin` to PATH so the
          // server's own child-process resolution works without activation. The
          // node executor merges this over the inherited process.env, so the rest
          // of the environment is preserved.
          const baseCommand = Command.make(resolution.command, ...buildMlxArgs(spec))
          const command = resolution.pathPrepend
            ? Command.env(baseCommand, {
                PATH: `${resolution.pathPrepend}${path.delimiter}${process.env.PATH ?? ""}`,
              })
            : baseCommand
          return executor.start(command).pipe(
            Effect.map((proc) => ({
              pid: proc.pid,
              stderr: proc.stderr,
              // `proc.exitCode` suspends until the process exits; we discard the
              // code and normalize any PlatformError to "exited" — for kill's
              // liveness race, an error awaiting exit still means "stop waiting".
              awaitExit: proc.exitCode.pipe(Effect.ignore),
            })),
            // A spawn-time ENOENT (binary vanished between preflight and exec, or
            // a non-executable file) must not surface as a raw platform error —
            // convert it to the same actionable missing-runtime message.
            Effect.mapError((e) =>
              String(e).includes("ENOENT")
                ? new SpawnError(
                    spec.tier,
                    spec.model,
                    mlxNotFoundMessage(resolution.pathPrepend ?? path.dirname(resolution.command)),
                  )
                : e,
            ),
          )
        }))

    return makeServerBackend({
      startProcess,
      fetchImpl: deps.fetchImpl,
      killSeam: deps.killSeam,
      stderrLabel: "mlx",
    })
  })
}
