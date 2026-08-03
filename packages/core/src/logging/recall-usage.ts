/**
 * Recall USAGE labels: after the agent has produced its output for a step, how
 * much of each memory that reached its prompt reappears in that output.
 *
 * WHY THIS EXISTS. `logging/recall-telemetry.ts` records everything the scorer
 * DID — the pool, the components, the mood, the stamps, the control arm. It
 * records nothing about whether any of it HELPED. That is precisely the gap that
 * made four offline studies inconclusive: ground truth had to be hand-labelled
 * after the fact, twice, and neither label set could be trusted. This stream is
 * an automatic, per-recall, per-candidate outcome signal emitted at the moment
 * the evidence exists, joined to the recall by `recallId`.
 *
 * ── WHAT THIS MEASURES, AND WHAT IT DOES NOT ────────────────────────────────
 *
 * `metric: "token-containment-v1"` is TEXTUAL OVERLAP. It detects direct
 * quotation and near-quotation. It does NOT detect paraphrase, and it cannot
 * detect influence — a memory can change what the agent decides without a single
 * shared token, and will score 0 here. Every record therefore carries
 * `signal: "textual-overlap-not-usage"`. Treat a high score as "this memory's
 * words are in the output" and nothing more; treat a low score as "no textual
 * evidence", never as "unused".
 *
 * Two confounds that inflate it, neither correctable here:
 *  - Memories are WRITTEN FROM prior agent output (observe/orient/decide/
 *    evaluate text), so a memory of the agent's own earlier phrasing overlaps
 *    with new output partly because the agent repeats itself.
 *  - Within one deliberation the orient recall feeds orient, whose text feeds the
 *    decide query and prompt. A memory returned to BOTH recalls can reach the
 *    decide output transitively.
 *
 * ── The stopword guard, and how to check it ─────────────────────────────────
 *
 * Boilerplate ("the", "to", "a", "it") overlaps between any two English texts.
 * Containment is therefore reported TWICE, over the same token stream:
 * `rawContainment` (every token) and `contentContainment` (stopwords removed).
 * Both, plus the counts they divide, are on every candidate — so the guard's
 * effect is a subtraction an analyst can perform, not a claim they must accept.
 * `STOPWORDS` is exported and its size is stamped on every record, so a later
 * re-analysis can tell which list produced the numbers.
 *
 * N-gram containment over the UNFILTERED stream (ladder `NGRAM_LADDER`) is the
 * quotation evidence: shared bigrams are cheap, shared 8-grams are not. All raw
 * counts are stored, so a later analyst re-thresholds without re-running
 * anything.
 *
 * ── Discipline (same as logging/episodes.ts, logging/recall-telemetry.ts) ────
 *
 * Plain functions returning Effect<void, never, never>; no Effect service, no
 * layer, no addition to the closed `UnifiedEvent` union. This runs on the hot
 * path immediately after a model call, so: the output index is built ONCE per
 * output and shared across candidates, both token streams are hard-capped
 * (`OUTPUT_TOKEN_CAP` / `MEMORY_TOKEN_CAP`, with the truncation recorded), and
 * every failure is swallowed after a console.error. Types stay STRUCTURAL — this
 * module imports nothing from `brain/`.
 */
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import type { CharacterConfig } from "../services/CharacterFs.js"
import { logsDir } from "../services/character-paths.js"
import { captureEpisodeAttribution } from "./episodes.js"

export const RECALL_USAGE_FILE = "recall-usage.jsonl"

/** The metric's name, stamped on every candidate. Bump the suffix if the maths moves. */
export const USAGE_METRIC = "token-containment-v1"

/** Contiguous n-gram widths scored, in ascending order. */
export const NGRAM_LADDER: ReadonlyArray<number> = [2, 3, 5, 8]

/** Hard cap on tokens taken from the agent output; overflow is recorded, not hidden. */
export const OUTPUT_TOKEN_CAP = 4000

/** Hard cap on tokens taken from a memory's text (memories are clipped to 500 chars upstream). */
export const MEMORY_TOKEN_CAP = 400

/** How many recalls per character may await an output before the oldest is dropped. */
export const PENDING_CAP = 16

/** Chars of memory / output text kept verbatim so the metric can be spot-checked. */
export const MEMORY_PREVIEW_CHARS = 160
export const OUTPUT_PREVIEW_CHARS = 400

