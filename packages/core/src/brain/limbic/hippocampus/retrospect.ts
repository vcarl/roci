/**
 * Meso retrospect stage (agent-cognition Stage 4, spec §4).
 *
 * Per reflection cycle, AFTER promote and BEFORE consolidate (see
 * planned-action.ts): grade the just-ended cycle's episode streams (§1) against
 * the character's skill index (§3) and APPEND skill create/revise/retire
 * proposals to me/growth/proposals.jsonl. Meso PROPOSES ONLY — it never edits a
 * skill file, never touches an identity file, never mutates the episode streams.
 * Proposals accumulate (deduped/capped) until the macro cycle (Stage 5)
 * adjudicates them.
 *
 * House reflection-turn pattern (like dream/consolidate): role:"brain", noTools,
 * runTurn via the claude binary, the shared REFLECTION_TURN_TIMEOUT_MS budget,
 * and a blank/timed-out/errored turn keeps NOTHING (never-fail). The large
 * episode input is bounded IN CODE (compact aggregates + a small raw sample)
 * before it reaches the model — the retrospect turn never sees the raw
 * prompt/output blobs the transition stream carries.
 */
import { Effect } from "effect"
import type { CommandExecutor } from "@effect/platform"
import { CharacterFs, type CharacterConfig } from "../../../services/CharacterFs.js"
import { CharacterLog, logError, logToConsole } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { renderSkillIndex } from "../../../services/skills-core.js"
import { readCurrentCycleEpisodes } from "../../../logging/episodes.js"
import { runTurn } from "#brain/stem/transport/process-runner.js"
import type { ModelConfig } from "../../../core/model-config.js"
import { resolveModel } from "../../../core/model-config.js"
import { REFLECTION_TURN_TIMEOUT_MS } from "./dream.js"
import {
  aggregateEpisodes,
  renderAggregate,
  renderRawSample,
  renderTransitionDigest,
  parseProposals,
  appendProposals,
} from "./growth-store.js"

/** How many of the cycle's most recent step-end records to sample raw. */
export const RETROSPECT_RAW_SAMPLE_STEPS = 12

export interface RetrospectInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  addDirs?: string[]
  env?: Record<string, string>
  models: ModelConfig
}

export interface RetrospectOutput {
  proposals: number
}

/**
 * The retrospect turn prompt — character-facing, second person, reflective, with
 * a strict JSON output contract the harness parses. `index` is the bodiless
 * skill index; `aggregate` is the compact per-skill digest; `sample` is the
 * bounded raw step sample. All three are computed in code (prompt-budget).
 */
export function buildRetrospectPrompt(parts: {
  index: string
  aggregate: string
  sample: string
  activity: string
}): string {
  return [
    "You have just finished a stretch of work and are looking back on it before you rest.",
    "This is your retrospect: a quiet moment to ask whether your *skills* — the notes-to-self",
    "you keep in me/skills/ — still serve you, and to propose changes for a stronger version",
    "of you to weigh later. You are not changing anything now. You are only proposing.",
    "",
    "## Your skills right now",
    "",
    parts.index,
    "",
    "## How the cycle went (measured from your own episode log)",
    "",
    parts.aggregate,
    "",
    "## A sample of your most recent steps",
    "",
    parts.sample,
    "",
    "## Recent tier transitions and working-memory activity",
    "",
    parts.activity,
    "",
    "## What to do",
    "",
    "Look for skills that are earning their place and skills that are not, and for work you",
    "did well or badly that no skill yet captures. Then propose concrete changes:",
    "",
    "- **create** — a new skill for a recurring kind of work you had no skill for.",
    "- **revise** — a sharper body for an existing skill that let you down or could be better.",
    "- **retire** — drop a skill you never reach for or that keeps steering you wrong.",
    "",
    "Rules:",
    "",
    "- Ground EVERY proposal in what actually happened this cycle. Cite the evidence: the",
    "  step ids (in the c<epoch>-s<tick>-<n> form shown above), the verdicts, the",
    "  tool-failure counts, or the per-skill numbers. The `evidence` field is required —",
    "  a proposal that cites nothing concrete cannot be applied.",
    "- When this cycle completed real steps it almost always taught you something worth",
    "  keeping: aim for 1 to 3 proposals grounded in those steps and the digest above.",
    "  Return an empty list ONLY when the cycle genuinely taught nothing new — never as a",
    "  reflex. Do not invent work that did not happen.",
    "- Quality over volume: at most a handful, and prefer the sharpest one or two.",
    "- For create/revise, write the full proposed skill body (frontmatter is not needed here —",
    "  just the body prose). For retire, no body.",
    "",
    "## Worked example (shape and evidence style only — its scenario is fictional; never",
    "reuse its skill name, step id, or content)",
    "",
    "Suppose a step [c3-s16-1] ended with verdict `failed` after you retried the same failing",
    "command five times in a row without changing anything. A well-formed proposal grounded",
    "in that step:",
    "",
    "```json",
    '{"action": "create", "skill": "example-skill-name", "summary": "Stop and rethink after two identical failures instead of blind retries", "body": "When the same command fails twice with the same error, do not run it a third time unchanged. Stop, read the error, and change your approach — vary the input, pick another tool, or replan. Identical retries burn the step\'s time budget and teach you nothing.", "evidence": "step c3-s16-1 verdict=failed; 5 identical tool retries, all errored"}',
    "```",
    "",
    "Note how `evidence` cites the step id and what actually went wrong there. Yours must do",
    "the same — with your own step ids from the digest above, not the example's.",
    "",
    "## Output",
    "",
    "Respond with exactly one JSON object shaped like this (a code fence is fine, but not required):",
    "",
    "```json",
    '{"proposals": [',
    '  {"action": "create|revise|retire", "skill": "<skill name>", "summary": "<one line: what and why>", "body": "<proposed body for create/revise; omit for retire>", "evidence": "<concrete citation: step ids / verdicts / tool stats>"}',
    "]}",
    "```",
  ].join("\n")
}

