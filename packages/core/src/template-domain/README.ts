/**
 * ═══════════════════════════════════════════════════════════════════
 *  TEMPLATE DOMAIN — A worked example showing how to implement a
 *  domain for the ROCI agent harness.
 * ═══════════════════════════════════════════════════════════════════
 *
 * ## What is a "domain"?
 *
 * A domain is the game/simulation/environment-specific layer that the
 * core orchestrator drives. The core provides the plan-act-evaluate
 * loop, the brain (LLM calls), and the lifecycle state machine. The
 * domain tells it:
 *
 *   - What the world state looks like (types.ts)
 *   - How raw events become state updates (event-processor.ts)
 *   - How to summarize state into a situation (situation-classifier.ts)
 *   - What conditions warrant interrupting the current plan (interrupt-rules.ts)
 *   - What skills/tasks the agent can perform (skills.ts)
 *   - How to assemble prompts for the brain (prompt-builder.ts)
 *   - How to render state for humans (state-renderer.ts)
 *   - How to wire it all together (bundle.ts)
 *
 * This template uses a **todo-list manager** as its example domain —
 * simple enough to read quickly, realistic enough to show all the
 * patterns.
 *
 *
 * ## Architecture: the limbic metaphor
 *
 * The core borrows terminology from neuroscience to name its
 * subsystems. Understanding this mapping helps when implementing a
 * domain:
 *
 * **Thalamus** (sensory relay):
 *   - `EventProcessor` — raw events come in (like WebSocket messages
 *     or polling results), and get translated into state updates and
 *     event categories. This is "sensation" — raw input to structured
 *     data. Your domain implements this.
 *   - `SituationClassifier` — takes the full domain state and distills
 *     it into a `SituationSummary` with a headline, sections, and
 *     metrics. This is "perception" — making sense of what's happening.
 *     Your domain implements this.
 *
 * **Amygdala** (threat detection):
 *   - `InterruptRule[]` — declarative rules that fire when state
 *     crosses thresholds (e.g. "deadline approaching", "error rate
 *     spiking"). Critical interrupts kill the current subagent and
 *     force replanning. This is the "fight or flight" response. Your
 *     domain defines these rules.
 *
 * **Hypothalamus** (drives and rhythms):
 *   - Tempo settings control the pace of the plan-act-evaluate loop
 *     (tick interval, max cycles per session, break duration). These
 *     are configured in your phase definitions, not in the bundle.
 *
 * **The Brain** (cortex):
 *   - `PromptBuilder` — assembles the prompt context that gets sent
 *     to the LLM for planning, interrupting, evaluating, and
 *     subagent execution. Your domain implements this.
 *
 *
 * ## File inventory
 *
 * | File                      | What it provides                                  |
 * |---------------------------|---------------------------------------------------|
 * | `types.ts`                | Domain state, situation, and event types           |
 * | `event-processor.ts`      | `EventProcessorTag` — events → state updates      |
 * | `situation-classifier.ts` | `SituationClassifierTag` — state → situation       |
 * | `interrupt-rules.ts`      | `InterruptRegistryTag` — declarative alert rules   |
 * | `skills.ts`               | `SkillRegistryTag` — agent capabilities            |
 * | `prompt-builder.ts`       | `PromptBuilderTag` — prompt assembly               |
 * | `state-renderer.ts`       | `StateRendererTag` — state → human-readable output |
 * | `bundle.ts`               | `DomainBundle` Layer + `DomainConfig` export       |
 * | `index.ts`                | Public API re-exports                              |
 *
 *
 * ## How to create a new domain
 *
 * 1. Copy this directory and rename it.
 * 2. Define your state, situation, and event types in `types.ts`.
 * 3. Implement each service (event processor, classifier, etc.).
 * 4. Wire them into a `DomainBundle` layer in `bundle.ts`.
 * 5. Create a `DomainConfig` that includes the bundle, phase
 *    registry, container mounts, and any init procedures.
 * 6. Register the domain in the CLI's domain registry so `signal run
 *    --domain <yours>` works.
 *
 * The key insight: every service receives `DomainState` (which is
 * `unknown` in the core types) and must cast it to your concrete
 * state type. This is the "opaque state" pattern — the core never
 * knows your state shape, it just threads it through.
 */

// This file is intentionally documentation-only. No runtime exports.
export {};
