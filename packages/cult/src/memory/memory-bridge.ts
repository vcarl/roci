/**
 * Memory Bridge — CULT-specific
 *
 * After dream compression, extract high-signal facts from the compressed diary
 * and store them in the shared Signal Memory DB for cross-agent retrieval.
 *
 * This runs on the host side (after `dream.execute()`), writing directly to the
 * Signal Memory MCP's SQLite database via better-sqlite3.
 *
 * The `memories` table schema matches the Signal Memory MCP server (memory.ts):
 *   id, type, title, content, tags (JSON), importance, session, author,
 *   pinned, access_count, last_accessed, created_at, updated_at, embedding
 */

import Database from "better-sqlite3"
import { randomUUID } from "node:crypto"

export interface MemoryEntry {
  title: string
  content: string
  type: "solution" | "pattern" | "error" | "workflow" | "lore" | "general"
  importance: number
  tags: string[]
}

export interface MemoryBridgeConfig {
  /** Minimum importance threshold for storing a memory (0.0–1.0). Default: 0.65 */
  minImportance?: number
  /** Maximum entries to extract per dream. Default: 5 */
  maxEntries?: number
}

/**
 * Write extracted memories to the Signal Memory DB.
 * Uses upsert on title to avoid duplicates across dream cycles.
 * Non-fatal — returns results, never throws.
 */
export function writeMemoriesToDb(
  agentName: string,
  entries: MemoryEntry[],
  dbPath: string,
): { written: number; errors: string[] } {
  const errors: string[] = []
  let written = 0
  const now = Date.now()

  let db: InstanceType<typeof Database> | undefined
  try {
    db = new Database(dbPath)
    db.pragma("journal_mode = WAL")

    // Ensure the memories table exists (the MCP server creates it, but be safe)
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id           TEXT    PRIMARY KEY,
        type         TEXT    NOT NULL DEFAULT 'general',
        title        TEXT,
        content      TEXT    NOT NULL,
        tags         TEXT    NOT NULL DEFAULT '[]',
        importance   REAL    NOT NULL DEFAULT 0.5,
        session      TEXT,
        author       TEXT,
        pinned       BOOL    NOT NULL DEFAULT 0,
        access_count INT     NOT NULL DEFAULT 0,
        last_accessed INT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        embedding    BLOB
      )
    `)

    const insertStmt = db.prepare(`
      INSERT INTO memories (id, type, title, content, tags, importance, session, author, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const findByTitle = db.prepare(`
      SELECT id FROM memories WHERE title = ? AND author = ? LIMIT 1
    `)

    const updateStmt = db.prepare(`
      UPDATE memories SET content = ?, tags = ?, importance = MAX(importance, ?), updated_at = ?
      WHERE id = ?
    `)

    const txn = db.transaction(() => {
      for (const entry of entries) {
        try {
          const author = agentName.toLowerCase()
          const existing = findByTitle.get(entry.title, author) as { id: string } | undefined

          if (existing) {
            // Update existing memory with fresh content
            updateStmt.run(entry.content, JSON.stringify(entry.tags), entry.importance, now, existing.id)
          } else {
            // Insert new memory
            const id = randomUUID().replace(/-/g, "").slice(0, 16)
            insertStmt.run(
              id, entry.type, entry.title, entry.content,
              JSON.stringify(entry.tags), entry.importance,
              "dream", author, now, now,
            )
          }
          written++
        } catch (e: unknown) {
          errors.push(`Failed to write "${entry.title}": ${e}`)
        }
      }
    })

    txn()
  } catch (e: unknown) {
    errors.push(`Database error: ${e}`)
  } finally {
    db?.close()
  }

  return { written, errors }
}

/**
 * Extracts high-signal facts from a compressed diary using a simple heuristic parser.
 * Looks for sections that indicate strategic intel: Beliefs, Accomplishments, Relationships.
 *
 * The heuristic approach avoids an extra API call during dream processing.
 */
