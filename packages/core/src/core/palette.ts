/**
 * The emotional palette — a character's nonverbal "voice." Each line is an
 * emoji pole-pair (the axes a character feels along); the hindbrain paints its
 * gut reaction as runs of these emoji rather than words. Characters get a
 * personalized palette generated at creation time (character-scaffold.ts); this
 * seed is the graceful-degradation default and the eval reference.
 */
export const TEMPLATE_PALETTE = `🌊 ↔ ☁️   # sinking ↔ soaring
😊 ↔ 😢   # joy ↔ sorrow
🏙️ ↔ 🌲   # stir ↔ stillness
👶 ↔ 🧓   # wonder ↔ weariness
🔥 ↔ 🧊   # fury ↔ numbness`

/** Wrap a palette body in the human-readable PALETTE.md file header. */
export const paletteFile = (body: string): string =>
  `# Palette
<!-- This character's emotional voice — the axes they feel along. They paint
     feelings as runs of these emoji: lean toward a pole for where they are,
     more emoji = felt harder, mix poles when it's tangled. -->

${body.trim()}
`
