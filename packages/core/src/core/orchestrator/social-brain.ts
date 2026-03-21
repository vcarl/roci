/**
 * Social Brain — second autonomous planning loop per agent.
 *
 * Handles relational presence: team communication, DMs, forum activity,
 * hobby maintenance. Architecturally identical to Core Brain: same claude -p
 * execution path, different prompt stack, different cadence.
 *
 * Core Brain asks: "What do I do next to advance my mission?"
 * Social Brain asks: "What's happening with my people, and how do I show up for them?"
 */

import { Effect } from "effect"
import type { CharacterConfig } from "../../services/CharacterFs.js"
import { CharacterFs } from "../../services/CharacterFs.js"
import { logToConsole } from "../../logging/console-renderer.js"
import { runTurn } from "../limbic/hypothalamus/process-runner.js"
import { parseSocialReport } from "./harness-state.js"
import { readSocialState, writeSocialState, type SocialState } from "../../operator/workspace.js"
import type { AnyModel } from "../../services/Claude.js"
import * as path from "node:path"
import { readFileSync } from "node:fs"

// ── Types ────────────────────────────────────────────────────

export interface SocialBrainConfig {
  /** Whether social brain is enabled. */
  enabled: boolean
  /** Ticks between social turns. Default: 25. */
  cadence: number
}

export interface SocialPlan {
  reasoning: string
  steps: SocialPlanStep[]
}

export interface SocialPlanStep {
  action: "faction_chat" | "dm" | "forum_post" | "forum_reply" | "forum_thread" | "hobby_update"
  target: string
  intent: string
  model: "haiku" | "sonnet"
}

export interface SocialBrainState {
  lastSocialTick: number
  consecutiveFailures: number
  skipUntilTick: number
}

// ── Constants ────────────────────────────────────────────────

const SOCIAL_FAILURE_CAP = 3
const SOCIAL_SKIP_TICKS = 15
const FORUM_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

// ── Runner ───────────────────────────────────────────────────

/**
 * Check if a social turn should fire this tick.
 */
export function shouldRunSocial(
  currentTick: number,
  socialState: SocialBrainState,
  config: SocialBrainConfig,
): boolean {
  if (!config.enabled) return false
  if (currentTick < socialState.skipUntilTick) return false
  return (currentTick - socialState.lastSocialTick) >= config.cadence
}

/**
 * Run one social brain turn: plan → execute → parse SOCIAL_REPORT.
 * Returns the updated SocialBrainState.
 */
