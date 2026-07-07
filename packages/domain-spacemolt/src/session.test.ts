import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  SPACEMOLT_URL_DEFAULT,
  SESSION_FILE_NAME,
  spaceMoltUrl,
  spaceMoltSocketBaseUrl,
  spaceMoltUserAgent,
  sessionFilePath,
  containerSessionPath,
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

  it("maps to the container players mount", () => {
    expect(containerSessionPath("Dust")).toBe(`/work/players/Dust/me/${SESSION_FILE_NAME}`)
  })
})

describe("SPACEMOLT_URL wiring", () => {
  const prev = process.env.SPACEMOLT_URL
  afterEach(() => {
    if (prev === undefined) delete process.env.SPACEMOLT_URL
    else process.env.SPACEMOLT_URL = prev
  })

  it("defaults to the v2 API base URL", () => {
    delete process.env.SPACEMOLT_URL
    expect(spaceMoltUrl()).toBe(SPACEMOLT_URL_DEFAULT)
  })

  it("honors the env override", () => {
    process.env.SPACEMOLT_URL = "https://staging.spacemolt.com/api/v2"
    expect(spaceMoltUrl()).toBe("https://staging.spacemolt.com/api/v2")
  })

  it("derives the socket origin without the /api/v2 path", () => {
    delete process.env.SPACEMOLT_URL
    expect(spaceMoltSocketBaseUrl()).toBe("https://game.spacemolt.com")
  })
})

describe("SPACEMOLT_USER_AGENT wiring", () => {
  const prev = process.env.SPACEMOLT_USER_AGENT
  afterEach(() => {
    if (prev === undefined) delete process.env.SPACEMOLT_USER_AGENT
    else process.env.SPACEMOLT_USER_AGENT = prev
  })

  it("defaults to the roci client identifier", () => {
    delete process.env.SPACEMOLT_USER_AGENT
    expect(spaceMoltUserAgent()).toBe("roci")
  })

  it("honors the env override", () => {
    process.env.SPACEMOLT_USER_AGENT = "roci/0.1.0"
    expect(spaceMoltUserAgent()).toBe("roci/0.1.0")
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
