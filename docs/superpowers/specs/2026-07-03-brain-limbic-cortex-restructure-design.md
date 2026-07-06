# brain/ restructure — limbic + cortex under one processing-depth hierarchy

- **Status:** DECIDED (structure + wiring), behavior-preserving. Not yet implemented.
- **Branch base:** `feat/wm` @ `b7b4ca6` (the branch's live tip).
- **⚠️ Base-label correction (post-implementation):** earlier revisions of this spec labeled the base `e917ab4`. The refactor's true git base is `b7b4ca6` = `feat/wm`'s current tip; `e917ab4` is a *divergent* line (shares only `bbc4721` with the branch). The features attributed to `e917ab4` below (non-blocking deliberation, SYNTHESIS-as-memory-index, wm prune, dream size-gate) all exist on the real base as equivalent commits, so the migration map, path verification, and behavior-preservation all hold against `b7b4ca6`. The historical `e917ab4`/`fa03736` references in §5–§5.5 and §7 below are retained as the original analysis narrative — read them as describing the equivalent feat/wm-tip state.
- **Rebase history:** first written against `bbc4721` (orphaned at `1d45196`), rewritten onto `fa03736`, now rebased onto `e917ab4`. The `fa03736..e917ab4` deltas (5 commits) are integrated in §5.5; the `bbc4721..fa03736` deltas remain in §5. **Path re-verification at `e917ab4`:** the migration map's source paths are all un-drifted — the memory cluster + wm + growth-store + identity-context + install-cli are still under `conscious/`, the four limbic subdirs (`amygdala`, `hippocampus`, `hypothalamus`, `thalamus`) are intact, `cortex/{loop,tiers,state,parse}.ts` and `skills/{observe,orient,decide,evaluate,diary,consolidate}.md` are all present. (Individual "verified on `fa03736`" notes below still hold; they were spot-re-confirmed at `e917ab4`.)
- **Scope guard:** this is a *directory + import-wiring* refactor. Which model runs which work does **not** change. `DEFAULT_CORTEX_MODELS` is untouched. The tier identifiers `hindbrain` / `forebrain` / `conscious` are **not** renamed this pass. No new behavior, no new files beyond the doc moves listed here.

---

## 1. Motivation

The cognition stack today is laid out along **two orthogonal axes that don't line up on disk**:

1. **Model tiers** (`CortexTier = "hindbrain" | "forebrain" | "conscious"`, `packages/core/src/model/handles.ts:2`) — *which* local mlx model does a unit of work.
2. **Limbic subsystems** (`packages/core/src/core/limbic/{thalamus,amygdala,hypothalamus,hippocampus}`) — biological-metaphor grouping of pre-conscious functions.

Plus a third, free-floating group: the OODA skill prompts (`packages/core/src/skills/{observe,orient,decide,evaluate,diary}.md`) and the tick engine itself (`packages/core/src/cortex/`), which today is named "cortex" but actually contains the *whole* loop — orchestration, all three tiers' runners, and the conscious executor wiring.

The result: the word "cortex" means "the entire engine," the word "working memory" is overloaded (the hippocampus doc calls itself the "working-memory tier" while a genuinely-new procedural working-memory subsystem `wm/` lives under `conscious/`), and there is no single place in the tree that reads as "reflexive vs. integrative vs. deliberative."

**Goal:** collapse all of the above into ONE processing-depth hierarchy — **reflexive → integrative → deliberative** — under a new `brain/` root, so the directory structure *is* the mental model. The limbic→cortex boundary becomes exactly the **orient→decide seam**: everything up to and including "orient" is pre-conscious (limbic); "decide / evaluate / execute" is conscious (cortex).

This is deliberately behavior-preserving so the diff is reviewable as pure motion + re-wiring, decoupled from the (later) tier-rename and any semantic change.

---

## 2. Target structure

Root: `packages/core/src/brain/`.

```
brain/
├── loop         tick orchestrator (today's runCortex, cortex/loop.ts) — drives limbic→cortex, forks orient→decide off-fiber and applies on land; owns all mutation, no cognition of its own
├── transport    SHARED docker-exec turn plumbing (base runTurn + payload + transport helpers),
│                 used by BOTH limbic memory turns AND the cortex executor
├── limbic/                    pre-conscious
│   ├── amygdala      reflexive (2B)    threat detection / interrupt safety-rail
│   ├── autonomic     reflexive (2B)    tempo · cadence · drives  (assembled, see §4.2)
│   ├── thalamus      integrative (9B)  relay · classification · situation summary
│   ├── hippocampus/           integrative (9B)  ALL memory formation + retrieval — owned here, not conscious
│   │   ├── (dream / retrospect / macro / synthesis-bootstrap)  episodic/narrative memory + growth stages
│   │   ├── memory/            long-term vector store: gateway, longterm-store, memory CLI, embed/sql/format/args
│   │   ├── growth-store       on-disk growth-proposal store (skill create/revise/retire proposals in `proposals.jsonl`; also emits the SYNTHESIS memory index on macro adjudication)
│   │   └── identity-context   orient-injection assembly seam (reads memory + wm; feeds the loop)
│   └── wm/                    WORKING (procedural / intent) memory: plan/todo state machine (wm.json / WM.md)
└── cortex/                    conscious  (REDEFINED from "the whole engine" to "the conscious layer only")
    └── conscious    deliberative (31B) decide · evaluate · tool-using OpenCode session executor
```

Reading it top-to-bottom: the loop conducts; below it, processing gets deeper from reflexive rails (amygdala/autonomic, 2B) through integrative relay + memory (thalamus/hippocampus/wm, 9B) to the deliberative conscious layer (31B). **Memory formation and retrieval belong to the hippocampus, not to the conscious system** (design ruling) — so the entire memory cluster and the identity-context assembly seam live under `brain/limbic/hippocampus/`, and the conscious executor reaches memory only through the in-container `memory` CLI subprocess (§4.4), never by importing memory host code.

> **Naming note (current tree vs. target).** Limbic today lives at `packages/core/src/core/limbic/` (nested under an extra `core/`), the engine at `packages/core/src/cortex/`, and the conscious-tier files at `packages/core/src/conscious/`. The target flattens all three under `packages/core/src/brain/`. Absolute source prefixes in the migration map (§6) are therefore `packages/core/src/…`, not the bare paths in the sketch above.

---

## 3. Locked decisions

These are firm. State them as constraints for the implementer; do not relitigate.

### 3.1 Ownership / dependency direction

`brain/loop` resolves **two layer facades — `Limbic` and `Cortex`** — instead of today's direct resolution of the individual limbic tags.

- Today the loop reaches in and resolves `EventProcessorTag`, `SituationClassifierTag`, `InterruptRegistryTag` directly (`cortex/loop.ts:9-11`, resolved at `loop.ts:148-150`). After the refactor those become internals of the **Limbic** facade; the loop resolves one Limbic interface and one Cortex interface.
- Each layer **composes its own subsystems** and exposes exactly one interface upward.
- **Limbic and cortex do NOT depend on each other.** The loop mediates the orient→decide handoff. This is the load-bearing invariant of the whole refactor: it is what makes "the limbic→cortex boundary = the orient→decide seam" true in the import graph, not just on paper.
- **The orient→decide handoff runs as a forked, non-blocking fiber — and this STRENGTHENS the invariant, not weakens it** (integrated from `4a76121`). As of `4a76121` the idle-path deliberation (forebrain `orient` → `memory.recall` → conscious `decide`) no longer runs inline on the tick fiber; the loop forks it into a background `deliberationFiber` (mirroring the existing `consciousFiber` body-turn fork/poll/join) so a slow decide can't blind the reflex loop (event drain, amygdala criticals, hindbrain triage). Crucially for *this* refactor, the fork is assembled and owned entirely by **`brain/loop`**:
  - `runDeliberation(snapshot)` (`loop.ts:351`) is a closure **in the loop module** that composes `readIdentityContext → runForebrain (orient, limbic) → runConsciousDecide (decide, cortex)` and returns a **pure `DeliberationResult` (`{ orient, decide }`)** — it never mutates `cortex.*`, `state`, episode context, wm, or skills.
  - `applyDeliberation(outcome)` (`loop.ts:416`) runs back **on the loop fiber** and does all seeding (`seedWmPlan`, plan/skill/episode). ALL loop-state mutation stays on the loop fiber, at fork time (snapshot) and land time (apply).
  - So limbic (orient) and cortex (decide) are still composed *by the loop*, never by each other — the fork closure is the composition point, exactly as the inline critical section was. `brain/loop` still **owns orchestration and all mutation**; the two facades still expose pure computation upward. The escalation ladder governs the in-flight deliberation (reorient/interrupt kills it; a stale landed plan is discarded), which is loop-owned control flow. Nothing about the fork changes the limbic/cortex ownership split or introduces a limbic↔cortex edge.
- **Memory formation and retrieval are hippocampus-owned, not shared and not cortex** (design ruling). The whole memory cluster (gateway, long-term store, the `memory` CLI host code, embed/sql/format/args) moves *down* into `brain/limbic/hippocampus/memory/`. This is what keeps the invariant true: the conscious executor never imports memory host code (verified — §4.4), so there is no cortex→limbic "up" edge. Everything that reads memory — the loop, the growth stages, `identity-context` — sits at or below the limbic layer.

### 3.2 Hypothalamus split by function (three ways)

Today's `hypothalamus/` is doing three unrelated jobs; it is split along them:

1. **Autonomic timing / drives / cadence** → `brain/limbic/autonomic`. (`hypothalamus/tempo.ts` + `skills/cadence.ts` + `core/drives.ts` — see §4.2.)
2. **BASE docker-exec transport** (the `runTurn` plumbing: `transport.ts` + `payload.ts` + `process-runner.ts::runTurn` and its helpers) → shared `brain/transport`.
3. **Tool-using OpenCode SESSION executor** (`process-runner.ts::runOpenCodeSessionTurn` + `runtime.ts` + `sdk-runner/` + `sdk-payload.ts`) → `brain/cortex/conscious`.

**Rationale:** the limbic memory turns (dream, and the growth turns) call `runTurn(noTools)` and must **not** depend "up" on cortex. Putting the base transport in a shared `brain/transport` (belonging to neither layer) lets both limbic (`runTurn`) and cortex (`runOpenCodeSessionTurn`) depend *sideways/down* onto it without either depending on the other. See §4.1 for the file-level split of `process-runner.ts`.

### 3.3 `wm/` (procedural working memory) moves under limbic

`wm/` moves from `conscious/` to `brain/limbic/wm/`, co-located with hippocampus.

- **Naming resolution:** "working memory" now unambiguously means **`wm/`** (the procedural / intent state machine). The hippocampus is **relabeled** from LIMBIC.md's current "working-memory tier" (LIMBIC.md line ~185) to **"episodic / narrative memory."** (This mislabel is corrected in the doc; see §6.4.)
- The loop reads/renders the open-todo tree into **both** the orient and decide prompts (via `readIdentityContext` → `renderOpenTodoTree`, threaded through `runForebrain`/`runConsciousDecide` inside the loop's forked `runDeliberation` closure — `loop.ts:351-396` after `4a76121`; also the in-session steer read at `loop.ts:787-793`). So **decide (cortex) never reads limbic directly** — the loop hands wm state into the decide prompt. This is consistent with §3.1: the loop mediates.

### 3.4 Tier identifiers unchanged (behavior-preserving); interim state accepted

`CortexTier = "hindbrain" | "forebrain" | "conscious"` (`model/handles.ts:2`) is **not** renamed this pass. An interim naming mismatch is explicitly accepted: `hindbrain` (a `CortexTier` value) and `forebrain` will live under `brain/limbic/` even though the identifiers say "…brain." The tier→neuroanatomy rename is a **separate later pass** (§8).

---

## 4. Placement details worth spelling out

### 4.1 The `process-runner.ts` file split

`hypothalamus/process-runner.ts` today exports both halves of the transport story (verified against `fa03736`):

| Export | Job | New home |
|---|---|---|
| `runTurn` | base one-shot docker-exec turn (claude/opencode, `--add-dir`, `noTools`) | `brain/transport` |
| `buildExecArgs` | arg assembly for the exec | `brain/transport` |
| `runOpenCodeSessionTurn` | tool-using OpenCode **session** turn (open + resume) | `brain/cortex/conscious` |
| `firstSessionId` | parse the session id out of the session stream | `brain/cortex/conscious` |
| `sessionNotFoundMessage` | resume-error string | `brain/cortex/conscious` |

The two halves already share `payload.ts` helpers (`buildInnerCommand`/`normalizerFor` for `runTurn`; `buildOpenCodeSessionCommand`/`openCodeBodyEnv` for the session path) and the `runTransport` primitive. **`payload.ts` therefore belongs in `brain/transport`** (it is used by BOTH halves — see the self-review note in §9 on why this is not a contradiction of "payload → transport"). The session executor in `brain/cortex/conscious` imports its command-builders *from* `brain/transport`; that is a cortex→transport (down) dependency, which is allowed.

`sdk-payload.ts` (`endLine()` NDJSON framing for the frontier worker) and `sdk-runner/` (the in-container Agent-SDK `.mjs` worker + protocol) serve only the session/frontier path → `brain/cortex/conscious`.

### 4.2 The `autonomic` subsystem is *assembled*, not moved

`brain/limbic/autonomic` does not correspond to a single current directory; it is assembled from three currently-separate files:

- `packages/core/src/core/limbic/hypothalamus/tempo.ts` — `TempoConfig` discriminated union (`StateMachineTempo | PlannedActionTempo`).
- `packages/core/src/skills/cadence.ts` — `Cadence` type + `getCadenceGuidance`.
- `packages/core/src/core/drives.ts` — `TEMPLATE_DRIVES`, `CORE_DRIVE_NAMES`, `renderDriveLines`, `parseDriveNames`, `drivesFile`.

These are the "housekeeping rhythm" of the organism (pace, cadence profile, innate drive frame) and read naturally as one reflexive-tier subsystem.

### 4.3 Hippocampus owns ALL memory: episodic/narrative + growth stages + the long-term store

Hippocampus is more than "consolidate + dream." Per the design ruling — *"the hippocampus owns memory formation and retrieval; that shouldn't be part of the conscious system"* — everything that forms, stores, or retrieves memory lives here. On `fa03736` that is three groups:

1. **Reflection / narrative memory + growth stages:** the **meso (retrospect)** and **macro** growth stages, the **synthesis bootstrap**, and the **dream** (consolidate + cull), all driven from the orchestrator's `runReflection` (`core/orchestrator/planned-action.ts`, which imports `dream`, `retrospect`, `bootstrapSynthesis`, `macro` from `core/limbic/hippocampus/`). All four are `runTurn(noTools)` reflection turns on the local reasoning model — Claude is never in this path. **SYNTHESIS.md is a long-term MEMORY INDEX** (reframed in `6dc2c7f`, no longer a first-person "self-model"): a compact index over the long-term vector store — what knowledge/resources/open threads live in memory, organized by topic/source/tag, each entry naming the `memory search` query/tag that retrieves it. It is *produced by* `synthesis-bootstrap.ts` (seed) + `macro.ts` (steady-state rewrite) and *injected into* orient by `identity-context.ts` (the orient section header is now "Memory Index (synthesis)"). This reframe **reinforces** the memory=hippocampus ruling: SYNTHESIS.md is literally a retrieval surface over the hippocampal long-term store, so its producers and its injection seam all belong under `brain/limbic/hippocampus/` — no placement change, stronger rationale.
2. **The long-term vector store cluster** (moved down from `conscious/`, verified set in §5.3): `memory-gateway.ts`, `longterm-store.ts`, `memory-cli.ts`, `memory-embed.ts`, `memory-sql.ts`, `memory-format.ts`, `memory-args.ts` → `brain/limbic/hippocampus/memory/`. This is memory *formation and retrieval* — squarely hippocampal, not conscious.
3. **Growth store + identity-context** (moved down from `conscious/`): `growth-store.ts` (the on-disk growth-proposal store (skill create/revise/retire proposals in `proposals.jsonl`; also emits the SYNTHESIS memory index on macro adjudication)) and `identity-context.ts` (the orient-injection assembly seam that reads memory + wm and hands them to the loop). Both are firm now (no longer open items — §8), because with the memory cluster in limbic, `identity-context.ts`'s import of `memory-gateway` is limbic→limbic, not the limbic→cortex "up" edge that previously made it ambiguous.

They all sit under `brain/limbic/hippocampus/`.

### 4.4 How the conscious executor gets memory access (consumer-graph finding)

Under this ruling the key risk is: does anything in the conscious/cortex layer import memory *host* code, creating a cortex→limbic "up" dependency? **Verified on `fa03736`: no.**

- The executor service `conscious-thought.ts` imports only `runOpenCodeSessionTurn`, `Docker`, `OAuthToken`, logging, and turn types — **no `memory-*` / `longterm-store` import.**
- `opencode-config.ts` mentions the `memory` command only inside **prompt text** (the instructions block telling the agent to run `memory remember` / `memory search` / `memory recent`) — it is a string literal, not a code import.
- The agent obtains memory purely by invoking the in-container **`memory` bash CLI as a subprocess**. That CLI is *generated* from host code in `memory-cli.ts` (embedded via `installContainerCli`) and installed into the container, then run in-container — the host↔agent boundary is a subprocess call, not a module import. So the memory host code moving into `brain/limbic/hippocampus/memory/` introduces **no** new cortex→limbic edge.

The only external importers of the memory host cluster are `brain/loop` (the loop), `brain/limbic/hippocampus/macro.ts` (same layer), the orchestrator's `planned-action.ts` (the caller *above* brain), and `identity-context.ts` (moving into limbic alongside it). Every one of these is at or below the limbic layer, or is the loop/orchestrator that legitimately sits above both — none is the conscious executor.

> **Neutral installer note.** `conscious/install-cli.ts` (`installContainerCli`) is a generic Docker CLI installer imported by `memory-cli.ts` **and** `wm-cli.ts` **and** `frontier-cli.ts`. It is shared, layer-neutral provisioning infra (like `brain/transport`), so it does **not** move into `hippocampus/memory/`; it lives at a shared/brain level (or stays under `services/`) and is imported *down* by whichever CLIs need it. Placing it inside hippocampus would create a cortex(frontier-cli)→limbic edge; keeping it neutral avoids that.

---

## 5. Deltas vs. the `bbc4721` draft (verified against `fa03736`)

Each of these was checked by reading the file on `fa03736`:

1. **`hippocampus/consolidate.ts` is DELETED** (commit `693c2ae`). Do **not** reference it as a live file. Consolidate is now **turn 1 of three inside `hippocampus/dream.ts`** (`dream.execute()`: consolidate → cull-diary → cull-secrets), all resolving the single `dreamCompression` role on the local conscious-tier mlx model (`dream.ts:11-22`). Confirmed: `dream.ts` still `loadTemplate`s `skills/consolidate.md` (the *prompt* survives; the *module* is gone).
   - *Additional doc-staleness delta:* `LIMBIC.md`'s directory-structure block **still lists `consolidate.ts`** (and describes dream as only "the cull"). That block is stale and must be corrected in the move (§6.4).

2. **`runTurn(noTools)` consumer set is `{dream, macro, retrospect, synthesis-bootstrap}`** — verified by grep on `fa03736` (`dream.ts`, `macro.ts`, `retrospect.ts`, `synthesis-bootstrap.ts` all import `runTurn` from `../hypothalamus/process-runner.js` and pass `noTools: true`). It is **not** `{consolidate, dream}` as the old draft implied. This exact set is the concrete justification for the shared `brain/transport`: every one of these lives under limbic and must reach the base transport without importing cortex.

3. **Growth / cognition pipeline exists and spans three areas** (all verified present on `fa03736`) — all now FIRM under `brain/limbic/hippocampus/` (design ruling; no longer open):
   - `core/limbic/hippocampus/{retrospect.ts, macro.ts, synthesis-bootstrap.ts}` — memory/growth stages → **`brain/limbic/hippocampus/`** (firm; §4.3).
   - `conscious/{growth-store.ts, identity-context.ts}` → **`brain/limbic/hippocampus/`** (firm). `growth-store.ts` is the on-disk growth-proposal store (skill create/revise/retire proposals in `proposals.jsonl`; also emits the SYNTHESIS memory index on macro adjudication) (imported by `loop.ts`, `hippocampus/macro.ts`, `hippocampus/retrospect.ts`); `identity-context.ts` is the orient-injection assembly seam (imported only by `loop.ts`; it imports `memory-gateway` + `wm-store`). With the memory cluster now in limbic (§5.3a), `identity-context`'s `memory-gateway` import is limbic→limbic — the ambiguity that made it an open item is gone.
   - `services/skills-core.ts` (+ the `CharacterFs` skill writers) — the skill index/registry helpers. Stays under `services/` (a cross-cutting service, not a brain subsystem); the loop reads it for the decide prompt (`loop.ts:77,495-498`).

3a. **Memory cluster is hippocampus-owned** (design ruling — verified set in `conscious/` on `fa03736`): `memory-gateway.ts`, `longterm-store.ts`, `memory-cli.ts`, `memory-embed.ts`, `memory-sql.ts`, `memory-format.ts`, `memory-args.ts` → **`brain/limbic/hippocampus/memory/`**. Behavior preserved — the code home moves; what memory *does* is unchanged. `LongtermStore` (the vector tier, `longterm-store.ts`) is part of this move; it is **no longer "out of scope."** Consumer-graph confirms no cortex→limbic edge is introduced (§4.4). The neutral installer `install-cli.ts` does **not** move into `memory/` (shared infra — §4.4 installer note).

4. **`wm/` subsystem files to place** (verified in `conscious/` on `fa03736`): `conscious/{wm-core.ts, wm-store.ts, wm-cli.ts}` → `brain/limbic/wm/`. Described accurately (from reading `wm-core.ts` / `wm-store.ts`):
   - **State machine:** `WmState = "open" | "done" | "discarded"`. *discarded* = retained, not done, excluded from active renders, still visible to retrospectives.
   - **Provenance:** every `WmTodo` carries `origin: "agent" | "harness"` — harness = loop-seeded plan todos (headline + one child per step); agent = created via the in-container `wm` CLI as deliberate free-standing memory. The cross-session orphan sweep uses this to discard dead-plan todos while preserving agent memory.
   - **On disk:** `players/<name>/me/wm.json` (JSON, atomic write-tmp-then-rename) + `WM.md` (re-rendered on every mutation; it is the opencode `instructions` file injected on every LLM request). `WM_PROMPT_CAP = 20` open-todo lines into orient/decide prompts.
   - **In-container CLI:** `wm-core.ts` functions are embedded **verbatim** into the generated `wm` CLI via `Function.prototype.toString()` (the same no-drift discipline as `memory-cli`); every exported function there must stay self-contained (no imports, no module-level refs).

### 5.5 `fa03736..e917ab4` deltas (5 commits) — integrated

Each was analyzed via `git show <sha>` for design impact on this restructure:

1. **`4a76121` feat(cortex): non-blocking idle deliberation — HIGH impact, no structural change.** The idle orient→decide chain moved from inline-on-the-tick-fiber to a forked `deliberationFiber` (new loop-local state: `deliberationFiber`, `DeliberationContext`, `DeliberationResult`, closures `runDeliberation` @ `loop.ts:351` and `applyDeliberation` @ `loop.ts:416`). Touches `cortex/loop.ts` (+390/−162), `cortex/tiers.ts` (episode-attribution plumbing), `logging/episodes.ts` (+14). **Migration impact: none** — no new files under any brain subsystem; `loop.ts`/`tiers.ts` are already in the map (§6.3), `logging/episodes.ts` is cross-cutting logging that stays put. **Ownership impact: recorded in §3.1** — the fork is loop-owned pure-compute-over-snapshot; the limbic/cortex non-dependency invariant holds and is strengthened. The loop grew ~966→~1090 lines, so pre-`4a76121` `loop.ts:NNN` citations elsewhere are now approximate (self-review §9).

2. **`6dc2c7f` feat(synthesis): SYNTHESIS.md as long-term memory index — MEDIUM, reinforces the ruling.** Reframes SYNTHESIS.md from self-model → memory index; touches `synthesis-bootstrap.ts` + `macro.ts` (hippocampus), `identity-context.ts`, `growth-store.ts`, `orient.md`, `memory-format.ts` (`renderMemoryHits` now surfaces source+tags), `model-config.ts`. **Migration impact: none new** — all producers/injectors are already placed under `brain/limbic/hippocampus/`; the reframe strengthens why (§4.3 group 1). `orient.md` (→ cortex/conscious? no — orient is the *forebrain/limbic* prompt; it stays a limbic-runner prompt per §6.3) gains a section-header rename only.

3. **`59f3d76` feat(wm): prune fully-settled root plan subtrees at persist — LOW.** `wm-core.ts` + `wm-store.ts` internals only (a persist-time prune). **No new files, no path change** — `wm/` stays `brain/limbic/wm/` with the same three-file set.

4. **`e917ab4` feat(dream): size-gate diary/secrets compression on absolute char budget — LOW.** `dream.ts` internals + `planned-action.ts` (the `runReflection` caller). **No structural change** — `dream.ts` is still the consolidate+cull home under `brain/limbic/hippocampus/`; the size-gate is behavior tuning inside it.

5. **`a2ee2f5` fix(spacemolt): guard in-space briefing — NOT RELEVANT.** Touches only `packages/domain-spacemolt/` (0 core files, verified). Ignored.

---

## 6. Migration map (current path → new path)

All moves use `git mv` to preserve history. Absolute prefix `packages/core/src/` elided in the tables below.

### 6.1 Limbic subsystems (four subdirs + the assembled fifth)

| Current | New |
|---|---|
| `core/limbic/thalamus/` (`event-processor.ts`, `situation-classifier.ts`, `index.ts`) | `brain/limbic/thalamus/` |
| `core/limbic/amygdala/` (`interrupt.ts`, `index.ts`) | `brain/limbic/amygdala/` |
| `core/limbic/hippocampus/` (`dream.ts`, `retrospect.ts`, `macro.ts`, `synthesis-bootstrap.ts`, `prompts/`, `index.ts`) | `brain/limbic/hippocampus/` |
| `core/limbic/hypothalamus/tempo.ts` | `brain/limbic/autonomic/tempo.ts` |
| `skills/cadence.ts` | `brain/limbic/autonomic/cadence.ts` |
| `core/drives.ts` | `brain/limbic/autonomic/drives.ts` |

### 6.2 Hypothalamus 3-way split (the file split)

| Current | New | Layer |
|---|---|---|
| `core/limbic/hypothalamus/transport.ts` | `brain/transport/transport.ts` | shared |
| `core/limbic/hypothalamus/payload.ts` | `brain/transport/payload.ts` | shared (used by both halves — §4.1) |
| `core/limbic/hypothalamus/process-runner.ts` → `runTurn`, `buildExecArgs` | `brain/transport/process-runner.ts` | shared |
| `core/limbic/hypothalamus/process-runner.ts` → `runOpenCodeSessionTurn`, `firstSessionId`, `sessionNotFoundMessage` | `brain/cortex/conscious/session-runner.ts` | cortex |
| `core/limbic/hypothalamus/runtime.ts` | `brain/cortex/conscious/runtime.ts` | cortex |
| `core/limbic/hypothalamus/sdk-payload.ts` | `brain/cortex/conscious/sdk-payload.ts` | cortex |
| `core/limbic/hypothalamus/sdk-runner/` | `brain/cortex/conscious/sdk-runner/` | cortex |
| `core/limbic/hypothalamus/types.ts` (`TurnConfig`, `TurnResult`) | `brain/transport/types.ts` | shared |

> `process-runner.ts` is split, so it cannot be a single `git mv`. Move the file to `brain/transport/process-runner.ts` (preserving history for the `runTurn` half), then extract the three session-executor exports into a new `brain/cortex/conscious/session-runner.ts`. History for the extracted half is unavoidably weaker; that is the one place in this refactor where `git mv` cannot fully preserve blame.

### 6.3 Cortex engine + tiers + skills + wm + growth

| Current | New | Notes |
|---|---|---|
| `cortex/loop.ts` (`runCortex`) | `brain/loop/loop.ts` | the conductor; resolves the two facades (§3.1) |
| `cortex/state.ts`, `cortex/parse.ts` | `brain/loop/` | loop-local pure helpers (appraisal reducer, JSON parse) stay with the loop |
| `cortex/tiers.ts` → `runHindbrain` | `brain/limbic/` runner (observe tier) | re-homed to the owning layer |
| `cortex/tiers.ts` → `runForebrain` | `brain/limbic/` runner (orient tier) | re-homed to the owning layer |
| `cortex/tiers.ts` → `runConsciousDecide`, `runConsciousEvaluate`, `runDiaryTurn` | `brain/cortex/conscious/` runners | re-homed to the owning layer |
| `skills/observe.md`, `skills/orient.md` | `brain/limbic/` (under owning subsystem) | observe→amygdala/hindbrain runner; orient→forebrain runner |
| `skills/decide.md`, `skills/evaluate.md`, `skills/diary.md` | `brain/cortex/conscious/` | conscious-tier prompts |
| `skills/consolidate.md` | `brain/limbic/hippocampus/prompts/` | dream turn-1 prompt (module deleted; prompt lives on) |
| `skills/loader.ts`, `skills/types.ts` | `brain/` shared (or keep under a neutral prompts helper) | shared skill-loading plumbing; keep neutral, imported by both layers' runners |
| `conscious/{wm-core.ts, wm-store.ts, wm-cli.ts}` | `brain/limbic/wm/` | §5.4 |
| `conscious/growth-store.ts` | `brain/limbic/hippocampus/growth-store.ts` | FIRM (design ruling): on-disk growth-proposal store (proposals.jsonl) — memory/growth, hippocampus-owned |
| `conscious/identity-context.ts` | `brain/limbic/hippocampus/identity-context.ts` | FIRM (design ruling): orient-injection seam; imports `memory-gateway` + `wm-store`, both now in limbic — clean |
| `conscious/memory-gateway.ts` | `brain/limbic/hippocampus/memory/memory-gateway.ts` | FIRM: memory retrieval facade (`MemoryGateway`, `orientQuery`, `decideQuery`, `evaluateQuery`, remember/recall) |
| `conscious/longterm-store.ts` | `brain/limbic/hippocampus/memory/longterm-store.ts` | FIRM: LongtermStore vector tier — **relocated**, behavior preserved (was "out of scope"; no longer) |
| `conscious/memory-cli.ts` | `brain/limbic/hippocampus/memory/memory-cli.ts` | FIRM: host code generating the in-container `memory` CLI (`MEMORY_CLI_PATH`, `installContainerCli`) |
| `conscious/memory-embed.ts` | `brain/limbic/hippocampus/memory/memory-embed.ts` | FIRM: embedding helper |
| `conscious/memory-sql.ts` | `brain/limbic/hippocampus/memory/memory-sql.ts` | FIRM: SQL builders (unit-tested, embedded into the CLI) |
| `conscious/memory-format.ts` | `brain/limbic/hippocampus/memory/memory-format.ts` | FIRM: recall/render formatting |
| `conscious/memory-args.ts` | `brain/limbic/hippocampus/memory/memory-args.ts` | FIRM: CLI arg parsing |
| `conscious/conscious-thought.ts`, `conscious/opencode-config.ts` | `brain/cortex/conscious/` | the executor service + its config — imports NO memory host code (§4.4) |
| `conscious/frontier-cli.ts` | `brain/cortex/conscious/frontier-cli.ts` | frontier worker CLI (imports the neutral `install-cli`, not memory) |
| `conscious/install-cli.ts` | `brain/` shared (or keep under `services/`) | neutral Docker CLI installer, imported by memory-cli + wm-cli + frontier-cli — layer-neutral (§4.4) |

> **`cortex/tiers.ts` is split like `process-runner.ts`:** the observe/orient runners go to limbic, the decide/evaluate/diary runners go to cortex/conscious. The shared parse/appraise helpers it imports (`cortex/state.ts`, `cortex/parse.ts`) move with the loop (`brain/loop/`), imported by both sets of runners.

### 6.4 Docs

| Current | New | Risk / action |
|---|---|---|
| `docs/CORTEX.md` | `docs/CORTEX.md` (rewritten) | **HIGHEST-RISK rename.** Today "cortex" = the whole engine; the doc must be rewritten as the *redefinition*: "cortex" now = the conscious/deliberative layer only, and the tick engine is `brain/loop`. Every "the cortex loop" reference across the repo (`LIMBIC.md`, `HARNESS.md`, domain phase files) must be reconciled to the new vocabulary. |
| `packages/core/src/core/limbic/LIMBIC.md` | `packages/core/src/brain/limbic/LIMBIC.md` | Move under `brain/limbic/`. **Fix staleness bugs while moving:** (a) the directory-structure block still lists the deleted `consolidate.ts` and calls dream "the cull" — correct to "dream = consolidate + cull"; (b) the hippocampus "**working-memory** tier" label (line ~185) → "**episodic / narrative** memory" (§3.3); (c) the note that long-term memory is "a separate tier" reached via the `memory` CLI must be updated — per the design ruling the long-term store is now **hippocampus-owned** and lives at `brain/limbic/hippocampus/memory/` (still reached in-container via the `memory` CLI subprocess). Update the `loop.ts:9-11,106-108` back-references to the new facade wiring. |
| — (new) | `packages/core/src/brain/BRAIN.md` | New top-level overview: the conductor (`brain/loop`) + the two layers (limbic / cortex) + shared `brain/transport`, and the reflexive→integrative→deliberative depth model. |
| `HARNESS.md` | `HARNESS.md` (updated) | Update the architecture prose + any path references to `brain/`. |

---

## 7. What did NOT change from the skeleton (sanity anchors)

A `bbc4721..fa03736..e917ab4` structural review confirmed the skeleton is intact: the four limbic subdirs still exist, `runCortex` is still the single `while (true)` engine in `cortex/loop.ts`, the three tiers are still `hindbrain`/`forebrain`/`conscious` in `model/handles.ts`, and `DEFAULT_CORTEX_MODELS` is unchanged. The only structural deltas are the ones in §5 (consolidate folded into dream; the wm subsystem and growth pipeline added). The `fa03736..e917ab4` commits (§5.5) added **no new files or directories** to any brain subsystem — `4a76121`'s deliberation fork is new loop-*internal* state and closures within `cortex/loop.ts`, not a new module. Everything in this spec is motion + re-wiring of that intact skeleton.

---

## 8. Open items (explicit — do NOT decide these in this pass)

1. **Tier rename** (`hindbrain`/`forebrain`/`conscious` → neuroanatomical names aligned with `brain/`): deferred to a later pass. This pass accepts the interim mismatch (§3.4).
2. **Whether `wm/` earns a neuroanatomical name** or stays `wm`: left as `wm` for now (it is the one subsystem with no clean single brain-region analog; "working memory" is distributed neurologically).

> **Resolved (were open in the prior draft):** the memory-gateway layer crux and `growth-store.ts` / `identity-context.ts` homes are now FIRM per the design ruling *"the hippocampus owns memory formation and retrieval; that shouldn't be part of the conscious system."* The entire memory cluster + growth-store + identity-context move to `brain/limbic/hippocampus/` (§4.3, §5.3, §5.3a, §6.3). `LongtermStore` is relocated (not untouched); behavior is preserved. The consumer graph (§4.4) confirms this introduces no cortex→limbic edge.

---

## 9. Self-review (inline)

- **Placeholder / TODO scan:** none left in this spec; every path in §6 was verified to exist (or, for deleted `consolidate.ts`, verified absent) on `fa03736`.
- **`payload.ts` — apparent contradiction, resolved.** Decision §3.2 lists `payload.ts` under "BASE transport → `brain/transport`," but §4.1 shows `payload.ts` also feeds the session executor (`buildOpenCodeSessionCommand`, `openCodeBodyEnv`). Resolution (one interpretation, made explicit): `payload.ts` moves **whole** to `brain/transport` (it is genuinely shared plumbing); the cortex session executor imports its command-builders *from* `brain/transport`, which is an allowed cortex→transport (down) dependency. `payload.ts` is **not** split. This keeps §3.2 and §4.1 consistent.
- **`process-runner.ts` / `tiers.ts` splits are the only files that cannot be a clean single `git mv`.** Called out in §6.2 / §6.3 so the implementer expects weaker blame on the extracted halves.
- **Ambiguity resolved — `skills/loader.ts` + `skills/types.ts`:** these are shared by both layers' runners. One interpretation (chosen): keep them as neutral shared skill-loading plumbing (co-located near `brain/` or under a neutral prompts helper), imported down by both layers — mirrors the `brain/transport` pattern. They are **not** forced into either layer.
- **Memory ownership — crux resolved (design ruling), consumer graph verified.** The memory cluster is hippocampus-owned (§4.3, §5.3a). The one real risk this creates — a cortex→limbic "up" edge if the conscious executor imported memory host code — was checked directly on `fa03736`: `conscious-thought.ts` imports no `memory-*`/`longterm-store` module; `opencode-config.ts` names the `memory` command only in prompt *text*. The agent reaches memory via the in-container `memory` CLI **subprocess** (generated from `memory-cli.ts`, run in-container), so the host code moving to limbic adds no import edge. External importers of the memory cluster are all at/below limbic (loop, macro, identity-context) or the orchestrator above brain — none is the executor. Documented in §4.4.
- **Neutral installer edge, resolved.** `install-cli.ts` is imported by `memory-cli` (limbic), `wm-cli` (limbic), AND `frontier-cli` (cortex). If it moved into `hippocampus/memory/`, `frontier-cli` would create a cortex→limbic edge. Chosen interpretation: `install-cli.ts` stays **layer-neutral** (shared `brain/`-level or `services/`), imported *down* by all three CLIs. Made explicit in §4.4 + §6.3.
- **Deliberation fork (`4a76121`) — invariant re-checked, not just asserted.** I confirmed in the current `loop.ts` that `runDeliberation` (`:351`) is a closure *in the loop module* returning a pure `{ orient, decide }` and that `applyDeliberation` (`:416`) does the seeding on the loop fiber; the forked chain composes `runForebrain` (limbic) then `runConsciousDecide` (cortex) but neither imports the other — the loop is the composition point. So the fork does **not** create a limbic↔cortex edge and does **not** move ownership off `brain/loop`. Recorded firmly in §3.1 (not hedged).
- **SYNTHESIS reframe (`6dc2c7f`) — no placement conflict.** SYNTHESIS.md becoming a memory index reinforces (does not contradict) memory=hippocampus; its producers (`synthesis-bootstrap`, `macro`) and injector (`identity-context`) were already placed under `brain/limbic/hippocampus/`. `orient.md` stays a limbic-runner (forebrain) prompt — the reframe only renames a section header, no re-home.
- **Scope check:** no behavior change, no model-routing change, no tier rename, no new runtime files (only doc `BRAIN.md` and the mechanical split-out `session-runner.ts`); the memory move is a pure relocation (behavior preserved); the integrated `fa03736..e917ab4` commits add no new brain files (§5.5/§7). `DEFAULT_CORTEX_MODELS` untouched. Within "structure + wiring, behavior-preserving."
- **Line-number drift (noted, not load-bearing) — now compounded by `4a76121`'s loop rewrite.** `cortex/loop.ts` grew from ~966 to ~1090 lines in `4a76121`, so any pre-rewrite `loop.ts:NNN` citation is approximate. The load-bearing ones were re-checked against the current file: the memory/wm/identity imports sit at `loop.ts:28-80`; `MemoryGateway` resolves at `:180`; `readIdentityContext`/`runForebrain`/`runConsciousDecide` are used in `runDeliberation` at `:351-396`; `seedWmPlan` in `applyDeliberation` region at `:468/485`. The `LIMBIC.md` "working-memory tier" label is at line ~185. None of this drift changes a decision.

---

## 10. Verification plan

No change to which model runs what — so verification is about proving the *wiring* still resolves and the loop still ticks, not re-measuring cognition.

1. **Typecheck with `--skip-nx-cache`.** The nx cache can mask cross-package symbol breaks (a downstream app can read green while a moved/renamed export is actually dangling). Run the typecheck target with `--skip-nx-cache`.
2. **Full test suite.** Every subsystem being moved has co-located tests (`dream.test.ts`, `wm-core.test.ts`, `wm-store.test.ts`, `process-runner.test.ts`, `transport.test.ts`, `loop.test.ts`, `tiers.test.ts`, etc.); they move with their modules and their imports must be re-pointed. Note `loop.test.ts` grew substantially in `4a76121` (+461 lines of deliberation-fork coverage) — it moves with `loop.ts` to `brain/loop/`.
3. **roci-qa smoke run** confirming the loop still ticks end-to-end (orient → decide → step → evaluate) against a real container — including that a **forked** idle deliberation still lands and seeds a plan (the `4a76121` path), so the fork survives the re-home.
4. **Load-bearing-import spot check:** `wm`, `growth`, and `memory` are load-bearing in the loop (memory/wm/identity imports at `loop.ts:28-80` on `e917ab4`; `seedWmPlan`/`mutateWm`/`closePlanTodos`/`drainWmDeltas`/`readIdentityContext`/`MemoryGateway` used across the tick body and the `runDeliberation`/`applyDeliberation` closures). After the move, confirm these resolve from `brain/loop` down to `brain/limbic/wm` and `brain/limbic/hippocampus` (incl. `hippocampus/memory/`).
5. **No cortex→limbic import edge (invariant guard).** After the move, grep the `brain/cortex/**` tree for any import of `hippocampus/memory`, `memory-gateway`, `longterm-store`, or `memory-*` host modules — expect **zero** hits (the executor's memory access is the in-container CLI subprocess only, §4.4). A hit means the invariant broke and must be reworked before merge.
