/**
 * PrayerClient
 * Thin HTTP client for the Prayer SpaceMolt platform backend.
 * Prayer API: http://localhost:5000/ (configurable via prayerBaseUrl)
 */

export type PrayerSnapshot = {
  sessionId: string
  isHalted: boolean
  hasActiveCommand: boolean
  currentScriptLine?: number
  currentScript?: string
  latestSystem?: string
  latestPoi?: string
  fuel?: number
  maxFuel?: number
  credits?: number
}

export type PrayerFullState = {
  system?: string
  poiName?: string
  fuel?: number
  maxFuel?: number
  hull?: number
  maxHull?: number
  shield?: number
  armor?: number
  credits?: number
  cargoUsed?: number
  cargoCapacity?: number
  docked?: boolean
  cargo?: Record<string, number>
  notifications?: Array<{ type: string; summary: string }>
  activeMissions?: Array<{ title: string; progressText: string }>
  executionStatusLines?: string[]
  memory?: string[]
  lastGenerationPrompt?: string
  economyDeals?: PrayerEconomyDeal[]
  globalSellPrices?: Record<string, number>
  poisByResource?: Record<string, string[]>
  currentPoiResources?: PrayerPoiResource[]
  availableMissions?: Array<{ title: string; type: string; difficulty?: number; rewardsSummary: string }>
}

export type PrayerRoute = {
  target?: string
  hops?: string[]
  totalJumps?: number
  fuelEstimate?: number
}

export type PrayerApiStats = {
  totalCalls?: number
  distinctCommands?: number
  topCommands?: Array<{ command: string; count: number; avgLatencyMs: number; maxLatencyMs: number }>
}


export type PrayerEconomyDeal = {
  itemId: string
  buyStationId: string
  buyPrice: number
  sellStationId: string
  sellPrice: number
  profitPerUnit: number
}

export type PrayerPoiResource = {
  resourceId: string
  name: string
  richnessText: string
  richness?: number
  remaining?: number
}

export class PrayerClient {
  constructor(private readonly baseUrl: string) {}

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async createSession(username: string, password: string, label?: string): Promise<string> {
    const res = await this.post("/api/runtime/sessions", { username, password, label })
    if (!res.ok) throw new Error(`Prayer createSession ${res.status}: ${await res.text()}`)
    const data = await res.json() as { id: string }
    return data.id
  }

  async setScript(sessionId: string, script: string): Promise<void> {
    const res = await this.post(`/api/runtime/sessions/${sessionId}/script`, { script })
    if (!res.ok) throw new Error(`Prayer setScript ${res.status}: ${await res.text()}`)
  }

  async executeScript(sessionId: string): Promise<void> {
    const res = await this.post(`/api/runtime/sessions/${sessionId}/script/execute`, {})
    if (!res.ok) throw new Error(`Prayer executeScript ${res.status}: ${await res.text()}`)
  }

  async halt(sessionId: string): Promise<void> {
    const res = await this.post(`/api/runtime/sessions/${sessionId}/halt`, {})
    if (!res.ok && res.status !== 404) throw new Error(`Prayer halt ${res.status}: ${await res.text()}`)
  }

  async getSnapshot(sessionId: string): Promise<PrayerSnapshot> {
    const res = await fetch(`${this.baseUrl}/api/runtime/sessions/${sessionId}/snapshot`)
    if (!res.ok) throw new Error(`Prayer getSnapshot ${res.status}: ${await res.text()}`)

    const data = await res.json() as {
      sessionId: string
      snapshot: {
        isHalted: boolean
        hasActiveCommand: boolean
        currentScriptLine?: number
        currentScript?: string
      }
      latestSystem?: string
      latestPoi?: string
      fuel?: number
      maxFuel?: number
      credits?: number
    }

    return {
      sessionId: data.sessionId,
      isHalted: data.snapshot.isHalted,
      hasActiveCommand: data.snapshot.hasActiveCommand,
      currentScriptLine: data.snapshot.currentScriptLine,
      currentScript: data.snapshot.currentScript,
      latestSystem: data.latestSystem,
      latestPoi: data.latestPoi,
      fuel: data.fuel,
      maxFuel: data.maxFuel,
      credits: data.credits,
    }
  }

