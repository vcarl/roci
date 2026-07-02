import { Layer } from "effect"
import type { DomainBundle } from "@roci/core/core/domain-bundle.js"
import { GitHubEventProcessorLive } from "./event-processor.js"
import { GitHubInterruptRegistryLive } from "./interrupts.js"
import { GitHubSituationClassifierLive } from "./situation-classifier.js"
import { GitHubStateRendererLive } from "./renderer.js"
import { GitHubPromptBuilderLive } from "./prompt-builder.js"
import { GitHubClientLive } from "./github-client.js"

/** All GitHub domain service layers bundled for the core state machine. */
export const gitHubDomainBundle: DomainBundle = Layer.mergeAll(
  GitHubPromptBuilderLive,
  GitHubEventProcessorLive,
  GitHubInterruptRegistryLive,
  GitHubSituationClassifierLive,
  GitHubStateRendererLive,
)

/** GitHub-specific service layer (GitHubClient) for the CLI's global service layer. */
export { GitHubClientLive }
