import * as fs from "fs"
import * as path from "path"

export type EdictPriority = "low" | "high" | "critical"

export type Edict = {
  id: string
  priority: EdictPriority
  content: string
  issuedAt: string
  source?: string
}

/**
 * Drain all edicts from `players/{name}/inbox/`.
 * Files are moved to `processed/` after reading (exactly-once delivery).
 * Supports .json, .md, and .txt files.
 */
export function drainEdictInbox(playerDir: string): Edict[] {
  const inboxDir = path.join(playerDir, "inbox")
  const processedDir = path.join(playerDir, "inbox", "processed")

  if (!fs.existsSync(inboxDir)) return []

  const entries = fs.readdirSync(inboxDir, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && /\.(json|md|txt)$/.test(e.name))
    .map((e) => e.name)
    .sort() // process in alphabetical order (timestamp-prefixed filenames sort chronologically)

  if (files.length === 0) return []

  fs.mkdirSync(processedDir, { recursive: true })

  const edicts: Edict[] = []

  for (const filename of files) {
    const filePath = path.join(inboxDir, filename)
    let edict: Edict | null = null

    try {
      const raw = fs.readFileSync(filePath, "utf-8")

      if (filename.endsWith(".json")) {
        const parsed = JSON.parse(raw) as Partial<Edict>
        edict = {
          id: filename,
          priority: parsed.priority ?? "low",
          content: parsed.content ?? raw,
          issuedAt: parsed.issuedAt ?? new Date().toISOString(),
          source: parsed.source,
        }
      } else {
        // .md or .txt: parse optional frontmatter priority
        const priority = extractPriority(raw)
        edict = {
          id: filename,
          priority,
          content: raw.trim(),
          issuedAt: new Date().toISOString(),
        }
      }

      // Move to processed
      const destPath = path.join(processedDir, filename)
      fs.renameSync(filePath, destPath)
    } catch {
      // Malformed file — skip but still move to processed to avoid re-processing
      try {
        fs.renameSync(filePath, path.join(processedDir, filename))
      } catch {
        // ignore
      }
    }

    if (edict) edicts.push(edict)
  }

  return edicts
}

/**
 * Write an edict to `players/{name}/inbox/` for a specific agent.
 * Used by external monitoring to send commands to agents.
 */
export function writeEdict(
  playerDir: string,
  edict: Omit<Edict, "id">,
  filename?: string,
): void {
  const inboxDir = path.join(playerDir, "inbox")
  fs.mkdirSync(inboxDir, { recursive: true })

  const id = filename ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  const filePath = path.join(inboxDir, id)
  fs.writeFileSync(filePath, JSON.stringify({ ...edict, id }, null, 2), "utf-8")
}

function extractPriority(content: string): EdictPriority {
  const match = /priority:\s*(low|high|critical)/i.exec(content)
  if (!match) return "low"
  return match[1]!.toLowerCase() as EdictPriority
}
