import { Effect } from "effect"
import type { AgentIdentity } from "../../core/agent-identity.js"
import { CharacterFs, type CharacterConfig } from "../../services/CharacterFs.js"
import type { Credentials } from "../../../../harness/src/types.js"

/**
 * Wraps CharacterConfig + CharacterFs into the generic AgentIdentity interface.
 */
export class SpaceMoltAgentIdentity implements AgentIdentity {
  readonly name: string
  readonly dir: string

  constructor(
    private readonly char: CharacterConfig,
    private readonly charFs: {
      readDiary: (char: CharacterConfig) => Effect.Effect<string, unknown>
      writeDiary: (char: CharacterConfig, content: string) => Effect.Effect<void, unknown>
      readBackground: (char: CharacterConfig) => Effect.Effect<string, unknown>
      readValues: (char: CharacterConfig) => Effect.Effect<string, unknown>
      readCredentials: (char: CharacterConfig) => Effect.Effect<Credentials, unknown>
    },
  ) {
    this.name = char.name
    this.dir = char.dir
  }

  readMemory(): Effect.Effect<string, unknown> {
    return this.charFs.readDiary(this.char)
  }

  writeMemory(content: string): Effect.Effect<void, unknown> {
    return this.charFs.writeDiary(this.char, content)
  }

  readBackground(): Effect.Effect<string, unknown> {
    return this.charFs.readBackground(this.char)
  }

  readValues(): Effect.Effect<string, unknown> {
    return this.charFs.readValues(this.char)
  }

  readCredentials(): Effect.Effect<Credentials, unknown> {
    return this.charFs.readCredentials(this.char)
  }

  /** Access the underlying CharacterConfig for domain-specific code. */
  get characterConfig(): CharacterConfig {
    return this.char
  }
}
