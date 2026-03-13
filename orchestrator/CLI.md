# CLI and Character Setup Guide

All commands run from the `orchestrator/` directory:

```
npx tsx src/main.ts <command> [options]
```

## Commands

### `start [characters...] [--domain <name>] [--tick-interval <seconds>] [--manual-approval]`

Start character sessions. With no arguments, starts all characters from all domains in `config.json`. Use `--domain` to restrict to one domain, or pass character names to run specific characters.

```
npx tsx src/main.ts start                          # all characters, all domains
npx tsx src/main.ts start --domain github          # all github characters
npx tsx src/main.ts start swe-dike swe-eunomia     # specific characters only
npx tsx src/main.ts start --manual-approval        # pause before each agent step
```

`--tick-interval` sets the seconds between monitor ticks (default: 30).

### `setup <character> [character...] --domain <domain>`

Interactively create a new character. Creates the player directory, prompts for domain-specific credentials, and registers the character in `config.json`. Requires `background.md` and `VALUES.md` to exist before running.

```
npx tsx src/main.ts setup my-agent --domain github
```

### `init --domain <domain>`

Validate a domain's configuration. Checks that Docker is available, `config.json` has the domain entry, all character directories exist with required files, and domain-specific config is valid (e.g., GitHub token works). Run this after `setup` to confirm everything is ready.

```
npx tsx src/main.ts init --domain github
```

### `stop [--domain <name>]`, `pause [--domain <name>]`, `resume [--domain <name>]`

Manage running containers. Without `--domain`, operates on all roci containers.

### `status`

List all roci containers and their current state.

### `destroy [--domain <name>]`

Remove roci container(s) entirely. The container will be rebuilt on next `start`.

### `logs <character>`

Show the last 50 entries from a character's `thoughts.jsonl` log.

### `auth`

Print instructions for authenticating Claude inside running containers.

### `ws-test <character>`

SpaceMolt-only. Test WebSocket connectivity to the game server using a character's credentials.

## Configuration

### config.json

Located at the project root. Maps domain names to character lists:

```json
{
  "spacemolt": {
    "characters": ["test-pilot", "test-copilot"]
  },
  "github": {
    "characters": ["swe-dike", "swe-eunomia"]
  }
}
```

The `setup` command adds characters here automatically. You can also edit it by hand.

### .env

The project root `.env` must contain `CLAUDE_CODE_OAUTH_TOKEN`. The orchestrator reads this at startup and passes it into containers.

## Character Creation

### Step 1: Write identity files

Create the character directory and write the two required files:

```
mkdir -p players/<name>/me
```

- `players/<name>/me/background.md` -- The character's personality, background, and identity. This is the core prompt that shapes how the agent behaves.
- `players/<name>/me/VALUES.md` -- Working values and principles the character follows.

### Step 2: Run setup

```
npx tsx src/main.ts setup <name> --domain <domain>
```

This command:
1. Creates `DIARY.md` and `SECRETS.md` (empty) if they do not exist.
2. Runs the domain-specific setup procedure (see below).
3. Adds the character to `config.json`.

**GitHub domain** -- Prompts for a GitHub PAT (or reads one from `gh auth token`) and target repositories (`owner/repo`). Writes `players/<name>/me/github.json`:

```json
{
  "token": "ghp_...",
  "repos": ["owner/repo"]
}
```

**SpaceMolt domain** -- Prompts for a SpaceMolt username and password. Writes `players/<name>/me/credentials.txt`:

```
Username: myuser
Password: mypass
```

### Step 3: Validate

```
npx tsx src/main.ts init --domain <domain>
```

This checks all files exist and credentials are valid (for GitHub, it calls the GitHub API to verify the token).

## Character File Structure

Each character lives under `players/<name>/me/`:

| File | Purpose | Created by |
|------|---------|------------|
| `background.md` | Identity and personality prompt | You (required before setup) |
| `VALUES.md` | Working principles | You (required before setup) |
| `DIARY.md` | Session diary, updated by the agent | `setup` (empty) |
| `SECRETS.md` | Private notes, updated by the agent | `setup` (empty) |
| `github.json` | GitHub token and repo list | `setup --domain github` |
| `credentials.txt` | SpaceMolt login credentials | `setup --domain spacemolt` |

Logs are written to `players/<name>/logs/thoughts.jsonl` during sessions.

## Docker Containers

Each domain has its own Docker image and container (`roci-<domain>`). On `start`, the orchestrator:

1. Builds the Docker image from the domain's Dockerfile (e.g., `orchestrator/src/domains/github/docker/Dockerfile` for GitHub, `.devcontainer/Dockerfile` for SpaceMolt).
2. Creates and starts a container with domain-specific volume mounts. The `players/` directory and domain resources are mounted into the container at `/work/`.
3. All characters in a domain share one container. The orchestrator spawns a fiber per character inside the shared container.

Containers persist between runs. Use `stop`/`resume` to pause, or `destroy` to remove and rebuild.

## Running a Session

```
npx tsx src/main.ts start --domain github
```

At startup the orchestrator:
1. Reads `config.json` and resolves which domains/characters to run.
2. Loads `CLAUDE_CODE_OAUTH_TOKEN` from `.env`.
3. Builds Docker images (skips if already built).
4. Ensures per-domain containers are running.
5. Forks a fiber per character, each running the domain's phase loop.

The orchestrator runs until interrupted with Ctrl-C. Monitor output in the terminal or use `logs <character>` in another shell.
