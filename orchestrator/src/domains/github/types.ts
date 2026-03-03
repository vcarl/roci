// =====================================================
// GitHub Domain Types
// =====================================================

export interface Issue {
  number: number
  title: string
  labels: string[]
  author: string
  createdAt: string
  body: string
}

export interface PullRequest {
  number: number
  title: string
  author: string
  draft: boolean
  checks: "pending" | "passing" | "failing"
  reviewStatus: "none" | "approved" | "changes_requested" | "review_required"
  createdAt: string
}

export interface RepoState {
  owner: string
  repo: string
  openIssues: Issue[]
  openPRs: PullRequest[]
  ciStatus: "passing" | "failing" | "unknown"
  recentActivity: string[]
  tick: number
  timestamp: number
}

// =====================================================
// Situation Types
// =====================================================

export type GitHubSituationType =
  | "idle"
  | "ci_failing"
  | "triage_needed"
  | "review_needed"
  | "work_available"

export interface GitHubSituationFlags {
  ciFailing: boolean
  untriagedIssues: boolean
  reviewablePRs: boolean
  stalePRs: boolean
}

export interface GitHubSituation {
  type: GitHubSituationType
  flags: GitHubSituationFlags
  alerts: Array<{ priority: "critical" | "high" | "medium" | "low"; message: string; suggestedAction?: string }>
}

// =====================================================
// Event Types
// =====================================================

export type GitHubEvent =
  | { type: "poll_update"; payload: RepoState }
  | { type: "tick"; payload: { tick: number } }
