export type ClaudeModel = "opus" | "sonnet" | "haiku"

/**
 * Base `claude -p` args that every invocation must include.
 * Ensures bare mode (no hooks/LSP/CLAUDE.md) and bypassed permissions.
 */
export function claudeBaseArgs(model: ClaudeModel): string[] {
  return ["-p", "--bare", "--permission-mode", "bypassPermissions", "--model", model]
}

export class ClaudeError {
  readonly _tag = "ClaudeError"
  constructor(readonly message: string, readonly cause?: unknown) {}
  toString() { return this.message }
}
