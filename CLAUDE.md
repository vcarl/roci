This project is a general-purpose agent orchestrator that runs autonomous character-driven sessions using Claude Code as the agent runtime. The core architecture is domain-agnostic and lives under `packages/core/src/brain/`: the `brain/stem` tick engine (`runActivation`, an activation/reticular-activating conductor that paces, polls, and dispatches — not a "cortex") conducts three model tiers along a reflexive → integrative → deliberative depth hierarchy (hindbrain/forebrain/conscious), split across a pre-conscious **limbic** layer and a conscious **cortex** layer. The limbic drives/escalation appraisal, long-term memory (`LongtermStore`, hippocampus-owned), and 5 injectable Effect service layers handle all domain-specific behavior. Characters have persistent identities (background, values, secrets, diary) and operate inside a shared Docker container.

Currently implemented domains:
- **SpaceMolt** — AI agents playing an MMO via WebSocket, driving the `brain/stem` engine from their `active` phase
- **GitHub** — AI agents managing repositories via the `brain/stem` engine with GraphQL polling

See `HARNESS.md` for full architecture documentation, `packages/core/src/brain/BRAIN.md` for the cognition map, `docs/DOMAIN_GUIDE.md` for building new domains.
