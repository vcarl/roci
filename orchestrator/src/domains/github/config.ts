import * as path from "node:path"
import type { DomainConfig, ContainerMount } from "../../core/domain-bundle.js"
import { gitHubDomainBundle } from "./index.js"
import { gitHubPhaseRegistry } from "./phases.js"

const IMAGE_NAME = "github-agent"

/** Container volume mounts for the GitHub domain. */
const containerMounts = (projectRoot: string): ContainerMount[] => [
  {
    host: path.resolve(projectRoot, "players"),
    container: "/work/players",
  },
  // TODO: Mount repo checkout directory when Docker image is built
  // {
  //   host: path.resolve(projectRoot, "repos"),
  //   container: "/work/repos",
  // },
]

/** Build the GitHub domain config for a given project root. */
export const gitHubDomainConfig = (projectRoot: string): DomainConfig => ({
  bundle: gitHubDomainBundle,
  phaseRegistry: gitHubPhaseRegistry,
  containerMounts: containerMounts(projectRoot),
  imageName: IMAGE_NAME,
})
