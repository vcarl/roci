# Contributing to Signal

## Development Setup

```bash
git clone <repo-url>
cd Signal
pnpm install
pnpm build
```

Verify your environment:
- Node.js >= 22
- pnpm >= 9
- Docker running
- Claude Code CLI installed and authenticated

## Monorepo Conventions

This is a pnpm workspace monorepo with Nx for build orchestration.

### Where code goes

- **`packages/core/`** (`@signal/core`) -- Domain-agnostic engine code. Types, services, orchestrator engines, limbic subsystems, and logging all live here. Changes here affect all domains.
- **`packages/domain-*/`** (`@signal/domain-*`) -- Domain-specific implementations. Each domain provides the Effect service layers that the engine requires.
- **`apps/signal/`** (`signal`) -- CLI entry point and domain registry. This is where domains are wired into the CLI.
- **`docs/`** -- Project documentation.
- **`shared-resources/`** -- Assets shared across domains.

### Package boundaries

- Domain packages depend on `@signal/core` but never on each other.
- The `signal` app depends on `@signal/core` and all domain packages.
- Core never imports from domain packages or the app.

## Code Style

### Formatting and Linting

The project uses [Biome](https://biomejs.dev/) for both formatting and linting. Run checks with:

```bash
pnpm lint        # Lint only
pnpm format      # Auto-format
pnpm check       # Both lint and format
```

### TypeScript and Effect-TS

- TypeScript strict mode is enabled.
- The project uses Effect-TS heavily. All services are Effect Context Tags with Layers for dependency injection.
- Follow existing patterns for service definitions, error handling, and streaming.
- Use `Effect.gen` for async composition rather than raw Promises.

## Adding a New Domain

1. Create a new package under `packages/domain-<name>/`.
2. Implement the required Effect service layers.
3. Register the domain in the CLI app.

See [docs/DOMAIN_GUIDE.md](docs/DOMAIN_GUIDE.md) for a detailed walkthrough.

## Build and Test Commands

```bash
pnpm build       # Build all packages (via Nx)
pnpm test        # Run tests (Vitest)
pnpm typecheck   # Type-check all packages (via Nx)
pnpm lint        # Lint with Biome
pnpm format      # Format with Biome
pnpm check       # Lint + format with Biome
```

To run commands for a specific package:

```bash
pnpm --filter @signal/core build
pnpm --filter signal signal start
```

## Commit Conventions

- Use imperative mood in commit messages ("Add feature", not "Added feature").
- Focus on the "why" -- explain the reason for the change, not just what changed.
- Keep the first line under 72 characters.
- Reference issues or context in the commit body when relevant.
