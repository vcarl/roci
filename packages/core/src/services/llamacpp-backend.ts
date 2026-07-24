import { Effect, Scope } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import type { TierSpec } from "./model-tier-spec.js"
import type { ModelBackend } from "./model-backend.js"
import { SpawnError } from "./model-backend.js"
import { KillSeam, SpawnedProcess, makeServerBackend } from "./server-process.js"

// ---------------------------------------------------------------------------
// llama.cpp `llama-server` backend for the CONSCIOUS tier.
//
// The conscious tier runs unsloth/gpt-oss-20b-GGUF (Q8_0) natively via
// llama-server, while hindbrain/forebrain stay on the mlx backend. Dispatch is by
// the handle's `provider` field (see the composite backend). The spawn/probe/kill
// scaffolding is SHARED with the mlx backend (`server-process.ts`); this module
// only supplies the two backend-specific pieces: command resolution and arg
// building.

/** Env var overriding the llama-server binary path (absolute). */
export const LLAMA_SERVER_VAR = "ROCI_LLAMA_SERVER"

/** The llama-server console/binary name (bare-PATH name). */
export const LLAMA_SERVER_BIN = "llama-server"

/** Homebrew install location, tried last when nothing else resolves. */
export const LLAMA_SERVER_FALLBACK = "/opt/homebrew/bin/llama-server"

/** Env var overriding the resolved .gguf model file (absolute). */
export const CONSCIOUS_GGUF_VAR = "ROCI_CONSCIOUS_GGUF"

/**
 * HF hub cache dir name for the conscious GGUF repo, and the specific quant file
 * we serve. Derivable pieces (not one giant hardcoded path) so the model/quant is
 * a single obvious knob.
 */
export const GGUF_MODEL_DIR = "models--unsloth--gpt-oss-20b-GGUF"
export const GGUF_QUANT_FILE = "gpt-oss-20b-Q8_0.gguf"

/** Resolution of the llama-server binary. */
export type LlamaServerResolution =
  | { readonly found: true; readonly command: string }
  | { readonly found: false; readonly searched: ReadonlyArray<string> }

/**
 * Decide which llama-server binary to spawn, purely (injected env + existence
 * check). Order: $ROCI_LLAMA_SERVER (trusted verbatim) → a PATH-resolvable
 * `llama-server` → the homebrew fallback → not found (actionable SpawnError).
 */
export function resolveLlamaServerCommand(
  env: Record<string, string | undefined>,
  fileExists: (p: string) => boolean,
): LlamaServerResolution {
  const override = env[LLAMA_SERVER_VAR]
  if (override && override.length > 0) {
    return { found: true, command: override }
  }
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter((d) => d.length > 0)
  for (const dir of pathDirs) {
    if (fileExists(path.join(dir, LLAMA_SERVER_BIN))) {
      return { found: true, command: LLAMA_SERVER_BIN }
    }
  }
  if (fileExists(LLAMA_SERVER_FALLBACK)) {
    return { found: true, command: LLAMA_SERVER_FALLBACK }
  }
  return { found: false, searched: [`$${LLAMA_SERVER_VAR}`, "PATH", LLAMA_SERVER_FALLBACK] }
}

/** The actionable text surfaced when no llama-server binary can be found. */
export function llamaServerNotFoundMessage(searched: ReadonlyArray<string>): string {
  return (
    `${LLAMA_SERVER_BIN} not found. Install llama.cpp (brew install llama.cpp) ` +
    `or set ${LLAMA_SERVER_VAR}=/path/to/llama-server. Looked in: ${searched.join(", ")}.`
  )
}

/** The glob the default seam expands to find the served .gguf under the HF cache. */
export function ggufSnapshotsGlob(homedir: string): string {
  return path.join(
    homedir,
    ".cache/huggingface/hub",
    GGUF_MODEL_DIR,
    "snapshots",
    "*",
    GGUF_QUANT_FILE,
  )
}

/** Resolution of the conscious .gguf file. */
export type GgufResolution =
  | { readonly found: true; readonly path: string }
  | { readonly found: false; readonly searchedGlob: string }

/**
 * Resolve the conscious tier's .gguf file, purely (injected env + homedir + a
 * glob-match seam). Order: $ROCI_CONSCIOUS_GGUF (trusted verbatim) → the sole/
 * newest match of the HF snapshots glob → not found (naming the searched glob).
 * `listMatches` must return matches newest-first; the first is chosen.
 */
export function resolveGgufPath(
  env: Record<string, string | undefined>,
  homedir: string,
  listMatches: (globPattern: string) => ReadonlyArray<string>,
): GgufResolution {
  const override = env[CONSCIOUS_GGUF_VAR]
  if (override && override.length > 0) {
    return { found: true, path: override }
  }
  const glob = ggufSnapshotsGlob(homedir)
  const matches = listMatches(glob)
  if (matches.length > 0) {
    return { found: true, path: matches[0] }
  }
  return { found: false, searchedGlob: glob }
}

