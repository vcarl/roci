// Shared test-only Effect layers for the model/cortex/limbic tier tests.
//
// These three fakes were copy-pasted verbatim across the tier test files
// (brain/cortex, brain/limbic, core/identity-gen). They only touch
// layer-neutral core modules (model client/service, logging), so they live
// here as neutral test infra imported *down* into those tests. This file is
// NOT exported from any package barrel and is never imported by production
// code — it exists solely for `*.test.ts` consumption.
import { Effect, Layer } from "effect"
import { ModelClient } from "../model/client.js"
import type { ModelHandle } from "../model/handles.js"
import { ModelService } from "../services/ModelService.js"
import { CharacterLog } from "../logging/log-writer.js"
import type { UnifiedEvent } from "../logging/events.js"

/** A ModelClient that returns a fixed body regardless of input. */
export const fixedClient = (text: string): Layer.Layer<ModelClient> =>
  Layer.succeed(
    ModelClient,
    ModelClient.of({ complete: (_h: ModelHandle) => Effect.succeed({ text, raw: {} }) }),
  )

// A ModelService whose withTier records the tier it wrapped, then runs the
// effect unchanged — lets tests assert callTier routed through withTier.
export const recordingService = (sink: string[]): Layer.Layer<ModelService> =>
  Layer.succeed(
    ModelService,
    ModelService.of({
      withTier: (tier) => (effect) => {
        sink.push(tier)
        return effect as never
      },
    }),
  )

// A CharacterLog that records every emitted event into `sink`, so tests can
// assert the raw text surfaced (e.g. the forebrain text on a parse failure).
export const recordingLog = (sink: UnifiedEvent[]): Layer.Layer<CharacterLog> =>
  Layer.succeed(
    CharacterLog,
    CharacterLog.of({
      emit: (_char, event) => {
        sink.push(event)
        return Effect.void
      },
    }),
  )

/** A CharacterLog that silently discards every event. */
export const silentLog = recordingLog([])
