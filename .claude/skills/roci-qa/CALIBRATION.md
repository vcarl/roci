<!-- .claude/skills/roci-qa/CALIBRATION.md -->
# roci-qa calibration log

Each QA session appends one dated entry: observations → decided changes → applied/queued.
New named anomaly detectors and threshold changes are born here (the dogfood loop).

<!-- template:
## YYYY-MM-DD — <char>/<domain>

**Observations:** ...
**Misses → new detector:** ...
**False positives → threshold/narration change:** ...
**Digest blind spots → new field:** ...
**Status:** applied | queued
-->

## 2026-06-21 — kvothe/spacemolt (first live triple-dogfood run)

First real wiring of app + qa-monitor + skill together. Run did **not** reach a clean
multi-tick session: it died on **tick 1** at the first hindbrain model call, so the monitor was
never launched live and **no `run-digest.json` / baseline** was produced. The happy path *up to*
the first model call is healthy — token validates in-container, WebSocket login as `kvothe in
"First Step"` succeeds, loop reaches phase `active` with real game state (`docked fuel:51%
hull:100% cargo:9/75`). 13 events captured in `players/kvothe/logs/events.jsonl` (a useful
crash/PROCESS_DIED fixture). Two blocking app bugs found en route; the bridge and digest are
still largely **unexercised** pending a clean run.

### App findings (cortex/orchestrator)

- **Bug A — firewall strict-mode kills the container, misreported as bad token.**
  `init-firewall.sh` runs `set -euo pipefail`; it dies on `ERROR: Failed to resolve
  statsig.anthropic.com` (telemetry domain; `api.anthropic.com` resolves fine). Script exits →
  `&& sleep infinity` never runs → container exits (code 1) → orchestrator's `docker exec`
  token-validation gets **exit 137** and surfaces it as *"OAuth token is not valid inside
  container"* (`orchestrator.ts:127`, `OAuthToken.ts:84`). Token is actually valid (proved via
  firewall-bypassed `docker run … claude -p ping` → "Pong!"). **Fixes:** (1) make non-essential
  domains (statsig/sentry) non-fatal in `init-firewall.sh` (resolve in a `|| true` block, not
  under `pipefail`); (2) in `validateInContainer`, distinguish "container not running / exec
  137" from "auth rejected" so the error message is truthful. Worked around this run with the
  supported `SKIP_FIREWALL=1` (plumbed at `orchestrator.ts:49`).
- **Bug B — hindbrain default is a reasoning model; loop fatals on tick 1.** Default hindbrain =
  `mlx-community/Qwen3.5-9B-4bit` (`handles.ts:48`), a reasoning model. Under the real triage
  prompt it spends its token budget on `message.reasoning` and returns empty `message.content`;
  the client throws `malformed response: missing choices[0].message.content` → loop fatal. **No
  runtime override exists** — `cortexModels` is never populated anywhere, so `loop.ts:96` always
  falls back to `DEFAULT_CORTEX_MODELS`. **Fixes:** (1) cortex client tolerates reasoning-only
  responses (adequate `max_tokens` / read `content` after `reasoning`); and/or (2) add a
  runtime cortex-tier override path (file/env/flag) mirroring the frontier `--tier-*` flags;
  and/or (3) pin non-reasoning instruct defaults for the local tiers.

### Misses → new/changed detectors (`apps/roci/src/qa/markers.ts`)

- **Loop-killing errors escape ERROR.** `Fatal error: Model call failed …` is `kind:"system"`
  but matches no regex, so it does **not** trip ERROR — only `--session-pid` PROCESS_DIED caught
  the death. Broaden the prime candidate `/^event error:/` to also cover `/^Fatal error:/` and
  `/Model call failed/` (and `diary write failed:`). **New detector candidate.**
- **Phase transitions are not classified.** Orchestrator `Entering phase: <x>` lifecycle lines
  match nothing, so no TRANSITION beat fires for startup→active. If the design wants phase beats
  narrated (per §3 "narrate the beat"), add `^Entering phase: (\w+)$` → TRANSITION. **Decision
  needed: is the intended "transition" the OODA marker set only, or also orchestrator phases?**

