import * as path from "node:path"
import { Effect } from "effect"
import type { DomainConfig, ContainerMount, ProcedureMessage, InitContext, DomainProcedure } from "../../core/domain-bundle.js"
import { gitHubPhaseRegistry } from "./phases.js"
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import * as readline from "node:readline"

const IMAGE_NAME = "github-agent"

/** Container volume mounts for the GitHub domain. */
const containerMounts = (projectRoot: string): ContainerMount[] => [
  {
    host: path.resolve(projectRoot, "players"),
    container: "/work/players",
  },
  {
    // Shared repo clones — persisted across container restarts
    host: path.resolve(projectRoot, "repos"),
    container: "/work/repos",
  },
  {
    host: path.resolve(projectRoot, ".claude"),
    container: "/work/.claude",
    readonly: true,
  },
  {
    // Skill files auto-discovered by subagent Claude Code instances
    host: path.resolve(projectRoot, "orchestrator/src/domains/github/.claude"),
    container: "/work/repos/.claude",
    readonly: true,
  },
  {
    host: path.resolve(projectRoot, "scripts"),
    container: "/opt/scripts",
    readonly: true,
  },
]

/**
 * Validate a GitHub PAT by calling the /user endpoint.
 * Returns { ok, login } on success, { ok: false, status } on auth failure,
 * or null if the API is unreachable.
 */
export function validateGitHubToken(
  token: string,
): Promise<{ ok: true; login: string } | { ok: false; status: number } | null> {
  return fetch("https://api.github.com/user", {
    headers: { Authorization: `token ${token}` },
  }).then(async (resp) => {
    if (resp.ok) {
      const user = (await resp.json()) as { login: string }
      return { ok: true as const, login: user.login }
    }
    return { ok: false as const, status: resp.status }
  }).catch(() => null)
}

/** Prompt the user for a line of input. */
const askUser = (question: string): Effect.Effect<string> =>
  Effect.async<string>((resume) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resume(Effect.succeed(answer.trim()))
    })
  })

/** Returns true if a repo string looks like a placeholder. */
const isPlaceholderRepo = (repo: string) =>
  repo === "owner/repo" || repo === "org/repo" || repo === "user/repo"

/** Per-character init procedure for the GitHub domain. */
const gitHubInitProcedure: DomainProcedure<InitContext> = {
  name: "github-init",
  run: (ctx) =>
    Effect.gen(function* () {
      const messages: ProcedureMessage[] = []
      const ghJsonPath = path.resolve(ctx.characterDir, "github.json")

      if (!existsSync(ghJsonPath)) {
        messages.push({ level: "error", text: `${ctx.characterName} — missing github.json` })
        return messages
      }

      let ghConfig: { token?: string; repos?: string[] }
      try {
        ghConfig = JSON.parse(readFileSync(ghJsonPath, "utf-8"))
      } catch {
        messages.push({ level: "error", text: `${ctx.characterName} — github.json is not valid JSON` })
        return messages
      }

      if (!ghConfig.token || ghConfig.token === "ghp_placeholder") {
        // Try to auto-fix from gh CLI
        try {
          const token = execSync("gh auth token", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
          if (token) {
            ghConfig.token = token
            writeFileSync(ghJsonPath, JSON.stringify(ghConfig, null, 2) + "\n")
            messages.push({ level: "ok", text: `${ctx.characterName} — wrote token from \`gh auth token\` into github.json` })
          } else {
            messages.push({ level: "warning", text: `${ctx.characterName} — github.json has placeholder token. Run \`gh auth login\` first, then re-run init.` })
          }
        } catch {
          messages.push({ level: "warning", text: `${ctx.characterName} — github.json has placeholder token and \`gh auth token\` failed. Run \`gh auth login\` first, then re-run init.` })
        }
      }

      const hasRealRepos = ghConfig.repos && ghConfig.repos.length > 0 &&
        !ghConfig.repos.every(isPlaceholderRepo)

      if (!hasRealRepos) {
        const repos: string[] = []
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const prompt = repos.length === 0
            ? `  Enter a repo (owner/repo) for ${ctx.characterName}: `
            : `  Another repo (or press Enter to finish): `
          const input = yield* askUser(prompt)
          if (!input) {
            if (repos.length === 0) {
              messages.push({ level: "warning", text: `${ctx.characterName} — no repos configured` })
            }
            break
          }
          if (!input.includes("/")) {
            messages.push({ level: "warning", text: `"${input}" doesn't look like owner/repo — skipping` })
            continue
          }
          repos.push(input)
        }

        if (repos.length > 0) {
          ghConfig.repos = repos
          writeFileSync(ghJsonPath, JSON.stringify(ghConfig, null, 2) + "\n")
          messages.push({ level: "ok", text: `${ctx.characterName} — wrote ${repos.length} repo(s) to github.json: ${repos.join(", ")}` })
        }
      } else {
        messages.push({ level: "ok", text: `${ctx.characterName} — ${ghConfig.repos!.length} repo(s): ${ghConfig.repos!.join(", ")}` })
      }

      // Validate token against GitHub API
      if (ghConfig.token && ghConfig.token !== "ghp_placeholder") {
        const tokenResult = yield* Effect.tryPromise(() => validateGitHubToken(ghConfig.token!))
        if (tokenResult === null) {
          messages.push({ level: "warning", text: `${ctx.characterName} — could not reach GitHub API (offline?)` })
        } else if (tokenResult.ok) {
          messages.push({ level: "ok", text: `${ctx.characterName} — authenticated as ${tokenResult.login}` })
        } else {
          messages.push({ level: "error", text: `${ctx.characterName} — token returned HTTP ${tokenResult.status}` })
        }
      }

      return messages
    }),
}

/** Project-level init for GitHub — ensures repos/ directory exists. */
const gitHubInitProject = (projectRoot: string): Effect.Effect<ProcedureMessage[]> =>
  Effect.sync(() => {
    const reposDir = path.resolve(projectRoot, "repos")
    if (!existsSync(reposDir)) {
      mkdirSync(reposDir, { recursive: true })
      return [{ level: "ok" as const, text: `Created ${reposDir}` }]
    }
    return [{ level: "ok" as const, text: `${reposDir} already exists` }]
  })

/** Instructions shown when no GitHub characters are configured. */
const gitHubCharacterSetupGuide = [
  `Each character needs its own GitHub service account:`,
  `  1. Create a GitHub account (e.g. roci-<character-name>)`,
  `  2. Add it as collaborator to target repos`,
  `  3. Create a fine-grained PAT with: issues:write, pull_requests:write, contents:write`,
  `  4. Put the PAT in players/<name>/me/github.json`,
  ``,
  `Required files:`,
  `  players/<name>/me/github.json  — { "token": "ghp_...", "repos": ["owner/repo"] }`,
  `  players/<name>/me/background.md — personality and identity`,
  `  players/<name>/me/VALUES.md     — working values`,
  `  players/<name>/me/DIARY.md      — empty diary template`,
  `  players/<name>/me/SECRETS.md    — empty`,
]

/** Build the GitHub domain config for a given project root. */
export const gitHubDomainConfig = (projectRoot: string): DomainConfig => ({
  phaseRegistry: gitHubPhaseRegistry,
  containerMounts: containerMounts(projectRoot),
  imageName: IMAGE_NAME,
  dockerfilePath: "orchestrator/src/domains/github/docker/Dockerfile",
  dockerContext: "orchestrator/src/domains/github/docker",
  containerAddDirs: ["/work/repos"],
  initProcedure: gitHubInitProcedure,
  initProject: gitHubInitProject,
  characterSetupGuide: gitHubCharacterSetupGuide,
})
