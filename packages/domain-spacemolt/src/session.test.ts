import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  SPACEMOLT_URL_DEFAULT,
  SESSION_FILE_NAME,
  spaceMoltUrl,
  spaceMoltWsUrl,
  sessionFilePath,
  validateSessionFile,
  readPlayerCredentials,
  SessionFileError,
} from "./session.js"

const validFile = (active: string, accounts: Record<string, unknown>) =>
  JSON.stringify({ version: 2, activeAccount: active, accounts })

describe("session paths", () => {
  it("resolves the host session file path under players/<name>/me", () => {
    expect(sessionFilePath("/proj", "Dust")).toBe(
      path.resolve("/proj", "players", "Dust", "me", SESSION_FILE_NAME),
    )
  })
})

describe("SPACEMOLT_URL wiring", () => {
  const prev = process.env.SPACEMOLT_URL
  afterEach(() => {
    if (prev === undefined) delete process.env.SPACEMOLT_URL
    else process.env.SPACEMOLT_URL = prev
    delete process.env.SPACEMOLT_WS_URL
  })

  it("defaults to the v2 API base URL", () => {
    delete process.env.SPACEMOLT_URL
    expect(spaceMoltUrl()).toBe(SPACEMOLT_URL_DEFAULT)
  })

  it("honors the env override", () => {
    process.env.SPACEMOLT_URL = "https://staging.spacemolt.com/api/v2"
    expect(spaceMoltUrl()).toBe("https://staging.spacemolt.com/api/v2")
  })

  it("derives the library's wss /ws/v2 URL from the same base", () => {
    delete process.env.SPACEMOLT_WS_URL
    expect(spaceMoltWsUrl()).toBe("wss://game.spacemolt.com/ws/v2")
  })

  it("downgrades to ws:// for an http base (local gameserver)", () => {
    delete process.env.SPACEMOLT_WS_URL
    process.env.SPACEMOLT_URL = "http://localhost:8080/api/v2"
    expect(spaceMoltWsUrl()).toBe("ws://localhost:8080/ws/v2")
  })

  it("honors an outright SPACEMOLT_WS_URL override", () => {
    process.env.SPACEMOLT_WS_URL = "wss://staging.example/ws/v2"
    expect(spaceMoltWsUrl()).toBe("wss://staging.example/ws/v2")
    delete process.env.SPACEMOLT_WS_URL
  })
})

describe("session file validation + credential reads", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "sm-session-"))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const write = (player: string, contents: string) => {
    const file = sessionFilePath(root, player)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
    return file
  }

  it("accepts a valid active account", () => {
    const file = write("Dust", validFile("dust", { dust: { username: "dust", password: "pw" } }))
    expect(validateSessionFile(file)).toEqual({ ok: true, username: "dust" })
  })

  it("falls back to the sole account when no activeAccount", () => {
    const file = write("Dust", JSON.stringify({ version: 2, accounts: { dust: { username: "dust", password: "pw" } } }))
    expect(validateSessionFile(file)).toEqual({ ok: true, username: "dust" })
  })

  it("reports a missing file", () => {
    const res = validateSessionFile(sessionFilePath(root, "Nobody"))
    expect(res).toEqual({ ok: false, reason: "session file not found" })
  })

  it("rejects wrong version", () => {
    const file = write("Dust", JSON.stringify({ version: 1, accounts: {} }))
    expect(validateSessionFile(file).ok).toBe(false)
  })

  it("rejects an account missing the password", () => {
    const file = write("Dust", validFile("dust", { dust: { username: "dust" } }))
    const res = validateSessionFile(file)
    expect(res).toEqual({ ok: false, reason: "account missing password" })
  })

  it("rejects invalid JSON", () => {
    const file = write("Dust", "{not json")
    expect(validateSessionFile(file).ok).toBe(false)
  })

  it("reads username/password for createSocket", () => {
    write("Dust", validFile("dust", { dust: { username: "dust", password: "s3cret" } }))
    expect(readPlayerCredentials(root, "Dust")).toEqual({ username: "dust", password: "s3cret" })
  })

  it("throws SessionFileError when the file is missing", () => {
    expect(() => readPlayerCredentials(root, "Nobody")).toThrow(SessionFileError)
  })
})
