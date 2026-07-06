import { Effect } from "effect"
import { Docker, type DockerError } from "../services/Docker.js"

/**
 * Install a generated CLI script into the container at `installPath` and mark it
 * executable (0755). Base64-pipes the script to sidestep shell quoting, and execs
 * AS ROOT: `/usr/local/bin` is root-owned while the container's default user is
 * `node`, so a `node`-run write would `Permission denied`. The installed file
 * ends up `root:root 0755`, which `node` can execute.
 *
 * The error channel PROPAGATES DockerError — callers decide whether to swallow it
 * (best-effort provisioning) or surface it.
 */
export function installContainerCli(
  containerId: string,
  installPath: string,
  script: string,
): Effect.Effect<void, DockerError, Docker> {
  const b64 = Buffer.from(script).toString("base64")
  const sh = `echo ${b64} | base64 -d > ${installPath} && chmod 0755 ${installPath}`
  return Effect.gen(function* () {
    const docker = yield* Docker
    yield* docker.exec(containerId, ["bash", "-lc", sh], { user: "root" })
  })
}