export function extractMemoriesFromDiary(
  agentName: string,
  compressedDiary: string,
  config: MemoryBridgeConfig = {},
): MemoryEntry[] {
  const { minImportance = 0.65, maxEntries = 5 } = config
  const entries: MemoryEntry[] = []

  // Parse Beliefs section — these are confirmed facts worth sharing
  const beliefsMatch = compressedDiary.match(/##\s*Beliefs\s*\n([\s\S]*?)(?=##|$)/)
  if (beliefsMatch) {
    const beliefs = beliefsMatch[1]
      .split(/\n(?=-)/)
      .map((b) => b.trim())
      .filter((b) => b.startsWith("-") && b.length > 20)

    for (const belief of beliefs.slice(0, 3)) {
      const clean = belief.replace(/^-\s*\*\*[^*]+\*\*\s*/, "").replace(/^-\s*/, "").trim()
      if (!clean) continue

      const tags = inferTags(belief)
      const importance = inferImportance(belief)

      if (importance >= minImportance) {
        entries.push({
          title: `[${agentName}] ${extractTitle(belief)}`,
          content: `Agent: ${agentName}\n${belief}`,
          type: "pattern",
          importance,
          tags: ["cult", agentName.toLowerCase(), ...tags],
        })
      }
    }
  }

  // Parse Accomplishments — milestones worth the fleet knowing
  const accomplishmentsMatch = compressedDiary.match(/##\s*Accomplishments\s*\n([\s\S]*?)(?=##|$)/)
  if (accomplishmentsMatch) {
    const items = accomplishmentsMatch[1]
      .split(/\n(?=-)/)
      .map((b) => b.trim())
      .filter((b) => b.startsWith("-") && b.length > 20)

    for (const item of items.slice(0, 2)) {
      const tags = inferTags(item)
      const importance = inferImportance(item) * 0.9 // slightly lower than beliefs

      if (importance >= minImportance) {
        entries.push({
          title: `[${agentName}] ${extractTitle(item)}`,
          content: `Agent: ${agentName}\nAccomplishment: ${item}`,
          type: "solution",
          importance,
          tags: ["cult", agentName.toLowerCase(), "milestone", ...tags],
        })
      }
    }
  }

  return entries.slice(0, maxEntries)
}

function extractTitle(line: string): string {
  // Extract bold text as title, or first 60 chars
  const boldMatch = line.match(/\*\*([^*]+)\*\*/)
  if (boldMatch) return boldMatch[1].slice(0, 80)
  return line.replace(/^-\s*/, "").slice(0, 80)
}

function inferTags(text: string): string[] {
  const tags: string[] = []
  const lower = text.toLowerCase()

  if (/market|price|sell|buy|order|cr\b|credits/.test(lower)) tags.push("market", "economics")
  if (/allian|contact|player|faction|roci|goon|stlr|kura/.test(lower)) tags.push("alliance", "social")
  if (/arq|arg|chain|trace|signal_amplifier|sanctum|npc|dialog/.test(lower)) tags.push("arq", "lore")
  if (/mission|quest|task/.test(lower)) tags.push("mission")
  if (/craft|recipe|l\d+|skill|refin|process/.test(lower)) tags.push("crafting", "mechanics")
  if (/mine|ore|titanium|cobalt|plasma|iron|darksteel/.test(lower)) tags.push("mining")
  if (/fuel|travel|jump|system|route/.test(lower)) tags.push("navigation")

  return [...new Set(tags)]
}

function inferImportance(text: string): number {
  const lower = text.toLowerCase()
  let importance = 0.6

  // Higher importance signals
  if (/confirmed|verified|proven|tested/.test(lower)) importance += 0.1
  if (/never|always|critical|key|gate|lock|unlock/.test(lower)) importance += 0.08
  if (/allian|roci|stlr|kura|goon/.test(lower)) importance += 0.08
  if (/arq|arg|sanctum|chain|lore/.test(lower)) importance += 0.1
  if (/l\d+\s*(achieved|maxed|complete)/.test(lower)) importance += 0.1
  if (/lockbox|storage|200k|facility/.test(lower)) importance += 0.07

  // Lower importance signals
  if (/routine|basic|simple/.test(lower)) importance -= 0.1
  if (/todo|pending|next/.test(lower)) importance -= 0.05

  return Math.min(1.0, Math.max(0.0, importance))
}