### False positives / chattiness

- N/A this run — the monitor never ran live (no clean session to observe). Re-assess next run.

### Digest blind spots → new field (`apps/roci/src/qa/digest.ts`)

- A crashed run is indistinguishable from a clean one in the fingerprint: the tick-1 fatal is
  `kind:"system"`/unclassified, so it folds into nothing. Add a **terminal-cause field**
  (`terminalError` / `diedAtTick` / `exitReason`) so digests/baselines can tell "completed" from
  "died at tick 1 on a model error." Also still missing tier-health + latency (known).

### Skill / playbook fixes (`.claude/skills/roci-qa/SKILL.md`)

- **§1 preflight — add an on-disk identity check.** `players/` is gitignored (`.gitignore:16`),
  so it's empty in a fresh worktree. Verify `players/<char>/me/{background,VALUES,DIARY}.md`
  exist before launch; none did (had to copy `kvothe` in from `testbench/roci-testing`).
- **§2 launch snippet — `npx tsx …` fails.** `tsx` is only installed under `apps/roci`. Use
  `apps/roci/node_modules/.bin/tsx <script>` or `npx --prefix apps/roci tsx <script>` (the repo's
  `./roci` wrapper already does the prefix). Applies to both the session and the monitor commands.
- **§2 — wrong `--session-pid`.** As written the snippet pipes through `tee`, so `$!` is tee's
  PID, not the session's → PROCESS_DIED never fires. Capture the real PID via
  `pgrep -f "main.ts start <char>"` after launch. (Also the snippet omits the backgrounding `&`.)
- **Setup gap — config.json membership required.** A copied-in identity must also be added to
  `config.json` under `<domain>.characters[]`; `resolveConfigs` intersects the char arg with
  config.json, else "No domains/characters matched." Had to add `kvothe`.
- **Setup gap — token filename.** Orchestrator loads `<projectRoot>/.oauth-token`, but the repo
  ships the token as `auth-token` (different name). Preflight should check/copy `auth-token →
  .oauth-token`.
- **§1 — firewall awareness.** On a host that can't resolve every firewall domain, the session
  dies at validation with a misleading message (Bug A). Preflight should test the firewall path
  or recommend `SKIP_FIREWALL=1` for local runs.
- **Step-1 tier smoke false-fails reasoning models.** `client.smoke.test.ts` uses too small a
  `max_tokens`; reasoning models exhaust it on `reasoning` and report "missing content" though
  they're healthy with adequate budget (all 3 tiers false-failed). Bump the smoke budget or pin
  non-reasoning smoke models; the skill should not treat that smoke failure as a hard stop
  without checking the token budget. (This is the same root cause as Bug B.)
- **Monitor reads from offset 0**, not tail — it replays a pre-existing `events.jsonl` as fresh
  beats. The skill should say to start against a fresh/empty events file (done manually here), or
  the monitor should support `--from-end`.

**Status:** partially applied.
- **Bug A (firewall strict-mode → misreported token): APPLIED** (2026-06-21, parallel fix
  session). All three `init-firewall.sh` copies split essential vs non-essential telemetry
  domains (statsig/sentry resolve best-effort outside `pipefail`); `OAuthToken.ts` gained
  `classifyValidationResult()` + `isContainerRunning()` and the orchestrator now reports
  container-down truthfully instead of blaming the token. Covered by `OAuthToken.test.ts` (7) +
  `init-firewall.test.ts` (9). Not yet proven on a real Docker run — next QA pass exercises it.
- **Bug B (reasoning-model hindbrain → tick-1 fatal): APPLIED** (2026-06-21, same session).
  `client.ts` tolerates reasoning-only responses (`content` → `reasoning` → `reasoning_content`,
  still fails loudly if none yield text); `handles.ts` pins `maxTokens` on all local tiers.
  Covered by `client.test.ts`, `handles.test.ts`, `tiers.test.ts` regression. Runtime cortex-tier
  override path (fix candidate 2) **deferred** as a follow-up (orchestrator-level). Not yet proven
  against a live MLX server — next QA pass exercises it.
