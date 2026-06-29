# Core Behavioral Prompts: Proactive Discovery

**Status:** Approved design — transcription only. This spec is the sole deliverable now;
the change set it describes is a follow-up (mostly prompt content, with one small GitHub
code touch — see §8).
**Date:** 2026-06-29

## Summary

The core behavioral prompts assume the agent already knows its world. They don't.
This design gives the agent a way to learn its environment, its own capabilities,
and the paths open to it — by probing the live world at runtime. The change adds a
single `confidence` field to orient, a new `discover` action to decide, and a shared
discovery rubric that each domain specializes with four slots. The two domains have
**different acting models** (SpaceMolt: one persistent agent reading a markdown prompt;
GitHub: per-step report-back subagents whose prompts are string literals in code), so the
rubric composes into each differently — but both end up **consistent in method**. The
`discover`-decision execution wiring in the loop is a noted follow-up.

---

## 1. Motivation / Problem

The current core prompts assume the agent already knows its world.

- The GitHub acting prompts assume the agent already knows the world. (The thin
  `packages/domain-github/src/session-system-prompt.md:18` even says *"Use `gh` for
  GitHub API operations and `git` for repository operations."* — but that file is dead
  code; see §7 Stale files. The live GitHub acting prompts are the subagent string
  literals in `prompt-builder.ts`, described in §6a.) Either way, the prompts tell the
  agent to use its tools without teaching it how to learn what they are.
- The OODA skills (`packages/core/src/skills/observe.md`,
  `orient.md`, `decide.md`, `evaluate.md`) reason over injected domain STATE, but there
  is no mechanism for the agent to **learn** its environment, its own capabilities, or
  the paths open to it.

**Goal.** Each domain should provide clear instructions on how to interact with the
world AND how to learn more about the domain itself. And the core loop should be able to
start up, orient, learn its environment, learn its capabilities, and determine what paths
it may follow.

---

## 2. Three Governing Decisions

### (a) Discover BY DOING

The acting session probes the live world at runtime — `--help`, docs, workspace listing,
world-state commands — **fresh each session**.

- **Rationale:** the world changes; a probe against the live environment is always
  current, where a remembered map drifts.
