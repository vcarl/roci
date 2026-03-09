# GitHub Domain — Status & Next Steps

## Completed This Session

- [x] Fix auth header (`Bearer` → `token` scheme for PATs)
- [x] Fix error handling — log actual errors instead of swallowing
- [x] Include GitHub response body in API error messages
- [x] Add token validation (catch placeholder/empty tokens early)
- [x] Implement stalePRs check (was a TODO stub)
- [x] Replace credentials.txt with github.json (`{ token, repos }`)
- [x] Multi-repo support — brain sees all repos, subagent scoped to one
- [x] Shared clone model — one clone per repo at `/work/repos/<owner>--<repo>`
- [x] Per-character worktree dirs at `/work/players/<name>/worktrees/`
- [x] Volume mount for `/work/repos` — clones persist across container restarts
- [x] Prompts teach worktree workflow (don't modify shared clone directly)
- [x] Situation classifier / interrupts aggregate across repos
- [x] `containerAddDirs` includes `/work/repos`
- [x] Git author is `Claude <noreply@anthropic.com>`, characters sign off in commits
- [x] `GH_TOKEN` passed to subagent env so `gh` CLI works per-character
- [x] `init --domain github` CLI command — validates config, creates repos/
- [x] Token validation in init (fetches GitHub API to verify PAT)
- [x] Docker availability check in init
- [x] Init as generic domain procedure — `DomainProcedure<InitContext>` contract
- [x] CLI init delegates to domain's `initProcedure` / `initProject` / `characterSetupGuide`
- [x] SpaceMolt init procedure stub (validates credentials.txt)

## Ready to Test

The GitHub domain is feature-complete for a first run. To test:

1. `npx tsx src/main.ts init --domain github`
2. Set a real token in `players/<name>/me/github.json`
3. Set `CLAUDE_CODE_OAUTH_TOKEN` in `.env`
4. `npx tsx src/main.ts start --domain github`

### Known risks for first test
- `gh` CLI: `GH_TOKEN` env var should work for most commands, but some
  (like `gh auth status`) may still require `gh auth login`. If we hit
  this, add `gh auth login --with-token` in the startup phase.
- Shared clone fetch: only happens at startup. Long sessions may work
  with stale local state. Could add periodic fetch in the poll cycle.
- Worktree creation: handled entirely by the agent via prompts. If the
  agent doesn't follow instructions, worktrees won't be created. May
  need orchestrator-level worktree management if this is unreliable.
- REST rate limit risk resolved — now uses GraphQL (1 query/repo/poll).
- Process exit detection: fixed (waits for exitCode), but ToolSearch tool
  use by subagent can still cause early exit in some cases.

## Next: First Real Test

- [ ] Create a test repo on GitHub (or use an existing one)
- [ ] Configure a character with a real PAT
- [ ] Run the full loop and observe: does the agent clone, create worktrees, triage, code, PR?
- [ ] Fix whatever breaks

## Recent Changes (2026-03-09)

- Brain/body prompts overhauled — identity injected into brain, directive-style briefings, body trusts brain output
- Process runner now waits for `process.exitCode` (not stdout drain) — fixes premature completion detection
- GraphQL migration — replaced ~39 REST API calls per poll with 1 GraphQL query per repo
- Enriched state — PR branches, body, mergeable, mergeStateStatus, size stats, comments; issue milestone + reactions

## Next: Hardening

- [ ] Periodic `git fetch` on shared clones during poll cycle (GraphQL polling replaces REST for state, but local clones still only fetched at startup)
- [x] Delete old `credentials.txt` from github-test (SpaceMolt vestige)
- [ ] Error recovery: what happens if clone fails mid-startup?
- [ ] Worktree cleanup: stale worktrees from merged branches

## Next: Character Creation CLI

- [ ] `init --domain github --create-character <name>` scaffolds player dir
- [ ] Interactive: prompt for token, repos, personality
- [ ] Auto-add to config.json

## Future: Collaboration Features

- [ ] Deliberation phase — invoke multiple characters around shared context
  (planning meetings, architecture decisions, doc review)
- [ ] Cross-character PR awareness — orchestrator knows who authored which PR,
  routes reviews to other characters
- [ ] Shared context channel — characters can leave notes for each other
  (maybe via a shared file or GitHub discussions)

## Future: Symphony-Inspired Ideas

(From comparison with OpenAI's Symphony spec)
- [ ] Approval policies — human gate before certain actions (force push, deploy)
- [ ] Hook scripts — pre/post task hooks for validation
- [ ] Status dashboard — human-readable view of what all characters are doing
