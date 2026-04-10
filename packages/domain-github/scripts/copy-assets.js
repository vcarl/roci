import { cpSync, readdirSync, statSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

function copyAssets(srcDir, distDir) {
  for (const entry of readdirSync(srcDir, { recursive: true })) {
    const srcPath = join(srcDir, entry)
    if (!statSync(srcPath).isFile()) continue
    if (entry.endsWith(".ts") && !entry.startsWith("docker/")) continue
    const destPath = join(distDir, entry)
    mkdirSync(dirname(destPath), { recursive: true })
    cpSync(srcPath, destPath)
  }
}

copyAssets("src", "dist")
