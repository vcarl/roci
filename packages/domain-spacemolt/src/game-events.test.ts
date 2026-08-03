import { describe, it, expect } from "vitest"
import { TYPED_NOTIFICATION_TYPES } from "@spacemolt/lib"
import {
  KNOWN_FRAME_TYPES,
  CONTROL_FRAME_TYPES,
  HOST_FRAME_TYPES,
  STATE_SYNC_FRAME,
  CONNECTION_STATE_FRAME,
  schemaGapNote,
} from "./game-events.js"

describe("KNOWN_FRAME_TYPES", () => {
  it("contains every one of the library's 36 generated notification types", () => {
    expect(TYPED_NOTIFICATION_TYPES.length).toBe(36)
    for (const t of TYPED_NOTIFICATION_TYPES) {
      expect(KNOWN_FRAME_TYPES.has(t)).toBe(true)
    }
  })

  it("INVERTS the old ws-types assertion: battle_damage is now TYPED, not a gap", () => {
    // ws-types.test.ts:9-11 asserted the opposite, because client-v2's
    // hand-written ServerEvent union omitted this real, default-on push frame
    // and roci bridged it by hand. The generated catalog models it.
    expect(KNOWN_FRAME_TYPES.has("battle_damage")).toBe(true)
  })

  it("contains the combat family §6's reflex is written against", () => {
    for (const t of ["battle_started", "battle_joined", "battle_ended", "battle_alert", "player_died"]) {
      expect(KNOWN_FRAME_TYPES.has(t)).toBe(true)
    }
  })

  it("contains the control frames the library routes to onAny", () => {
    for (const t of CONTROL_FRAME_TYPES) expect(KNOWN_FRAME_TYPES.has(t)).toBe(true)
    expect(CONTROL_FRAME_TYPES.has("action_result")).toBe(true)
    expect(CONTROL_FRAME_TYPES.has("error")).toBe(true)
  })

  it("contains the two host synthetic frames, so the host never warns about itself", () => {
    expect(HOST_FRAME_TYPES.has(STATE_SYNC_FRAME)).toBe(true)
    expect(HOST_FRAME_TYPES.has(CONNECTION_STATE_FRAME)).toBe(true)
    expect(KNOWN_FRAME_TYPES.has("state_sync")).toBe(true)
    expect(KNOWN_FRAME_TYPES.has("connection_state")).toBe(true)
  })
})

describe("schemaGapNote", () => {
  it("returns null for a frame the generated catalog models", () => {
    expect(schemaGapNote({ type: "battle_update", payload: {} })).toBeNull()
    expect(schemaGapNote({ type: "battle_damage", payload: {} })).toBeNull()
    expect(schemaGapNote({ type: "pirate_radio", payload: { x: 1 } })).toBeNull()
  })

  it("returns null for the host's own synthetic frames", () => {
    expect(schemaGapNote({ type: "state_sync", payload: { sections: ["ship"] } })).toBeNull()
    expect(schemaGapNote({ type: "connection_state", payload: { connected: false } })).toBeNull()
  })

  it("flags a frame outside the catalog, carrying its type and payload", () => {
    const note = schemaGapNote({ type: "wormhole_collapsed", payload: { x: 1 } })
    expect(note).not.toBeNull()
    if (note!.type !== "note") throw new Error("unreachable")
    expect(note!.label).toBe("unknown_ws_frame")
    expect(note!.severity).toBe("warn")
    expect(note!.data).toEqual({ type: "wormhole_collapsed", payload: { x: 1 } })
  })

  it("does not dedup — every untyped frame emits its own note", () => {
    // Deliberate (ws-types.ts:80-81): a repeated gap is a repeated signal that
    // the generated catalog is behind the server, and suppressing repeats would
    // hide exactly the frames arriving most often.
    const a = schemaGapNote({ type: "wormhole_collapsed", payload: { n: 1 } })
    const b = schemaGapNote({ type: "wormhole_collapsed", payload: { n: 2 } })
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    if (b!.type !== "note") throw new Error("unreachable")
    expect(b!.data).toEqual({ type: "wormhole_collapsed", payload: { n: 2 } })
  })
})
