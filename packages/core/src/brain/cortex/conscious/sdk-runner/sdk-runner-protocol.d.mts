export function parseCommand(line: string): { type: "task" | "steer"; text: string } | { type: "end" } | null
export function toSdkUserMessage(text: string): {
  type: "user"
  message: { role: "user"; content: string }
  parent_tool_use_id: null
}
export function statusFromResult(sdkResult: object): "completed" | "failed"
export function formatEventLine(sdkMessage: object): string
export function formatResultLine(sdkResult: object): string
