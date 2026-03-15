/**
 * Local embedding utility — calls the BAAI/bge-small-en-v1.5 embed server at EMBED_BASE_URL.
 * Server started by start-embed.sh before fleet launch.
 * Accessible from both WSL (localhost:11435) and Windows host.
 */

const EMBED_URL = `${process.env.EMBED_BASE_URL ?? "http://localhost:11435"}/v1/embeddings`
const EMBED_MODEL = process.env.EMBED_MODEL ?? "BAAI/bge-small-en-v1.5"

/**
 * Embed a single text string. Throws if embed server is unreachable.
 */
export async function embed(text: string): Promise<number[]> {
  const resp = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  })
  if (!resp.ok) throw new Error(`Embed API ${resp.status}: ${await resp.text()}`)
  const data = await resp.json() as { data: Array<{ embedding: number[] }> }
  return data.data[0].embedding
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Return the most semantically relevant diary content for a given query.
 *
 * Splits diary by blank lines / --- separators into entries, embeds all,
 * ranks by cosine similarity to query, returns top entries up to maxChars.
 * Falls back to tail slice if embed server is unavailable.
 *
 * @param query - Current situation/goal summary to match against
 * @param diary - Full diary content string
 * @param maxChars - Max characters to return (default 2000)
 */
export async function semanticDiarySlice(
  query: string,
  diary: string,
  maxChars = 2000,
): Promise<string> {
  if (!diary.trim()) return diary

  // Split into entries (blank lines or --- separators)
  const entries = diary
    .split(/\n(?:---+|\n)/)
    .map((e) => e.trim())
    .filter((e) => e.length > 30) // skip noise

  // Short diary — return tail as-is
  if (entries.length <= 4) return diary.slice(-maxChars)

  try {
    const vecs = await Promise.all([
      embed(query.slice(0, 512)),
      ...entries.map((e) => embed(e.slice(0, 512))),
    ])
    const queryVec = vecs[0]
    const entryVecs = vecs.slice(1)

    const scored = entries
      .map((e, i) => ({ e, score: cosineSimilarity(queryVec, entryVecs[i]) }))
      .sort((a, b) => b.score - a.score)

    const result: string[] = []
    let chars = 0
    for (const { e } of scored) {
      if (chars + e.length + 2 > maxChars) break
      result.push(e)
      chars += e.length + 2
    }

    return result.join("\n\n")
  } catch {
    // Embed server unavailable — fall back to tail
    return diary.slice(-maxChars)
  }
}
