/**
 * The emotional palette — a character's nonverbal "voice." Each line is one
 * emotional axis expressed as a 5-emoji gradient from one pole through the
 * middle to the other; the hindbrain paints its gut reaction by picking a
 * position along the gradient (repeat an emoji for intensity) rather than with
 * words. Characters get a personalized palette generated at creation time
 * (identity-gen); this seed is the graceful-degradation default and the eval
 * reference.
 */
export const TEMPLATE_PALETTE = `🌊 💧 😶 🌤️ ☁️   # sinking → soaring
😱 😟 😐 🙂 😌   # panic → calm
🔥 😤 😐 🧘 🥶   # fury → numb
🏙️ 🚶 😐 🛖 🌲   # stir → stillness
👶 🤩 😐 😪 🧓   # wonder → weariness`

/** Wrap a palette body in the human-readable PALETTE.md file header. */
export const paletteFile = (body: string): string =>
  `# Palette
<!-- This character's emotional voice — the axes they feel along. Each row is a
     5-emoji gradient from one pole to the other. Paint feelings by picking the
     position along the gradient that fits; repeat an emoji to show intensity
     (😟😟😟 = deep toward that pole); mix axes when a feeling is tangled. -->

${body.trim()}
`
