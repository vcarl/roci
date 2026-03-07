# Follow-Up Issues

Tracked here for later creation as GitHub issues.

## 1. Character creation CLI

`init --domain github` should scaffold a new character: create `players/<name>/me/` with template files (`background.md`, `VALUES.md`, `DIARY.md`, `SECRETS.md`, `github.json`), prompt for token and repos, and auto-add to `config.json`.

## 2. Periodic git fetch during sessions

Shared clones only fetch at startup. Long sessions work with stale code. Add periodic `git fetch --all` on shared clones (e.g. every 10 poll ticks) so characters see upstream changes.

## 3. Worktree cleanup

Detect merged branches and run `git worktree remove` on stale worktrees. Could run during startup or as a periodic maintenance task.

## 4. Deliberation phase

Invoke multiple characters in a shared context for planning, triage, or doc review. Characters would see each other's responses and collaborate on decisions before returning to solo work.

## 5. Cross-character PR awareness

Route PR reviews to other characters based on authorship. The orchestrator knows who authored which PR and can assign reviews to teammates automatically.

## 6. SpaceMolt domain: migrate off credentials.txt

Align with the GitHub domain's per-domain config file pattern (`spacemolt.json` or similar) instead of the current `credentials.txt` approach.
