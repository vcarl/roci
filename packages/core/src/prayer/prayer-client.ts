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
  credits?: number
  cargoUsed?: number
  cargoCapacity?: number
  docked?: boolean
  cargo?: Record<string, number>
  notifications?: Array<{ type: string; summary: string }>
  activeMissions?: Array<{ title: string; progressText: string }>
  executionStatusLines?: string[]
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
          currentPOI?: { name?: string }
          ship?: {
            fuel: number
            maxFuel: number
            cargoUsed: number
            cargoCapacity: number
            cargo?: Record<string, { itemId: string; quantity: number }>
          }
          notifications?: Array<{ type: string; summary: string; payloadJson: string }>
          activeMissions?: Array<{ title: string; progressText: string }>
        }
        executionStatusLines?: string[]
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
        credits: data.state?.credits,
        cargoUsed: data.state?.ship?.cargoUsed,
        cargoCapacity: data.state?.ship?.cargoCapacity,
        docked: data.state?.docked,
        cargo: Object.keys(cargo).length > 0 ? cargo : undefined,
        notifications: data.state?.notifications?.map((n) => ({ type: n.type, summary: n.summary })),
        activeMissions: data.state?.activeMissions?.map((m) => ({ title: m.title, progressText: m.progressText })),
        executionStatusLines: data.executionStatusLines,
      }
    } catch {
      return null
    }
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
