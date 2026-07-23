/**
 * The `wm` CLI's dispatch — the code that IS the shipped binary's body
 * (package-design spec §2b). It calls the tested `wm-core` state machine directly
 * (`parseWmFile` / `applyWmMutation` / `renderWmMarkdown`), replacing the old
 * `Function.prototype.toString()` embedding (spec §1b): no more unenforced
 * no-closure contract — the container CLI and the host `wm-store` are literally
 * the same imported functions.
 *
 * Uses only `node:fs` + `node:crypto`, so this runs under both bun (shipped) and
 * plain node (host tests) — the entrypoint is behaviorally testable on the host,
 * unlike `memory` (which needs bun:sqlite + vec0.so).
 */

import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import { applyWmMutation, parseWmFile, renderWmMarkdown, type WmMutation } from "./wm-core.js"

/** Store paths relative to the in-container cwd /work/players/<name>. */
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

export interface WmDeps {
  /** The in-container cwd the store paths resolve against (process.cwd()). */
  cwd: string
  /** Injected clock so mutation timestamps are deterministic under test. */
  nowIso: string
  out: (line: string) => void
  err: (line: string) => void
}

/**
 * Atomic write-via-rename (spec §4 invariant 8). The tmp suffix is pid+random,
 * NOT pid-only: this CLI and the host's wm-store.ts both write this file over the
 * shared mount, and a pid-only suffix can collide across processes/hosts (e.g.
 * containerized pid 1) or rapid re-invocations reusing a pid.
 */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/** Parse argv into a mutation, or "usage" for a malformed invocation. */
function parseWmMutation(argv: ReadonlyArray<string>): WmMutation | "usage" {
  const verb = argv[0]
  if (verb === "todo") {
    let parent: string | null = null
    const rest: string[] = []
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--parent" && i + 1 < argv.length) {
        parent = argv[i + 1]
        i++
      } else {
        rest.push(argv[i])
      }
    }
    if (rest.length !== 1) return "usage"
    return { verb: "todo", text: rest[0], parent }
  }
  if (verb === "done" || verb === "discard") {
    if (argv.length !== 2) return "usage"
    return { verb, id: argv[1] }
  }
  return "usage"
}

/**
 * Run one `wm` invocation. Returns the process exit code (0 ok, 1 mutation
 * rejected, 2 usage error). Pure w.r.t. its inputs beyond the fs writes.
 */
export function runWm(argv: ReadonlyArray<string>, deps: WmDeps): number {
  const { cwd, nowIso, out, err } = deps
  const wmJson = `${cwd}/${WM_JSON_REL}`
  const wmMd = `${cwd}/${WM_MD_REL}`

  const readStore = () => {
    try {
      return parseWmFile(fs.readFileSync(wmJson, "utf8"))
    } catch {
      return parseWmFile("")
    }
  }

  const mutation = parseWmMutation(argv)
  if (mutation === "usage") {
    err(WM_USAGE)
    return 2
  }

  const result = applyWmMutation(readStore(), mutation, "agent", nowIso)
  if (!result.ok) {
    err(`wm: ${result.error}`)
    return 1
  }
  // Journal the agent mutation for the harness to drain into the episode log at
  // the next step boundary (spec §2).
  const next = result.file
  next.pendingDeltas = next.pendingDeltas.concat([result.delta])
  writeAtomic(wmJson, JSON.stringify(next, null, 2))
  writeAtomic(wmMd, renderWmMarkdown(next))
  if (mutation.verb === "todo") out(result.delta.id)
  return 0
}