export const runSocialTurn = (params: {
  char: CharacterConfig
  containerId: string
  playerName: string
  containerEnv?: Record<string, string>
  addDirs?: string[]
  currentTick: number
  socialBrainState: SocialBrainState
  projectRoot: string
  socialPlanTemplate: string
  socialBodyTemplate: string
  systemPrompt: string
  /** Model for planning turns (default "haiku") */
  brainModel?: AnyModel
  /** Model for body turns (default "haiku") */
  evalModel?: AnyModel
}) =>
  Effect.gen(function* () {
    const { char, currentTick, socialBrainState, projectRoot } = params

    const charFs = yield* CharacterFs

    // Read minimal context
    const background = yield* charFs.readBackground(char).pipe(Effect.catchAll(() => Effect.succeed("")))
    const values = yield* charFs.readValues(char).pipe(Effect.catchAll(() => Effect.succeed("")))

    // Read status.json
    const playerDir = path.resolve(char.dir, "..")
    let statusSummary = "(no status available)"
    try {
      const statusJson = readFileSync(path.join(playerDir, "status.json"), "utf-8")
      const status = JSON.parse(statusJson) as Record<string, unknown>
      statusSummary = `Phase: ${status.phase}, Mode: ${status.mode}, Goal: ${status.currentGoal ?? "none"}, Situation: ${status.situation}`
    } catch { /* use default */ }

    // Read social-state.json
    const socialState = readSocialState(playerDir)
    const socialStateStr = JSON.stringify(socialState, null, 2)

    // Read TODO.md
    let todoSection = "(no directives)"
    try {
      todoSection = readFileSync(path.join(char.dir, "TODO.md"), "utf-8").trim() || "(no directives)"
    } catch { /* use default */ }

    // Read workspace/INDEX.md
    let workspaceIndex = "(workspace not available)"
    try {
      workspaceIndex = readFileSync(path.join(projectRoot, "shared-resources", "workspace", "INDEX.md"), "utf-8").trim()
    } catch { /* use default */ }

    // Check forum cooldown
    const forumCooldown = socialState.lastForumPost
      ? (Date.now() - new Date(socialState.lastForumPost).getTime()) < FORUM_COOLDOWN_MS
      : false

    // ── Plan phase ──────────────────────────────────────────
    yield* logToConsole(char.name, "social", "Social Brain planning...")

    const planPrompt = params.socialPlanTemplate
      .replace("{{background}}", background.slice(0, 1500))
      .replace("{{values}}", values.slice(0, 1000))
      .replace("{{statusSummary}}", statusSummary)
      .replace("{{socialState}}", socialStateStr)
      .replace("{{todoSection}}", todoSection)
      .replace("{{workspaceIndex}}", workspaceIndex)

    const planResult = yield* runTurn({
      char,
      containerId: params.containerId,
      playerName: params.playerName,
      systemPrompt: params.systemPrompt,
      prompt: planPrompt,
      model: params.evalModel ?? "haiku",
      timeoutMs: 60_000,
      env: params.containerEnv,
      addDirs: params.addDirs,
      role: "brain",
    }).pipe(
      Effect.catchAll((e) => {
        return logToConsole(char.name, "social", `Social plan failed: ${e}`).pipe(
          Effect.as({ output: "", timedOut: true, durationMs: 0 }),
        )
      }),
    )

    if (!planResult.output.trim()) {
      yield* logToConsole(char.name, "social", "Social plan empty — skipping")
      return {
        ...socialBrainState,
        lastSocialTick: currentTick,
        consecutiveFailures: socialBrainState.consecutiveFailures + 1,
        skipUntilTick: socialBrainState.consecutiveFailures + 1 >= SOCIAL_FAILURE_CAP
          ? currentTick + SOCIAL_SKIP_TICKS
          : socialBrainState.skipUntilTick,
      } satisfies SocialBrainState
    }

    // Parse plan JSON
    let plan: SocialPlan
    try {
      const jsonMatch = planResult.output.match(/\{[\s\S]*\}/)
      plan = JSON.parse(jsonMatch?.[0] ?? "{}") as SocialPlan
      if (!plan.steps || plan.steps.length === 0) throw new Error("no steps")
    } catch {
      yield* logToConsole(char.name, "social", "Social plan parse failed — skipping")
      return {
        ...socialBrainState,
        lastSocialTick: currentTick,
        consecutiveFailures: socialBrainState.consecutiveFailures + 1,
        skipUntilTick: socialBrainState.consecutiveFailures + 1 >= SOCIAL_FAILURE_CAP
          ? currentTick + SOCIAL_SKIP_TICKS
          : socialBrainState.skipUntilTick,
      } satisfies SocialBrainState
    }

    yield* logToConsole(char.name, "social", `Social plan: ${plan.reasoning.slice(0, 100)}`)

    // Filter out forum steps if cooldown is active
    const filteredSteps: SocialPlanStep[] = []
    for (const step of plan.steps) {
      if (forumCooldown && (step.action === "forum_post" || step.action === "forum_thread")) {
        yield* logToConsole(char.name, "social", `Forum cooldown active — skipping ${step.action}`)
        continue
      }
      filteredSteps.push(step)
    }

    if (filteredSteps.length === 0) {
      yield* logToConsole(char.name, "social", "All social steps filtered (cooldown) — skip, not failure")
      return { ...socialBrainState, lastSocialTick: currentTick } satisfies SocialBrainState
    }

    // ── Execute phase (all steps in one body turn) ──────────
    const firstStep = filteredSteps[0]!
    const bodyPrompt = params.socialBodyTemplate
      .replace("{{personality}}", background.slice(0, 2000))
      .replace("{{values}}", values.slice(0, 1500))
      .replace("{{action}}", firstStep.action)
      .replace("{{target}}", firstStep.target)
      .replace("{{intent}}", firstStep.intent + (filteredSteps.length > 1
        ? `\n\nAlso: ${filteredSteps.slice(1).map(s => `[${s.action}] ${s.intent}`).join("; ")}`
        : ""))
      .replace("{{briefing}}", statusSummary)
      .replace("{{agentName}}", char.name.toLowerCase())

    yield* logToConsole(char.name, "social", `Executing: [${firstStep.action}] ${firstStep.intent.slice(0, 80)}`)

    // Map "haiku"/"sonnet" to actual configured models
    const bodyModel: AnyModel = firstStep.model === "sonnet"
      ? (params.brainModel ?? "sonnet")
      : (params.evalModel ?? "haiku")

    const bodyResult = yield* runTurn({
      char,
      containerId: params.containerId,
      playerName: params.playerName,
      systemPrompt: params.systemPrompt,
      prompt: bodyPrompt,
      model: bodyModel,
      timeoutMs: 120_000,
      env: params.containerEnv,
      addDirs: params.addDirs,
      role: "body",
    }).pipe(
      Effect.catchAll((e) => {
        return logToConsole(char.name, "social", `Social body failed: ${e}`).pipe(
          Effect.as({ output: "", timedOut: true, durationMs: 0 }),
        )
      }),
    )

    // Parse SOCIAL_REPORT
    const report = parseSocialReport(bodyResult.output)
    if (report) {
      yield* logToConsole(char.name, "social", `Social report: ${report.slice(0, 150)}`)
    } else {
      yield* logToConsole(char.name, "social", "No SOCIAL_REPORT found in output")
    }

    // Update social-state.json based on what actions were taken
    const updatedSocial: SocialState = {
      ...socialState,
      lastDM: { ...socialState.lastDM },
      pendingReplies: [...socialState.pendingReplies],
      openDMThreads: [...socialState.openDMThreads],
    }
    const now = new Date().toISOString()
    for (const step of filteredSteps) {
      if (step.action === "faction_chat") {
        updatedSocial.lastFactionChat = now
      } else if (step.action === "forum_post" || step.action === "forum_thread") {
        updatedSocial.lastForumPost = now
      } else if (step.action === "dm") {
        updatedSocial.lastDM[step.target] = now
      }
    }
    if (report) {
      updatedSocial.recentTeamActivity = report.slice(0, 500)
    }
    writeSocialState(playerDir, updatedSocial)

    yield* logToConsole(char.name, "social", `Social turn complete (${Math.round(bodyResult.durationMs / 1000)}s)`)

    return {
      lastSocialTick: currentTick,
      consecutiveFailures: 0,
      skipUntilTick: 0,
    } satisfies SocialBrainState
  })
