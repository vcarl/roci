# GitHub Domain

AI agents that manage GitHub repositories through a hypervisor brain/body execution model. Each character monitors a set of repos, triages issues, reviews PRs, investigates CI failures, and implements code changes -- all within a structured cycle of investigation, action, and reflection.

## Execution Model

The GitHub domain uses the **hypervisor** execution model (`runHypervisor` from `core/orchestrator/hypervisor.ts`). Each active phase runs up to 3 brain/body cycles:

1. **Brain** (Opus, 8-minute timeout) -- Receives a structured briefing of current repo state (issues, PRs, CI status, recent commits). Reads its diary, updates it if needed, then produces a single text output: a briefing containing situation assessment, priorities, and specific directives for the body. Tool calls are allowed (diary writes, targeted investigation) but their output is not forwarded -- only the final text response reaches the body.

2. **Body** (Sonnet, 15-minute timeout) -- Receives the brain's briefing as its opening prompt. Has full access to `gh` CLI, `git`, and all standard tools inside the Docker container. Executes directives sequentially: investigating issues, writing code in worktrees, pushing branches, opening PRs, submitting reviews, applying labels. Reports results back to the orchestrator.

The brain sees repo state, identity files, diary, cycle progress, soft alerts, and state diffs from previous cycles. The body sees the brain's briefing plus the body system prompt describing its environment, capabilities, and constraints.

Certain tools are blocked from the brain session to prevent hangs: `ToolSearch`, `MCPSearch`, `WebFetch`, `WebSearch`, `NotebookEdit`, and `Edit`.

## Phase Lifecycle

```
startup --> active --> break --> reflection --> active (loop)
                 \                    ^
                  \---> (interrupt) --/
```

- **startup** -- Reads `github.json`, validates the token against `/user`, clones all configured repos into `/work/repos/owner--repo`, creates worktree directories, starts the `GitHubClient` polling fiber.

- **active** -- Runs `runHypervisor` with up to 3 brain/body cycles. Drains pending events between cycles to keep state current. On completion, transitions to `break`. If a critical interrupt fires mid-cycle, returns `Interrupted` and re-enters `active` immediately.

- **break** -- Sleeps for 90 minutes via `runBreak`, polling for critical interrupts every 5 seconds. If a critical interrupt fires (e.g., CI starts failing), exits early to `active`. Otherwise, proceeds to `reflection`.

- **reflection** -- Runs `runReflection` to compress the diary if it exceeds 200 lines (the dream threshold). Always transitions back to `active`.

## Service Implementations

### EventProcessor

Handles two event types:

- `poll_update` -- Merges fresh `RepoState` from the GraphQL poller into the aggregate `GitHubState`. Preserves local-only fields (`clonePath`, `worktreePath`, `currentBranch`) that the API does not know about.
- `tick` -- Heartbeat event. Advances the tick counter.

### SituationClassifier

Classifies each repo independently, then rolls up to an aggregate situation using worst-first priority ordering:

1. `ci_failing` -- Default branch CI is failing
2. `triage_needed` -- Untriaged issues exist (missing `triaged` label)
3. `review_needed` -- Non-draft PRs with passing checks await review, or the authenticated user's review is explicitly requested
4. `work_available` -- Open issues exist but nothing is urgent
5. `idle` -- No actionable items

Produces a `SituationSummary` with an overview section, per-repo detail sections (CI status, issue/PR breakdowns with labels, assignees, comments, recent commits), a headline, and numeric metrics.

### InterruptRegistry

Five interrupt rules, evaluated against current state:

| Rule | Priority | Trigger |
|------|----------|---------|
| `ci_failing_main` | critical | Any repo has CI failing |
| `review_requested` | high | Authenticated user's review is requested on a non-draft PR |
| `untriaged_issues` | medium | 5+ untriaged issues across all repos |
| `claimed_issue_activity` | medium | New comments on issues assigned to the authenticated user |
| `stale_prs` | low | PRs older than 7 days with no activity |

Only `ci_failing_main` is critical and can wake the agent from a break phase.

### PromptBuilder

Implements all prompt interfaces:

