#!/usr/bin/env node
/**
 * Pack script that creates a self-contained tarball including workspace dependencies.
 * Vendors workspace packages into dist/node_modules/ so they're included in the tarball
 * (npm always excludes top-level node_modules, but dist/ contents are included).
 * Node.js module resolution finds @roci/* packages via dist/node_modules/ when
 * the entry point runs from dist/.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(__dirname, "..")
const repoRoot = resolve(appRoot, "../..")
const stagingDir = resolve(repoRoot, ".pack-staging")

// Clean staging
rmSync(stagingDir, { recursive: true, force: true })
mkdirSync(stagingDir, { recursive: true })

// Copy app files
cpSync(resolve(appRoot, "dist"), resolve(stagingDir, "dist"), { recursive: true })
cpSync(resolve(appRoot, "bin"), resolve(stagingDir, "bin"), { recursive: true })

// Read and modify package.json: remove workspace: deps from dependencies
const pkg = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf-8"))
const workspaceDeps = ["@roci/core", "@roci/domain-spacemolt", "@roci/domain-github"]
for (const dep of workspaceDeps) {
  delete pkg.dependencies[dep]
}
pkg.files = ["dist", "bin"]
writeFileSync(resolve(stagingDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n")

// Vendor workspace packages into dist/node_modules/ so Node resolves them
// when running from dist/main.js
for (const [pkgName, pkgDir] of [
  ["@roci/core", "packages/core"],
  ["@roci/domain-spacemolt", "packages/domain-spacemolt"],
  ["@roci/domain-github", "packages/domain-github"],
]) {
  const src = resolve(repoRoot, pkgDir)
  const dest = resolve(stagingDir, "dist", "node_modules", pkgName)
  mkdirSync(dirname(dest), { recursive: true })

  // Copy dist and package.json
  cpSync(resolve(src, "dist"), resolve(dest, "dist"), { recursive: true })
  cpSync(resolve(src, "package.json"), resolve(dest, "package.json"))
}

// Run npm pack from staging
const result = execFileSync("npm", ["pack"], { cwd: stagingDir, encoding: "utf-8" }).trim()
const tgzName = result.split("\n").pop()
cpSync(resolve(stagingDir, tgzName), resolve(repoRoot, tgzName))
console.log(`Packed: ${tgzName}`)

// Clean up
rmSync(stagingDir, { recursive: true, force: true })
