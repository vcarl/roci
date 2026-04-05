export type ClaudeModel = "opus" | "sonnet" | "haiku"

/**
 * Base `claude -p` args that every invocation must include.
 * Note: --bare is NOT used because it disables OAuth token resolution.
 */
export function claudeBaseArgs(model: ClaudeModel): string[] {
  return ["-p", "--permission-mode", "bypassPermissions", "--model", model]
}

export class ClaudeError {
  readonly _tag = "ClaudeError"
  constructor(readonly message: string, readonly cause?: unknown) {}
  toString() { return this.message }
}