- `brainPrompt` -- Assembles state summary, identity, values, diary, cycle progress, soft alerts, and state diffs for the hypervisor brain.
- `planPrompt` -- Template-based. In `select` mode, first prompts for an investigation step, then (with investigation results) presents available procedures and requires one to be chosen. For specific procedures (`triage`, `feature`, `review`), renders the corresponding procedure template.
- `subagentPrompt` -- Task-specific prompts for `investigate`, `triage`, `code`, `review`, `investigate_ci`, and `diary` tasks. Each specifies allowed/forbidden operations.
- `systemPrompt` -- Mode-specific system prompts (read-only, triage, feature, review, diary) that define capability boundaries for subagents.
- `evaluatePrompt` / `interruptPrompt` -- Template-based, loaded from `prompts/` directory.

### StateRenderer

- `snapshot` -- Compact view: repo name, issue/PR counts, CI status, tick.
- `richSnapshot` -- Includes per-issue labels/assignees/authors and per-PR check/review/reviewer details. Used for diff computation.
- `stateDiff` -- Compares rich snapshots to detect changes in issue counts, PR counts, CI status, label additions/removals, assignee changes, review status changes, and new issues/PRs.
- `logStateBar` -- Writes a compact status line to stderr: repo count, issue count, PR count, CI failures.

### SkillRegistry

File-based loader. Reads `SKILL.md` files from `.claude/skills/` subdirectories at startup. Each skill file uses YAML frontmatter (`name`, `description`, `model`, `timeoutTicks`) and a markdown body for instructions. Completion checking always falls through to the LLM evaluator.

## Data Model

**`GitHubState`** -- Top-level aggregate: array of `RepoState`, tick counter, timestamp, authenticated username.

**`RepoState`** -- Per-repo snapshot: open issues, open PRs, CI status (`passing | failing | unknown`), recent commits, recent activity log, clone path, worktree path, current branch.

**`Issue`** -- Number, title, labels, assignees, author, timestamps, body, comment count, recent comments, milestone, reaction count.

**`PullRequest`** -- Number, title, author, draft flag, head SHA/branch, base branch, body, checks status, mergeable state, merge state status, review status, reviews array, requested reviewers, timestamps, changed files count, additions/deletions, recent comments.

**`GitHubSituation`** -- Aggregate situation type (worst across repos) plus per-repo `RepoSituation` entries with individual type and flags.

## Configuration

**`github.json`** -- Per-character config file in the character's `me/` directory:
```json
{
  "token": "ghp_...",
  "repos": ["owner/repo1", "owner/repo2"]
}
```

**Tempo constants** (in `phases.ts`):
- Tick interval: 30 seconds
- Max cycles per active phase: 3
- Break duration: 90 minutes
- Break poll interval: 5 seconds
- Dream threshold: 200 diary lines
- Brain timeout: 8 minutes
- Body timeout: 15 minutes

**Environment:** `GH_TOKEN` is injected per-subagent via `containerEnv`. Repos are volume-mounted at `/work/repos` on the host. Git author is always `Claude <noreply@anthropic.com>`; characters sign off in commit bodies.

## Key Files

| File | Purpose |
|------|---------|
| `phases.ts` | Phase definitions (startup, active, break, reflection) and tempo config |
| `index.ts` | Domain bundle assembly and file-based skill registry |
| `types.ts` | All domain types: state, events, situations, config |
| `github-client.ts` | GraphQL polling client (1 query per repo per poll) |
| `event-processor.ts` | Translates poll_update and tick events into state changes |
| `situation-classifier.ts` | Per-repo classification and aggregate rollup with structured sections |
| `interrupts.ts` | Five interrupt rules with priority levels |
| `prompt-builder.ts` | All prompt generation: brain, plan, subagent, evaluate, interrupt, system |
| `prompt-helpers.ts` | Shared helpers for identity sections, timing, repo summaries |
| `renderer.ts` | State snapshots, rich diffs, status bar |
| `brain-system-prompt.md` | System prompt for the Opus brain session |
| `body-system-prompt.md` | System prompt for the Sonnet body session |
| `procedures/` | Procedure templates (select, triage, feature, review) |
| `prompts/` | Prompt templates (evaluate, interrupt) |
| `skills/` | Skill definitions loaded at startup |
| `config.ts` | Domain configuration utilities |
