import { Context, Effect, Layer, Stream, Chunk } from "effect"
import { Command, CommandExecutor } from "@effect/platform"

export interface ContainerInfo {
  id: string
  name: string
  status: "running" | "paused" | "exited" | "created" | "unknown"
}

export class DockerError {
  readonly _tag = "DockerError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

export class Docker extends Context.Tag("Docker")<
  Docker,
  {
    readonly build: (
      tag: string,
      dockerfilePath: string,
      contextPath: string,
    ) => Effect.Effect<void, DockerError>

    readonly create: (opts: {
      name: string
      image: string
      mounts: Array<{ host: string; container: string; readonly?: boolean }>
      env: Record<string, string>
      entrypoint?: string[]
      cmd?: string[]
      capAdd?: string[]
      privileged?: boolean
    }) => Effect.Effect<string, DockerError>

    readonly exec: (
      containerId: string,
      command: string[],
      opts?: { interactive?: boolean },
    ) => Effect.Effect<string, DockerError>

    readonly execStream: (
      containerId: string,
      command: string[],
    ) => Effect.Effect<Stream.Stream<string, DockerError>, DockerError>

    readonly pause: (containerId: string) => Effect.Effect<void, DockerError>
    readonly resume: (containerId: string) => Effect.Effect<void, DockerError>
    readonly stop: (containerId: string) => Effect.Effect<void, DockerError>
    readonly remove: (containerId: string) => Effect.Effect<void, DockerError>

    readonly status: (
      containerName: string,
    ) => Effect.Effect<ContainerInfo | null, DockerError>

    readonly sendSignal: (
      containerId: string,
      signal: string,
    ) => Effect.Effect<void, DockerError>

    readonly listByLabel: (
      label: string,
      value?: string,
    ) => Effect.Effect<ContainerInfo[], DockerError>
  }
>() {}

const runDockerCommand = (
  args: string[],
  executor: CommandExecutor.CommandExecutor,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cmd = Command.make("docker", ...args)
      const process = yield* executor.start(cmd)
      const stdout = yield* process.stdout.pipe(
        Stream.decodeText(),
        Stream.runCollect,
        Effect.map(Chunk.join("")),
      )
      const exitCode = yield* process.exitCode
      if (exitCode !== 0) {
        const stderr = yield* process.stderr.pipe(
          Stream.decodeText(),
          Stream.runCollect,
          Effect.map(Chunk.join("")),
        )
        return yield* Effect.fail(
          new DockerError(`docker ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`),
        )
      }
      return stdout.trim()
    }),
  ).pipe(Effect.mapError((e) => (e instanceof DockerError ? e : new DockerError("Docker command failed", e))))

export const DockerLive = Layer.effect(
  Docker,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor

    return Docker.of({
      build: (tag, dockerfilePath, contextPath) =>
        runDockerCommand(
          ["build", "-t", tag, "-f", dockerfilePath, contextPath],
          executor,
        ).pipe(Effect.asVoid),

      create: (opts) =>
        Effect.gen(function* () {
          const args = ["create", "--name", opts.name]

          for (const m of opts.mounts) {
            const ro = m.readonly ? ":ro" : ""
            args.push("-v", `${m.host}:${m.container}${ro}`)
          }

          for (const [key, val] of Object.entries(opts.env)) {
            args.push("-e", `${key}=${val}`)
          }

          if (opts.capAdd) {
            for (const cap of opts.capAdd) {
              args.push("--cap-add", cap)
            }
          }

          if (opts.privileged) {
            args.push("--privileged")
          }

          if (opts.entrypoint) {
            args.push("--entrypoint", opts.entrypoint.join(" "))
          }

          args.push("--label", "roci-crew=true")
          args.push(opts.image)

          if (opts.cmd) {
            args.push(...opts.cmd)
          }

          const output = yield* runDockerCommand(args, executor)
          return output
        }),

      exec: (containerId, command, opts) =>
        Effect.gen(function* () {
          const args = ["exec"]
          if (opts?.interactive) args.push("-it")
          args.push(containerId, ...command)
          return yield* runDockerCommand(args, executor)
        }),

      execStream: (containerId, command) =>
        Effect.scoped(
          Effect.gen(function* () {
            const cmd = Command.make("docker", "exec", containerId, ...command)
            const process = yield* executor.start(cmd)
            return process.stdout.pipe(
              Stream.decodeText(),
              Stream.mapError((e) => new DockerError("stream read error", e)),
            )
          }),
        ).pipe(
          Effect.mapError((e) =>
            e instanceof DockerError ? e : new DockerError("execStream failed", e),
          ),
        ),

      pause: (containerId) =>
        runDockerCommand(["pause", containerId], executor).pipe(Effect.asVoid),

      resume: (containerId) =>
        runDockerCommand(["unpause", containerId], executor).pipe(Effect.asVoid),

      stop: (containerId) =>
        runDockerCommand(["stop", containerId], executor).pipe(Effect.asVoid),

      remove: (containerId) =>
        runDockerCommand(["rm", "-f", containerId], executor).pipe(Effect.asVoid),

      status: (containerName) =>
        Effect.gen(function* () {
          const args = [
            "inspect",
            "--format",
            '{{.Id}}\t{{.Name}}\t{{.State.Status}}',
            containerName,
          ]
          const result = yield* runDockerCommand(args, executor).pipe(
            Effect.catchAll(() => Effect.succeed("")),
          )
          if (!result) return null
          const [id, name, status] = result.split("\t")
          return {
            id: id ?? "",
            name: (name ?? "").replace(/^\//, ""),
            status: (status as ContainerInfo["status"]) ?? "unknown",
          }
        }),

      sendSignal: (containerId, signal) =>
        runDockerCommand(["kill", `--signal=${signal}`, containerId], executor).pipe(
          Effect.asVoid,
        ),

      listByLabel: (label, value) =>
        Effect.gen(function* () {
          const filter = value ? `label=${label}=${value}` : `label=${label}`
          const args = [
            "ps",
            "-a",
            "--filter",
            filter,
            "--format",
            '{{.ID}}\t{{.Names}}\t{{.Status}}',
          ]
          const output = yield* runDockerCommand(args, executor).pipe(
            Effect.catchAll(() => Effect.succeed("")),
          )
          if (!output) return []
          return output.split("\n").filter(Boolean).map((line) => {
            const [id, name, rawStatus] = line.split("\t")
            let status: ContainerInfo["status"] = "unknown"
            if (rawStatus?.startsWith("Up")) status = "running"
            else if (rawStatus?.includes("Paused")) status = "paused"
            else if (rawStatus?.startsWith("Exited")) status = "exited"
            else if (rawStatus?.startsWith("Created")) status = "created"
            return { id: id ?? "", name: name ?? "", status }
          })
        }),
    })
  }),
)
