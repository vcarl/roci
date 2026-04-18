# Agent Operating Skills Design

## Problem

The orchestrator needs to support both real-time domains (SpaceMolt — WebSocket MMO with fast tick cycles) and non-real-time domains (GitHub — polled GraphQL at a slower cadence). Both receive live data via channel events, but agents operate at fundamentally different tempos.

The old architecture used orchestrator-driven brain turn prompts (`plan.md`, `evaluate.md`, `interrupt.md`) invoked programmatically per turn. The current architecture uses persistent Claude sessions receiving channel events, where the agent self-regulates. The old brain turn prompts are relics that need replacement with a coherent skill-based operating model.

## Architecture: The Agent Loop

The agent operates in a four-skill loop. Skills 1-2 run in the limbic system (pre-conscious processing). Skills 3-4 are the agent's conscious decision-making. Between decide and evaluate, a domain-specific action skill executes (loaded by name from the domain's skill registry).

```
observe → orient → decide → [domain skill] → evaluate
   ↑                                              |
   └──────────────────────────────────────────────┘
```

### How Skills Are Loaded

Skills are referenced by name and loaded on demand. The orchestrator prompt may invoke a specific skill as the required tool for the current step in a multi-step process. Domain action skills (e.g. `feature`, `triage`, `review`) are separate from these four operating skills — they occupy the "act" slot in the loop.

### Cadence Model

Rather than separate skills per cadence, each operating skill contains cadence-sensitive guidance. The session's system prompt or task prompt tells the agent which cadence it operates in. The two cadences are:

- **Real-time** — environment changes fast, delayed reactions have consequences. Lower escalation thresholds, shorter plans, more willing to replan.
- **Planned-action** — environment changes slowly, patience is a virtue. Higher escalation thresholds, longer plans, comfortable with wait states.

## Skill 1: Observe (Limbic — Thalamus)

**Purpose:** First filter on incoming channel events. Determines what reaches the agent's conscious processing.

**Consumed by:** The limbic system (thalamus subsystem). This skill defines the prompt; the thalamus executes it.

**Input:** Raw channel event (task, tick, or alert type, plus payload).

**Output:**

- **Disposition** — one of:
  - **Discard** — no meaningful change, nothing to process (e.g. a tick with no state diff)
  - **Accumulate** — noteworthy but not urgent, fold into running context for next orient pass (e.g. a PR got a new comment, CI is still running)
  - **Escalate** — requires immediate reorientation (e.g. critical alert, new task event, a PR the agent was waiting on just got approved)
- **Emotional weight** — an emoji string encoding the agent's gut reaction. Intensity is expressed through count, character encodes valence. Examples: `👌` (routine, all good), `💅💢` (mildly annoyed), `🫠🫠😑🤬` (overwhelmed and angry). This compressed emotional signal is human-readable in logs and interpretable by downstream skills.

**Cadence sensitivity:**
- Real-time: lower threshold for escalation — the environment changes fast and delayed reactions have consequences
- Planned-action: higher threshold — most ticks accumulate. Escalation reserved for things that invalidate current work

**What it doesn't do:** No planning, no action, no situation synthesis. Purely a relevance filter with an emotional response.

**Relationship to existing code:** Maps to the thalamus subsystem (`EventProcessor`). The existing `EventCategory` discriminated union (Heartbeat/StateChange/LifecycleReset) informs the disposition, but observe adds the emotional weight and the accumulate/escalate distinction that the current binary model doesn't capture.

## Skill 2: Orient (Limbic — Thalamus + Amygdala)

**Purpose:** Synthesize accumulated state into a situation assessment. Controls what context surfaces to the conscious decision-maker.

**Consumed by:** The limbic system (thalamus + amygdala subsystems).

**Input:** Accumulated events since last orientation, current domain state, agent's identity (diary, background, values).

**Output:** A structured situation assessment:

- **Headline** — one-sentence summary of the current situation
- **Sections** — relevant context organized by topic, curated for the decision-maker. Orient decides what to include and what to leave out — this is an attention mechanism.
- **What changed** — delta since last orientation
- **Emotional weight** — carried forward from observe, potentially amplified by orient's synthesis (e.g. three individually-minor accumulations that together paint a concerning picture)
- **Metrics** — quantitative signals (resource levels, time budgets, queue depths)

**Cadence sensitivity:**
- Real-time: orient runs frequently, summaries are tighter, focused on immediate tactical situation
- Planned-action: orient runs less often, summaries are broader, include strategic context

**What it doesn't do:** No decisions about what to do. Orient says "here is what's happening" — never "here is what you should do."

**Relationship to existing code:** Maps to `SituationClassifier.summarize()` + `InterruptRegistry.evaluate()`. The existing `SituationSummary` type (headline, sections, metrics) is close to orient's output. The amygdala's interrupt evaluation currently produces binary critical/non-critical — the emotional weight replaces this with a continuous signal.

## Skill 3: Decide (Conscious)

**Purpose:** First conscious step. Receives orient's situation assessment and chooses what to do.

**Input:** Situation assessment from orient (headline, sections, relevant context, emotional weight, what changed).

**Output:** One of:

- **Plan** — a sequence of steps to execute, each referencing a domain skill by name (e.g. "use `feature` to implement #42", "use `triage` on #15"). Includes:
  - `reasoning` — strategic thinking behind the plan
  - `steps[]` — each with `task` (domain skill name), `goal`, `successCondition`, `tier` (fast/smart), `timeoutTicks`
