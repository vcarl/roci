import { Effect } from "effect"
import * as readline from "node:readline"

/** Prompt the user for a line of input. */
export const askUser = (question: string): Effect.Effect<string> =>
  Effect.async<string>((resume) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resume(Effect.succeed(answer.trim()))
    })
  })
