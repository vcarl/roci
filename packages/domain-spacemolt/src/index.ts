import { Layer } from "effect"
import type { DomainBundle } from "@signal/core/core/domain-bundle.js"
import { SkillRegistryTag } from "@signal/core/core/skill.js"
import { SpaceMoltEventProcessorLive } from "./event-processor.js"
import { SpaceMoltInterruptRegistryLive } from "./interrupts.js"
import { SpaceMoltSituationClassifierLive } from "./situation.js"
import { SpaceMoltStateRendererLive } from "./renderer.js"
import { SpaceMoltPromptBuilderLive } from "./prompt-builder.js"
import { makeGameSocketLive } from "./game-socket.js"

/** No-op skill registry — all step completion falls through to the LLM evaluator. */
const StubSkillRegistryLive = Layer.succeed(SkillRegistryTag, {
  skills: [],
  getSkill: () => undefined,
  taskList: () => "",
  isStepComplete: () => ({
    complete: false,
    reason: "No deterministic check — use your judgment based on state changes",
    matchedCondition: null,
    relevantState: {},
  }),
})

/** All SpaceMolt domain service layers bundled for the core state machine. */
export const spaceMoltDomainBundle: DomainBundle = Layer.mergeAll(
  SpaceMoltPromptBuilderLive,
  SpaceMoltEventProcessorLive,
  StubSkillRegistryLive,
  SpaceMoltInterruptRegistryLive,
  SpaceMoltSituationClassifierLive,
  SpaceMoltStateRendererLive,
)

/** SpaceMolt-specific service layer (GameSocket) for the CLI's global service layer. */
export const spaceMoltServiceLayer = makeGameSocketLive()
