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

// =====================================================
// Per-Repo State (from GitHub API + local)
// =====================================================

export interface RepoState {
  owner: string
  repo: string
  openIssues: Issue[]
  openPRs: PullRequest[]
  ciStatus: "passing" | "failing" | "unknown"
  recentActivity: string[]
  /** Path to the shared clone inside the container. */
  clonePath: string
  /** Character's worktree path for this repo (if created). */
  worktreePath: string | null
  /** Current branch in the character's worktree (or main in the shared clone). */
  currentBranch: string | null
}

// =====================================================
// Aggregate State (what the brain sees)
// =====================================================

export interface GitHubState {
  repos: RepoState[]
  tick: number
  timestamp: number
}

// =====================================================
// Character Config (github.json)
// =====================================================

export interface GitHubCharacterConfig {
  token: string
  repos: string[]  // "owner/repo" format
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

/** Per-repo situation summary, rolled up for the brain. */
export interface RepoSituation {
  owner: string
  repo: string
  type: GitHubSituationType
  flags: GitHubSituationFlags
}

export interface GitHubSituation {
  type: GitHubSituationType  // worst across all repos
  repos: RepoSituation[]
  alerts: Array<{ priority: "critical" | "high" | "medium" | "low"; message: string; suggestedAction?: string }>
}

// =====================================================
// Event Types
// =====================================================

export type GitHubEvent =
  | { type: "poll_update"; payload: { repoIndex: number; repoState: RepoState } }
  | { type: "tick"; payload: { tick: number } }
