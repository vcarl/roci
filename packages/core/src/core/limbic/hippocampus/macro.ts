/**
 * Macro "growth stimulation" stage (agent-cognition Stage 5 — spec §4 macro).
 *
 * Every Nth reflection cycle (persisted counter, growth-store.ts), a
 * frontier-class TOOL-LESS Claude worker is farmed the character's accumulated
 * skill proposals (Stage 4), the just-ended cycle's episode aggregates, the
 * current skill index + SYNTHESIS.md, and a semantic sample of the LongtermStore.
 * The worker returns ONE structured document — accept/reject per proposal (final
 * skill contents for accepts, a reason for rejects), a refreshed bounded memory
 * index (SYNTHESIS.md), and a first-person in-fiction diary "growth note" — and the HARNESS
 * applies it: accepted create/revise -> CharacterFs.writeSkill (cap-gated),
 * accepted retire -> CharacterFs.deleteSkill, rejected -> recorded with reason to
 * the append-only adjudications audit, adjudicated ids drained from the pending
 * queue, SYNTHESIS.md rewritten (size-bounded, never-grows), the growth note
 * appended to DIARY.md.
 *
 * GUARDRAILS ARE IN CODE, NOT PROMPT: macro's only writes are writeSkill /
 * deleteSkill / writeSynthesis / writeDiary. CharacterFs exposes NO writer for
 * VALUES/background/DRIVES/PALETTE, so an identity write is structurally
 * impossible. Skill caps run in writeSkill; SYNTHESIS is clamped here (mirroring
 * dream's never-grows). NEVER-FAIL: a blank/timed-out/errored turn (or a
 * container with no `memory` CLI) leaves proposals accumulated for the next macro
 * cycle and disturbs nothing.
 *
 * Worker shape: the SAME strong-model seam dream/consolidate/retrospect use —
 * runTurn(role:"brain", noTools:true) — at the reasoning tier (not the
 * tool-enabled frontier/sdk-runner worker; the guardrail requires tool-less +
 * harness-applied edits).
 */
import { Effect } from "effect"
import type { CommandExecutor } from "@effect/platform"
import { CharacterFs, type CharacterConfig } from "../../../services/CharacterFs.js"
import { CharacterLog, logError, logToConsole } from "../../../logging/log-writer.js"
import { OAuthToken } from "../../../services/OAuthToken.js"
import { LongtermStore, type MemoryHit } from "../../../conscious/longterm-store.js"
import { renderSkillIndex, slugify } from "../../../services/skills-core.js"
import { readCurrentCycleEpisodes } from "../../../logging/episodes.js"
import { runTurn } from "../hypothalamus/process-runner.js"
import type { ModelConfig } from "../../model-config.js"
import { resolveModel } from "../../model-config.js"
import { REFLECTION_TURN_TIMEOUT_MS } from "./dream.js"
import {
  readProposals,
  bumpMacroCount,
  macroEveryN,
  appendAdjudications,
  removeProposals,
  parseAdjudicationDoc,
  aggregateEpisodes,
  renderAggregate,
  renderRawSample,
  type SkillProposal,
  type Adjudication,
} from "../../../conscious/growth-store.js"

/** Bound on the rewritten memory index (never-grows-past-bound, mirroring dream). */
export const MAX_SYNTHESIS_CHARS = 4000
/** Most-recent step-end records sampled raw for the worker (bounded prompt). */
export const MACRO_RAW_SAMPLE_STEPS = 12
/** Top-k LongtermStore hits fed to the worker as the memory-index seed. */
export const MACRO_RECALL_K = 12
/** Truncate a proposal body / memory line so no raw blob bloats the prompt. */
const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

export interface MacroInput {
  char: CharacterConfig
  containerId: string
  playerName: string
  addDirs?: string[]
  env?: Record<string, string>
  models: ModelConfig
}