/**
 * Common English function words. Removed for `contentContainment` ONLY —
 * `rawContainment` and every n-gram are computed over the unfiltered stream, so
 * nothing here can silently swallow signal. Exported (and its size stamped on
 * every record) so a re-analysis knows exactly which list produced the numbers.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but",
  "by", "can", "cannot", "could", "did", "do", "does", "doing", "don", "down", "during",
  "each", "few", "for", "from", "further", "had", "has", "have", "having", "he", "her",
  "here", "hers", "herself", "him", "himself", "his", "how", "i", "if", "in", "into", "is",
  "it", "its", "itself", "just", "me", "more", "most", "my", "myself", "no", "nor", "not",
  "now", "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours",
  "ourselves", "out", "over", "own", "s", "same", "she", "should", "so", "some", "such",
  "t", "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very",
  "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
  "will", "with", "would", "you", "your", "yours", "yourself", "yourselves",
])

// ---- Tokenisation ----------------------------------------------------------

/**
 * Lowercase alphanumeric runs, capped. Punctuation and case are discarded;
 * digits are KEPT (ids, coordinates and counts are the most quotable thing a
 * memory carries). Non-ASCII letters are dropped by the character class — a
 * known limitation, harmless for this corpus and recorded here rather than in a
 * field.
 */
export function tokenize(text: string, cap: number): { tokens: string[]; truncated: boolean } {
  const all = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  if (all.length <= cap) return { tokens: all, truncated: false }
  return { tokens: all.slice(0, cap), truncated: true }
}

/** Unique contiguous n-grams of a token stream, space-joined (tokens are alphanumeric, so a space is unambiguous). */
function ngramSet(tokens: ReadonlyArray<string>, n: number): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + n <= tokens.length; i += 1) out.add(tokens.slice(i, i + n).join(" "))
  return out
}

/**
 * The agent output, indexed once. Built per OUTPUT, not per candidate — the cost
 * of this stream is one pass over the output plus |ladder| passes, regardless of
 * how many memories are scored against it.
 */
export interface OutputIndex {
  readonly chars: number
  readonly tokens: number
  readonly truncated: boolean
  readonly unigrams: ReadonlySet<string>
  readonly ngrams: ReadonlyMap<number, ReadonlySet<string>>
}

export function buildOutputIndex(output: string): OutputIndex {
  const { tokens, truncated } = tokenize(output, OUTPUT_TOKEN_CAP)
  const ngrams = new Map<number, ReadonlySet<string>>()
  for (const n of NGRAM_LADDER) ngrams.set(n, ngramSet(tokens, n))
  return {
    chars: output.length,
    tokens: tokens.length,
    truncated,
    unigrams: new Set(tokens),
    ngrams,
  }
}

// ---- The metric ------------------------------------------------------------

/** Contiguous-phrase evidence at one width. */
export interface NgramOverlap {
  readonly n: number
  /** Unique n-grams in the memory. 0 when the memory is shorter than n. */
  readonly memoryNgrams: number
  /** How many of them occur in the output. */
  readonly matched: number
  /** `matched / memoryNgrams`; null when the memory has no n-grams at that width. */
  readonly containment: number | null
}

/**
 * Everything the metric computed, raw. The two containments are the SAME
 * quantity over the same stream with and without the stopword guard, so their
 * difference is the guard's measured effect on this pair.
 */
export interface RecallUsageOverlap {
  readonly metric: string
  readonly memoryChars: number
  /** Tokens in the memory (post-cap). */
  readonly memoryTokens: number
  readonly memoryTruncated: boolean
  /** Unique tokens, guard OFF. */
  readonly uniqueTokens: number
  /** Unique tokens, guard ON (stopwords removed). */
  readonly contentTokens: number
  /** Unique tokens the guard removed (`uniqueTokens − contentTokens`). */
  readonly stopwordTokens: number
  /** Unique tokens present in the output, guard OFF. */
  readonly rawMatched: number
  /** `rawMatched / uniqueTokens`; null for a memory with no tokens. */
  readonly rawContainment: number | null
  /** Unique tokens present in the output, guard ON. */
  readonly contentMatched: number
  /** `contentMatched / contentTokens`; null when the memory is ALL stopwords. */
  readonly contentContainment: number | null
  readonly ngrams: ReadonlyArray<NgramOverlap>
  /** Widest ladder rung with any match (1 if only unigrams matched, 0 if nothing did). */
  readonly longestMatchedNgram: number
}

/**
 * Overlap of one memory against a pre-built output index. Pure; never throws.
 * Cost is O(memory tokens × |NGRAM_LADDER|) with set lookups only.
 */
