import { Effect } from "effect"
import type { ClaudeModel } from "./Claude.js"
import { Claude } from "./Claude.js"
import { Docker, DockerError } from "./Docker.js"
import { logToConsole } from "../logging/console-renderer.js"
import { execSync } from "node:child_process"
import * as path from "node:path"

const SHARED_CONTAINER_NAME = "roci-crew"

/**
 * Docker + Claude CLI based execution environment for subagents.
 * Satisfies the ExecutionEnvironment contract conceptually;
 * the `implements` clause is omitted because Effect's R parameter
 * variance makes formal interface conformance impractical.
 */
export class DockerExecutionEnvironment {
  initialize(config: { projectRoot: string; imageName: string }) {
    return Effect.gen(function* () {
      const docker = yield* Docker

      const existing = yield* docker.status(SHARED_CONTAINER_NAME)

      if (existing && existing.status === "running") {
        yield* logToConsole("orchestrator", "main", `Shared container ${SHARED_CONTAINER_NAME} already running`)
        return existing.id
      }

      if (existing && existing.status === "paused") {
        yield* docker.resume(SHARED_CONTAINER_NAME)
        yield* logToConsole("orchestrator", "main", `Shared container ${SHARED_CONTAINER_NAME} resumed`)
        return existing.id
      }

      if (existing) {
        yield* docker.remove(SHARED_CONTAINER_NAME)
      }

      const containerId = yield* docker.create({
        name: SHARED_CONTAINER_NAME,
        image: config.imageName,
        mounts: [
          { host: path.resolve(config.projectRoot, "players"), container: "/work/players" },
          { host: path.resolve(config.projectRoot, "shared-resources/workspace"), container: "/work/shared/workspace" },
          { host: path.resolve(config.projectRoot, "shared-resources/spacemolt-docs"), container: "/work/shared/spacemolt-docs" },
          { host: path.resolve(config.projectRoot, "docs"), container: "/work/shared/docs" },
          { host: path.resolve(config.projectRoot, "shared-resources/sm-cli"), container: "/work/sm-cli" },
          { host: path.resolve(config.projectRoot, ".claude"), container: "/work/.claude", readonly: true },
          { host: path.resolve(config.projectRoot, ".devcontainer"), container: "/opt/devcontainer", readonly: true },
          { host: path.resolve(config.projectRoot, "harness"), container: "/opt/harness", readonly: true },
          { host: path.resolve(config.projectRoot, "scripts"), container: "/opt/scripts", readonly: true },
        ],
        env: {},
        cmd: ["bash", "-c", "sudo /usr/local/bin/init-firewall.sh && sleep infinity"],
        capAdd: ["NET_ADMIN", "NET_RAW"],
      })

      yield* Effect.try({
        try: () => { execSync(`docker start ${containerId}`, { stdio: "pipe" }) },
        catch: (e) => new DockerError("Failed to start shared container", e),
      })

      yield* Effect.try({
        try: () => { execSync(`docker exec -u root ${containerId} ln -sf /work/sm-cli/sm /usr/local/bin/sm`, { stdio: "pipe" }) },
        catch: (e) => new DockerError("Failed to create sm symlink", e),
      })

      yield* logToConsole("orchestrator", "main", `Shared container ${SHARED_CONTAINER_NAME} created and started`)
      return containerId
    })
  }

  executeSubagent(opts: {
    containerId: string
    playerName: string
    prompt: string
    model: ClaudeModel
    systemPrompt?: string
    env?: Record<string, string>
  }) {
    return Effect.gen(function* () {
      const claude = yield* Claude
      return yield* claude.execInContainer({
        containerId: opts.containerId,
        playerName: opts.playerName,
        prompt: opts.prompt,
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        outputFormat: "stream-json",
        env: opts.env,
      })
    })
  }
}
