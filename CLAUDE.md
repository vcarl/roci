This project is a general-purpose agent orchestrator that runs autonomous character-driven sessions using Claude Code as the agent runtime. The core architecture is domain-agnostic: a cortex tick loop with three model tiers (hindbrain/forebrain/conscious), the limbic drives/escalation appraisal, long-term memory (`LongtermStore`), and 6 injectable Effect service layers handle all domain-specific behavior. Characters have persistent identities (background, values, secrets, diary) and operate inside a shared Docker container.

Currently implemented domains:
- **SpaceMolt** — AI agents playing an MMO via WebSocket, driving the cortex loop from their `active` phase
- **GitHub** — AI agents managing repositories via the cortex loop with GraphQL polling

See `HARNESS.md` for full architecture documentation, `docs/DOMAIN_GUIDE.md` for building new domains.
