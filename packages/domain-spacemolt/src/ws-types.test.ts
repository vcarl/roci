import { describe, it, expect } from "vitest"
import { KNOWN_SERVER_EVENT_TYPES, schemaGapNote } from "./ws-types.js"

describe("KNOWN_SERVER_EVENT_TYPES", () => {
  it("contains a known lib ServerEvent member", () => {
    expect(KNOWN_SERVER_EVENT_TYPES.has("battle_update")).toBe(true)
  })

  it("deliberately excludes battle_damage (the bridged, still-a-gap frame)", () => {
    expect(KNOWN_SERVER_EVENT_TYPES.has("battle_damage")).toBe(false)
  })
})

describe("schemaGapNote", () => {
  it("returns null for a frame the lib's ServerEvent union models", () => {
    expect(schemaGapNote({ type: "battle_update", payload: {} })).toBeNull()
  })

  it("flags battle_damage as a gap even though the processor handles it", () => {
    const payload = {
      attacker_id: "foe",
      attacker_name: "EvilPirate",
      damage_type: "laser",
      hit_success: true,
      hull_hit: 20,
      shield_hit: 30,
      target_id: "me",
      target_name: "Pilot",
      tick: 42,
      total_damage: 50,
      weapons_fired: [],
    }
    const note = schemaGapNote({ type: "battle_damage", payload })
    expect(note).not.toBeNull()
    expect(note!.type).toBe("note")
    if (note!.type !== "note") throw new Error("unreachable")
    expect(note!.label).toBe("unknown_ws_frame")
    expect(note!.severity).toBe("warn")
    expect(note!.data).toEqual({ type: "battle_damage", payload })
  })

  it("flags a totally unknown frame as a gap, carrying its type and payload", () => {
    const note = schemaGapNote({ type: "pirate_radio", payload: { x: 1 } })
    expect(note).not.toBeNull()
    if (note!.type !== "note") throw new Error("unreachable")
    expect(note!.label).toBe("unknown_ws_frame")
    expect(note!.severity).toBe("warn")
    expect(note!.data).toEqual({ type: "pirate_radio", payload: { x: 1 } })
  })
})