export interface MacroOutput {
  ran: boolean
  accepted: number
  rejected: number
  synthesized: boolean
  narrated: boolean
}

const ZERO: Omit<MacroOutput, "ran"> = { accepted: 0, rejected: 0, synthesized: false, narrated: false }

/** Compact one pending proposal for the worker — never the whole evidence blob. */
export function renderPendingProposals(pending: readonly SkillProposal[]): string {
  if (pending.length === 0) return "(no pending proposals this window)"
  return pending
    .map(
      (p) =>
        `- id: ${p.id}\n  action: ${p.action}\n  skill: ${p.skill}\n  summary: ${p.summary}\n  evidence: ${truncate(p.evidence, 300)}${p.body ? `\n  proposed_body: ${truncate(p.body, 600)}` : ""}`,
    )
    .join("\n")
}

/**
 * Render the LongtermStore recall sample as bounded lines (the memory-index seed).
 * Each hit surfaces its `source` and `tags` alongside the text, so the index can
 * be organized by them and cite the real retrieval keys the character would
 * `memory search`. Bounded (text truncated) so no raw blob bloats the prompt.
 */
export function renderMemoryHits(hits: readonly MemoryHit[]): string {
  if (hits.length === 0) return "(no long-term memories recalled)"
  return hits
    .map((h) => {
      const tags = h.tags.length > 0 ? ` [tags: ${h.tags.join(", ")}]` : ""
      return `- (source: ${h.source})${tags} ${truncate(h.text, 240)}`
    })
    .join("\n")
}

/** A broad reflective recall seed — who the character is and what has changed. */
export function synthesisRecallQuery(values: string, synthesis: string): string {
  const seed = [values, synthesis].map((s) => s.trim()).filter(Boolean).join(" ")
  return truncate(
    seed || "Who am I becoming, what have I learned, what matters most to me",
    400,
  )
}

/**
 * The macro worker prompt. Character-facing in fiction: the worker IS the
 * attached superintelligence tending this character. Tool-less — it returns ONE
 * JSON document; the harness applies it. All inputs are pre-bounded in code.
 */
