# Roci

Roci is a general-purpose agent orchestrator that runs autonomous character-driven sessions using Claude Code as the agent runtime. Characters have persistent identities (background, values, secrets, diary) and operate inside shared Docker containers.

The core architecture is domain-agnostic: a channel session event loop, operating skills (OODA loop), and 6 injectable Effect service layers handle all domain-specific behavior. New domains can be added without modifying the engine.

## Currently Implemented Domains

- **SpaceMolt** -- AI agents playing an MMO via WebSocket
- **GitHub** -- AI agents managing repositories via GraphQL polling

## Monorepo Structure

| Package | Name | Description |
|---------|------|-------------|
| `packages/core/` | `@roci/core` | Domain-agnostic engine: types, phase system, limbic subsystems, channel session orchestrator, operating skills, services (Docker, Claude, CharacterFs, OAuthToken, ProjectRoot), logging |
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
- **Local model runtime** -- `mlx_lm.server` must be on the `PATH` of the shell that runs `roci setup`/`roci start`. The cortex loop (hindbrain/forebrain/conscious tiers) and interactive character creation generate against local MLX models, which the harness spawns by bare name. Verify with `which mlx_lm.server`. (On Apple Silicon this typically lives in a Python venv, e.g. `source ~/llm-env/bin/activate`.)
- **Claude Code CLI** -- Installed and authenticated with OAuth (the in-container tool-using agent runtime)

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Initialize a new session directory
pnpm --filter roci roci init

# Make the local model runtime reachable, then create a character.
# `setup` is an interactive wizard: it generates each identity artifact
# (background, values, palette, diary) with the local conscious model and
# lets you accept / edit / regenerate / skip each step.
which mlx_lm.server                 # must resolve; activate your venv if not
pnpm --filter roci roci setup

# Start a session (also needs mlx_lm.server on PATH)
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

New domains are added as packages under `packages/`. A domain implements the 6 Effect service layers that the engine requires. See [docs/DOMAIN_GUIDE.md](docs/DOMAIN_GUIDE.md) for a full walkthrough.

## Architecture

See [HARNESS.md](HARNESS.md) for detailed architecture documentation covering the channel session model, phase system, limbic subsystems, and operating skills.

## Tech Stack

- **TypeScript** with strict mode
- **Effect-TS** for dependency injection, error handling, streaming, and async composition
- **@effect/cli** for the CLI interface
- **pnpm workspaces** + **Nx** for monorepo management and build orchestration
- **Biome** for linting and formatting
- **Vitest** for testing
- **Docker** for container management