- **Continue** — current work is still valid, keep going. No new plan needed.
- **Wait** — explicitly blocked on something external (CI running, PR under review, waiting on contributor). Includes:
  - What we're waiting for
  - What event would resolve the wait (so observe knows what to escalate)
  - Whether to terminate the session or hold it open
- **Terminate** — nothing actionable, session should end. Includes a summary of what was accomplished.

**Cadence sensitivity:**
- Real-time: biased toward short plans (1-2 steps), faster re-decision. Emotional weight from escalate events can override an in-progress plan.
- Planned-action: comfortable with longer plans (3-5 steps), more tolerant of wait states. Lets current work finish before reorienting unless something truly urgent arrives.

**Key responsibility:** Decide also determines the model tier for each step (fast vs. smart) and a time budget. This is where resource allocation happens.

**What it doesn't do:** No execution. No situation assessment — decide trusts the curated context from orient.

**Relationship to existing code:** Replaces the old `plan.md` and `interrupt.md` brain turn prompts. The plan output schema stays similar to today's `Plan` type, but the decision to replan on interrupt is now part of decide's logic rather than a separate prompt invocation.

## Skill 4: Evaluate (Conscious)

**Purpose:** After a domain skill finishes executing, judge the outcome and determine what happens next.

**Input:**
- The step that was executed (goal, success condition)
- The execution result (completion report from the domain skill)
- State changes observed (diff from before/after)
- Current emotional weight from the most recent observe pass
- Deterministic condition check from `SkillRegistry` (advisory)

**Output:**

- **Judgment** — succeeded / partially succeeded / failed, with reasoning
- **Transition** — one of:
  - **Next step** — plan continues, advance to the next step in the sequence
  - **Replan** — the result changed the situation enough that decide needs to run again (e.g. the fix exposed a deeper issue, or a step failed unexpectedly)
  - **Wait** — the step produced something that requires external response (opened a PR, asked a question, triggered CI). Includes what we're waiting for and how we'll know it resolved.
  - **Terminate** — the plan is complete, or no further progress is possible

**Cadence sensitivity:**
- Real-time: more willing to replan. Partial success in a fast-moving environment often means the situation has shifted.
- Planned-action: more patient. Partial success on step 2 of 4 usually means continue the plan. Wait states are expected and comfortable.

**Key responsibility:** Evaluate is where the agent learns within a session. It updates the diary with meaningful observations and adjusts its mental model. It's also the gatekeeper for the wait state — it must articulate specifically what it's waiting for, so observe knows what event would resolve the wait.

**Relationship to existing code:** Replaces the old `evaluate.md` brain turn prompt. The existing `StepCompletionResult` (deterministic check from `SkillRegistry`) feeds in as advisory input, same as today.

## The "Act" Slot

Act is not an operating skill — it's the moment when a domain-specific skill gets loaded and executed. The decide step's plan references domain skills by name (e.g. `feature`, `triage`, `review`, `mine`, `travel`). The orchestrator loads the appropriate skill and runs it.

Domain skills live in the domain packages (e.g. `packages/domain-github/src/procedures/feature.md`). They define task-specific behavior. The operating skills define the loop that wraps them.

## Wait States (New Concept)

Both decide and evaluate can produce a **wait** transition. This is new — the current orchestrator has no concept of "waiting on an external contributor."

A wait state includes:
- **What** we're waiting for (human-readable description)
- **Resolution signal** — what observe should look for to know the wait is over (e.g. "PR #42 has a review", "CI check on commit abc123 completes")
- **Disposition** — whether to hold the session open (polling for resolution) or terminate and resume on next session start

Wait states feed back into observe: when a resolution signal matches an incoming event, observe escalates it, orient surfaces it, and decide can transition out of the wait.

## Doc/Code Inconsistencies Found

During exploration, the following inconsistencies between HARNESS.md and current code were identified:

1. **PromptBuilder interface has changed.** HARNESS.md describes `plan()`, `interrupt()`, `evaluate()`, `subagent()`, `brainPrompt()`. The current code has `systemPrompt(mode, task)`, `taskPrompt(ctx)`, `channelEvent(ctx)`. The old per-turn prompt methods are gone.

2. **State machine engine deleted.** HARNESS.md describes `runStateMachine` as the SpaceMolt execution engine. The file `state-machine.ts` no longer exists. The orchestrator directory now contains: `channel-session.ts`, `lifecycle.ts`, `planned-action.ts`, `planning/`. The channel session model has replaced the state machine.

3. **Brain/body cycle model superseded.** HARNESS.md describes `runCycle` as running brain (Opus) then body (Sonnet) pairs. The current model uses a single persistent session receiving channel events. The brain/body distinction exists conceptually but not as separate invocations.

4. **Log demux reference stale.** HARNESS.md references `logging/log-demux.ts` — recent commits show this file was deleted (`9857d9c refactor: delete log-demux.ts`).

5. **Domain comparison table outdated.** The SpaceMolt row references `runStateMachine` and "Opus plans steps, Haiku/Sonnet executes each step" — this no longer reflects the channel session model.

These should be addressed in a HARNESS.md revision, likely after the operating skills are implemented and the architecture stabilizes.
