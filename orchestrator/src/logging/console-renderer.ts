import { Effect } from "effect"

/** Simple multi-character console renderer. Prefixes each line with the character name. */
export const logToConsole = (
  character: string,
  source: string,
  message: string,
) =>
  Effect.sync(() => {
    const prefix = `[${character}:${source}]`
    for (const line of message.split("\n")) {
      console.log(`${prefix} ${line}`)
    }
  })
