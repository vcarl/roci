# GitHub Domain — Remaining Work

## Done

- [x] Fix auth header (`Bearer` → `token` scheme for PATs)
- [x] Fix error handling — log actual errors instead of swallowing
- [x] Include GitHub response body in API error messages
- [x] Add token validation (catch placeholder/empty tokens early)
- [x] Implement stalePRs check (was a TODO stub)
- [x] Replace credentials.txt with github.json (`{ token, repos }`)
- [x] Multi-repo support — brain sees all repos, subagent scoped to one
- [x] Shared clone model — one clone per repo at `/work/repos/<owner>--<repo>`
- [x] Per-character worktree directories at `/work/players/<name>/worktrees/`
- [x] Volume mount for `/work/repos` — clones persist across container restarts
- [x] `repos/` in .gitignore
- [x] Prompts teach worktree workflow (don't modify shared clone directly)
- [x] Situation classifier / interrupts aggregate across repos
- [x] `containerAddDirs` includes `/work/repos`

## Next Steps

- [ ] Test with a real GitHub token and repos
- [ ] `gh auth login --with-token` in container setup so `gh` CLI works
- [ ] Fetch shared clones during poll cycle (not just at startup)
- [ ] git identity: each character needs their own — currently last writer wins on shared clone config
- [ ] Future: deliberation phase — invoke multiple characters around shared context
- [ ] Future: characters review each other's PRs (orchestrator awareness of PR authorship)
