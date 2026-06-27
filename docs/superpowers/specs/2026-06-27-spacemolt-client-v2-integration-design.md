# SpaceMolt domain — client-v2 integration design

**Date:** 2026-06-27
**Status:** Approved (design); ready for delegated implementation
**Worktree:** `/Users/vcarl/workspace/roci/.claude/worktrees/spacemolt-v2`

## Goal

Revise the `@roci/domain-spacemolt` domain to consume the new `@spacemolt/client-v2`
package, replacing the current raw-`ws` WebSocket integration and the deprecated
`sm` CLI. Two user-facing capabilities:

1. **CLI for the conscious mind** — the OpenCode conscious agent invokes
   `spacemolt <command>` (e.g. `spacemolt travel sol_asteroid_belt`) as a bash tool
   for all in-game *actions*.
2. **Library for the domain** — the host orchestrator uses the client-v2 library
   (`createSocket`) for the live *event/state stream* that feeds the domain's Effect
   services.

## Approved decisions

- **Migration posture: clean replacement.** Remove the raw-`ws` GameSocket impl and
  all `sm`/sm-cli provisioning. client-v2 is the only path. (Server is assumed to be
  on the v2 protocol client-v2 targets — see Open Item 2.)
- **Task split: CLI = actions, library = events.** Confirmed.
- **Auth model: move to session files.** Per-player `.spacemolt-session.json` becomes
  the source of truth, replacing `players/<name>/credentials.txt`.

## The clean seam

client-v2 exposes two transports that map onto the two tasks **and run in two
different processes**, which is what makes parallel delegation safe:

| | Transport | Process | client-v2 surface | Task |
|---|---|---|---|---|
| **Actions** | REST (`X-Session-Id`) | Docker container (OpenCode agent) | `spacemolt` CLI binary | Team A |
| **Events** | WebSocket | Host orchestrator (Effect services) | `createSocket` library | Team B |

REST session auth and WS auth are independent, so one account holds both at once with
no conflict.

## client-v2 reference (verified from the published tarball, v1.5.0)

- Package: `@spacemolt/client-v2`, ESM-only, Node 18+.
- Install source for this work:
  `/private/tmp/claude-501/-Users-vcarl-workspace-client-v2/ff220a87-7d68-4197-8938-89afc5ea9a76/scratchpad/spacemolt-client-v2-ws-b1facd8-20260627150735.tgz`
- Docs: `/Users/vcarl/workspace/client-v2/README.md`, `/Users/vcarl/workspace/client-v2/AGENTS.md`.

**CLI:** binary `spacemolt`; 269 commands across 18 tool groups. Positional or
named args (`spacemolt travel sol_asteroid_belt` or `... destination=...`). Global
flags: `--json`, `--debug`, `--session <token>`, `--version`, `-h`. Discovery via
`spacemolt help [group|command]`. Session file `.spacemolt-session.json` (override
with `SPACEMOLT_SESSION`); base URL `SPACEMOLT_URL` (default
`https://game.spacemolt.com/api/v2`). Auto-retries on rate-limit; 600s HTTP timeout
for long-poll travel/jump. `spacemolt register <username> <empire> <code>` and
`spacemolt login <username> <password>` write the session file.

**Library:** exports `createClient`, `createSession`, `createSocket`, plus 269
generated `spacemolt*` operation functions and all socket types.
- `createSession({ username, password, baseUrl? }) => Promise<{ client, sessionId }>`
  for authenticated REST ops.
- `createSocket({ auth, endpoint?, baseUrl?, wsUrl?, reconnect?, WebSocketImpl? })
  => Promise<SpacemoltSocket>`. Auth is one of `{username,password}`,
  `{loginToken}`, or `{anonymous:true}`. Returns an async-iterable + emitter with
  `events()`, `on(type, cb)`, `send(frame)`, `request(frame, {timeoutMs})`,
  `subscribeMarket()`, `subscribeObservation({activeScan})`, `status`, `close()`.
  Auto-reconnect with exponential backoff after first successful auth. One
  connection per account (a new connection kicks the old: close `4001`).
- `ServerEvent` is a discriminated union: control frames (`welcome`, `logged_in`,
  `registered`, `ok`, `result`, `error`, `action_result`, `action_error`) and
  notifications (`combat_update`, `player_died`, `scan_result`, `scan_detected`,
  `pilotless_ship`, `reconnected`, `mining_yield`, `chat_message`,
  `trade_offer_received`, `skill_level_up`, `market_update`, `observation_update`,
  `crafting_update`). Unknown frames still arrive as `RawServerFrame`.
- Node WebSocket: pass `WebSocketImpl: (await import('ws')).default` (the package
  is ESM and lazily imports `ws` if not provided).

## Current state (what gets replaced)

Host-side domain (`packages/domain-spacemolt/src/`):
- `game-socket-impl.ts` / `game-socket.ts` / `ws-types.ts` — raw `ws` connection to
  `wss://game.spacemolt.com/ws`, health polling at `/health`, custom event types.
  **Replaced by client-v2 `createSocket`.**
- `event-processor.ts` — built around `state_update` events. **Rewritten**: the
  client-v2 union has no `state_update`; state arrives via `observation_update` /
  `logged_in` plus discrete notifications.
- `register.ts` — WebSocket-based auto-registration. **Rewritten** to the
  session-file model.
- The other five service layers (`SituationClassifier`, `StateRenderer`,
  `InterruptRegistry`, `PromptBuilder`, `SkillRegistry`) keep their interfaces; only
  the event inputs they consume change.

