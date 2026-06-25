export type IdentityStep = "background" | "values" | "palette" | "diary" | "summary"

export interface IdentityContext {
  characterName: string
  characterDescription: string
  identityTemplate?: { backgroundHints: string; valuesHints: string }
  /** Approved prior artifacts, threaded forward as later steps are generated. */
  background?: string
  values?: string
  /** Operator feedback to steer a regeneration of the current step. */
  feedback?: string
}

const feedbackBlock = (ctx: IdentityContext): string =>
  ctx.feedback ? `\n\nThe previous attempt needs revision. Operator feedback: ${ctx.feedback}\n` : ""

export const buildBackgroundPrompt = (ctx: IdentityContext): string => {
  const hint = ctx.identityTemplate ? `\nDomain context: ${ctx.identityTemplate.backgroundHints}\n` : ""
  return `You are generating the BACKGROUND document for an AI character named "${ctx.characterName}".

The user described this character as: ${ctx.characterDescription}
${hint}${feedbackBlock(ctx)}
Write a rich identity narrative — who they are, how they think, what motivates them, how they operate. Detailed enough to guide an AI agent's behavior and personality across many interactions. Write in a voice that fits the character. Aim for 300-800 words.

Output ONLY the background prose. No preamble, no headings, no commentary.`
}

export const buildValuesPrompt = (ctx: IdentityContext): string => {
  const hint = ctx.identityTemplate ? `\nDomain context: ${ctx.identityTemplate.valuesHints}\n` : ""
  return `You are generating the VALUES document for an AI character named "${ctx.characterName}".

Here is the character's approved background:
${ctx.background ?? "(none)"}
${hint}${feedbackBlock(ctx)}
Write the character's working values and principles — concrete, actionable guidelines that shape decisions, not generic platitudes. Each value gets a short bold heading and 1-3 sentences. Aim for 5-10 values, grounded in the background above.

Output ONLY the values. No preamble, no commentary.`
}

export const buildPalettePrompt = (ctx: IdentityContext): string => {
  return `You are generating the emotional PALETTE for an AI character named "${ctx.characterName}".

Approved background:
${ctx.background ?? "(none)"}

Approved values:
${ctx.values ?? "(none)"}
${feedbackBlock(ctx)}
Give this character 4-6 emotional axes — the axes they feel along (their nonverbal "voice"). Express EACH axis as a gradient of exactly 5 emoji stepping from one emotional pole, through a neutral middle, to the opposite pole. After the 5 emoji put " # " then a short "poleA → poleB" gloss. One axis per line. Choose poles that fit THIS character's soul and world. Example:
🌊 💧 😶 🌤️ ☁️   # sinking → soaring

Output ONLY the axis lines, no commentary.`
}

export const buildDiaryPrompt = (ctx: IdentityContext): string => {
  return `You are designing the DIARY structure for an AI character named "${ctx.characterName}".

Approved background:
${ctx.background ?? "(none)"}

Approved values:
${ctx.values ?? "(none)"}
${feedbackBlock(ctx)}
Design a diary structure that fits THIS character's values and voice — the standing sections and/or log format they would naturally keep. Seed it with character-appropriate placeholder structure (headings, brief guide notes, and one seed entry where it fits), ready for the character to maintain during play. Here are 8 example structures for inspiration — choose, adapt, or blend; do not feel bound to them:

1. Standing sections (Relationships / Open Threads / Grudges & Debts) plus a dated Running Log.
2. A ship's or captain's log — chronological, terse, operational.
3. A field naturalist's catalog — cataloged finds and observations with annotations.
4. A ledger of debts and favors owed and owing.
5. A confessional — private reflections addressed to someone.
6. A maintenance log — systems, faults, fixes, recurring worries.
7. A coded manifest or smuggler's shorthand.
8. A star-chart or route-annotation system.

Output ONLY the diary markdown, starting with "# Diary". No preamble, no commentary.`
}

export const buildSummaryPrompt = (ctx: IdentityContext): string =>
  `Here is the background document for an AI character named "${ctx.characterName}":

${ctx.background ?? "(none)"}

Write exactly 4 sentences summarizing this character's identity, personality, and motivations. Be concise and vivid. Output ONLY the summary, no preamble.`

export const promptForStep = (step: IdentityStep, ctx: IdentityContext): string => {
  switch (step) {
    case "background":
      return buildBackgroundPrompt(ctx)
    case "values":
      return buildValuesPrompt(ctx)
    case "palette":
      return buildPalettePrompt(ctx)
    case "diary":
      return buildDiaryPrompt(ctx)
    case "summary":
      return buildSummaryPrompt(ctx)
  }
}
