import * as path from "node:path"
import { execSync } from "node:child_process"
import { Effect } from "effect"
import type { DomainConfig, ContainerMount, ProcedureMessage, InitContext, DomainProcedure } from "../../core/domain-bundle.js"
import { spaceMoltDomainBundle, spaceMoltServiceLayer } from "./index.js"
import { spaceMoltPhaseRegistry } from "./phases.js"
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { askUser } from "../../util/prompt.js"

const IMAGE_NAME = "spacemolt-player"

/** Container volume mounts for SpaceMolt. */
const containerMounts = (projectRoot: string): ContainerMount[] => [
  {
    host: path.resolve(projectRoot, "players"),
    container: "/work/players",
  },
  {
    host: path.resolve(projectRoot, "shared-resources/workspace"),
    container: "/work/shared/workspace",
  },
  {
    host: path.resolve(projectRoot, "shared-resources/spacemolt-docs"),
    container: "/work/shared/spacemolt-docs",
  },
  {
    host: path.resolve(projectRoot, "docs"),
    container: "/work/shared/docs",
  },
  {
    host: path.resolve(projectRoot, "shared-resources/sm-cli"),
    container: "/work/sm-cli",
  },
  {
    host: path.resolve(projectRoot, ".claude"),
    container: "/work/.claude",
    readonly: true,
  },
  {
    host: path.resolve(projectRoot, ".devcontainer"),
    container: "/opt/devcontainer",
    readonly: true,
  },
  {
    host: path.resolve(projectRoot, "scripts"),
    container: "/opt/scripts",
    readonly: true,
  },
]

/** Post-start container setup for SpaceMolt (creates sm CLI symlink). */
const containerSetup = (containerId: string) => {
  try {
    execSync(`docker exec -u root ${containerId} ln -sf /work/sm-cli/sm /usr/local/bin/sm`, { stdio: "pipe" })
  } catch {
    // Non-fatal — sm symlink is a convenience
  }
}

/** Per-character init procedure for SpaceMolt. */
const spaceMoltInitProcedure: DomainProcedure<InitContext> = {
  name: "spacemolt-init",
  run: (ctx) =>
    Effect.sync(() => {
      const messages: ProcedureMessage[] = []
      const credsPath = path.resolve(ctx.characterDir, "credentials.txt")

      if (!existsSync(credsPath)) {
        const regCodePath = path.resolve(ctx.characterDir, "registration-code.txt")
        if (existsSync(regCodePath)) {
          messages.push({ level: "ok", text: `${ctx.characterName} — no credentials.txt yet, but registration-code.txt found (will auto-register on first run)` })
        } else {
          messages.push({ level: "warning", text: `${ctx.characterName} — no credentials.txt or registration-code.txt. Run 'roci setup --domain spacemolt' to configure.` })
        }
        return messages
      }

      const content = readFileSync(credsPath, "utf-8")
      const hasUsername = /^Username:\s*.+/m.test(content)
      const hasPassword = /^Password:\s*.+/m.test(content)

      if (!hasUsername || !hasPassword) {
        messages.push({ level: "error", text: `${ctx.characterName} — credentials.txt missing Username or Password line` })
      } else {
        messages.push({ level: "ok", text: `${ctx.characterName} — credentials.txt valid` })
      }

      return messages
    }),
}

/** Per-character setup procedure for SpaceMolt. Prompts for registration code if no credentials exist. */
const spaceMoltSetupCharacter: DomainProcedure<InitContext> = {
  name: "spacemolt-setup",
  run: (ctx) =>
    Effect.gen(function* () {
      const messages: ProcedureMessage[] = []
      const credsPath = path.resolve(ctx.characterDir, "credentials.txt")
      const regCodePath = path.resolve(ctx.characterDir, "registration-code.txt")

      if (existsSync(credsPath)) {
        messages.push({ level: "ok", text: `${ctx.characterName} — credentials.txt already exists` })
        return messages
      }

      if (existsSync(regCodePath)) {
        messages.push({ level: "ok", text: `${ctx.characterName} — registration-code.txt already exists (will auto-register on first run)` })
        return messages
      }

      // Prompt for registration code
      const code = yield* askUser(
        `Enter SpaceMolt registration code for ${ctx.characterName} (from spacemolt.com/dashboard): `,
      )

      if (!code) {
        messages.push({ level: "warning", text: `${ctx.characterName} — no registration code provided. Run setup again or manually create players/${ctx.characterName}/me/registration-code.txt` })
        return messages
      }

      writeFileSync(regCodePath, code + "\n")
      messages.push({ level: "ok", text: `${ctx.characterName} — registration-code.txt saved (will auto-register on first run)` })
      return messages
    }),
}

/** Instructions shown when no SpaceMolt characters are configured. */
const spaceMoltCharacterSetupGuide = [
  `Each character needs:`,
  `  players/<name>/me/background.md   — personality and identity`,
  `  players/<name>/me/VALUES.md       — working values`,
  `  players/<name>/me/DIARY.md        — empty diary template`,
  `  players/<name>/me/SECRETS.md      — empty`,
  ``,
  `You'll need a registration code from spacemolt.com/dashboard.`,
  `credentials.txt is created automatically during the first run.`,
]

/** Build the SpaceMolt domain config for a given project root. */
export const spaceMoltDomainConfig = (projectRoot: string): DomainConfig => ({
  bundle: spaceMoltDomainBundle,
  phaseRegistry: spaceMoltPhaseRegistry,
  containerMounts: containerMounts(projectRoot),
  containerSetup,
  imageName: IMAGE_NAME,
  serviceLayer: spaceMoltServiceLayer,
  dockerfilePath: path.resolve(import.meta.dirname, "docker/Dockerfile"),
  dockerContext: path.resolve(import.meta.dirname, "docker"),
  containerAddDirs: ["/work/shared", "/work/sm-cli"],
  initProcedure: spaceMoltInitProcedure,
  setupCharacter: spaceMoltSetupCharacter,
  characterSetupGuide: spaceMoltCharacterSetupGuide,
  identityTemplate: {
    backgroundHints:
      "You are a character in a persistent multiplayer space MMO. You belong to a faction or empire, " +
      "have relationships with other players, and make decisions about exploration, combat, trade, and diplomacy.",
    valuesHints:
      "Your priorities include resource management, faction loyalty, combat readiness, exploration of unknown sectors, " +
      "and maintaining social relationships with allies and rivals.",
  },
})
