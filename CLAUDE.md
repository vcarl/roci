This project is a general-purpose agent orchestrator that runs autonomous character-driven sessions using Claude Code as the agent runtime. The core architecture is domain-agnostic: a state machine event loop, brain/body execution model, and 7 injectable Effect service layers handle all domain-specific behavior. Characters have persistent identities (background, values, secrets, diary) and operate inside a shared Docker container.

Currently implemented domains:
- **SpaceMolt** — AI agents playing an MMO via WebSocket, using a plan/act/evaluate state machine loop
- **GitHub** — AI agents managing repositories via a planned-action brain/body cycle with GraphQL polling

See `HARNESS.md` for full architecture documentation, `domains/DOMAIN_GUIDE.md` for building new domains.
