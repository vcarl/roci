import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Phase-2 bundle contract test. Drives the real bundler (scripts/bundle.mjs) as a
 * SUBPROCESS into a tmp dir — hermetic (no dependency on a prior `nx build`) and
 * with nothing importing the untyped .mjs from typechecked .ts. Asserts the three
 * static container-contract invariants (shebang, externals-only, determinism) and,
 * where bun is available, smoke-runs the node:fs-only `wm` bundle.
 */

const BUN_SHEBANG = "#!/home/node/.bun/bin/bun"
const bundleScript = fileURLToPath(new URL("../scripts/bundle.mjs", import.meta.url))

/** Run the bundler into `outDir`; returns the two artifact paths. */
function runBundler(outDir: string): { memory: string; wm: string } {
  const stdout = execFileSync(process.execPath, [bundleScript, outDir], { encoding: "utf8" })
  const { memory, wm } = JSON.parse(stdout) as { memory: { path: string }; wm: { path: string } }
  return { memory: memory.path, wm: wm.path }
}

/** Locate a runnable bun for the exec smoke, or null to skip it (CI portability). */
function findBun(): string | null {
  const home = process.env.HOME ? join(process.env.HOME, ".bun/bin/bun") : null
  if (home && existsSync(home)) return home
  try {
    return execFileSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).trim() || null
  } catch {
    return null
  }
}

/** Every module specifier the bundle imports/requires. */
function importSpecifiers(code: string): string[] {
  const specs = new Set<string>()
  for (const m of code.matchAll(/(?:import[^;\n]*?from|require\()\s*["']([^"']+)["']/g)) specs.add(m[1])
  for (const m of code.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) specs.add(m[1])
  return [...specs]
}

const isAllowedExternal = (spec: string) => spec === "bun:sqlite" || spec.startsWith("node:")

describe("phase-2 bundles", () => {
  const out = mkdtempSync(join(tmpdir(), "pt-bundle-"))
  const artifacts = runBundler(out)
  const memoryCode = readFileSync(artifacts.memory, "utf8")
  const wmCode = readFileSync(artifacts.wm, "utf8")

  it("both artifacts start with the exact container-contract shebang (exactly one)", () => {
    expect(memoryCode.startsWith(`${BUN_SHEBANG}\n`)).toBe(true)
    expect(wmCode.startsWith(`${BUN_SHEBANG}\n`)).toBe(true)
    expect(memoryCode.split("\n").filter((l) => l.startsWith("#!")).length).toBe(1)
    expect(wmCode.split("\n").filter((l) => l.startsWith("#!")).length).toBe(1)
  })

  it("inline everything except bun:sqlite / node:* (no other imports survive)", () => {
    const memSpecs = importSpecifiers(memoryCode)
    const wmSpecs = importSpecifiers(wmCode)
    expect(memSpecs.every(isAllowedExternal)).toBe(true)
    expect(wmSpecs.every(isAllowedExternal)).toBe(true)
    expect(memSpecs).toContain("bun:sqlite")
    // no @roci/* or relative specifier leaked through un-inlined
    expect([...memSpecs, ...wmSpecs].some((s) => s.startsWith("@roci/") || s.startsWith("."))).toBe(false)
  })

  it("is deterministic — a second build is byte-identical", () => {
    const out2 = mkdtempSync(join(tmpdir(), "pt-bundle2-"))
    const again = runBundler(out2)
    expect(readFileSync(again.memory, "utf8")).toBe(memoryCode)
    expect(readFileSync(again.wm, "utf8")).toBe(wmCode)
    rmSync(out2, { recursive: true, force: true })
  })

  const bun = findBun()
  describe.skipIf(!bun)("wm bundle executes under bun (node:fs only — no sqlite)", () => {
    it("creates wm.json + WM.md and journals the mutation", () => {
      const work = mkdtempSync(join(tmpdir(), "pt-wm-run-"))
      mkdirSync(join(work, "me"))
      const printed = execFileSync(bun as string, [artifacts.wm, "todo", "buy milk"], {
        cwd: work,
        encoding: "utf8",
      }).trim()
      expect(printed).toBe("t1")
      const file = JSON.parse(readFileSync(join(work, "me/wm.json"), "utf8"))
      expect(file.todos[0]).toMatchObject({ id: "t1", text: "buy milk", state: "open", origin: "agent" })
      expect(file.pendingDeltas).toHaveLength(1)
      expect(readFileSync(join(work, "me/WM.md"), "utf8")).toContain("[ ] t1 buy milk")
      rmSync(work, { recursive: true, force: true })
    })
  })

  it("(cleanup)", () => {
    rmSync(out, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})
