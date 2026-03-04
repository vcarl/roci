import { readFileSync } from "node:fs"
import * as path from "node:path"
import type { DomainConfig } from "../core/domain-bundle.js"
import { spaceMoltDomainConfig } from "./spacemolt/config.js"
import { gitHubDomainConfig } from "./github/config.js"

/** Factory that builds a DomainConfig given the project root. */
export type DomainConfigFactory = (projectRoot: string) => DomainConfig

/** Static registry of all known domains. Add a new domain = one line here. */
export const DOMAIN_REGISTRY: Record<string, DomainConfigFactory> = {
  spacemolt: spaceMoltDomainConfig,
  github: gitHubDomainConfig,
}

/** Shape of config.json at the project root. */
export interface ProjectConfig {
  [domainName: string]: { characters: string[] }
}

/** A resolved domain ready for the orchestrator. */
export interface ResolvedDomain {
  name: string
  config: DomainConfig
  characters: string[]
}

/** Read config.json from the project root. */
export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = path.resolve(projectRoot, "config.json")
  const raw = readFileSync(configPath, "utf-8")
  return JSON.parse(raw) as ProjectConfig
}

/**
 * Combine config.json with the domain registry, applying optional filters.
 *
 * @param projectRoot - Absolute path to the project root
 * @param domainFilter - If non-empty, only include these domain names
 * @param characterFilter - If non-empty, only include these characters (across all domains)
 */
export function resolveConfigs(
  projectRoot: string,
  domainFilter: string[],
  characterFilter: string[],
): ResolvedDomain[] {
  const projectConfig = loadProjectConfig(projectRoot)
  const resolved: ResolvedDomain[] = []

  for (const [domainName, entry] of Object.entries(projectConfig)) {
    // Apply domain filter
    if (domainFilter.length > 0 && !domainFilter.includes(domainName)) continue

    const factory = DOMAIN_REGISTRY[domainName]
    if (!factory) {
      console.warn(`Warning: domain "${domainName}" in config.json has no registry entry, skipping`)
      continue
    }

    // Apply character filter
    let characters = entry.characters
    if (characterFilter.length > 0) {
      characters = characters.filter((c) => characterFilter.includes(c))
      if (characters.length === 0) continue
    }

    resolved.push({
      name: domainName,
      config: factory(projectRoot),
      characters,
    })
  }

  return resolved
}
