import * as fs from "fs"
import * as path from "path"

/**
 * Read operator TODO directives for an agent.
 * Path: {dir}/TODO.md (typically players/{name}/me/TODO.md)
 *
 * Returns the raw file content, or null if the file doesn't exist or is empty.
 * The file path is included in the returned object so the agent can self-update it.
 */
export function readTodo(playerDir: string): { content: string; filePath: string } | null {
  const filePath = path.join(playerDir, "TODO.md")

  if (!fs.existsSync(filePath)) return null

  try {
    const content = fs.readFileSync(filePath, "utf-8").trim()
    if (!content) return null
    return { content, filePath }
  } catch {
    return null
  }
}

/**
 * Write (or overwrite) the TODO.md for an agent.
 * Used by external monitoring to inject session directives.
 */
export function writeTodo(playerDir: string, content: string): void {
  const filePath = path.join(playerDir, "TODO.md")
  fs.mkdirSync(playerDir, { recursive: true })
  fs.writeFileSync(filePath, content, "utf-8")
}
