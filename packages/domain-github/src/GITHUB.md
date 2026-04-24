# GitHub Domain

AI agents that manage GitHub repositories through persistent channel sessions. Each character monitors a set of repos, triages issues, reviews PRs, investigates CI failures, and implements code changes -- all within a structured cycle of work and reflection.

## Execution Model

The GitHub domain uses a persistent channel session (`runChannelSession` from `core/orchestrator/channel-session.ts`). The orchestrator spawns a `claude --channels` process in Docker and pushes state updates every 30 seconds.

The session receives:
- An **initial task** with the full situation briefing, agent identity, and work instructions
- **Tick events** every 30 seconds with state diffs, situation summaries, and soft alerts
- **Alert events** immediately when the event processor detects something urgent

The agent has full access to `gh` CLI, `git`, and standard tools inside the Docker container. Certain modes restrict capabilities (e.g., read-only for investigation).

## Phase Lifecycle

```
startup --> active --> break --> reflection --> active (loop)
                 \                    ^
                  \---> (interrupt) --/
```

- **startup** -- Reads `github.json`, validates the token against `/user`, clones all configured repos into `/work/repos/owner--repo`, creates worktree directories, starts the `GitHubClient` polling fiber.

- **active** -- Runs `runChannelSession` with the domain bundle. On completion, transitions to `break`. If a critical interrupt fires, returns `Interrupted` and re-enters `active` immediately.

- **break** -- Sleeps for 90 minutes via `runBreak`, polling for critical interrupts every 5 seconds. If a critical fires (e.g., CI starts failing), exits early to `active`. Otherwise, proceeds to `reflection`.

- **reflection** -- Runs `runReflection` to compress the diary if it exceeds 200 lines (the dream threshold). Always transitions back to `active`.

## Service Implementations

### EventProcessor

Handles two event types:

- `poll_update` -- Merges fresh `RepoState` from the GraphQL poller into the aggregate `GitHubState`. Preserves local-only fields (`clonePath`, `worktreePath`, `currentBranch`).
- `tick` -- Heartbeat event. Advances the tick counter.

### SituationClassifier

Classifies each repo independently, then rolls up to an aggregate situation using worst-first priority ordering:

1. `ci_failing` -- Default branch CI is failing
2. `triage_needed` -- Untriaged issues exist (missing `triaged` label)
3. `review_needed` -- Non-draft PRs with passing checks await review
4. `work_available` -- Open issues exist but nothing is urgent
5. `idle` -- No actionable items

### InterruptRegistry

Five interrupt rules:

| Rule | Priority | Trigger |
|------|----------|---------|
| `ci_failing_main` | critical | Any repo has CI failing |
| `review_requested` | high | Authenticated user's review is requested |
| `untriaged_issues` | medium | 5+ untriaged issues across all repos |
| `claimed_issue_activity` | medium | New comments on assigned issues |
| `stale_prs` | low | PRs older than 7 days with no activity |

### PromptBuilder

Implements the three-method interface:

- `systemPrompt(mode, task)` -- Mode-specific system prompts (select, triage, feature, review, diary) that define capability boundaries. Task overrides take precedence.
- `taskPrompt(ctx)` -- Builds a headline + situation sections + diary excerpt + background/values + instructions for the initial session task.
- `channelEvent(ctx)` -- State update with headline, diff, soft alerts, and situation sections.

### StateRenderer

- `snapshot` -- Compact view: repo name, issue/PR counts, CI status, tick.
- `richSnapshot` -- Per-issue and per-PR detail for diff computation.
- `stateDiff` -- Detects changes in issue counts, PR counts, CI status, labels, assignees, reviews.
- `logStateBar` -- Compact status line: repo count, issue count, PR count, CI failures.

### SkillRegistry

File-based loader. Reads `SKILL.md` files from `.claude/skills/` subdirectories at startup. Each skill uses YAML frontmatter (`name`, `description`, `model`, `timeoutTicks`) and a markdown body.

## Configuration

**`github.json`** -- Per-character config in the `me/` directory:
```json
{
  "token": "ghp_...",
  "repos": ["owner/repo1", "owner/repo2"]
}
```

**Tempo constants** (in `phases.ts`):
- Tick interval: 30 seconds
- Break duration: 90 minutes
- Break poll interval: 5 seconds
- Dream threshold: 200 diary lines

## Key Files

| File | Purpose |
|------|---------|
| `phases.ts` | Phase definitions and tempo config |
| `index.ts` | Domain bundle assembly and skill loading |
| `types.ts` | All domain types |
| `github-client.ts` | GraphQL polling client |
| `prompt-builder.ts` | Prompt generation |
| `interrupts.ts` | Interrupt rules |
| `situation-classifier.ts` | Situation classification |
| `renderer.ts` | State rendering |
| `session-system-prompt.md` | System prompt for the persistent session |
| `procedures/` | Procedure templates (select, triage, feature, review) |