export function overlap(memoryText: string, index: OutputIndex): RecallUsageOverlap {
  const { tokens, truncated } = tokenize(memoryText, MEMORY_TOKEN_CAP)
  const unique = new Set(tokens)
  let contentTokens = 0
  let contentMatched = 0
  let rawMatched = 0
  for (const t of unique) {
    const hit = index.unigrams.has(t)
    if (hit) rawMatched += 1
    if (!STOPWORDS.has(t)) {
      contentTokens += 1
      if (hit) contentMatched += 1
    }
  }
  const ngrams: NgramOverlap[] = []
  let longest = rawMatched > 0 ? 1 : 0
  for (const n of NGRAM_LADDER) {
    const mine = ngramSet(tokens, n)
    const theirs = index.ngrams.get(n)
    let matched = 0
    if (theirs) for (const g of mine) if (theirs.has(g)) matched += 1
    ngrams.push({
      n,
      memoryNgrams: mine.size,
      matched,
      containment: mine.size === 0 ? null : matched / mine.size,
    })
    if (matched > 0 && n > longest) longest = n
  }
  return {
    metric: USAGE_METRIC,
    memoryChars: memoryText.length,
    memoryTokens: tokens.length,
    memoryTruncated: truncated,
    uniqueTokens: unique.size,
    contentTokens,
    stopwordTokens: unique.size - contentTokens,
    rawMatched,
    rawContainment: unique.size === 0 ? null : rawMatched / unique.size,
    contentMatched,
    contentContainment: contentTokens === 0 ? null : contentMatched / contentTokens,
    ngrams,
    longestMatchedNgram: longest,
  }
}

// ---- The pending-recall registry -------------------------------------------

/** One memory that actually reached the prompt, held until the output exists. */
export interface PendingRecallCandidate {
  readonly id: number
  /** 1-based rank in the post-injection pool. */
  readonly rank: number
  /** `"random"` iff randomised injection put it there — the control arm. */
  readonly injection: "ranked" | "random"
  readonly text: string
  /**
   * Did this memory's WHOLE rendered line survive `formatRecall`'s `maxChars`
   * cut? The orient site recalls k=2 at maxChars=300, so the tail memory is
   * routinely clipped mid-line — its overlap is then being scored against text
   * the model never fully saw. False ⇒ read that candidate's numbers as a lower
   * bound, or filter it out.
   */
  readonly promptLineIntact: boolean
}

/**
 * A recall awaiting its output. Held in memory only: the text of a returned
 * memory is not on the recall telemetry record (which stores ids and scores), so
 * it has to survive here from recall to output.
 */
export interface PendingRecall {
  readonly recallId: string
  readonly site: string
  readonly label: string
  readonly k: number
  readonly poolSize: number
  readonly tick: number | null
  readonly stepId: string | null
  readonly epoch: string | null
  readonly candidates: ReadonlyArray<PendingRecallCandidate>
}

const pending = new Map<string, PendingRecall[]>()

/**
 * Hold a recall's returned candidates until the agent's output lands.
 *
 * Bounded per character (`PENDING_CAP`, oldest evicted). In the normal flow each
 * recall is consumed by the very next model call, so the queue holds one entry;
 * the cap exists so a call site that recalls without ever recording usage leaks
 * a bounded amount rather than the run.
 */
export function registerRecallForUsage(characterName: string, recall: PendingRecall): void {
  let q = pending.get(characterName)
  if (!q) {
    q = []
    pending.set(characterName, q)
  }
  q.push(recall)
  while (q.length > PENDING_CAP) q.shift()
}

/** Remove and return a held recall, or null if it was never held / already consumed. */
export function takePendingRecall(characterName: string, recallId: string): PendingRecall | null {
  const q = pending.get(characterName)
  if (!q) return null
  const i = q.findIndex((r) => r.recallId === recallId)
  if (i < 0) return null
  return q.splice(i, 1)[0]
}

/** Test seam: drop every held recall. */
export function resetPendingRecalls(): void {
  pending.clear()
}

// ---- The record ------------------------------------------------------------

/** One returned memory's outcome. Raw quantities; deliberately NO verdict field. */
export interface RecallUsageCandidate extends RecallUsageOverlap {
  readonly memoryId: number
  readonly rank: number
  /**
   * `"random"` marks the injected control candidate. It is scored EXACTLY like
   * every ranked candidate — excluding it would destroy the control arm — and
   * flagged so an analyst can split treatment from control.
   */
  readonly injection: "ranked" | "random"
  /** False ⇒ `maxChars` clipped this memory's line; its overlap is a lower bound. */
  readonly promptLineIntact: boolean
  /** First `MEMORY_PREVIEW_CHARS` of the memory, so the numbers can be eyeballed. */
  readonly textPreview: string
}

