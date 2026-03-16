# Signal

Signal is a general-purpose agent orchestrator that runs autonomous character-driven sessions using Claude Code as the agent runtime. Characters have persistent identities (background, values, secrets, diary) and operate inside shared Docker containers.

The core architecture is domain-agnostic: a state machine event loop, brain/body execution model, and injectable Effect service layers handle all domain-specific behavior. New domains can be added without modifying the engine.

## Currently Implemented Domains

- **SpaceMolt** -- AI agents playing an MMO via WebSocket, using a plan/act/evaluate state machine loop
- **GitHub** -- AI agents managing repositories via a planned-action brain/body cycle with GraphQL polling

## Monorepo Structure

| Package | Name | Description |
|---------|------|-------------|
| `packages/core/` | `@signal/core` | Domain-agnostic engine: types, phase system, limbic subsystems, orchestrator engines, services (Docker, Claude, CharacterFs, OAuthToken, ProjectRoot), logging |
| `packages/domain-spacemolt/` | `@signal/domain-spacemolt` | SpaceMolt domain implementation |
| `packages/domain-github/` | `@signal/domain-github` | GitHub domain implementation |
| `apps/signal/` | `signal` | CLI entry point, setup wizards, domain registry |

Supporting directories:

- `shared-resources/` -- Shared docs and game documentation
- `docs/` -- Project documentation

## Prerequisites

- **Node.js** >= 22
- **pnpm** >= 9
- **Docker** -- Running and accessible
- **Claude Code CLI** -- Installed and authenticated with OAuth

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Initialize a new session directory
pnpm --filter signal signal init

# Run domain-specific setup (character creation, config)
pnpm --filter signal signal setup

# Start a session
pnpm --filter signal signal start
```

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

New domains are added as packages under `packages/`. A domain implements the 7 Effect service layers that the engine requires. See [docs/DOMAIN_GUIDE.md](docs/DOMAIN_GUIDE.md) for a full walkthrough.

## Architecture

See [HARNESS.md](HARNESS.md) for detailed architecture documentation covering the state machine, brain/body model, Effect service layers, and limbic subsystems.

## Tech Stack

- **TypeScript** with strict mode
- **Effect-TS** for dependency injection, error handling, streaming, and async composition
- **@effect/cli** for the CLI interface
- **pnpm workspaces** + **Nx** for monorepo management and build orchestration
- **Biome** for linting and formatting
- **Vitest** for testing
- **Docker** for container management
