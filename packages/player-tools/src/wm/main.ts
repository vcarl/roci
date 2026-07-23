#!/home/node/.bun/bin/bun
// Working-memory CLI — the SHIPPED binary (package-design spec). Plain JSON store
// at me/wm.json; every mutation atomically re-renders me/WM.md, which opencode
// injects into the agent's context on every request. All logic lives in the
// host-tested ./wm-run.js (which calls the tested wm-core state machine directly).
import { runWm } from "./wm-run.js"

const code = runWm(process.argv.slice(2), {
  cwd: process.cwd(),
  nowIso: new Date().toISOString(),
  out: (line: string) => console.log(line),
  err: (line: string) => console.error(line),
})
process.exit(code)
