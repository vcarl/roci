# Roci

Roci is a general-purpose agent orchestrator that runs autonomous character-driven sessions using Claude Code as the agent runtime. Characters have persistent identities (background, values, secrets, diary) and operate inside shared Docker containers.

The core architecture is domain-agnostic: a cortex tick loop with three model tiers (hindbrain/forebrain/conscious), operating skills (OODA loop), and 5 injectable Effect service layers handle all domain-specific behavior. A limbic drives/escalation system appraises each event to decide when to steer, reorient, or interrupt the running agent, and a long-term vector memory store persists experience across sessions. New domains can be added without modifying the engine.

## Currently Implemented Domains

- **SpaceMolt** -- AI agents playing an MMO via WebSocket
- **GitHub** -- AI agents managing repositories via GraphQL polling

## Monorepo Structure

| Package | Name | Description |
|---------|------|-------------|
| `packages/core/` | `@roci/core` | Domain-agnostic engine: types, phase system, limbic subsystems, cortex tick loop, operating skills, long-term memory, services (Docker, Claude, CharacterFs, OAuthToken, ProjectRoot), logging |
| `packages/domain-spacemolt/` | `@roci/domain-spacemolt` | SpaceMolt domain implementation |
| `packages/domain-github/` | `@roci/domain-github` | GitHub domain implementation |
| `apps/roci/` | `roci` | CLI entry point, setup wizards, domain registry |

Supporting directories:

- `shared-resources/` -- Shared docs and game documentation
- `docs/` -- Project documentation

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **Docker** -- Running and accessible (characters run in shared containers)
- **Local model runtime** -- The cortex loop (hindbrain/forebrain/conscious tiers) and interactive character creation generate against local MLX models, which the harness spawns via `mlx_lm.server`. The harness resolves the binary automatically from a Python venv at `~/llm-env` (the typical Apple-Silicon location) -- so you do **not** need to `source ~/llm-env/bin/activate` before running `roci setup`/`roci start`. Override the venv root with `ROCI_LLM_ENV=/path/to/venv`. If the venv binary isn't found, the harness falls back to a `mlx_lm.server` on `PATH` (e.g. an already-activated shell or a system install). Install it with `pip install mlx-lm` inside the venv.
- **Long-term memory embed server** -- The long-term memory backend (the in-container `memory remember`/`memory search` commands, plus the pre-cull diary->long-term promotion at session startup) is served by a host-side embeddings server bound to `127.0.0.1:8084`, running `mlx-community/bge-small-en-v1.5-bf16` (384-dim) via `scripts/embed-server/serve-embeddings.py`. It comes up **automatically** under `roci start` (and bare `roci`) -- launched at orchestrator startup alongside the MLX model tiers and reaped together with them on `SIGTERM`/`SIGINT`/exit, so there is no manual step. It resolves its Python the **same way** `mlx_lm.server` does (`$ROCI_LLM_ENV` or `~/llm-env` -> `<venv>/bin/python3`, with that venv's `bin` prepended to `PATH`, else a `python3` found on `PATH`); override explicitly with `ROCI_EMBED_PYTHON=/path/to/python`. The venv just needs `mlx-embeddings` installed (`pip install mlx-embeddings`). If no Python resolves, it logs a loud, actionable warning and continues **non-fatally** -- `roci start` does not crash, but long-term memory is unavailable for that run (watch the logs for the embed-server warning). The first embed lazily loads the model; the embed client retries with backoff, so an early `remember`/`search` tolerates the cold-start warm-up. Inside the container the `memory` CLI is provisioned eagerly at container-ensure (before the first reflection), installed as root at `/usr/local/bin/memory` and pointed at the host server.
- **Claude Code CLI** -- Installed and authenticated with OAuth (the in-container tool-using agent runtime)

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Initialize a new session directory
pnpm --filter roci roci init

# Create a character. The local model runtime is resolved automatically from
# ~/llm-env (override with ROCI_LLM_ENV=/path/to/venv); no manual `source` needed.
# `setup` is an interactive wizard: it generates each identity artifact
# (background, values, palette, diary) with the local conscious model and
# lets you accept / edit / regenerate / skip each step.
pnpm --filter roci roci setup

# Start a session (also uses the local model runtime).
pnpm --filter roci roci start
```

> The `roci` CLI is also available as a binary once built. The examples above
> use `pnpm --filter roci roci <command>` so they work straight from the repo
> without a global install.

### CLI Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize a new session directory |
| `setup` | Run domain-specific setup wizard |
| `start` | Start a session |
| `stop` | Stop a running session |
| `pause` | Pause a running session |
| `resume` | Resume a paused session |
| `status` | Show session status |
| `destroy` | Tear down a session and its resources |
| `create-app` | Scaffold a new domain application |

## Development

### Build and Test

```bash
# Build all packages
pnpm build

# Run tests
pnpm test

# Type checking
pnpm typecheck

# Lint
pnpm lint

# Format
pnpm format

# Run all Biome checks (lint + format)
pnpm check
```

### Adding a New Domain

New domains are added as packages under `packages/`. A domain implements the 5 Effect service layers that the engine requires. See [docs/DOMAIN_GUIDE.md](docs/DOMAIN_GUIDE.md) for a full walkthrough.

## Architecture

See [HARNESS.md](HARNESS.md) for detailed architecture documentation covering the cortex loop, phase system, limbic subsystems, and operating skills.

## Tech Stack

- **TypeScript** with strict mode
- **Effect-TS** for dependency injection, error handling, streaming, and async composition
- **@effect/cli** for the CLI interface
- **pnpm workspaces** + **Nx** for monorepo management and build orchestration
- **Biome** for linting and formatting
- **Vitest** for testing
- **Docker** for container management
