import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { rociCommand, serviceLayer } from "./cli.js"

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
