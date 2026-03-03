import { Layer } from "effect"
import type { DomainBundle } from "../../core/domain-bundle.js"
import { SkillRegistryTag } from "../../core/skill.js"
import { GitHubEventProcessorLive } from "./event-processor.js"
import { GitHubInterruptRegistryLive } from "./interrupts.js"
import { GitHubSituationClassifierLive } from "./situation-classifier.js"
import { GitHubStateRendererLive } from "./renderer.js"
import { GitHubPromptBuilderLive } from "./prompt-builder.js"
import { GitHubContextHandlerLive } from "./context-handler.js"
import { GitHubClientLive } from "./github-client.js"

/** No-op skill registry — all step completion falls through to the LLM evaluator. */
const StubSkillRegistryLive = Layer.succeed(SkillRegistryTag, {
  skills: [],
  getSkill: () => undefined,
  taskList: () => "",
  isStepComplete: () => ({
    complete: false,
    reason: "No skill registry configured",
    matchedCondition: null,
    relevantState: {},
  }),
})

/** All GitHub domain service layers bundled for the core state machine. */
export const gitHubDomainBundle: DomainBundle = Layer.mergeAll(
  GitHubPromptBuilderLive,
  GitHubEventProcessorLive,
  StubSkillRegistryLive,
  GitHubInterruptRegistryLive,
  GitHubSituationClassifierLive,
  GitHubStateRendererLive,
  GitHubContextHandlerLive,
)

/** GitHub-specific service layer (GitHubClient) for the CLI's global service layer. */
export { GitHubClientLive }
