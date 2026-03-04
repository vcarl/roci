import * as path from "node:path"
import type { DomainConfig, ContainerMount } from "../../core/domain-bundle.js"
import { gitHubDomainBundle, GitHubClientLive } from "./index.js"
import { gitHubPhaseRegistry } from "./phases.js"

const IMAGE_NAME = "github-agent"

/** Container volume mounts for the GitHub domain. */
const containerMounts = (projectRoot: string): ContainerMount[] => [
  {
    host: path.resolve(projectRoot, "players"),
    container: "/work/players",
  },
  {
    host: path.resolve(projectRoot, ".claude"),
    container: "/work/.claude",
    readonly: true,
  },
  {
    host: path.resolve(projectRoot, "scripts"),
    container: "/opt/scripts",
    readonly: true,
  },
]

/** Build the GitHub domain config for a given project root. */
export const gitHubDomainConfig = (projectRoot: string): DomainConfig => ({
  bundle: gitHubDomainBundle,
  phaseRegistry: gitHubPhaseRegistry,
  containerMounts: containerMounts(projectRoot),
  imageName: IMAGE_NAME,
  serviceLayer: GitHubClientLive,
  dockerfilePath: "orchestrator/src/domains/github/docker/Dockerfile",
  dockerContext: "orchestrator/src/domains/github/docker",
  containerAddDirs: [],
})
