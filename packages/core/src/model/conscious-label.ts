import type { ModelHandle } from "./handles.js"

/** OpenCode provider id for the local host model server. */
export const CONSCIOUS_PROVIDER_ID = "local"

/**
 * The `-m` label opencode resolves: `<provider>/<real-model-id>`. opencode splits the
 * provider on the FIRST slash, so the multi-slash real id (e.g.
 * `mlx-community/Qwen3.5-122B-A10B-4bit`) is preserved as the model part and the API
 * `model` field sent to mlx is the real id. This MUST match the provider map key
 * registered in `buildProviderConfigJson`.
 */
export const consciousModelLabel = (handle: ModelHandle): string =>
  `${CONSCIOUS_PROVIDER_ID}/${handle.model}`