- **Rejected:** "domain hands it a static map" (goes stale, and the domain can't know the
  live state). **Rejected:** "bootstrap once then remember / persisted capability cache"
  (introduces a cache to invalidate and a staleness problem we don't want).

### (b) Discovery as a SELECTABLE PATH

The conscious decider gains an explicit `discover` action alongside
plan/continue/wait/terminate. Orient must surface the knowledge-gaps that justify
choosing it.

- **Rationale:** discovery is a real choice the decider makes when it recognizes it's
  flying blind — not a phase bolted onto every run, and not an invisible reflex.
- **Rejected:** a mandatory opening phase (wastes ticks when the agent already has
  footing). **Rejected:** an ambient habit with no distinct action (can't be reasoned
  about, scheduled, or budgeted).

### (c) CORE RUBRIC + THIN SPECIALIZATION

A generic discovery METHOD lives in core; each domain fills a few slots.

- **Rationale:** the *method* of learning a world is domain-agnostic; only the nouns
  differ. Keeping the method in core makes both domains probe the same way.
- **Rejected:** fully domain-owned discovery instructions (duplication, divergence).
  **Rejected:** core-only with no domain specifics (can't name the real tools, docs, or
  paths).

---

## 3. The Cold-Start Lifecycle

1. **Start up.** A session begins with little grounding in the live world.
2. **Orient emits LOW confidence + open questions.** At cold start, orientation reports
   that the agent doesn't yet know its tools / the world's affordances / the paths open
   to it, and sets `confidence: "low"`.
3. **Decider chooses `discover`.** Reading low confidence and unresolved open questions,
   the conscious decider prefers `discover` over a speculative plan.
4. **Acting session probes by doing.** It works the rubric: locate itself, inventory
   tools, read world state, enumerate actions.
5. **Discovery names 2–4 distinct paths.** The probe output names concrete directions the
   agent could pursue right now.
6. **Results flow back.** Through evaluate → the next orient → into the decider's
   available-paths context.
7. **Decider now plans real work.** With footing established, it plans against the named
   paths.

Discovery is **NOT mandatory.** It is chosen when orientation reveals the agent is flying
blind. It can **recur mid-session**: the world changes, or a tool fails → confidence drops
→ the decider chooses `discover` again.

---

## 4. Change: `orient.md` (kept minimal)

**Constraint (cited as the reason for minimalism).** The forebrain (orient) tier runs with
**thinking disabled** (`enable_thinking: false`) and a **`maxTokens` budget of 1024** —
see `packages/core/src/model/handles.ts:106-107`
(`maxTokens: 1024`, `extraBody: { chat_template_kwargs: { enable_thinking: false } }`).
Its JSON output is already parse-fragile on complex inputs; `runForebrain`
(`packages/core/src/cortex/tiers.ts:118-169`) carries a tolerant extractor and a
field-merge fallback precisely because the model omits or malforms fields under load. Any
addition to orient's output must therefore stay minimal.

**Changes to `packages/core/src/skills/orient.md`:**

- Add **exactly ONE** new scalar output field: `"confidence": "low | medium | high"`.
- **Do NOT** add nested structure. The richer "what I don't know yet / open questions"
  detail rides inside the **existing** `sections[]` array as one optional section (e.g.
  heading **"Open questions"**). `sections[]` already exists in the schema
  (`orient.md:55-61`).
- Add **~2 lines** of instruction: assess not just the world but the agent's own footing
  in it — if it doesn't yet know its tools, the world's affordances, or the paths open to
  it, say so and set `confidence` accordingly; cold start is normally low confidence.

**Updated output schema** (current fields from `orient.md:52-68` + the one new field):

```json
{
  "headline": "<one-sentence summary of the current situation>",
  "sections": [
    {
      "id": "<stable-id>",
      "heading": "<section heading>",
      "body": "<relevant context, curated>"
    }
  ],
  "whatChanged": "<delta since last orientation>",
  "emotionalState": "<emoji string — carried forward from observations, potentially amplified>",
  "confidence": "low | medium | high",
  "metrics": {
    "<key>": "<value>"
  }
}
```

---

## 5. Change: `decide.md` — new `discover` action (hybrid realization)

**Changes to `packages/core/src/skills/decide.md`.** Today it presents four actions —
plan / continue / wait / terminate (`decide.md:40-104`). Add `discover` as a fifth,
clearly-named option.

**Its JSON shape:**

```json
{
  "decision": "discover",
  "reasoning": "<why I don't know enough to plan well>",
  "discover": {
    "questions": ["what actions does my CLI expose?", "where are the world's docs?"],
    "tier": "fast | smart",
    "timeoutTicks": <number>
  }
}
```

**Added decide guidance.** When the situation assessment reports low confidence or
unresolved open questions about environment / capabilities / paths — especially at session
start — prefer `discover` over a speculative plan. **Discovery is cheap; acting blind is
not.**

**HYBRID-C NOTE.** The prompt presents `discover` as its own intent, but its shape is
**designed to map onto the existing plan/step execution path** — a one-step discovery
task. In `decide.md`, a plan step already carries `task` / `goal` / `successCondition` /
`tier` / `timeoutTicks` (`decide.md:60-74`), and the loop executes plan steps through
`planSteps` / the step-execution path
(`packages/core/src/cortex/loop.ts:285-307`). The discover shape mirrors that — `tier` and
`timeoutTicks` match a step's fields, and `questions` becomes the step goal — so it can
later be executed with **no new loop branch, or a very small one.** This execution wiring
is **explicitly deferred** (see §8 Scope).

---

## 6. The Core Discovery Rubric (new shared block)

A new shared block, **core-owned**, read by the acting session when a discovery step runs.
It carries four template slots that each domain fills.

**Full rubric text:**

> **Discovering your world.** When you've been asked to discover, or you're unsure what's
> possible, work through this — don't act on findings in the same pass unless trivial;
> report them so your next orientation can use them.
>
> 1. **Locate yourself** — where am I? List the workspace; read any README, CLAUDE.md, or
>    docs present (`{{whereDocsLive}}`).
> 2. **Inventory your tools** — what can I run? Check `{{primaryTools}}` and read their
>    `--help`/usage. Don't assume; confirm.
> 3. **Read the world state** — what's true right now? (`{{statusCommands}}`)
> 4. **Enumerate actions** — what can I actually do from here? Separate always-available
>    actions from ones gated by state or cost.
> 5. **Name the paths** — given what you found, name 2–4 distinct directions you could
>    pursue right now (`{{pathExamples}}`).
> 6. **Note the edges** — what failed, what's blocked, what's still unknown. Carry these
>    forward as open questions.

**The ONLY per-domain inputs are the four slots:** `{{whereDocsLive}}`, `{{primaryTools}}`,
`{{statusCommands}}`, `{{pathExamples}}`.

Where this block physically lives is **left to the implementation plan**. Conceptually it
is **core-owned** and composed into each domain's acting prompt. The composition mechanism
differs by domain (see §6a): SpaceMolt embeds it in a markdown file; GitHub builds it into
a string literal in TypeScript. The shared block must therefore be **loadable in both** —
e.g. a core markdown asset both read, or a core exported string.

---

## 6a. Two Acting Models (architectural asymmetry)

The two domains have **different acting models.** Discovery composes into each differently,
even though both consume the same rubric.

### SpaceMolt — single persistent autonomous agent

- `SpaceMoltPromptBuilderLive.systemPrompt`
  (`packages/domain-spacemolt/src/prompt-builder.ts:82-86`) **ignores `mode`/`task`** and
  always returns the contents of `packages/domain-spacemolt/src/prompts/in-game-claude.md`
  (365 lines — the rich prompt with CLI reference and diary/forum/social guidance).
- One persistent agent consults the rubric when doing a discovery pass / when uncertain.

### GitHub — constrained report-back subagents dispatched per step

- `gitHubPromptBuilder.systemPrompt(mode, task)`
  (`packages/domain-github/src/prompt-builder.ts:219-222`) returns
  `SYSTEM_PROMPT_BY_TASK[task] ?? SYSTEM_PROMPT_BY_MODE[mode] ?? SYSTEM_PROMPT_BY_MODE.select`.
- Those are the functions `systemPromptReadOnly` / `Triage` / `Feature` / `Review` /
  `Diary` (`prompt-builder.ts:58-201`), each composed from `SYSTEM_PROMPT_PREAMBLE`
  (`:45-47` — *"You are a subagent — a worker dispatched by a planning brain… You do NOT
  interact with the outside world… report your findings… back to the brain"*), a
  Capabilities allow/forbid list, and `REPO_LAYOUT` (`:49-56`).
- Maps: `SYSTEM_PROMPT_BY_MODE` = `{select→ReadOnly, triage→Triage, feature→Feature,
  review→Review}` (`:203-208`); `SYSTEM_PROMPT_BY_TASK` = `{diary→Diary,
  investigate→ReadOnly, investigate_ci→ReadOnly}` (`:211-215`).
- So GitHub's acting prompts live as **string literals in `prompt-builder.ts`**, not a
  markdown file. Each subagent is dispatched per plan step, keyed by `task`/`mode`.

---

## 7. Domain Discovery Insertion (asymmetric realization)

The shared rubric (§6) is unchanged; only the insertion point differs per acting model.
Decision (c) holds: one method, thin per-domain specialization.

### GitHub — new `discover` task subagent

Add a `discover` entry to `SYSTEM_PROMPT_BY_TASK`
(`packages/domain-github/src/prompt-builder.ts:211-215`) mapping to a new
`systemPromptDiscover(task)` function. That function = the **read-only capability envelope**
(the agent must only probe/report, never mutate — like `systemPromptReadOnly`) + the shared
rubric filled with GitHub slots:

| Slot | Value |
| --- | --- |
| `{{primaryTools}}` | `gh`, `git`, file ops |
| `{{whereDocsLive}}` | repo README / CLAUDE.md / `docs/` |
| `{{statusCommands}}` | `gh pr list`, `gh issue list`, `git status` |
| `{{pathExamples}}` | implement a feature / review a PR / triage issues / maintain or refactor |

This **mirrors the existing `investigate`→ReadOnly task pattern** (`:212-213`), so it's a
small, idiomatic addition. The decide `discover` action's step is dispatched as a subagent
with `task="discover"`.

### SpaceMolt — graft into the rich prompt

Graft the same rubric as a section inside
`packages/domain-spacemolt/src/prompts/in-game-claude.md` (the 365-line file
`systemPrompt` actually returns). Graft + **light dedupe**; **do not disturb** the working
character / diary / forum guidance. Slots:

| Slot | Value |
| --- | --- |
| `{{primaryTools}}` | `spacemolt` CLI |
| `{{whereDocsLive}}` | in-game docs + forum |
| `{{statusCommands}}` | game-state command |
| `{{pathExamples}}` | build fleet / gather resources / combat / alliance or social |

### Principle

Both domains end up **consistent in method** — same rubric, same discovery shape — while
each keeps its own acting model and voice.

### Stale files (out of scope)

`packages/domain-github/src/session-system-prompt.md` and
`packages/domain-spacemolt/src/session-system-prompt.md` appear **unused by code**:
`grep -rn "session-system-prompt" packages --include="*.ts"` returns nothing; both are
referenced only in `GITHUB.md` / `SPACEMOLT.md` docs. They are **deletion / cleanup
candidates**, flagged for a future pass — **out of scope** for this change.

---

## 8. Scope Boundaries (deliberately NOT doing)

- **No persisted capability cache.** We chose discover-by-doing over
  bootstrap-then-remember (§2a). Discovery output lives **in-session** and feeds the next
  orient. The agent may **incidentally diary** a finding, but there is no capability store.
- **This spec is the only deliverable now.** The change set that follows is
  prompt-content: `orient.md`, `decide.md`, the shared rubric block, and the two domain
  acting prompts. **Note:** because GitHub's acting-prompt content lives in
  `prompt-builder.ts` string literals (§6a), the GitHub discovery prompt is a small
  **code touch** — a new `systemPromptDiscover` function + one `SYSTEM_PROMPT_BY_TASK`
  entry — not a pure markdown edit. SpaceMolt's graft and the OODA-skill edits are
  markdown.
- **The discover-decision EXECUTION wiring in the loop remains deferred** — a follow-up.
  Hybrid-C elegance: because GitHub already dispatches per-step subagents keyed by `task`,
  a `discover` step may need **little or no new loop branch** (the step's `task` just
  resolves to the discover prompt).
- **Keep orient's output to the single new enum field** per the forebrain budget
  constraint (§4).

---

## 9. Affected Files

| File | Change | Kind |
| --- | --- | --- |
| `packages/core/src/skills/orient.md` | Add `confidence` enum field + ~2 lines of instruction; "Open questions" rides in existing `sections[]` | Prompt / markdown |
| `packages/core/src/skills/decide.md` | Add `discover` action (fifth option) + guidance | Prompt / markdown |
| New shared rubric block | Core-owned; the 6-step method + four slots; **physical home TBD by the plan**; composed into each domain's acting prompt | Prompt content (new) |
| `packages/domain-github/src/prompt-builder.ts` | Add `systemPromptDiscover` + `SYSTEM_PROMPT_BY_TASK.discover` entry | Prompt content living in code (small code touch) |
| `packages/domain-spacemolt/src/prompts/in-game-claude.md` | Graft rubric + light dedupe | Prompt / markdown |
| `packages/core/src/cortex/loop.ts` | discover-decision execution wiring | **Deferred follow-up — possibly minimal** |
| `packages/domain-{github,spacemolt}/src/session-system-prompt.md` | Unused by code — delete/cleanup | **Stale / out of scope** |

---

## 10. Open Questions for Implementation

- **Rubric home + composition.** Exact physical home of the shared rubric block, and how
  each acting model composes it: SpaceMolt embeds it in a `.md`; GitHub builds it into a
  string in `.ts`. The shared block must be **loadable in both** — e.g. a core markdown
  asset both read, or a core exported string.
- **Discover execution / loop branch.** Whether a `discover` step needs **any** loop
  branch at all, given GitHub's `task`-keyed subagent dispatch and SpaceMolt's
  single-agent model (`packages/core/src/cortex/loop.ts:285-307`).
- **GitHub discovery value.** For GitHub, discovery is more about the agent learning repo
  specifics / conventions / its own capability envelope than world-state — the brain
  already gets rich `SituationClassifier` state
  (`packages/domain-github/src/situation-classifier.ts`). Confirm that's the intended
  value there.
- **Escalation of results.** Whether `observe` / cadence guidance
  (`packages/core/src/skills/observe.md`, `packages/core/src/skills/cadence.ts`) needs any
  tweak so a discovery step's results escalate properly into the next orient.

---

## Cross-References

- `docs/OPERATING_SKILLS.md` — the OODA skill set this design extends.
- `HARNESS.md` — cortex tiers, brain/body model, service layers.
- `docs/DOMAIN_GUIDE.md` — how domains inject behavior (incl. `PromptBuilder`).
