import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { reapResidentServers } from "@roci/core"
import { rociCommand, serviceLayer } from "./cli.js"

// Synchronous orphan-reaper backstop for the RESIDENT mlx server (the 122B on
// port 8083). When the session is launched under bare `tsx`, tsx double-forks and
// SIGKILLs the worker ~30ms after forwarding SIGTERM — long before Effect's async
// kill finalizer can run, so the resident server orphans (holds the port + ~42%
// RAM). These SYNCHRONOUS handlers run inside that 30ms window and group-SIGKILL
// each tracked resident pid. They are ADDITIVE to NodeRuntime.runMain's own
// SIGTERM/SIGINT handlers (Node allows multiple listeners) — we do NOT call
// process.exit here, leaving runMain/tsx to drive the actual exit (so the async
// finalizers still run on the non-double-forking packaged path). 'exit' is a
// final backstop, but note it does NOT fire on SIGKILL, so the signal handlers
// are the primary guard.
process.on("SIGTERM", () => reapResidentServers())
process.on("SIGINT", () => reapResidentServers())
process.on("exit", () => reapResidentServers())

// Provide services at the command level so they only initialize when a
// command handler actually runs — not during --help / --version parsing.
const provided = rociCommand.pipe(Command.provide(serviceLayer))

const cli = Command.run(provided, {
  name: "roci",
  version: "0.1.0",
})

cli(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)
