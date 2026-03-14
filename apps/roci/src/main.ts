import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { rociCommand, serviceLayer } from "./cli.js"

const mainLayer = serviceLayer.pipe(Layer.provideMerge(NodeContext.layer))

const cli = Command.run(rociCommand, {
  name: "roci",
  version: "0.1.0",
})

cli(process.argv).pipe(
  Effect.provide(mainLayer),
  NodeRuntime.runMain,
)