export interface RecallUsageRecord {
  readonly type: "recall-usage"
  /** Host-clock ISO timestamp of the write. */
  readonly ts: string
  readonly character: string
  /** THE JOIN KEY: the `recallId` of the recall telemetry record these memories came from. */
  readonly recallId: string
  /** Which harness call site recalled them (orient | decide | evaluate). */
  readonly site: string
  readonly label: string
  /** Attribution of the RECALL (matches the recall telemetry record). */
  readonly tick: number | null
  readonly stepId: string | null
  readonly epoch: string | null
  /** Attribution at the moment the output landed — may differ if the tick advanced. */
  readonly outputTick: number | null
  readonly outputStepId: string | null
  /** Which model output was scored (the tier whose prompt carried this recall). */
  readonly outputKind: string
  readonly outputChars: number
  readonly outputTokens: number
  readonly outputTruncated: boolean
  readonly outputPreview: string
  /** Read this before reading any number below. */
  readonly signal: "textual-overlap-not-usage"
  readonly metric: string
  /** Which stopword list produced `contentContainment`. */
  readonly stopwordListSize: number
  readonly ngramLadder: ReadonlyArray<number>
  readonly k: number
  readonly poolSize: number
  readonly candidates: ReadonlyArray<RecallUsageCandidate>
}

/** What the caller knows at output time. */
export interface RecallUsageInput {
  /** The tier whose output this is — `"orient" | "decide" | "evaluate"` in practice. */
  readonly outputKind: string
  /** The agent's natural-language output for the step this recall fed. */
  readonly output: string
}

/**
 * Build the record for a held recall + an output. Pure apart from the host clock
 * and the episode-attribution stamp; exported so a test can assert the shape
 * without touching the filesystem.
 */
export function buildUsageRecord(
  characterName: string,
  recall: PendingRecall,
  input: RecallUsageInput,
  now: () => string = () => new Date().toISOString(),
): RecallUsageRecord {
  const index = buildOutputIndex(input.output)
  const attribution = captureEpisodeAttribution(characterName)
  return {
    type: "recall-usage",
    ts: now(),
    character: characterName,
    recallId: recall.recallId,
    site: recall.site,
    label: recall.label,
    tick: recall.tick,
    stepId: recall.stepId,
    epoch: recall.epoch,
    outputTick: attribution.tick,
    outputStepId: attribution.stepId,
    outputKind: input.outputKind,
    outputChars: index.chars,
    outputTokens: index.tokens,
    outputTruncated: index.truncated,
    outputPreview: input.output.slice(0, OUTPUT_PREVIEW_CHARS),
    signal: "textual-overlap-not-usage",
    metric: USAGE_METRIC,
    stopwordListSize: STOPWORDS.size,
    ngramLadder: NGRAM_LADDER,
    k: recall.k,
    poolSize: recall.poolSize,
    candidates: recall.candidates.map((c) => ({
      memoryId: c.id,
      rank: c.rank,
      injection: c.injection,
      promptLineIntact: c.promptLineIntact,
      textPreview: c.text.slice(0, MEMORY_PREVIEW_CHARS),
      ...overlap(c.text, index),
    })),
  }
}

/**
 * Score a held recall against the output it fed and append one record. NEVER
 * FAILS and never throws into the caller — tokenisation, path derivation,
 * serialization and IO all sit inside the swallowed promise.
 *
 * A `recallId` of null means the recall returned nothing (no query, no hits), so
 * there is nothing to score: a silent no-op. A non-null id with no held recall is
 * an ANOMALY — the usage signal for that recall is lost — and is reported to the
 * console rather than swallowed silently.
 */
export const recordRecallUsage = (
  char: CharacterConfig,
  recallId: string | null,
  input: RecallUsageInput,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      if (recallId === null) return
      const recall = takePendingRecall(char.name, recallId)
      if (!recall) {
        console.error(`[recall-usage] no held recall for ${char.name}/${recallId}; usage lost`)
        return
      }
      if (recall.candidates.length === 0) return
      const dir = logsDir(char)
      const line = `${JSON.stringify(buildUsageRecord(char.name, recall, input))}\n`
      await fsp.mkdir(dir, { recursive: true })
      await fsp.appendFile(path.join(dir, RECALL_USAGE_FILE), line, "utf8")
    },
    catch: (e) => e,
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => console.error(`[recall-usage] append failed for ${char?.name}: ${e}`)),
    ),
  )
