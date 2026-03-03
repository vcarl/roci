import { Layer } from "effect"
import type { SituationClassifier } from "../../core/situation.js"
import { SituationClassifierTag } from "../../core/situation.js"
import type { RepoState, GitHubSituation, GitHubSituationType } from "./types.js"

function classify(state: RepoState): GitHubSituation {
  const ciFailing = state.ciStatus === "failing"
  const untriagedIssues = state.openIssues.some((i) => !i.labels.includes("triaged"))
  const reviewablePRs = state.openPRs.some(
    (pr) => !pr.draft && pr.checks === "passing" && pr.reviewStatus === "review_required",
  )
  const stalePRs = false // TODO: implement staleness check based on createdAt

  const flags = { ciFailing, untriagedIssues, reviewablePRs, stalePRs }

  let type: GitHubSituationType = "idle"
  if (ciFailing) type = "ci_failing"
  else if (untriagedIssues) type = "triage_needed"
  else if (reviewablePRs) type = "review_needed"
  else if (state.openIssues.length > 0) type = "work_available"

  return { type, flags, alerts: [] }
}

function briefing(state: RepoState, situation: GitHubSituation): string {
  const parts = [
    `${state.owner}/${state.repo}`,
    `${state.openIssues.length} open issues`,
    `${state.openPRs.length} open PRs`,
    `CI: ${state.ciStatus}`,
    `Situation: ${situation.type}`,
  ]
  return parts.join(" | ")
}

const gitHubSituationClassifier: SituationClassifier = {
  classify(state) {
    return classify(state as RepoState)
  },
  briefing(state, situation) {
    return briefing(state as RepoState, situation as GitHubSituation)
  },
}

/** Layer providing the GitHub situation classifier. */
export const GitHubSituationClassifierLive = Layer.succeed(SituationClassifierTag, gitHubSituationClassifier)