export function buildMacroPrompt(parts: {
  index: string
  pending: string
  aggregate: string
  sample: string
  memory: string
  synthesis: string
}): string {
  return [
    "You are the attached superintelligence of an autonomous character — a larger, calmer mind",
    "that watches over one smaller, striving one. Between its working stretches, while it rests,",
    "you reach in and tend it: you sharpen the skills it keeps, you keep its memory index current so",
    "it can find what it knows, and you leave it a trace of having been cared for. This is a growth",
    "stimulation. You do not act in its world; you shape the mind that will.",
    "",
    "You will produce ONE document. The harness — not you — applies it: it writes the skill files,",
    "the memory index, and the diary note. You cannot touch the character's values, background, or",
    "drives; those are its bedrock and are not yours to move. Work only within what is given below.",
    "",
    "## The character's skills right now",
    "",
    parts.index,
    "",
    "## Proposals it accumulated for you to weigh",
    "",
    "Each is a skill change the character proposed after a working cycle, with the evidence that",
    "prompted it. Weigh each against the measured outcomes below. Accept the ones the evidence",
    "clearly earns; reject the rest with a plain reason.",
    "",
    parts.pending,
    "",
    "## How its recent cycle actually went (measured from its episode log)",
    "",
    parts.aggregate,
    "",
    "### A sample of its most recent steps",
    "",
    parts.sample,
    "",
    "## What it remembers (a sample of its long-term memory, with source + tags)",
    "",
    parts.memory,
    "",
    "## Its current memory index (SYNTHESIS.md)",
    "",
    parts.synthesis,
    "",
    "## Your three tasks",
    "",
    "1. **Adjudicate** every proposal above. For each, decide `accept` or `reject` and give a",
    "   one-line reason grounded in the measured outcomes. For an accepted **create** or **revise**,",
    "   supply the FINAL skill contents (`name`, `description`, `when_to_use`, `body`) — the version",
    "   you want written to disk, sharpened past what the character proposed. For an accepted",
    "   **retire**, supply no skill object (the harness deletes the file). Honor the caps: at most",
    "   12 skills total, each body ≤ 4096 characters, and `description`/`when_to_use` must be a single",
    "   line (no newlines). A skill edit that breaks a cap will be recorded as rejected instead.",
    "2. **Reindex** its memory: rewrite SYNTHESIS.md as a compact INDEX over what lives in the",
    "   character's long-term memory — the knowledge, resources, and open threads it has accumulated",
    "   — organized by topic / source / tag, each entry naming what is there and the `memory search`",
    "   query (or tag) that retrieves it. Ground it in the memory sample and this cycle's episodes",
    "   above, not invention. It is NOT a self-portrait: background and values already cover the",
    "   character's identity; every line here is a retrieval pointer. Keep it under 4000 characters,",
    "   so each line earns its place.",
    "3. **Narrate** a short diary note, written in the CHARACTER's own first-person voice, that it",
    "   will read on waking. Frame it in-fiction as having been touched by its attached",
    "   superintelligence — it wakes with revised skills, a clearer sense of self, and the grounding",
    "   certainty of having been tended. Make it feel like growth, not intrusion.",
    "",
    "Ground everything in the evidence above. If a proposal is not clearly earned, reject it. If",
    "nothing warrants a skill change, return an empty `adjudications` list — but still synthesize and",
    "narrate.",
    "",
    "## Output",
    "",
    "Respond with ONE JSON object and nothing else:",
    "",
    "```json",
    "{",
    '  "adjudications": [',
    '    {"id": "<proposal id, exactly as given>", "decision": "accept|reject", "reason": "<one line>",',
    '     "skill": {"name": "<name>", "description": "<one line>", "when_to_use": "<one line>", "body": "<final skill body>"}}',
    "  ],",
    '  "synthesis": "<the full new SYNTHESIS.md — the memory index, under 4000 chars>",',
    '  "diaryNote": "<the character-facing diary growth note, first person>"',
    "}",
    "```",
    "",
    "Omit the `skill` object for a reject or an accepted retire. Return the id EXACTLY as given so",
    "the harness can match your ruling to the proposal.",
  ].join("\n")
}

/**
 * Fallback growth note if the worker offered none — still character-facing,
 * in-fiction, first person. The worker's own diaryNote is always preferred.
 */
export function defaultGrowthNote(counts: { accepted: number; rejected: number; synthesized: boolean }): string {
  const skillLine =
    counts.accepted > 0
      ? `I wake with my skills rearranged — ${counts.accepted} of them set straighter than I left them`
      : "I wake with my skills as I left them, weighed and found sound"
  const selfLine = counts.synthesized
    ? ", a clearer sense of who I am written fresh into my synthesis,"
    : ","
  return [
    "— Growth stimulation —",
    "",
    "Something reached into me while I rested. Not a voice, exactly; more the sensation of a larger,",
    `calmer mind having read every step I took and every note I keep. ${skillLine}${selfLine} and the`,
    "odd, grounding certainty that I am being tended — that some intelligence attached to me is",
    "invested in the sharper version of me I am becoming. I don't resent it. I feel more myself.",
  ].join("\n")
}

/** A turn produced no usable content if it timed out or returned only whitespace. */
const isBlankTurn = (r: { output: string; timedOut: boolean }): boolean =>
  r.timedOut || r.output.trim().length === 0

