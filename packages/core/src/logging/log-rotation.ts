/**
 * Size-based segment rotation for the append-only research streams
 * (`recall-telemetry.jsonl`, `recall-usage.jsonl`).
 *
 * WHY THIS EXISTS. Those two streams were shipped deliberately unrotated —
 * silently discarding a research stream mid-study is worse than a large file,
 * and four consecutive instrumentation tasks flagged the growth rather than
 * truncating it. But the records have grown: the per-candidate stage vectors
 * alone measured ~409 B, which at 8 axes and a decide/evaluate pool reaches
 * roughly 16 KB per record, plus lineage. A long QA run produces a single file
 * no ordinary tool will open.
 *
 * ── THE RULE: NOTHING IS EVER DELETED ────────────────────────────────────────
 *
 * There is no retention policy, no segment cap and no truncation anywhere in
 * this module. Rotation RENAMES the active file to the next free segment number
 * and starts a fresh one. Segment numbers increase forever. If disk fills, that
 * is a fact for an operator to act on, not something this module resolves by
 * throwing away data a study was collecting.
 *
 * ── THE SCHEME ───────────────────────────────────────────────────────────────
 *
 *   recall-telemetry.jsonl          ← the ACTIVE file, always this name
 *   recall-telemetry.00001.jsonl    ← the oldest closed segment
 *   recall-telemetry.00002.jsonl
 *   …
 *
 * Zero-padded to five digits so lexical order (`ls`, a glob, `cat *.jsonl`) is
 * chronological order for the first 99 999 segments; past that the numbers keep
 * counting and only the padding stops being uniform.
 *
 * ── THE SEAM MUST BE OBVIOUS ─────────────────────────────────────────────────
 *
 * An analyst concatenating segments must not be able to MISS one, so every
 * rotation writes two marker lines that name each other:
 *
 *   …last real record…
 *   {"type":"log-segment","event":"close","segment":1,"next":{"segment":2,…},…}
 *   ── file boundary ──
 *   {"type":"log-segment","event":"open","segment":2,"previous":{"segment":1,…},…}
 *   …first real record…
 *
 * Concatenated in order, every `close` is immediately followed by the `open`
 * that names it. A missing segment shows up as a `close` whose `next.segment`
 * does not match the following `open`'s `segment` — a check a reader can run in
 * one pass without knowing how many segments there should have been. The
 * close marker also carries `bytes`, the final on-disk size of the segment it
 * closes, so a truncated or partially-copied segment is detectable against
 * `wc -c` alone.
 *
 * Markers carry `type: "log-segment"`, the same discriminator every record in
 * these streams already carries (`recall`, `recall-usage`), so a consumer that
 * filters on `type` is unaffected and one that does not gets a loud, typed,
 * self-describing line rather than a silent gap. A stream that has never
 * rotated contains no markers at all.
 *
 * ── Discipline ───────────────────────────────────────────────────────────────
 *
 * Plain async functions over `node:fs/promises` — no Effect service, no layer
 * (the callers are `logging/recall-telemetry.ts` and `logging/recall-usage.ts`,
 * both of which already swallow every failure into a console.error). A rotation
 * that fails does NOT fail the append: the line still lands in the oversized
 * active file, because a lost record is worse than a large one.
 *
 * Size is tracked in memory — one `stat` per file per process, then a running
 * byte count — so the hot path adds no syscall beyond the append itself.
 * Appends to one path are serialised through a promise chain, so a rotation can
 * never interleave with a concurrent append from another fiber.
 */
import * as fsp from "node:fs/promises"
import * as path from "node:path"

/** The `type` discriminator on both marker lines. */
export const SEGMENT_MARKER_TYPE = "log-segment"

/** Default rotation threshold: 64 MiB. Large enough to be rare, small enough to open. */
export const DEFAULT_ROTATE_BYTES = 64 * 1024 * 1024

/** Env override for the threshold, in bytes. `0` or negative disables rotation. */
export const ROTATE_BYTES_ENV = "ROCI_LOG_ROTATE_BYTES"

/** Digits a segment number is zero-padded to, so lexical order is chronological. */
export const SEGMENT_DIGITS = 5

/**
 * Resolve the threshold. A malformed value falls back to the default rather
 * than disabling rotation by accident; an explicit `0` disables it on purpose.
 */
export function resolveRotateBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ROTATE_BYTES_ENV]?.trim()
  if (raw === undefined || raw.length === 0) return DEFAULT_ROTATE_BYTES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_ROTATE_BYTES
  return parsed
}

/** `recall-telemetry.jsonl` + 2 → `recall-telemetry.00002.jsonl`. */
export function segmentFileName(file: string, segment: number): string {
  const ext = path.extname(file)
  const stem = ext.length > 0 ? file.slice(0, -ext.length) : file
  return `${stem}.${String(segment).padStart(SEGMENT_DIGITS, "0")}${ext}`
}

