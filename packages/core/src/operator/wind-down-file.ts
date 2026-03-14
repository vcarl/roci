import * as fs from "fs"
import * as path from "path"

export type WindDownSignal = {
  reason: string
  sessionEndTime?: string // ISO timestamp — when session resets (nonstop uses +500s)
  issuedAt: string
}

/**
 * Write a wind-down signal. Agents polling this file will halt gracefully.
 */
export function writeWindDown(playersDir: string, signal: Omit<WindDownSignal, "issuedAt">): void {
  const filePath = getWindDownPath(playersDir)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const payload: WindDownSignal = { ...signal, issuedAt: new Date().toISOString() }
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8")
}

/**
 * Read the current wind-down signal, or null if none exists.
 */
export function readWindDown(playersDir: string): WindDownSignal | null {
  const filePath = getWindDownPath(playersDir)
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    return JSON.parse(raw) as WindDownSignal
  } catch {
    return null
  }
}

/**
 * Clear the wind-down signal (used after graceful shutdown or session restart).
 */
export function clearWindDown(playersDir: string): void {
  const filePath = getWindDownPath(playersDir)
  try {
    fs.unlinkSync(filePath)
  } catch {
    // already gone
  }
}

/**
 * Start polling for a wind-down signal. Calls `onWindDown` when detected.
 * Returns a cancel function.
 */
export function startWindDownWatcher(
  playersDir: string,
  onWindDown: (signal: WindDownSignal) => void,
  intervalMs = 10_000,
): () => void {
  let cancelled = false

  const check = () => {
    if (cancelled) return
    const signal = readWindDown(playersDir)
    if (signal) {
      onWindDown(signal)
    } else {
      setTimeout(check, intervalMs)
    }
  }

  setTimeout(check, intervalMs)

  return () => {
    cancelled = true
  }
}

// Wind-down file lives at players/WIND_DOWN.json (fleet-wide signal)
function getWindDownPath(playersDir: string): string {
  return path.join(playersDir, "WIND_DOWN.json")
}
