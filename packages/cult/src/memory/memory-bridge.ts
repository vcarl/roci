/**
 * Memory Bridge — CULT-specific
 *
 * After dream compression, extract high-signal facts from the compressed diary
 * and store them in the shared Memory MCP for cross-agent retrieval.
 *
 * This runs on the host side (after `dream.execute()`), using Claude to extract
 * structured facts from the compressed diary text, then storing them via the
 * Memory MCP server configured in `.claude/settings.json`.
 *
 * Usage:
 *   const bridge = new MemoryBridge(claudeInvoke)
 *   await bridge.extractAndStore(agentName, compressedDiary, background)
 */

export interface MemoryEntry {
  title: string
  content: string
  type: "solution" | "pattern" | "error" | "workflow"
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
 * Extracts high-signal facts from a compressed diary using a simple heuristic parser.
 * Looks for sections that indicate strategic intel: Beliefs, Accomplishments, Relationships.
 *
 * In production, this would be replaced by a Claude invoke call to do semantic extraction.
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
