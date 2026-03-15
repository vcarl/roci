import { Layer } from "effect"
import type { InterruptRule } from "@signal/core/core/limbic/amygdala/interrupt.js"
import { InterruptRegistryTag, createInterruptRegistry } from "@signal/core/core/limbic/amygdala/interrupt.js"
import type { GitHubState } from "./types.js"

const UNTRIAGED_THRESHOLD = 5
const STALE_PR_DAYS = 7

const interruptRules: ReadonlyArray<InterruptRule> = [
  // ── Critical ───────────────────────────────────────────
  {
    name: "ci_failing_main",
    priority: "critical",
    condition: (s) => (s as GitHubState).repos.some((r) => r.ciStatus === "failing"),
    message: (s) => {
      const failing = (s as GitHubState).repos.filter((r) => r.ciStatus === "failing")
      return `CI is failing in: ${failing.map((r) => `${r.owner}/${r.repo}`).join(", ")}. Investigate and fix immediately.`
    },
    suggestedAction: "investigate_ci",
  },

  // ── High ─────────────────────────────────────────────
  {
    name: "review_requested",
    priority: "high",
    condition: (s) => {
      const state = s as GitHubState
      return state.repos.some((r) =>
        r.openPRs.some((pr) =>
          !pr.draft && pr.requestedReviewers.includes(state.authenticatedUser),
        ),
      )
    },
    message: (s) => {
      const state = s as GitHubState
      const prs = state.repos.flatMap((r) =>
        r.openPRs
          .filter((pr) => !pr.draft && pr.requestedReviewers.includes(state.authenticatedUser))
          .map((pr) => `${r.owner}/${r.repo}#${pr.number} "${pr.title}"`),
      )
      return `Your review is requested on: ${prs.join(", ")}`
    },
    suggestedAction: "review_pr",
    suppressWhenTaskIs: "review_pr",
  },

  // ── Medium ─────────────────────────────────────────────
  {
    name: "untriaged_issues",
    priority: "medium",
    condition: (s) => {
      const state = s as GitHubState
      const total = state.repos.reduce((sum, r) =>
        sum + r.openIssues.filter((i) => !i.labels.includes("triaged")).length, 0,
      )
      return total >= UNTRIAGED_THRESHOLD
    },
    message: (s) => {
      const state = s as GitHubState
      const total = state.repos.reduce((sum, r) =>
        sum + r.openIssues.filter((i) => !i.labels.includes("triaged")).length, 0,
      )
      return `${total} untriaged issues across repos need attention.`
    },
    suggestedAction: "triage_issues",
  },

  {
    name: "claimed_issue_activity",
    priority: "medium",
    condition: (s) => {
      const state = s as GitHubState
      return state.repos.some((r) =>
        r.openIssues.some((i) =>
          i.assignees.includes(state.authenticatedUser) && i.recentComments.length > 0,
        ),
      )
    },
    message: (s) => {
      const state = s as GitHubState
      const issues = state.repos.flatMap((r) =>
        r.openIssues
          .filter((i) => i.assignees.includes(state.authenticatedUser) && i.recentComments.length > 0)
          .map((i) => `${r.owner}/${r.repo}#${i.number} "${i.title}"`),
      )
      return `New activity on your claimed issues: ${issues.join(", ")}`
    },
    suggestedAction: "respond_to_issue",
    suppressWhenTaskIs: "respond_to_issue",
  },

  // ── Low ────────────────────────────────────────────────
  {
    name: "stale_prs",
    priority: "low",
    condition: (s) => {
      const state = s as GitHubState
      const cutoff = Date.now() - STALE_PR_DAYS * 24 * 60 * 60 * 1000
      return state.repos.some((r) =>
        r.openPRs.some((pr) => new Date(pr.createdAt).getTime() < cutoff),
      )
    },
    message: (s) => {
      const state = s as GitHubState
      const cutoff = Date.now() - STALE_PR_DAYS * 24 * 60 * 60 * 1000
      const total = state.repos.reduce((sum, r) =>
        sum + r.openPRs.filter((pr) => new Date(pr.createdAt).getTime() < cutoff).length, 0,
      )
      return `${total} PRs across repos have had no activity in ${STALE_PR_DAYS}+ days.`
    },
    suggestedAction: "review_stale_prs",
  },
]

const gitHubInterruptRegistry = createInterruptRegistry(interruptRules)

/** Layer providing the GitHub interrupt registry. */
export const GitHubInterruptRegistryLive = Layer.succeed(InterruptRegistryTag, gitHubInterruptRegistry)
