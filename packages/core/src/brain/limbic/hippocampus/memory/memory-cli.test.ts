import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import {
  buildMemoryCliScript,
  provisionMemoryCli,
  MEMORY_CLI_PATH,
  VEC_EXTENSION_PATH,
} from "./memory-cli.js"
import {
  buildSchemaSql,
  buildInsertSql,
  buildVecInsertSql,
  buildMetaGetSql,
  buildMetaSetSql,
} from "./memory-sql.js"
import { Docker } from "../../../../services/Docker.js"

const opts = { embedBaseUrl: "http://127.0.0.1:8084/v1" }

describe("buildMemoryCliScript", () => {
  const script = buildMemoryCliScript(opts)

  it("is a bun script (absolute shebang — bun is not on PATH under bash -lc)", () => {
    expect(script.startsWith("#!/home/node/.bun/bin/bun")).toBe(true)
    expect(script).toContain('from "bun:sqlite"')
  })

  it("dispatches the three documented verbs plus the internal promotion verbs", () => {
    expect(script).toContain('"remember"')
    expect(script).toContain('"search"')
    expect(script).toContain('"recent"')
    expect(script).toContain('"promote"')
    expect(script).toContain('"mark-get"')
    expect(script).toContain('"mark-set"')
  })

  it("loads the sqlite-vec extension with the REQUIRED explicit entrypoint", () => {
    // bun's filename-derived default (sqlite3_vec0_init) does NOT match; the
    // explicit sqlite3_vec_init entrypoint is load-bearing (proven by the spike).
    expect(script).toContain(VEC_EXTENSION_PATH)
    expect(script).toContain('loadExtension')
    expect(script).toContain('"sqlite3_vec_init"')
  })

  it("opens the per-character db in WAL mode with a busy timeout", () => {
    expect(script).toContain("me/longterm.db")
    expect(script).toContain("journal_mode")
    expect(script).toContain("WAL")
    expect(script).toContain("busy_timeout")
  })

  it("embeds the schema + insert + meta SQL builders verbatim (no drift)", () => {
    expect(script).toContain(JSON.stringify(buildSchemaSql()))
    expect(script).toContain(JSON.stringify(buildInsertSql()))
    expect(script).toContain(JSON.stringify(buildVecInsertSql()))
    expect(script).toContain(JSON.stringify(buildMetaGetSql()))
    expect(script).toContain(JSON.stringify(buildMetaSetSql()))
  })

  it("bakes the host-rewritten embed endpoint (loopback → host.docker.internal)", () => {
    expect(script).toContain("http://host.docker.internal:8084/v1/embeddings")
  })

  it("runs a KNN MATCH query for search and inserts vectors as JSON", () => {
    expect(script).toContain("embedding MATCH ?")
    expect(script).toContain("ORDER BY v.distance")
    expect(script).toContain("JSON.stringify")
  })

  it("promote writes raw entries with source='promotion'; mark-get/mark-set use the meta table", () => {
    expect(script).toContain('"promotion"')
    expect(script).toContain("PROMOTE_MARK_KEY")
    expect(script).toContain("META_GET_SQL")
    expect(script).toContain("META_SET_SQL")
    // No full-history scan of promotion rows remains (the old promoted-hashes path).
    expect(script).not.toContain("promoted-hashes")
  })

  it("carries the laundering note (model-authored args, never raw events)", () => {
    expect(script.toLowerCase()).toContain("never paste raw")
  })
})

describe("provisionMemoryCli", () => {
  it("execs AS ROOT a command that base64-writes the script to the CLI path and chmods it", async () => {
    const calls: { command: string[]; opts?: { user?: string } }[] = []
    const StubDocker = Layer.succeed(
      Docker,
      Docker.of({
        exec: (_id: string, command: string[], execOpts?: { user?: string }) => {
          calls.push({ command, opts: execOpts })
          return Effect.succeed("")
        },
      } as unknown as typeof Docker.Service),
    )
    await Effect.runPromise(Effect.provide(provisionMemoryCli("cabc", opts), StubDocker))
    const joined = calls.flatMap((c) => c.command).join(" ")
    expect(joined).toContain(MEMORY_CLI_PATH)
    expect(joined).toContain("base64 -d")
    expect(joined).toContain("chmod 0755")
    const b64 = Buffer.from(buildMemoryCliScript(opts)).toString("base64")
    expect(joined).toContain(b64)
    // Must run as root: /usr/local/bin is root-owned, the container's default user
    // is `node`, so provisioning as node hits Permission denied (the QA blocker).
    expect(calls[0].opts?.user).toBe("root")
  })

  it("PROPAGATES a Docker failure (no longer swallows — provisionImpl logs it loud)", async () => {
    const FailDocker = Layer.succeed(
      Docker,
      Docker.of({
        exec: () => Effect.fail(new Error("docker boom")),
      } as unknown as typeof Docker.Service),
    )
    // The error now reaches the caller (provisionImpl), which logs loud + continues.
    await expect(
      Effect.runPromise(Effect.provide(provisionMemoryCli("cabc", opts), FailDocker)),
    ).rejects.toThrow()
  })
})

describe("buildMemoryCliScript — provenance", () => {
  const script = buildMemoryCliScript({ embedBaseUrl: "http://127.0.0.1:8090" })
  it("embeds the provenance map, default, and migration columns", () => {
    expect(script).toContain("const PROVENANCE_MAP =")
    expect(script).toContain("const PROVENANCE_DEFAULT =")
    expect(script).toContain("const MIGRATION_COLUMNS =")
    expect(script).toContain('"grounded"')
  })
  it("classifies from source at write time and migrates existing dbs", () => {
    expect(script).toContain("function classify(source)")
    expect(script).toContain("PRAGMA table_info(memories)")
    expect(script).toContain(", prov)")
  })
  it("emits provenance in search/recent output", () => {
    expect(script).toContain("provenance: r.provenance")
    expect(script).toContain("m.provenance AS provenance")
  })
})
