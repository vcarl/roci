/**
 * PrayerManager
 * Per-agent Prayer session lifecycle.
 *
 * When Prayer is active, the state machine skips body turns and polls here instead.
 * Claude resumes when Prayer halts (cargo full, fuel low, script end, combat threat).
 *
 * Prayer backend: .NET service at prayerBaseUrl (default http://localhost:5000).
 * Manual start required: clone https://github.com/Savolent/Prayer → dotnet run --project src/Prayer/Prayer.csproj
 */

import { spawn } from "node:child_process"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { PrayerClient } from "./prayer-client.js"
import type { PrayerSnapshot, PrayerFullState, PrayerRoute, PrayerApiStats, PrayerEconomyDeal } from "./prayer-client.js"
export type { PrayerFullState }

export type { PrayerSnapshot }

const STARTUP_TIMEOUT_MS = 30_000
const STARTUP_POLL_MS = 500

export type PrayerThreat = { type: string; summary: string }

export type PrayerPollResult = {
  isHalted: boolean
  hasActiveCommand: boolean
  fuel?: number
  maxFuel?: number
  credits?: number
  snapshot: PrayerSnapshot
  threats?: PrayerThreat[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class PrayerManager {
  private readonly client: PrayerClient
  private sessions = new Map<string, string>()        // agentId → prayerSessionId
  private running = new Map<string, boolean>()         // agentId → script executing
  private stateVersions = new Map<string, number>()   // agentId → last seen state version
  private lastPollResults = new Map<string, PrayerPollResult>()
  private prayerProc: ReturnType<typeof spawn> | null = null

  private constructor(private readonly baseUrl: string) {
    this.client = new PrayerClient(baseUrl)
  }

  /**
   * Create a PrayerManager. Health-checks first; if down, tries to start via dotnet.
   * Returns null if Prayer cannot be started — harness runs without Prayer (body turns only).
   */
  static async create(baseUrl: string, csprojPath?: string): Promise<PrayerManager | null> {
    const mgr = new PrayerManager(baseUrl)

    if (await mgr.client.healthCheck()) {
      console.log(`[Prayer] already running at ${baseUrl}`)
      return mgr
    }

    if (!csprojPath) {
      console.log(`[Prayer] not running and no csprojPath — Prayer disabled`)
      return null
    }

    console.log(`[Prayer] starting: dotnet run --project ${csprojPath}`)

    try {
      mgr.prayerProc = spawn(
        "dotnet",
        ["run", "--project", csprojPath, "--urls", baseUrl],
        {
          env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        },
      )

      mgr.prayerProc.stdout?.on("data", (d: Buffer) => {
        const line = d.toString().trim()
        if (line) console.log(`[Prayer][dotnet] ${line}`)
      })
      mgr.prayerProc.stderr?.on("data", (d: Buffer) => {
        const line = d.toString().trim()
        if (line) console.warn(`[Prayer][dotnet] ${line}`)
      })
      mgr.prayerProc.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          console.warn(`[Prayer] process exited with code ${code}`)
        }
      })
    } catch (err) {
      console.warn(`[Prayer] failed to spawn dotnet: ${err}`)
      return null
    }

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(STARTUP_POLL_MS)
      if (await mgr.client.healthCheck()) {
        console.log(`[Prayer] started and healthy at ${baseUrl}`)
        return mgr
      }
    }

    console.warn(`[Prayer] startup timed out after ${STARTUP_TIMEOUT_MS / 1000}s — disabled`)
    mgr.prayerProc.kill()
    return null
  }

  stopProcess(): void {
    if (this.prayerProc && !this.prayerProc.killed) {
      this.prayerProc.kill()
      console.log("[Prayer] process stopped")
    }
  }

  async ensureSession(agentId: string, username: string, password: string, sessionFile?: string): Promise<string> {
    // In-memory cache — fast path for same process lifetime
    if (this.sessions.has(agentId)) return this.sessions.get(agentId)!

    // Try persisted session from file (survives harness restarts)
    if (sessionFile && existsSync(sessionFile)) {
      try {
        const saved = readFileSync(sessionFile, "utf-8").trim()
        if (saved) {
          await this.client.getSnapshot(saved) // throws if session is gone
          this.sessions.set(agentId, saved)
          this.running.set(agentId, false)
          this.stateVersions.set(agentId, 0)
          console.log(`[Prayer][${agentId}] restored session: ${saved}`)
          try {
            await this.client.setLlm(saved, "llamacpp", "")
          } catch { /* non-fatal */ }
          return saved
        }
      } catch {
        console.log(`[Prayer][${agentId}] saved session invalid — creating new`)
      }
    }

    const sessionId = await this.client.createSession(username, password, agentId)
    this.sessions.set(agentId, sessionId)
    this.running.set(agentId, false)
    this.stateVersions.set(agentId, 0)

    if (sessionFile) {
      try {
        writeFileSync(sessionFile, sessionId)
      } catch (err) {
        console.warn(`[Prayer][${agentId}] failed to save session file: ${err}`)
      }
    }

    console.log(`[Prayer][${agentId}] session created: ${sessionId}`)
    // Configure LLM — use llamacpp (local) if available, falls back to Prayer default
    try {
      await this.client.setLlm(sessionId, "llamacpp", "")
      console.log(`[Prayer][${agentId}] LLM set to llamacpp (local)`)
    } catch {
      console.log(`[Prayer][${agentId}] llamacpp unavailable — using Prayer default LLM`)
    }
    return sessionId
  }

  isRunning(agentId: string): boolean {
    return this.running.get(agentId) === true
  }

  /** Execute a PrayerLang script written directly by Claude. */
  async startScript(agentId: string, script: string): Promise<void> {
    const sessionId = this.getSessionId(agentId)
    await this.client.setScript(sessionId, script)
    await this.client.executeScript(sessionId)
    this.running.set(agentId, true)
    console.log(`[Prayer][${agentId}] script started (${script.split("\n").length} lines)`)
  }

  async pollOnce(agentId: string): Promise<PrayerPollResult> {
    const sessionId = this.getSessionId(agentId)
    const snapshot = await this.client.getSnapshot(sessionId)

    if (snapshot.isHalted) {
      this.running.set(agentId, false)
    }

    return {
      isHalted: snapshot.isHalted,
      hasActiveCommand: snapshot.hasActiveCommand,
      fuel: snapshot.fuel,
      maxFuel: snapshot.maxFuel,
      credits: snapshot.credits,
      snapshot,
    }
  }

  /**
   * Long-poll variant — blocks up to `waitMs` for a state change.
   * Returns cached result with isHalted=false if no change.
   */
  async pollWithLongPoll(agentId: string, waitMs: number): Promise<PrayerPollResult> {
    const sessionId = this.getSessionId(agentId)
    const since = this.stateVersions.get(agentId) ?? 0

    const { changed, version } = await this.client.waitForStateChange(sessionId, since, waitMs)
    this.stateVersions.set(agentId, version)

    if (!changed) {
      const cached = this.lastPollResults.get(agentId)
      if (cached) return cached
    }

    const result = await this.pollOnce(agentId)
    this.lastPollResults.set(agentId, result)
    return result
  }

  async halt(agentId: string): Promise<void> {
    const sessionId = this.sessions.get(agentId)
    if (!sessionId) return
    try {
      await this.client.halt(sessionId)
    } catch (err) {
      console.warn(`[Prayer][${agentId}] halt error: ${err}`)
    }
    this.running.set(agentId, false)
  }

  async getFullStateForResume(agentId: string): Promise<PrayerFullState | null> {
    const sessionId = this.sessions.get(agentId)
    if (!sessionId) return null
    return this.client.getState(sessionId)
  }

  async checkThreats(agentId: string): Promise<PrayerThreat[]> {
    const sessionId = this.sessions.get(agentId)
    if (!sessionId) return []
    const state = await this.client.getState(sessionId)
    if (!state?.notifications) return []
    return state.notifications.filter((n) => n.type === "combat")
  }


  /** Save a successful (prompt → script) pair back to Prayer's RAG store for future generation. */
  async saveExample(agentId: string, prompt: string, script: string): Promise<void> {
    const sessionId = this.sessions.get(agentId)
    if (!sessionId) return
    await this.client.saveExample(sessionId, prompt, script)
    console.log(`[Prayer][${agentId}] example saved to RAG store`)
  }

  /** Get the active pathfinding route (populated while a go command is executing). */
  async getRoute(agentId: string): Promise<PrayerRoute | null> {
    const sessionId = this.sessions.get(agentId)
    if (!sessionId) return null
    return this.client.getRoute(sessionId)
  }

  /** Get SpaceMolt API call statistics for this session. */
  async getApiStats(agentId: string): Promise<PrayerApiStats | null> {
    const sessionId = this.sessions.get(agentId)
    if (!sessionId) return null
    return this.client.getApiStats(sessionId)
  }



  /**
   * Attempt to repair a broken PrayerLang script via the local LLM.
   * Returns repaired script text, or null if repair fails.
   */
  async repairScript(agentId: string, brokenScript: string, parseError: string): Promise<string | null> {
    const sessionId = this.sessions.get(agentId)
    if (!sessionId) return null

    // Try local LLM via Prayer backend
    const repaired = await this.client.repairScript(sessionId, brokenScript, parseError)
    if (repaired) {
      console.log(`[Prayer][${agentId}] script auto-repaired via local LLM`)
      return repaired
    }

    console.log(`[Prayer][${agentId}] local repair failed — script repair unavailable`)
    return null
  }

  async cleanup(agentId: string): Promise<void> {
    const sessionId = this.sessions.get(agentId)
    if (!sessionId) return
    try {
      await this.client.halt(sessionId)
      await this.client.deleteSession(sessionId)
    } catch (err) {
      console.warn(`[Prayer][${agentId}] cleanup error: ${err}`)
    }
    this.sessions.delete(agentId)
    this.running.delete(agentId)
    this.stateVersions.delete(agentId)
    this.lastPollResults.delete(agentId)
    console.log(`[Prayer][${agentId}] session cleaned up`)
  }

  async cleanupAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.cleanup(id)))
  }

  private getSessionId(agentId: string): string {
    const sessionId = this.sessions.get(agentId)
    if (!sessionId) throw new Error(`[Prayer] no session for agent: ${agentId}`)
    return sessionId
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a PRAYER_SET block from agent output.
 * Format:
 *   PRAYER_SET:
 *   <prayerlang script>
 *   PRAYER_END
 *
 * Returns the script text, or null if not present.
 */
export function parsePrayerScript(output: string): string | null {
  const match = output.match(/PRAYER_SET:\s*\n([\s\S]*?)\nPRAYER_END/)
  return match?.[1]?.trim() ?? null
}

/**
 * Build a resume summary string after Prayer halts.
 * Injected into the brain's next plan prompt as additional context.
 */
export function buildPrayerSummary(
  result: PrayerPollResult,
  fullState: PrayerFullState | null,
  haltReason?: string,
): string {
  const lines: string[] = ["## Prayer Grind Summary"]

  if (haltReason) {
    lines.push(`Halt reason: ${haltReason}`)
  }

  if (fullState) {
    lines.push(
      `Location: ${fullState.poiName ?? "unknown"} in ${fullState.system ?? "unknown"}`,
      `Fuel: ${fullState.fuel ?? "?"}/${fullState.maxFuel ?? "?"}`,
      `Credits: ${fullState.credits ?? "?"}`,
      `Cargo: ${fullState.cargoUsed ?? "?"}/${fullState.cargoCapacity ?? "?"} used`,
    )
    if (fullState.hull !== undefined) {
      lines.push(`Hull: ${fullState.hull}/${fullState.maxHull ?? "?"} | Shield: ${fullState.shield ?? "?"} | Armor: ${fullState.armor ?? "?"}`)
    }
    if (fullState.cargo && Object.keys(fullState.cargo).length > 0) {
      const items = Object.entries(fullState.cargo)
        .sort(([, a], [, b]) => b - a)
        .map(([id, qty]) => `${id}×${qty}`)
        .join(", ")
      lines.push(`Cargo contents: ${items}`)
    }
    if (fullState.memory && fullState.memory.length > 0) {
      // Show last 15 memory entries — this is what Prayer actually did
      const recentMemory = fullState.memory.slice(-15).join("\n")
      lines.push(`\nGrind log (last ${Math.min(15, fullState.memory.length)} actions):\n${recentMemory}`)
    } else if (fullState.executionStatusLines && fullState.executionStatusLines.length > 0) {
      lines.push(`Execution log:\n${fullState.executionStatusLines.slice(-10).join("\n")}`)
    }
    if (fullState.activeMissions && fullState.activeMissions.length > 0) {
      const missions = fullState.activeMissions.map((m) => `  ${m.title}: ${m.progressText}`).join("\n")
      lines.push(`Active missions:\n${missions}`)
    }
    if (fullState.currentPoiResources && fullState.currentPoiResources.length > 0) {
      const res = fullState.currentPoiResources.map((r) => `  ${r.resourceId} — ${r.richnessText}${r.remaining !== undefined ? ` (${r.remaining} remaining)` : ""}`).join("\n")
      lines.push(`Resources at current POI:\n${res}`)
    }
    if (fullState.economyDeals && fullState.economyDeals.length > 0) {
      // Top 5 deals by profit per unit
      const top = fullState.economyDeals
        .sort((a, b) => b.profitPerUnit - a.profitPerUnit)
        .slice(0, 5)
      const dealLines = top.map((d) =>
        `  ${d.itemId}: buy @${d.buyStationId} (${d.buyPrice}cr) → sell @${d.sellStationId} (${d.sellPrice}cr) = +${d.profitPerUnit}cr/unit`
      ).join("\n")
      lines.push(`Top arbitrage opportunities:\n${dealLines}`)
    }
    if (fullState.poisByResource && Object.keys(fullState.poisByResource).length > 0) {
      const entries = Object.entries(fullState.poisByResource)
        .slice(0, 8)
        .map(([res, pois]) => `  ${res}: ${pois.slice(0, 3).join(", ")}`)
        .join("\n")
      lines.push(`Known mining locations (resource → POIs):\n${entries}`)
    }
    if (fullState.availableMissions && fullState.availableMissions.length > 0) {
      const mlist = fullState.availableMissions.slice(0, 5).map((m) => `  [${m.type}] ${m.title} — ${m.rewardsSummary}`).join("\n")
      lines.push(`Available missions at this station:\n${mlist}`)
    }
  } else {
    lines.push(
      `Fuel: ${result.fuel ?? "?"}/${result.maxFuel ?? "?"}`,
      `Credits: ${result.credits ?? "?"}`,
    )
  }

  return lines.join("\n")
}
