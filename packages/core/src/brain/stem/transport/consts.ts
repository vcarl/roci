/**
 * Small shared constants for the transport layer. Neutral home (brain/transport/,
 * imported only downward by cortex) so infra-tier code never has to import cortex
 * to reach a bare string it needs.
 */

/**
 * Project-local OpenCode agent name (file basename, `--agent` value). Used by
 * `payload.ts` (buildOpenCodeSessionCommand's default `--agent`) and, downward,
 * by cortex/conscious's opencode-config.ts (agent file basename) and its
 * consumers.
 */
export const CONSCIOUS_AGENT_NAME = "conscious"
