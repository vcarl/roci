// =====================================================
// GitHub Domain Types
// =====================================================

export interface IssueComment {
  author: string
  createdAt: string
  body: string
}

export interface Issue {
  number: number
  title: string
  labels: string[]
  assignees: string[]
  author: string
  createdAt: string
  updatedAt: string
  body: string
  commentCount: number
  recentComments: IssueComment[]
  milestone: string | null
  reactionCount: number
}

export interface PullRequestReview {
  reviewer: string
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"
  submittedAt: string
}

export interface PullRequest {
  number: number
  title: string
  author: string
  draft: boolean
  headSha: string
  headBranch: string
  baseBranch: string
  body: string
  checks: "pending" | "passing" | "failing"
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  mergeStateStatus: "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE"
  reviewStatus: "none" | "approved" | "changes_requested" | "review_required"
  reviews: PullRequestReview[]
  requestedReviewers: string[]
  createdAt: string
  changedFiles: number
  additions: number
  deletions: number
  recentComments: IssueComment[]
}

// =====================================================
// Per-Repo State (from GitHub API + local)
// =====================================================

export interface RepoCommit {
  sha: string
  message: string
  author: string
  date: string
}

export interface RepoState {
  owner: string
  repo: string
  openIssues: Issue[]
  openPRs: PullRequest[]
  ciStatus: "passing" | "failing" | "unknown"
  recentCommits: RepoCommit[]
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
  authenticatedUser: string
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
  reviewRequested: boolean
  claimedIssueActivity: boolean
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
}

// =====================================================
// Event Types
// =====================================================

export type GitHubEvent =
  | { type: "poll_update"; payload: { repoIndex: number; repoState: RepoState } }
  | { type: "tick"; payload: { tick: number } }
