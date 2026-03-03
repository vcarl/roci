import { Layer } from "effect"
import type { InterruptRule } from "../../core/interrupt.js"
import { InterruptRegistryTag, createInterruptRegistry } from "../../core/interrupt.js"
import type { RepoState } from "./types.js"

const UNTRIAGED_THRESHOLD = 5
const STALE_PR_DAYS = 7

const interruptRules: ReadonlyArray<InterruptRule> = [
  // ── Critical ───────────────────────────────────────────
  {
    name: "ci_failing_main",
    priority: "critical",
    condition: (s) => (s as RepoState).ciStatus === "failing",
    message: () => "CI is failing on main. Investigate and fix immediately.",
    suggestedAction: "investigate_ci",
  },

  // ── Medium ─────────────────────────────────────────────
  {
    name: "untriaged_issues",
    priority: "medium",
    condition: (s) => {
      const state = s as RepoState
      const untriaged = state.openIssues.filter((i) => !i.labels.includes("triaged"))
      return untriaged.length >= UNTRIAGED_THRESHOLD
    },
    message: (s) => {
      const state = s as RepoState
      const count = state.openIssues.filter((i) => !i.labels.includes("triaged")).length
      return `${count} untriaged issues need attention.`
    },
    suggestedAction: "triage_issues",
  },

  // ── Low ────────────────────────────────────────────────
  {
    name: "stale_prs",
    priority: "low",
    condition: (s) => {
      const state = s as RepoState
      const cutoff = Date.now() - STALE_PR_DAYS * 24 * 60 * 60 * 1000
      return state.openPRs.some((pr) => new Date(pr.createdAt).getTime() < cutoff)
    },
    message: (s) => {
      const state = s as RepoState
      const cutoff = Date.now() - STALE_PR_DAYS * 24 * 60 * 60 * 1000
      const count = state.openPRs.filter((pr) => new Date(pr.createdAt).getTime() < cutoff).length
      return `${count} PRs have had no activity in ${STALE_PR_DAYS}+ days.`
    },
    suggestedAction: "review_stale_prs",
  },
]

const gitHubInterruptRegistry = createInterruptRegistry(interruptRules)

/** Layer providing the GitHub interrupt registry. */
export const GitHubInterruptRegistryLive = Layer.succeed(InterruptRegistryTag, gitHubInterruptRegistry)