- **Still queued** (not worked this round, candidates for a future session): the detector changes
  (`markers.ts` — `Fatal error:` / `Model call failed` / phase-transition classification), the
  digest terminal-cause field, and the SKILL.md playbook fixes. Treat with normal TDD/review
  discipline.

## 2026-06-21 (run 2) — kvothe/spacemolt (first clean multi-tick run)

With Bug A + Bug B applied, the session **cleared tick 1 for the first time** and exercised the
full ladder live: hindbrain → forebrain → conscious(plan) → body(`opencode run` in container).
Both fixes validated on metal (firewall ON, truthful token validation; hindbrain `accumulate`,
no tick-1 fatal). The run ended in a **self-inflicted `PROCESS_DIED`** (see methodology miss).

**New product finding → forebrain reasoning-model parse failure (same family as Bug B, one tier up).**
`GLM-4.7-Flash-4bit` (forebrain default, `handles.ts`) is a **reasoning model**. Its chain-of-thought
length is highly variable; when it exceeds the 4096 `maxTokens` budget the model hits `finish=length`
with `completion_tokens=4096`, `content=""`, and never emits the OrientResult JSON → `parseOr`
fallback `"Orient parse failure — situation unknown"` (`tiers.ts:105`). Directly observed: 2/6 warm
probes failed this way (reasoningLen 7465 / 13226), 4/6 passed (`finish=stop`, reasoning ~5.4–6.3k +
content ~1.0–1.2k). **The Bug-B `content→reasoning` client fallback does NOT rescue this** — the
reasoning prose isn't JSON (`Unterminated fractional number`). Fix candidates (deferred to the new
tack): pin a non-reasoning instruct model for forebrain (Qwen2.5-32B-Instruct / Mistral-Small-Instruct
are on :8082), and/or strip reasoning + raise/budget tokens, and/or add a parse-failure retry.

**New product finding → transient cortex transport errors hard-fatal the session.** Cold/uncached
forebrain calls are slow (`firstForebrainMs` 130s; an uncontended cold probe exceeded 240s). When a
forebrain `fetch` outruns the transport, the resulting `fetch failed` fatals the loop with **no
retry/backoff**. Ties to the queued `markers.ts` note that `Model call failed` escapes the ERROR
detector. Fix candidate (new tack): retry/backoff + timeout tolerance around `callTier`.

**Methodology miss (QA discipline) → never load-test a server the live session depends on.** The
local MLX servers **serialize** inference. A repro batch of heavy 4096-token orient probes against
:8082 contended with the live forebrain call → `fetch failed` → killed the live session (the
`PROCESS_DIED` above). Run repros only when no session is live, or against a separate instance/port.

**Monitor calibration applied this run.** `--stall-multiple 20` (≈10-min threshold at a 30s tick)
**eliminated the false STALLs** that fired last check-in on slow conscious/body ticks, while still
catching the real `PROCESS_DIED` and writing `run-digest.json`. Confirmed-good change; the monitor
default stall-multiple should rise (conscious + body steps routinely exceed 2× tick). Still unflagged:
`hindbrain:` dispositions, `loop_start`, `Entering phase:` (FOREBRAIN/DECISION/STEP_START do classify).

**Status:** forebrain/hindbrain fix **APPLIED** via the chosen tack — swap structured-output tiers
to non-reasoning instruct models (`handles.ts`): hindbrain → `Qwen2.5-7B-Instruct-4bit`, forebrain →
`Qwen2.5-32B-Instruct-4bit`. Verified empirically before the swap (both candidates: `finish=stop`,
`reasoningLen=0`, JSON parses). conscious left as the reasoning model `Qwen3.5-122B-A10B-4bit` by
decision (designated deep-reasoner, 8192 budget, held up in the run). Guarded by a new
`handles.test.ts` regression (structured tiers must be instruct, not a known reasoning model);
full suite 252 passed. **Not yet proven multi-tick on metal** — next QA pass validates the live
forebrain orient no longer hits the parse-failure fallback. Still **deferred**: transport
retry/backoff for the fetch-failed-fatal gap, and the `markers.ts` ERROR-detector additions. Repro
artifacts (`players/kvothe/qa/repro-orient.ts`, `repro-out.txt`) discarded.
