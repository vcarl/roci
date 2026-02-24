import { Context, Effect, Layer } from "effect"
import { SpaceMoltAPI } from "../../../harness/src/api/client.js"
import {
  collectGameState,
  collectSocialState,
  fetchGalaxyMap,
} from "../../../harness/src/situation/state-collector.js"
import { classifySituation } from "../../../harness/src/situation/classifier.js"
import { detectAlerts } from "../../../harness/src/situation/alerts.js"
import {
  generateBriefing,
  formatAlerts,
  formatSocialBriefing,
} from "../../../harness/src/context/briefing.js"
import type {
  Credentials,
  GameState,
  Situation,
  SocialState,
  GalaxyMap,
} from "../../../harness/src/types.js"

export class GameApiError {
  readonly _tag = "GameApiError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

export class GameApi extends Context.Tag("GameApi")<
  GameApi,
  {
    readonly login: (creds: Credentials) => Effect.Effect<void, GameApiError>
    readonly collectState: () => Effect.Effect<GameState, GameApiError>
    readonly collectSocial: () => Effect.Effect<SocialState, GameApiError>
    readonly fetchMap: () => Effect.Effect<GalaxyMap, GameApiError>
    readonly classify: (state: GameState) => Situation
    readonly briefing: (state: GameState, situation: Situation, galaxyMap?: GalaxyMap) => string
    readonly formatAlerts: (situation: Situation) => string
    readonly formatSocial: (social: SocialState) => string
  }
>() {}

const GAME_API_URL = "https://game.spacemolt.com/api/v1"

export const makeGameApiLive = (apiUrl?: string) =>
  Layer.succeed(
    GameApi,
    (() => {
      const api = new SpaceMoltAPI(apiUrl ?? GAME_API_URL)

      return GameApi.of({
        login: (creds) =>
          Effect.tryPromise({
            try: async () => {
              api.setCredentials(creds)
              await api.execute("login", {
                username: creds.username,
                password: creds.password,
              })
            },
            catch: (e) => new GameApiError("Login failed", e),
          }),

        collectState: () =>
          Effect.tryPromise({
            try: () => collectGameState(api),
            catch: (e) => new GameApiError("Failed to collect game state", e),
          }),

        collectSocial: () =>
          Effect.tryPromise({
            try: () => collectSocialState(api),
            catch: (e) => new GameApiError("Failed to collect social state", e),
          }),

        fetchMap: () =>
          Effect.tryPromise({
            try: () => fetchGalaxyMap(api),
            catch: (e) => new GameApiError("Failed to fetch galaxy map", e),
          }),

        classify: (state) => {
          const situation = classifySituation(state)
          situation.alerts = detectAlerts(state, situation)
          return situation
        },

        briefing: (state, situation, galaxyMap) =>
          generateBriefing(state, situation, galaxyMap),

        formatAlerts: (situation) => formatAlerts(situation.alerts),

        formatSocial: (social) => formatSocialBriefing(social),
      })
    })(),
  )