  /**
   * Long-poll for state change. Blocks up to `waitMs` ms server-side.
   * Returns { changed: false } on 204 timeout, { changed: true, version } on state change.
   */
  async waitForStateChange(
    sessionId: string,
    since: number,
    waitMs: number,
  ): Promise<{ changed: boolean; version: number }> {
    const res = await fetch(
      `${this.baseUrl}/api/runtime/sessions/${sessionId}/state?since=${since}&wait_ms=${waitMs}`,
      { signal: AbortSignal.timeout(waitMs + 5000) },
    )
    if (res.status === 204) {
      await res.arrayBuffer()
      return { changed: false, version: since }
    }
    if (!res.ok) throw new Error(`Prayer waitForStateChange ${res.status}: ${await res.text()}`)
    const version = parseInt(res.headers.get("X-Prayer-State-Version") ?? String(since), 10)
    await res.arrayBuffer()
    return { changed: true, version }
  }

  async getState(sessionId: string): Promise<PrayerFullState | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/api/runtime/sessions/${sessionId}/state`,
        { signal: AbortSignal.timeout(10_000) },
      )
      if (!res.ok) return null

      const data = await res.json() as {
        state?: {
          system?: string
          credits?: number
          docked?: boolean
          currentPOI?: {
            name?: string
            resources?: Array<{
              resourceId: string
              name: string
              richnessText: string
              richness?: number
              remaining?: number
            }>
          }
          ship?: {
            fuel: number
            maxFuel: number
            hull?: number
            maxHull?: number
            shield?: number
            armor?: number
            cargoUsed: number
            cargoCapacity: number
            cargo?: Record<string, { itemId: string; quantity: number }>
          }
          economyDeals?: Array<{
            itemId: string
            buyStationId: string
            buyPrice: number
            sellStationId: string
            sellPrice: number
            profitPerUnit: number
          }>
          galaxy?: {
            market?: {
              globalMedianSellPrices?: Record<string, number>
            }
            resources?: {
              poisByResource?: Record<string, string[]>
            }
          }
          availableMissions?: Array<{
            title: string
            type: string
            difficulty?: number
            rewardsSummary: string
          }>
          notifications?: Array<{ type: string; summary: string; payloadJson: string }>
          activeMissions?: Array<{ title: string; progressText: string }>
        }
        executionStatusLines?: string[]
        memory?: string[]
        lastGenerationPrompt?: string
      }

      const cargo: Record<string, number> = {}
      for (const [k, v] of Object.entries(data.state?.ship?.cargo ?? {})) {
        cargo[k] = v.quantity
      }

      return {
        system: data.state?.system,
        poiName: data.state?.currentPOI?.name,
        fuel: data.state?.ship?.fuel,
        maxFuel: data.state?.ship?.maxFuel,
        hull: data.state?.ship?.hull,
        maxHull: data.state?.ship?.maxHull,
        shield: data.state?.ship?.shield,
        armor: data.state?.ship?.armor,
        credits: data.state?.credits,
        cargoUsed: data.state?.ship?.cargoUsed,
        cargoCapacity: data.state?.ship?.cargoCapacity,
        docked: data.state?.docked,
        cargo: Object.keys(cargo).length > 0 ? cargo : undefined,
        notifications: data.state?.notifications?.map((n) => ({ type: n.type, summary: n.summary })),
        activeMissions: data.state?.activeMissions?.map((m) => ({ title: m.title, progressText: m.progressText })),
        executionStatusLines: data.executionStatusLines,
        memory: data.memory ?? undefined,
        lastGenerationPrompt: data.lastGenerationPrompt ?? undefined,
        economyDeals: data.state?.economyDeals?.map((d) => ({
          itemId: d.itemId,
          buyStationId: d.buyStationId,
          buyPrice: d.buyPrice,
          sellStationId: d.sellStationId,
          sellPrice: d.sellPrice,
          profitPerUnit: d.profitPerUnit,
        })),
        globalSellPrices: data.state?.galaxy?.market?.globalMedianSellPrices ?? undefined,
        poisByResource: data.state?.galaxy?.resources?.poisByResource ?? undefined,
        currentPoiResources: data.state?.currentPOI?.resources?.map((r) => ({
          resourceId: r.resourceId,
          name: r.name,
          richnessText: r.richnessText,
          richness: r.richness,
          remaining: r.remaining,
        })),
        availableMissions: data.state?.availableMissions?.map((m) => ({
          title: m.title,
          type: m.type,
          difficulty: m.difficulty,
          rewardsSummary: m.rewardsSummary,
        })),
      }
    } catch {
      return null
    }
  }


  async setLlm(sessionId: string, provider: string, model: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/runtime/sessions/${sessionId}/llm`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model }),
    })
    if (!res.ok) throw new Error(`Prayer setLlm ${res.status}: ${await res.text()}`)
  }

  async getRoute(sessionId: string): Promise<PrayerRoute | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/runtime/sessions/${sessionId}/route`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return null
      const data = await res.json() as {
        target?: string
        hops?: string[]
        totalJumps?: number
        fuelEstimate?: number
      }
      return {
        target: data.target,
        hops: data.hops,
        totalJumps: data.totalJumps,
        fuelEstimate: data.fuelEstimate,
      }
    } catch {
      return null
    }
  }

  async getApiStats(sessionId: string): Promise<PrayerApiStats | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/runtime/sessions/${sessionId}/spacemolt/stats`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return null
      const data = await res.json() as {
        totalCalls?: number
        distinctCommands?: number
        topCommands?: Array<{ command: string; count: number; avgLatencyMs: number; maxLatencyMs: number }>
      }
      return data
    } catch {
      return null
    }
  }

  async saveExample(sessionId: string, prompt: string, script: string): Promise<void> {
    try {
      const res = await this.post(`/api/runtime/sessions/${sessionId}/save-example`, { prompt, script })
      if (!res.ok) console.warn(`Prayer saveExample ${res.status}: ${await res.text()}`)
    } catch {
      // Non-critical — don't throw
    }
  }


  async generate(sessionId: string, prompt: string, maxTokens = 512, temperature = 0.7): Promise<string | null> {
    try {
      const res = await this.post(`/api/runtime/sessions/${sessionId}/generate`, {
        prompt,
        maxTokens,
        temperature,
      })
      if (!res.ok) return null
      const data = await res.json() as { text?: string }
      return data.text ?? null
    } catch {
      return null
    }
  }


  /**
   * Attempt to repair a broken PrayerLang script using the local LLM.
   * Builds a focused repair prompt (no character context needed — pure syntax correction).
   * Returns the repaired script text, or null if generation fails.
   */
  async repairScript(sessionId: string, brokenScript: string, parseError: string): Promise<string | null> {
    const prompt =
      "<|start_header_id|>system<|end_header_id|>\n" +
      "You write PrayerLang DSL scripts for a SpaceMolt game agent.\n" +
      "Fix the broken script below. Output only the corrected DSL text. No markdown, no explanation.\n" +
      "Every command ends with a semicolon (;).\n" +
      "<|eot_id|>\n" +
      "<|start_header_id|>user<|end_header_id|>\n" +
      "Broken script:\n" + brokenScript.trim() + "\n\n" +
      "Parse error:\n" + parseError.trim() + "\n\n" +
      "DSL rules:\n" +
      "- Three block types only: repeat { ... }  |  until CONDITION { ... }  |  if CONDITION { ... }\n" +
      "- NO 'repeat until' — does not exist. Use: until CONDITION { ... }\n" +
      "- mine takes NO argument — use bare: mine;\n" +
      "- Every command ends with ;\n" +
      "- Conditions: FUEL() CARGO() HULL() CREDITS() STASH(poi,item) MISSION_COMPLETE(id)\n\n" +
      "Return only the corrected script text.\n" +
      "<|eot_id|>\n" +
      "<|start_header_id|>assistant<|end_header_id|>\n"

    return this.generate(sessionId, prompt, 400, 0.1)
  }

  async deleteSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/runtime/sessions/${sessionId}`, {
      method: "DELETE",
    })
    if (!res.ok && res.status !== 404) {
      throw new Error(`Prayer deleteSession ${res.status}: ${await res.text()}`)
    }
  }

  private post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }
}
