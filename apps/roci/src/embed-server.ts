import { Effect } from "effect"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"
import { CharacterLog, logToConsole, logError } from "@roci/core/logging/log-writer.js"

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
/** Brief readiness window — we do NOT block start on a slow model load. */
export const EMBED_READY_ATTEMPTS = 5
export const EMBED_READY_DELAY_MS = 500

export function embedServerScriptPath(projectRoot: string): string {
  return path.resolve(projectRoot, "scripts", "embed-server", "serve-embeddings.py")
}

export function embedHealthUrl(port: number = EMBED_PORT): string {
  return `http://127.0.0.1:${port}/health`
}

export function resolveEmbedPython(env: Record<string, string | undefined>): string {
  const override = env[EMBED_PYTHON_ENV]
  return override && override.length > 0 ? override : "python3"
}

/** Pure spec for spawning the embed server (command, args, env overlay). */
export function buildEmbedServerSpawn(
  projectRoot: string,
  env: Record<string, string | undefined>,
): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: resolveEmbedPython(env),
    args: [embedServerScriptPath(projectRoot)],
    env: { EMB_PORT: String(EMBED_PORT), EMB_MODEL: EMBED_MODEL },
  }
}

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
 * failure path logs loud and returns. Registers a kill on process exit so the
 * child does not orphan when `roci` stops.
 */
export function launchEmbedServer(
  projectRoot: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Effect.Effect<void, never, CharacterLog> {
  const fetchImpl = deps.fetchImpl ?? fetch
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
    const spec = buildEmbedServerSpawn(projectRoot, process.env)
    const child = yield* Effect.sync(() =>
      spawn(spec.command, spec.args, {
        env: { ...process.env, ...spec.env },
        stdio: "ignore",
        detached: false,
      }),
    )
    // A spawn failure (e.g. python3 not on PATH → ENOENT) is delivered async on
    // the 'error' event, NOT thrown by spawn(); swallow it so node doesn't crash.
    child.on("error", (e) => {
      console.error(`[embed] spawn failed (long-term memory unavailable): ${e}`)
    })
    // Don't orphan the python server when roci exits.
    const kill = () => {
      try {
        child.kill("SIGTERM")
      } catch {
        // already gone
      }
    }
    process.once("exit", kill)
    process.once("SIGINT", kill)
    process.once("SIGTERM", kill)

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
