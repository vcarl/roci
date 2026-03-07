import { Effect, Ref } from "effect"
import type { Fiber } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { CharacterFs } from "../services/CharacterFs.js"
import { CharacterLog } from "../logging/log-writer.js"
import { logToConsole } from "../logging/console-renderer.js"
import type { DomainState, DomainSituation } from "./domain-types.js"
import type { StateRenderer } from "./state-renderer.js"
import type { BrainMode, Plan, StepTiming, Alert } from "./types.js"
import type { LifecycleHooks, PlanContext } from "./lifecycle.js"
import { brainPlan } from "./brain.js"

export interface PlanningRefs {
  readonly plan: Ref.Ref<Plan | null>
  readonly step: Ref.Ref<number>
  readonly subagentFiber: Ref.Ref<Fiber.RuntimeFiber<string, unknown> | null>
  readonly previousFailure: Ref.Ref<string | null>
  readonly chatContext: Ref.Ref<Array<{ channel: string; sender: string; content: string }>>
  readonly stepTimingHistory: Ref.Ref<StepTiming[]>
  readonly softAlertAcc: Ref.Ref<Map<string, Alert>>
  readonly tickCount: Ref.Ref<number>
  readonly stepStartTick: Ref.Ref<number>
  readonly mode: Ref.Ref<BrainMode>
  readonly investigationReport: Ref.Ref<string | null>
  readonly procedureTargets: Ref.Ref<string[]>
  readonly procedureStartState: Ref.Ref<Record<string, unknown> | null>
}

interface PlanningServices {
  readonly char: CharacterConfig
  readonly tickIntervalSec: number
  readonly hooks?: LifecycleHooks
  readonly renderer?: StateRenderer
}

/** Request a new plan from the brain if idle and no plan exists. */
export const maybeRequestPlan = (
  refs: PlanningRefs,
  services: PlanningServices,
  state: DomainState,
  situation: DomainSituation,
  briefing: string,
) =>
  Effect.gen(function* () {
    const plan = yield* Ref.get(refs.plan)
    const step = yield* Ref.get(refs.step)
    const noFiber = (yield* Ref.get(refs.subagentFiber)) === null

    if (noFiber && (!plan || step >= (plan?.steps.length ?? 0))) {
      const charFs = yield* CharacterFs
      const log = yield* CharacterLog

      const diary = yield* charFs.readDiary(services.char)
      const background = yield* charFs.readBackground(services.char)
      const values = yield* charFs.readValues(services.char)
      const previousFailure = yield* Ref.get(refs.previousFailure)
      const recentChat = yield* Ref.get(refs.chatContext)
      const stepTimingHistory = yield* Ref.get(refs.stepTimingHistory)

      const mode = yield* Ref.get(refs.mode)
      const investigationReport = yield* Ref.get(refs.investigationReport)
      const procedureTargets = yield* Ref.get(refs.procedureTargets)

      let additionalContext: string | undefined
      if (services.hooks?.beforePlan) {
        const planContext: PlanContext = {
          briefing,
          state,
          situation,
          diary,
          previousFailure: previousFailure ?? undefined,
        }
        const enrichment = yield* services.hooks.beforePlan(planContext)
        additionalContext = enrichment.additionalContext
      }

      // Drain accumulated soft alerts into additionalContext
      const accAlerts = yield* Ref.getAndSet(refs.softAlertAcc, new Map())
      if (accAlerts.size > 0) {
        const alertLines = Array.from(accAlerts.values())
          .map(a => `[${a.priority}] ${a.message}${a.suggestedAction ? ` (suggested: ${a.suggestedAction})` : ""}`)
          .join("\n")
        const softAlertSection = `Alerts observed since last plan:\n${alertLines}`
        additionalContext = additionalContext
          ? `${additionalContext}\n\n${softAlertSection}`
          : softAlertSection
      }

      yield* logToConsole(
        services.char.name,
        "brain-input",
        [
          mode !== "select" || investigationReport
            ? `--- Mode ---\n${mode}${investigationReport ? ` (investigation report: ${investigationReport.length} chars)` : ""}`
            : null,
          procedureTargets.length > 0
            ? `--- Procedure Targets ---\n${procedureTargets.join(", ")}`
            : null,
          `--- Briefing ---\n${briefing}`,
          `--- Diary (last 500 chars) ---\n${diary.slice(-500)}`,
          previousFailure ? `--- Previous Failure ---\n${previousFailure}` : null,
          recentChat.length > 0 ? `--- Recent Chat ---\n${recentChat.map((m) => `[${m.channel}] ${m.sender}: ${m.content}`).join("\n")}` : null,
          additionalContext ? `--- Additional Context ---\n${additionalContext}` : null,
        ].filter(Boolean).join("\n"),
      )

      const newPlan = yield* brainPlan.execute({
        state,
        situation,
        diary,
        briefing,
        background,
        values,
        previousFailure: previousFailure ?? undefined,
        recentChat: recentChat.length > 0 ? recentChat : undefined,
        stepTimingHistory: stepTimingHistory.length > 0 ? stepTimingHistory : undefined,
        tickIntervalSec: services.tickIntervalSec,
        additionalContext,
        mode,
        investigationReport: investigationReport ?? undefined,
        procedureTargets: procedureTargets.length > 0 ? procedureTargets : undefined,
      })

      yield* Ref.set(refs.previousFailure, null)
      yield* Ref.set(refs.chatContext, [])

      yield* log.thought(services.char, {
        timestamp: new Date().toISOString(),
        source: "brain",
        character: services.char.name,
        type: "plan",
        plan: newPlan,
        reasoning: newPlan.reasoning,
      })

      yield* logToConsole(
        services.char.name,
        "brain",
        `New plan (${newPlan.steps.length} steps): ${newPlan.reasoning}`,
      )

      const finalPlan = services.hooks?.afterPlan
        ? yield* services.hooks.afterPlan(newPlan)
        : newPlan

      const tickCount = yield* Ref.get(refs.tickCount)
      yield* Ref.set(refs.plan, finalPlan)
      yield* Ref.set(refs.step, 0)
      yield* Ref.set(refs.stepStartTick, tickCount)

      // Mode transition: if brain selected a procedure, switch mode and persist targets
      if (finalPlan.procedure && finalPlan.procedure !== "select") {
        yield* logToConsole(
          services.char.name,
          "brain",
          `Mode transition: select → ${finalPlan.procedure} (targets: ${finalPlan.targets?.join(", ") ?? "none"})`,
        )
        yield* Ref.set(refs.mode, finalPlan.procedure)
        yield* Ref.set(refs.procedureTargets, finalPlan.targets ?? [])
        if (services.renderer) {
          yield* Ref.set(refs.procedureStartState, services.renderer.richSnapshot(state))
        }
      }
    }
  })
