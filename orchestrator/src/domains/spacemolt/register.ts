import { Effect } from "effect"
import WebSocket from "ws"
import { parseGameEvent } from "./ws-types.js"
import type { RegisteredEvent } from "./ws-types.js"

const WS_URL = "wss://game.spacemolt.com/ws"

const EMPIRES = ["solarian", "crimson", "nebula", "voidborn", "outerrim"] as const

export class RegistrationError {
  readonly _tag = "RegistrationError"
  constructor(readonly message: string, readonly cause?: unknown) {}
  toString() { return this.message }
}

export interface RegistrationResult {
  readonly username: string
  readonly password: string
  readonly playerId: string
}

/**
 * Derive a SpaceMolt username from a character name.
 * Lowercase, replace spaces/hyphens with underscores, strip non-alphanumeric/underscore chars, truncate to 24.
 */
export function deriveUsername(characterName: string): string {
  return characterName
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24)
}

/**
 * Pick an empire deterministically from the character name.
 * Uses a simple hash so the same character always gets the same empire.
 */
export function pickEmpire(characterName: string): string {
  let hash = 0
  for (let i = 0; i < characterName.length; i++) {
    hash = ((hash << 5) - hash + characterName.charCodeAt(i)) | 0
  }
  return EMPIRES[Math.abs(hash) % EMPIRES.length]
}

/**
 * Register a new SpaceMolt character via raw WebSocket.
 *
 * Opens a one-shot connection: connect -> welcome -> register -> registered -> close.
 * Returns the credentials on success.
 */
export function registerCharacter(
  username: string,
  empire: string,
  registrationCode: string,
): Effect.Effect<RegistrationResult, RegistrationError> {
  return Effect.async<RegistrationResult, RegistrationError>((resume) => {
    const ws = new WebSocket(WS_URL)
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.close()
        resume(Effect.fail(new RegistrationError("Registration timed out after 30 seconds")))
      }
    }, 30_000)

    const cleanup = () => {
      clearTimeout(timeout)
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }

    ws.on("error", (err) => {
      if (!settled) {
        settled = true
        cleanup()
        resume(Effect.fail(new RegistrationError("WebSocket connection failed", err)))
      }
    })

    ws.on("close", () => {
      if (!settled) {
        settled = true
        cleanup()
        resume(Effect.fail(new RegistrationError("WebSocket closed before registration completed")))
      }
    })

    ws.on("message", (data) => {
      try {
        const event = parseGameEvent(data.toString())

        if (event.type === "welcome") {
          // Send registration
          ws.send(JSON.stringify({
            type: "register",
            payload: { username, empire, registration_code: registrationCode },
          }))
          return
        }

        if (event.type === "registered") {
          const payload = (event as RegisteredEvent).payload
          settled = true
          cleanup()
          resume(Effect.succeed({
            username,
            password: payload.password,
            playerId: payload.player_id,
          }))
          return
        }

        if (event.type === "error") {
          const errEvent = event as { type: "error"; payload: { code: string; message: string } }
          settled = true
          cleanup()
          resume(Effect.fail(new RegistrationError(
            `Registration failed: ${errEvent.payload.code} — ${errEvent.payload.message}`,
          )))
          return
        }
      } catch (err) {
        if (!settled) {
          settled = true
          cleanup()
          resume(Effect.fail(new RegistrationError("Failed to parse server message", err)))
        }
      }
    })
  })
}
