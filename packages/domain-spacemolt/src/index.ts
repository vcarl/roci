import { Layer } from "effect"
import type { DomainBundle } from "@roci/core/core/domain-bundle.js"
import { SpaceMoltEventProcessorLive } from "./event-processor.js"
import { SpaceMoltInterruptRegistryLive } from "./interrupts.js"
import { SpaceMoltSituationClassifierLive } from "./situation.js"
import { SpaceMoltStateRendererLive } from "./renderer.js"
import { SpaceMoltPromptBuilderLive } from "./prompt-builder.js"
import { makeGameSocketLive } from "./game-socket.js"

/** All SpaceMolt domain service layers bundled for the core state machine. */
export const spaceMoltDomainBundle: DomainBundle = Layer.mergeAll(
  SpaceMoltPromptBuilderLive,
  SpaceMoltEventProcessorLive,
  SpaceMoltInterruptRegistryLive,
  SpaceMoltSituationClassifierLive,
  SpaceMoltStateRendererLive,
)

/** SpaceMolt-specific service layer (GameSocket) for the CLI's global service layer. */
export const spaceMoltServiceLayer = makeGameSocketLive()