Container-side provisioning (`packages/domain-spacemolt/src/config.ts`,
`src/docker/Dockerfile`, `src/prompts/in-game-claude.md`):
- `sm` CLI cloned from `git@github.com:vcarl/sm-cli.git` into
  `shared-resources/sm-cli`, mounted to `/work/sm-cli`, symlinked to
  `/usr/local/bin/sm`, added to `containerAddDirs`, documented in the system prompt.
  **All removed** and replaced with `spacemolt` CLI provisioning.

Auth today: `players/<name>/credentials.txt` (Username/Password lines), validated by
the `spacemolt-init` procedure. **Replaced** by per-player `.spacemolt-session.json`.

## Phase 0 — shared foundation (lands first, both teams fork from it)

Three concerns touch both tasks, so they are settled and committed **before** the
team leads start, on this worktree's HEAD:

1. **Dependency**: `pnpm add <tarball>` into `domain-spacemolt`. Pins the version
   both teams build against (the library imports it; the CLI is installed separately
   into the container image, but pinning here keeps versions aligned).
2. **Auth → session files**: define the per-player `.spacemolt-session.json`
   location under `players/<name>/`, its container mount, the registration/login
   flow, and a small **shared host-side helper** that reads a player's
   username/password (for `createSocket`) and resolves `SPACEMOLT_SESSION` /
   `SPACEMOLT_URL`. Update the `spacemolt-init` procedure to validate the new shape.
   Remove `credentials.txt` reliance.
3. **Config**: `SPACEMOLT_URL` / base-URL wiring so CLI and library target the same
   server.

## Team A — CLI for the conscious mind (container side)

**Goal:** `spacemolt` on `PATH` in the container, conscious mind uses it for actions;
all `sm`/sm-cli traces removed.

- `src/docker/Dockerfile`: `npm install -g` the client-v2 package (ships a `bin`);
  remove the `sm-cli` clone/mount/symlink machinery.
- `src/config.ts`: replace sm-cli provisioning (`spaceMoltInitProject` clone,
  `containerMounts` for `/work/sm-cli`, `containerSetup` symlink) with `spacemolt`
  setup; mount the per-player session file; set `SPACEMOLT_URL` /
  `SPACEMOLT_SESSION` env; drop `/work/sm-cli` from `containerAddDirs`.
- `src/prompts/in-game-claude.md`: rewrite the `sm` reference (~lines 73–106 and the
  line-19 mention) for `spacemolt` syntax, `--json`, `spacemolt help` discovery, and
  rate-limit behavior.
- Owns deletion of every `sm` / sm-cli reference across the package (clean
  replacement; use the `tracing-dead-code-after-deletion` skill to find them all).

**Exclusive files:** `src/docker/**`, `src/config.ts`, `src/prompts/in-game-claude.md`,
plus any `sm`-only assets. Does **not** touch host-side socket/event code.

## Team B — library for the domain (host side)

**Goal:** replace the raw-`ws` GameSocket with client-v2's library and re-map the
event stream into the existing domain services.

- Rewrite `src/game-socket-impl.ts` (and `game-socket.ts` / `ws-types.ts` as needed)
  to wrap `createSocket` — async-iterable consumption, reconnect, request/response,
  Node `ws` injection — reading credentials via the Phase-0 helper.
- Rewrite `src/event-processor.ts`: map the client-v2 `ServerEvent` union onto the
  domain's `EventResult` / `EventCategory`. Largest single work item. `state_update`
  no longer exists — derive state from `logged_in` + `observation_update` and route
  the discrete notifications.
- Rewrite `src/register.ts` to the session-file registration model.
- Keep `SituationClassifier`, `StateRenderer`, `InterruptRegistry`, `PromptBuilder`,
  `SkillRegistry` interfaces intact; adapt only their event inputs.

**Exclusive files:** `src/game-socket*.ts`, `src/ws-types.ts`,
`src/event-processor.ts`, `src/register.ts`, and the related service wiring in
`src/index.ts`. Does **not** touch the Dockerfile or container provisioning.

## Management structure

- **Lead-of-leads** (this session): takes no implementation action directly. Lands
  Phase 0 via a focused delegate, then spawns the two team leads. Owns final
  reconciliation/merge.
- **Team leads** are managers, not doers. Each owns a goal + a squad. Each
  **decomposes its task into discrete units (spec → implement → review) and
  delegates each unit to its own subagents**, then curates, reviews, and commits.
  They do not write the bulk of the code themselves.
- **Coordination / git hygiene:** all delegates work *in this worktree* (not nested
  git worktrees, which fork from a stale base). Each team commits **only its own
  exclusive file paths** with explicit `git add <paths>`; retry on transient index
  locks. File sets are disjoint, so content conflicts should not arise.

## Open items the team leads must investigate (flagged, not blocking)

1. **Registration codes:** `spacemolt register` requires a `registration_code`;
   current auto-registration is WS-based. Confirm how codes are supplied before
   wiring the new registration flow (Phase-0 / Team B).
2. **Server protocol version:** confirm the live server actually speaks the v2
   framing client-v2 targets (current code hits `/ws` + `/health`, not `/api/v2`).
   If the server is not on v2, escalate before proceeding with clean replacement.

## Definition of done

- `pnpm -F @roci/domain-spacemolt build` and the package's `vitest` suite pass.
- No remaining references to `sm` / sm-cli or raw `ws` game connection in the
  package.
- Conscious mind can run `spacemolt` commands in the container; the host domain
  receives and processes the client-v2 event stream end to end.