/** A turn produced no usable content if it timed out or returned only whitespace. */
const isBlankTurn = (r: { output: string; timedOut: boolean }): boolean =>
  r.timedOut || r.output.trim().length === 0

export const retrospect = {
  name: "retrospect" as const,
  execute: (
    input: RetrospectInput,
  ): Effect.Effect<
    RetrospectOutput,
    never,
    CharacterFs | CharacterLog | CommandExecutor.CommandExecutor | OAuthToken
  > =>
    Effect.gen(function* () {
      const charFs = yield* CharacterFs

      // 1. Read the just-ended cycle's episode streams (before rotation).
      const { tool, transition } = yield* readCurrentCycleEpisodes(input.char.name)
      // Skip gate: a cycle with NO step boundaries (no step-start/step-end) had no
      // step activity to grade. The observed session-start misfire is exactly this
      // shape — setup tool calls / idle tier calls, zero steps — so a cycle that
      // carries tool calls but no step boundary still counts as EMPTY and is
      // skipped, sparing a wasted brain turn. This does NOT re-open the
      // write-only-stream bug (10879c6): a completed step ALWAYS emits a step-end,
      // so any cycle whose real signal lives in its tier/wm outputs (the long step
      // that surfaced a server bug) carries a step boundary and passes the gate. An
      // in-flight step cut off by the boundary keeps its step-start, so it too is
      // graded rather than skipped. The reflection flow is untouched — we just
      // return the no-proposals result without calling the model.
      const hasStepBoundary = transition.some(
        (r) => r.type === "step-start" || r.type === "step-end",
      )
      if (!hasStepBoundary) {
        yield* logToConsole(
          input.char.name,
          "hippocampus",
          "retrospect_skipped: empty cycle (no step-boundary episodes)",
        ).pipe(Effect.catchAll(() => Effect.void))
        return { proposals: 0 }
      }

      // 2. The bodiless skill index the turn grades against (never-fail read).
      const skills = yield* charFs.listSkills(input.char).pipe(Effect.catchAll(() => Effect.succeed([])))
      const index = renderSkillIndex(skills)

      // 3. Bound the prompt IN CODE: compact aggregates + a small raw sample +
      //    a bounded digest of the full-fidelity tier/wm records (parsed outputs
      //    only, count- and char-capped — never the raw prompt blobs).
      const aggregate = renderAggregate(aggregateEpisodes(tool, transition))
      const sample = renderRawSample(transition, RETROSPECT_RAW_SAMPLE_STEPS)
      const activity = renderTransitionDigest(transition)
      const prompt = buildRetrospectPrompt({ index, aggregate, sample, activity })

      // 4. One brain turn (house reflection pattern). A blank/timed-out/errored
      //    turn keeps NOTHING — never-fail, like dream/consolidate.
      const model = resolveModel(input.models, "retrospect", "smart")
      const turn = yield* runTurn({
        containerId: input.containerId,
        playerName: input.playerName,
        char: input.char,
        prompt,
        systemPrompt: "",
        model,
        timeoutMs: REFLECTION_TURN_TIMEOUT_MS,
        role: "brain",
        noTools: true,
        addDirs: input.addDirs,
        env: input.env,
      }).pipe(
        Effect.map((r) =>
          isBlankTurn(r)
            ? { ok: false as const, reason: r.timedOut ? "turn timed out (no output)" : "turn returned empty output" }
            : { ok: true as const, text: r.output },
        ),
        Effect.catchAll((e) => Effect.succeed({ ok: false as const, reason: String(e) })),
      )

      if (!turn.ok) {
        // logError's write can itself fail (LogWriterError); the `never`-error
        // contract below means this stage must never fail on that either —
        // swallow it the same way process-runner's emitBodyExchange does.
        yield* logError(
          input.char.name,
          "hippocampus",
          `retrospect_failed: ${turn.reason} — no proposals this cycle`,
        ).pipe(Effect.catchAll(() => Effect.void))
        return { proposals: 0 }
      }

      // 5. Parse (evidence-required, capped) + append (dedup, total cap). Proposes only.
      const parsed = parseProposals(turn.text, new Date().toISOString())
      const appended = yield* appendProposals(input.char, parsed)
      return { proposals: appended }
    }),
}