/** The actionable text surfaced when the conscious .gguf can't be found. */
export function ggufNotFoundMessage(searchedGlob: string): string {
  return (
    `Conscious GGUF not found. Download it (e.g. huggingface-cli download ` +
    `unsloth/gpt-oss-20b-GGUF ${GGUF_QUANT_FILE}) or set ${CONSCIOUS_GGUF_VAR}=/path/to/model.gguf. ` +
    `Looked for: ${searchedGlob}.`
  )
}

/**
 * llama-server argv. PURE, exported for tests.
 *
 * CRITICAL: `--alias` MUST equal `spec.model` exactly — the shared readiness
 * probe requires the server to echo response.model === spec.model, and
 * llama-server reports its `--alias` there. A mismatch means the resident
 * conscious never goes ready and hard-fails the whole model layer at boot.
 *
 * `--jinja --reasoning-format deepseek` makes llama.cpp apply the model's harmony
 * chat template and route the FINAL channel to `message.content` (reasoning to
 * `reasoning_content`), so the HTTP path reads a real answer. `-c 32768` context,
 * `-ngl 99` offloads all layers to the GPU.
 */
export function buildLlamaArgs(spec: TierSpec, ggufPath: string): ReadonlyArray<string> {
  return [
    "-m", ggufPath,
    "--host", "127.0.0.1",
    "--port", String(spec.port),
    "--alias", spec.model,
    "-c", "32768",
    "-ngl", "99",
    "--jinja",
    "--reasoning-format", "deepseek",
  ]
}

/**
 * Default glob-match seam: expand the fixed `snapshots/<hash>/<quant>.gguf` glob
 * by reading the snapshots dir directly (its only wildcard is the single
 * `<hash>` segment). Returns matches newest-first (by mtime) so
 * `resolveGgufPath` picks the newest snapshot. Never throws — a missing dir
 * yields no matches, which `resolveGgufPath` maps to an actionable error.
 */
function listGgufMatches(globPattern: string): ReadonlyArray<string> {
  // The glob is `<snapshotsDir>/*/<quant>`, so recover the fixed pieces.
  const quant = path.basename(globPattern)
  const snapshotsDir = path.dirname(path.dirname(globPattern))
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(snapshotsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => path.join(snapshotsDir, e.name, quant))
    .filter((p) => fs.existsSync(p))
  // Newest-first by mtime so the first match is the freshest snapshot.
  return candidates.sort((a, b) => statMtime(b) - statMtime(a))
}

function statMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0
  }
}

export function makeLlamaCppBackend(
  deps: {
    fetchImpl?: typeof fetch
    /**
     * Override the spawn seam. Defaults to spawning `llama-server` via
     * CommandExecutor after resolving the binary + .gguf. Tests inject their own.
     */
    startProcess?: (spec: TierSpec) => Effect.Effect<SpawnedProcess, unknown, Scope.Scope>
    killSeam?: KillSeam
  } = {},
): Effect.Effect<ModelBackend, never, CommandExecutor.CommandExecutor> {
  return Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor

    const startProcess =
      deps.startProcess ??
      ((spec: TierSpec): Effect.Effect<SpawnedProcess, unknown, Scope.Scope> =>
        Effect.suspend(() => {
          const cmd = resolveLlamaServerCommand(process.env, (p) => fs.existsSync(p))
          if (!cmd.found) {
            return Effect.fail(
              new SpawnError(spec.tier, spec.model, llamaServerNotFoundMessage(cmd.searched)),
            )
          }
          const gguf = resolveGgufPath(process.env, os.homedir(), listGgufMatches)
          if (!gguf.found) {
            return Effect.fail(
              new SpawnError(spec.tier, spec.model, ggufNotFoundMessage(gguf.searchedGlob)),
            )
          }
          const command = Command.make(cmd.command, ...buildLlamaArgs(spec, gguf.path))
          return executor.start(command).pipe(
            Effect.map((proc) => ({
              pid: proc.pid,
              stderr: proc.stderr,
              awaitExit: proc.exitCode.pipe(Effect.ignore),
            })),
            // A spawn-time ENOENT (binary vanished between preflight and exec)
            // becomes the actionable missing-runtime message, not a raw error.
            Effect.mapError((e) =>
              String(e).includes("ENOENT")
                ? new SpawnError(
                    spec.tier,
                    spec.model,
                    llamaServerNotFoundMessage([cmd.command]),
                  )
                : e,
            ),
          )
        }))

    return makeServerBackend({
      startProcess,
      fetchImpl: deps.fetchImpl,
      killSeam: deps.killSeam,
      stderrLabel: "llama.cpp",
    })
  })
}
