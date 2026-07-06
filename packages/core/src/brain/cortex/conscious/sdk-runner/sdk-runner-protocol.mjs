// Pure wire-protocol logic for the SDK runner. No SDK import — unit-testable on the host.
// Wire protocol (versioned NDJSON, v:1):
//   host→runner: {type:"task",text} | {type:"steer",text} | {type:"end"}
//   runner→host: {type:"event",event:<SDKMessage>} | {type:"result",status,output}

/** Parse one host→runner NDJSON line. Returns null for blank/invalid/unknown lines. */
export function parseCommand(line) {
  if (!line || !line.trim()) return null
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (obj.type === "task" || obj.type === "steer") {
    return { type: obj.type, text: typeof obj.text === "string" ? obj.text : "" }
  }
  if (obj.type === "end") return { type: "end" }
  return null
}

/** Wrap text as a streaming-input SDKUserMessage. */
export function toSdkUserMessage(text) {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }
}

/** Map an SDK result message to our coarse status. */
export function statusFromResult(sdkResult) {
  return sdkResult.subtype === "success" && !sdkResult.is_error ? "completed" : "failed"
}

/** Format an SDK message as a runner→host event line. */
export function formatEventLine(sdkMessage) {
  return JSON.stringify({ v: 1, type: "event", event: sdkMessage })
}

/** Format an SDK result message as a terminal runner→host result line. */
export function formatResultLine(sdkResult) {
  return JSON.stringify({
    v: 1,
    type: "result",
    status: statusFromResult(sdkResult),
    output: sdkResult.result ?? "",
  })
}
