import * as path from "node:path"
import { execSync } from "node:child_process"
import type { DomainConfig, ContainerMount } from "../../core/domain-bundle.js"
import { spaceMoltDomainBundle } from "./index.js"
import { spaceMoltPhaseRegistry } from "./phases.js"

const IMAGE_NAME = "spacemolt-player"

/** Container volume mounts for SpaceMolt. */
const containerMounts = (projectRoot: string): ContainerMount[] => [
  {
    host: path.resolve(projectRoot, "players"),
    container: "/work/players",
  },
  {
    host: path.resolve(projectRoot, "shared-resources/workspace"),
    container: "/work/shared/workspace",
  },
  {
    host: path.resolve(projectRoot, "shared-resources/spacemolt-docs"),
    container: "/work/shared/spacemolt-docs",
  },
  {
    host: path.resolve(projectRoot, "docs"),
    container: "/work/shared/docs",
  },
  {
    host: path.resolve(projectRoot, "shared-resources/sm-cli"),
    container: "/work/sm-cli",
  },
  {
    host: path.resolve(projectRoot, ".claude"),
    container: "/work/.claude",
    readonly: true,
  },
  {
    host: path.resolve(projectRoot, ".devcontainer"),
    container: "/opt/devcontainer",
    readonly: true,
  },
  {
    host: path.resolve(projectRoot, "harness"),
    container: "/opt/harness",
    readonly: true,
  },
  {
    host: path.resolve(projectRoot, "scripts"),
    container: "/opt/scripts",
    readonly: true,
  },
]

/** Post-start container setup for SpaceMolt (creates sm CLI symlink). */
const containerSetup = (containerId: string) => {
  try {
    execSync(`docker exec -u root ${containerId} ln -sf /work/sm-cli/sm /usr/local/bin/sm`, { stdio: "pipe" })
  } catch {
    // Non-fatal — sm symlink is a convenience
  }
}

/** Build the SpaceMolt domain config for a given project root. */
export const spaceMoltDomainConfig = (projectRoot: string): DomainConfig => ({
  bundle: spaceMoltDomainBundle,
  phaseRegistry: spaceMoltPhaseRegistry,
  containerMounts: containerMounts(projectRoot),
  containerSetup,
  imageName: IMAGE_NAME,
})
