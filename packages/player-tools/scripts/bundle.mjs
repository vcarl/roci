/**
 * Phase-2 bundle step (package-design spec §2f). Produce self-contained,
 * single-file bun artifacts for BOTH in-container entrypoints:
 *
 *   src/memory/main.ts -> dist/bundles/memory
 *   src/wm/main.ts     -> dist/bundles/wm
 *
 * The package's own TS is inlined; `bun:sqlite` and every `node:*` builtin stay
 * EXTERNAL (resolved by the in-container bun at runtime — the container never
 * runs a host bundler). The exact container-contract shebang (§4 invariant 2,
 * `#!/home/node/.bun/bin/bun`) is prepended deterministically.
 *
 * esbuild is the CI-portable bundler (no bun-on-host requirement; spec §2f/§8).
 * Wired into `build` as `tsc && node scripts/bundle.mjs` so nx `dependsOn:
 * ["^build"]` orders it ahead of core's build. Exposed as functions so the
 * bundle test can produce artifacts hermetically without a full nx build.
 */

import { buildSync } from "esbuild"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The load-bearing shebang — bun is not on PATH under `bash -lc` (spec §4.2). */
export const BUN_SHEBANG = "#!/home/node/.bun/bin/bun"

/** `bun:sqlite` is not a node builtin, so esbuild must be told to keep it external. */
const EXTERNAL = ["bun:sqlite"]

const pkgRoot = fileURLToPath(new URL("..", import.meta.url))

/**
 * Bundle one entrypoint to a single ESM file with the contract shebang.
 * `write:false` so we can normalize the shebang in-memory (exactly one, exactly
 * the contract string) before writing 0755. Returns { path, bytes }.
 */
export function bundleEntry(entryRel, outAbs) {
  const result = buildSync({
    entryPoints: [join(pkgRoot, entryRel)],
    bundle: true,
    // platform:node keeps every `node:*` builtin external automatically; esm so
    // `bun:sqlite`/`node:*` remain `import` statements the container bun resolves.
    platform: "node",
    format: "esm",
    external: EXTERNAL,
    write: false,
    legalComments: "none",
    // Deterministic output: no sourcemap, no minify (readable, reviewable), no
    // absolute paths baked in (esbuild uses paths relative to the entry).
    sourcemap: false,
    minify: false,
  })
  let text = result.outputFiles[0].text
  // esbuild may or may not preserve the entry's hashbang; normalize to exactly
  // one, exactly the contract string, so the artifact is deterministic and the
  // shebang invariant holds regardless of esbuild's hashbang handling.
  text = text.replace(/^#![^\n]*\n/, "")
  text = `${BUN_SHEBANG}\n${text}`
  mkdirSync(dirname(outAbs), { recursive: true })
  writeFileSync(outAbs, text)
  chmodSync(outAbs, 0o755)
  return { path: outAbs, bytes: Buffer.byteLength(text, "utf8") }
}

/** Bundle both entrypoints into `outDir` (default the package's dist/bundles). */
export function bundleAll(outDir = join(pkgRoot, "dist", "bundles")) {
  return {
    memory: bundleEntry("src/memory/main.ts", join(outDir, "memory")),
    wm: bundleEntry("src/wm/main.ts", join(outDir, "wm")),
  }
}

// CLI entry (invoked by the `build` script, and by the bundle test as a
// subprocess so nothing has to import this .mjs from typechecked .ts). An
// optional argv[2] overrides the output dir (the test bundles into a tmp dir).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = process.argv[2] ? resolve(process.argv[2]) : undefined
  const r = outDir ? bundleAll(outDir) : bundleAll()
  console.log(JSON.stringify({ memory: r.memory, wm: r.wm }))
}