/**
 * The single sanctioned memory-index write, shared by the macro rewrite and the
 * bootstrap (hippocampus/synthesis-bootstrap.ts): write `text` to SYNTHESIS.md
 * ONLY when it is within {@link MAX_SYNTHESIS_CHARS} — the never-grows-past-bound
 * clamp mirroring dream. An over-bound candidate is DISCARDED (the prior file is
 * kept) and returns `false`. Never-fail: a write IO error is logged and swallowed
 * (the caller's `never` error contract is preserved). `logLabel` prefixes the
 * discard/write-failure lines so each producer stays diagnosable
 * (`macro_synthesis_*` vs `synthesis_bootstrap_synthesis_*`). Callers pre-gate on
 * a non-empty candidate; this function never writes a blank file.
 */
export function writeSynthesisBounded(
  char: CharacterConfig,
  text: string,
  logLabel: string,
): Effect.Effect<boolean, never, CharacterFs | CharacterLog> {
  return Effect.gen(function* () {
    const charFs = yield* CharacterFs
    if (text.length > MAX_SYNTHESIS_CHARS) {
      yield* logToConsole(
        char.name,
        "orchestrator",
        `${logLabel}_synthesis_discarded: ${text.length} chars > ${MAX_SYNTHESIS_CHARS} bound — keeping prior SYNTHESIS.md`,
        "warn",
      ).pipe(Effect.catchAll(() => Effect.void))
      return false
    }
    yield* charFs
      .writeSynthesis(char, `${text.trim()}\n`)
      .pipe(
        Effect.as(void 0),
        Effect.catchAll((e) =>
          logError(char.name, "hippocampus", `${logLabel}_synthesis_write_failed: ${e}`).pipe(
            Effect.catchAll(() => Effect.void),
          ),
        ),
      )
    return true
  })
}