/** Segment numbers already on disk for `file`, from the directory listing. */
function segmentNumbers(entries: ReadonlyArray<string>, file: string): number[] {
  const ext = path.extname(file)
  const stem = ext.length > 0 ? file.slice(0, -ext.length) : file
  const re = new RegExp(`^${escapeRe(stem)}\\.(\\d+)${escapeRe(ext)}$`)
  const out: number[] = []
  for (const e of entries) {
    const m = re.exec(e)
    if (m) out.push(Number(m[1]))
  }
  return out.filter((n) => Number.isFinite(n))
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** In-memory size + segment bookkeeping for one active file. */
interface StreamState {
  /** Bytes currently in the ACTIVE file. */
  bytes: number
  /** The segment number the active file will be renamed to when it rotates. */
  nextSegment: number
}

const states = new Map<string, StreamState>()
/** Per-path serialisation, so a rotation never interleaves with an append. */
const chains = new Map<string, Promise<void>>()

/**
 * Test seam: forget every cached size and segment number. Necessary because the
 * state is keyed by absolute path and a test that recreates a temp dir would
 * otherwise inherit a stale byte count.
 */
export function resetLogRotationState(): void {
  states.clear()
  chains.clear()
}

async function initState(dir: string, file: string): Promise<StreamState> {
  let bytes = 0
  try {
    bytes = (await fsp.stat(path.join(dir, file))).size
  } catch {
    bytes = 0 // no active file yet
  }
  let nextSegment = 1
  try {
    const nums = segmentNumbers(await fsp.readdir(dir), file)
    if (nums.length > 0) nextSegment = Math.max(...nums) + 1
  } catch {
    nextSegment = 1 // no directory yet
  }
  return { bytes, nextSegment }
}

/**
 * Close the active file into `state.nextSegment` and open a fresh one, writing
 * the two cross-referencing marker lines.
 *
 * THE RENAME COMES FIRST, on purpose. If it fails, nothing has been written and
 * nothing has moved — the caller simply keeps appending to the current file, so
 * a failed rotation costs an oversized file and never a lost record. Doing it
 * the other way round would leave a `close` marker in a file that was never
 * closed, which is a seam that lies.
 */
async function rotate(dir: string, file: string, state: StreamState): Promise<void> {
  const active = path.join(dir, file)
  const segment = state.nextSegment
  const segFile = segmentFileName(file, segment)
  const segPath = path.join(dir, segFile)
  const bytesBeforeMarker = state.bytes
  await fsp.rename(active, segPath)
  state.nextSegment = segment + 1
  state.bytes = 0
  const ts = new Date().toISOString()
  const closeLine = `${JSON.stringify({
    type: SEGMENT_MARKER_TYPE,
    event: "close",
    ts,
    stream: file,
    segment,
    file: segFile,
    // Named so a reader can verify the chain in one pass: this MUST equal the
    // `segment` on the very next `open` marker, or a segment is missing.
    next: { segment: segment + 1, file },
    reason: "size",
  })}\n`
  await fsp.appendFile(segPath, closeLine, "utf8")
  const openLine = `${JSON.stringify({
    type: SEGMENT_MARKER_TYPE,
    event: "open",
    ts,
    stream: file,
    segment: segment + 1,
    // `bytes` is the final on-disk size of the segment just closed, so a
    // truncated or half-copied segment is detectable against `wc -c` alone.
    previous: { segment, file: segFile, bytes: bytesBeforeMarker + Buffer.byteLength(closeLine) },
  })}\n`
  await fsp.appendFile(active, openLine, "utf8")
  state.bytes = Buffer.byteLength(openLine)
}

/**
 * Append one NDJSON line, rotating first if it would push the active file past
 * the threshold.
 *
 * The line is never split across segments: rotation is decided BEFORE the write,
 * so a record lands whole in exactly one segment. That means a segment may
 * exceed the threshold by up to one record plus the close marker, which is the
 * right trade — a record split across a file boundary is unparseable, and the
 * threshold is a target, not a contract.
 *
 * Appends to the same path are serialised, so lines cannot interleave and a
 * concurrent append cannot land in the file being renamed.
 */
export async function appendRotatingLine(
  dir: string,
  file: string,
  line: string,
  maxBytes: number = resolveRotateBytes(),
): Promise<void> {
  const key = path.join(dir, file)
  const prior = chains.get(key) ?? Promise.resolve()
  const next = prior.then(async () => {
    await fsp.mkdir(dir, { recursive: true })
    let state = states.get(key)
    if (!state) {
      state = await initState(dir, file)
      states.set(key, state)
    }
    const size = Buffer.byteLength(line)
    // `state.bytes > 0` keeps a threshold smaller than a single record from
    // rotating an empty file on every append and producing a segment per line.
    if (maxBytes > 0 && state.bytes > 0 && state.bytes + size > maxBytes) {
      try {
        await rotate(dir, file, state)
      } catch (e) {
        // Keep the record. An oversized file is recoverable; a lost line is not.
        console.error(`[log-rotation] rotation failed for ${key}; appending anyway: ${e}`)
      }
    }
    await fsp.appendFile(key, line, "utf8")
    state.bytes += size
  })
  // The chain must never reject, or one failure would poison every later append
  // on this path. Errors propagate to THIS caller only.
  chains.set(
    key,
    next.catch(() => undefined),
  )
  return next
}
