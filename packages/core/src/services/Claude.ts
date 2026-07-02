export type ClaudeModel = "opus" | "sonnet" | "haiku"

export class ClaudeError {
  readonly _tag = "ClaudeError"
  constructor(readonly message: string, readonly cause?: unknown) {}
  toString() { return this.message }
}