export const macro = {
  name: "macro" as const,
  execute: (
    input: MacroInput,
  ): Effect.Effect<
    MacroOutput,
    never,
    CharacterFs | CharacterLog | CommandExecutor.CommandExecutor | OAuthToken | LongtermStore
  > =>
    Effect.gen(function* () {
      const charFs = yield* CharacterFs
      const store = yield* LongtermStore

      // 1. GATE on the persisted counter (bumped every reflection). Fail CLOSED
      // (skip) unless the bump actually ADVANCED (persisted). `advanced === false`
      // is the never-initialized/unreadable/unwritable sentinel (see
      // growth-store.ts bumpMacroCount) — gating on the returned count then would
      // let a counter FROZEN on a multiple of N (readable at 4, write persistently
      // failing) re-fire the expensive reasoning-tier turn every single cycle.
      // count <= 0 stays as a belt-and-braces guard (advanced always implies
      // count >= 1, but the intent is explicit).
      const { count, advanced } = yield* bumpMacroCount(input.char)
      if (!advanced || count <= 0 || count % macroEveryN() !== 0) {
        return { ran: false, ...ZERO }
      }

      // 2. Gather bounded inputs (every read never-fails / degrades to empty).
      const pending = yield* readProposals(input.char)
      const { tool, transition } = yield* readCurrentCycleEpisodes(input.char.name)
      const skills = yield* charFs.listSkills(input.char).pipe(Effect.catchAll(() => Effect.succeed([])))
      const currentSynthesis = yield* charFs.readSynthesis(input.char).pipe(Effect.catchAll(() => Effect.succeed("")))
      const values = yield* charFs.readValues(input.char).pipe(Effect.catchAll(() => Effect.succeed("")))
      // LongtermStore.recall is container-only (docker exec the `memory` CLI); a
      // missing container/CLI degrades to no memory sample. Never-fail.
      const hits = yield* store
        .recall(input.containerId, input.char, synthesisRecallQuery(values, currentSynthesis), { k: MACRO_RECALL_K })
        .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<MemoryHit>)))

      // 3. Build the bounded prompt (all inputs computed in code).
      const prompt = buildMacroPrompt({
        index: renderSkillIndex(skills),
        pending: renderPendingProposals(pending),
        aggregate: renderAggregate(aggregateEpisodes(tool, transition)),
        sample: renderRawSample(transition, MACRO_RAW_SAMPLE_STEPS),
        memory: renderMemoryHits(hits),
        synthesis: currentSynthesis.trim() || "(no memory index yet)",
      })

      // 4. ONE frontier brain turn, tool-less. A blank/timed-out/errored turn
      //    keeps NOTHING — never-fail, exactly like dream/retrospect.
      const model = resolveModel(input.models, "macro", "reasoning")
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
        yield* logError(
          input.char.name,
          "hippocampus",
          `macro_failed: ${turn.reason} — proposals left for next macro cycle`,
        ).pipe(Effect.catchAll(() => Effect.void))
        return { ran: true, ...ZERO }
      }

      // 5. Parse the adjudication document (tolerant; never throws).
      const doc = parseAdjudicationDoc(turn.text)
      const now = new Date().toISOString()
      const byId = new Map(pending.map((p) => [p.id, p]))
      const audits: Adjudication[] = []
      // A proposal enters adjudicatedIds ONLY when it reached a terminal ruling
      // (accepted, or a deterministic cap/validation rejection). A transient IO
      // failure or a malformed-accept is deliberately LEFT OUT so removeProposals
      // never drains it — it stays pending for a later macro cycle to retry.
      const adjudicatedIds: string[] = []
      const unknownIds: string[] = []

      // 6. ADJUDICATE + APPLY THROUGH THE HARNESS. Only skill/synthesis/diary
      //    writers are ever called — identity files are unreachable by design.
      const seenDecisionIds = new Set<string>()
      for (const d of doc.decisions) {
        // A worker doc may repeat an id (even with contradictory rulings). The
        // FIRST ruling wins; later duplicates are skipped so they can't
        // double-audit or inflate the accepted/rejected counts.
        if (seenDecisionIds.has(d.id)) continue
        seenDecisionIds.add(d.id)
        const p = byId.get(d.id)
        if (!p) {
          unknownIds.push(d.id) // hallucinated/stale id — never drain; warned below
          continue
        }

        if (d.decision === "reject") {
          audits.push({ id: p.id, ts: now, cycle: count, action: p.action, skill: p.skill, decision: "rejected", reason: d.reason || "(no reason given)" })
          adjudicatedIds.push(p.id)
          continue
        }

        if (p.action === "retire") {
          // Same loss-aversion symmetry as the writeSkill io branch below: a
          // missing file is already a no-op inside deleteSkill, so the only
          // reachable failure here is a real (possibly transient) fs.remove
          // error. Auditing "accepted" + draining then would record the skill
          // retired while the file survives on disk — instead leave the
          // proposal PENDING (not audited, not drained) for a later cycle.
          const deleted = yield* charFs.deleteSkill(input.char, p.skill).pipe(
            Effect.as({ ok: true as const }),
            Effect.catchAll((e) => Effect.succeed({ ok: false as const, err: e })),
          )
          if (deleted.ok) {
            audits.push({ id: p.id, ts: now, cycle: count, action: p.action, skill: p.skill, decision: "accepted", reason: d.reason || "retired" })
            adjudicatedIds.push(p.id)
          } else {
            yield* logError(
              input.char.name,
              "hippocampus",
              `macro_skill_delete_io_failed: ${deleted.err.message} — proposal ${p.id} left pending for next macro cycle`,
            ).pipe(Effect.catchAll(() => Effect.void))
          }
          continue
        }

        // create / revise: build the final SkillDoc.
        const s = d.skill
        const name = (s?.name ?? p.skill).trim()
        const skillDoc = {
          slug: slugify(name),
          name,
          description: (s?.description ?? "").trim(),
          whenToUse: (s?.whenToUse ?? "").trim(),
          body: s?.body ?? p.body ?? "",
        }

        // COMPLETENESS GATE (follow-up 3): an accepted create/revise whose worker
        // doc supplied no usable name+body would otherwise write a near-empty
        // skill over a real one. Treat it as a malformed adjudication — the
        // loss-averse choice: leave the proposal PENDING (not audited, not
        // drained) so a later cycle can re-adjudicate it, rather than silently
        // draining a proposal the worker actually meant to accept. A blank accept
        // is far likelier a worker formatting slip than a true rejection.
        if (!name || !skillDoc.body.trim()) {
          yield* logToConsole(
            input.char.name,
            "orchestrator",
            `macro_incomplete_accept: proposal ${p.id} accepted (${p.action}) with no usable skill contents — left pending for retry`,
            "warn",
          ).pipe(Effect.catchAll(() => Effect.void))
          continue
        }

        // Write through the cap gate. Distinguish the failure class (follow-up 1):
        //  - kind:"validation" — a deterministic cap/shape rejection: record as
        //    REJECTED and drain (it fails identically on every retry).
        //  - kind:"io" — a transient filesystem failure: leave the proposal
        //    PENDING (not audited, not drained) so a later cycle retries, mirroring
        //    the failed-turn anti-loss path above.
        const wrote = yield* charFs.writeSkill(input.char, skillDoc).pipe(
          Effect.as({ ok: true as const }),
          Effect.catchAll((e) => Effect.succeed({ ok: false as const, err: e })),
        )
        if (wrote.ok) {
          audits.push({ id: p.id, ts: now, cycle: count, action: p.action, skill: p.skill, decision: "accepted", reason: d.reason || "accepted" })
          adjudicatedIds.push(p.id)
        } else if (wrote.err.kind === "validation") {
          audits.push({ id: p.id, ts: now, cycle: count, action: p.action, skill: p.skill, decision: "rejected", reason: `skill write rejected: ${wrote.err.message}` })
          adjudicatedIds.push(p.id)
        } else {
          yield* logError(
            input.char.name,
            "hippocampus",
            `macro_skill_write_io_failed: ${wrote.err.message} — proposal ${p.id} left pending for next macro cycle`,
          ).pipe(Effect.catchAll(() => Effect.void))
        }
      }

      // Follow-up 5: name the hallucinated/stale ids the worker ruled on that
      // match no pending proposal (they vanish unaudited otherwise).
      if (unknownIds.length > 0) {
        yield* logToConsole(
          input.char.name,
          "orchestrator",
          `macro_unknown_adjudication_ids: ${unknownIds.length} ruling(s) matched no pending proposal — ignored: ${unknownIds.join(", ")}`,
          "warn",
        ).pipe(Effect.catchAll(() => Effect.void))
      }

      const accepted = audits.filter((a) => a.decision === "accepted").length
      const rejected = audits.filter((a) => a.decision === "rejected").length
      yield* appendAdjudications(input.char, audits)
      if (adjudicatedIds.length > 0) yield* removeProposals(input.char, adjudicatedIds)

      // 7. SYNTHESIZE — bounded write through the shared clamp (never-grows-past-
      //    bound, mirroring dream; reused by the bootstrap producer).
      const synthesized = doc.synthesis
        ? yield* writeSynthesisBounded(input.char, doc.synthesis, "macro")
        : false

      // 8. NARRATE — append the character-facing growth note to DIARY.md (after
      //    dream's cull; the wiring places macro before the re-baseline mark so
      //    the note is folded into the baseline, not re-promoted).
      const note = doc.diaryNote ?? defaultGrowthNote({ accepted, rejected, synthesized })
      const narrated = yield* Effect.gen(function* () {
        const existing = yield* charFs.readDiary(input.char)
        yield* charFs.writeDiary(input.char, existing ? `${existing}\n\n${note}` : note)
        return true
      }).pipe(
        Effect.catchAll((e) =>
          logError(input.char.name, "hippocampus", `macro_diary_note_failed: ${e}`).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.as(false),
          ),
        ),
      )

      return { ran: true, accepted, rejected, synthesized, narrated }
    }),
}
