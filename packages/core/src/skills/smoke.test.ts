import { describe, it, expect } from "vitest"
import { loadSkillSync } from "./loader.js"
import { getCadenceGuidance, type Cadence } from "./cadence.js"
import type {
  ObserveResult,
  OrientResult,
  DecideResult,
  EvaluateResult,
} from "./types.js"
import * as path from "node:path"

const SKILLS_DIR = path.resolve(import.meta.dirname, ".")

/**
 * Build the full variable set for a skill, including cadence guidance injection.
 */
function withCadence(
  skillName: string,
  cadence: Cadence,
  vars: Record<string, string>,
): Record<string, string> {
  return {
    cadence,
    cadenceGuidance: getCadenceGuidance(skillName, cadence),
    ...vars,
  }
}

// -- Realistic GitHub-domain test data --

const GITHUB_EVENT_PAYLOAD = `{
  "type": "pull_request",
  "action": "review_submitted",
  "repository": "acme/web-platform",
  "pr_number": 247,
  "reviewer": "jdoe",
  "review_state": "changes_requested",
  "comments": [
    "The auth token refresh logic in src/auth/refresh.ts has a race condition when two tabs refresh simultaneously. Please add a mutex or debounce.",
    "Minor: rename \`tkn\` to \`token\` for clarity."
  ]
}`

const GITHUB_DOMAIN_STATE = `Repository: acme/web-platform
Open PRs: 12
  - #247 (auth-token-refresh) — changes requested by jdoe, 2 comments
  - #245 (update-deps) — approved, CI passing, ready to merge
  - #243 (new-dashboard) — draft, 0 reviews
Open Issues: 34
  - #501 (critical) — "Login fails on Safari 17" — assigned to me
  - #498 (enhancement) — "Add dark mode toggle" — unassigned
CI Status: green on main, red on branch auth-token-refresh
Last deploy: 2h ago, stable`

const AGENT_BACKGROUND = `I'm a software engineer agent managing the acme/web-platform repository. I specialize in frontend infrastructure and auth systems. I've been active on this repo for 3 weeks.`

const AGENT_VALUES = `- Ship working code over perfect code
- Respond to review feedback within one cycle
- Prioritize critical bugs over feature work
- Keep PRs small and focused`

const AGENT_DIARY = `Session 14: Opened PR #247 for auth token refresh. Felt good about the implementation but worried the race condition fix might not cover all edge cases.
Session 15: Got review on #247 — jdoe found the exact race condition I was worried about. Need to add mutex pattern from our shared utils.`

const ACCUMULATED_EVENTS = `[Event 1] PR #247: review submitted by jdoe — changes_requested (2 comments about race condition and naming)
[Event 2] CI: auth-token-refresh branch turned red — test auth/refresh.test.ts failing with timeout
[Event 3] Issue #501: new comment from product — "Can we get an ETA on the Safari fix?"`

const ORIENT_SECTIONS = `#### Active Work
PR #247 has changes requested — the race condition jdoe flagged is real and matches your own concern from the diary. CI is also red on that branch, likely related.

#### Incoming Pressure
Product is asking for an ETA on the Safari login bug (#501). This is critical priority but you're mid-cycle on the auth refresh work.

#### Opportunity
PR #245 (update-deps) is approved and green — could merge it to clear the queue.`

const ORIENT_METRICS = `{
  "openPRs": 12,
  "criticalIssues": 1,
  "ciStatus": "red on auth-token-refresh",
  "reviewsPending": 1,
  "lastDeploy": "2h ago"
}`

const AVAILABLE_SKILLS = `- **code-change**: Make code changes in a repository (create/edit files, commit, push)
- **pr-management**: Create, update, merge, or close pull requests
- **issue-triage**: Read, label, assign, and comment on issues
- **ci-check**: Check CI status, read logs, retry failed jobs
- **review-respond**: Address review comments on a PR`

const EXECUTION_REPORT = `Opened src/auth/refresh.ts, identified the race condition in refreshToken(). Added a module-level mutex using the shared AsyncMutex utility. Updated the test in auth/refresh.test.ts to cover concurrent refresh calls. Pushed commit "fix: add mutex to prevent concurrent token refreshes" to branch auth-token-refresh. CI triggered.`

const STATE_DIFF = `Before:
  - PR #247: changes_requested, CI red
  - src/auth/refresh.ts: no mutex, bare async refresh
After:
  - PR #247: changes_requested (push pending review re-check), CI running
  - src/auth/refresh.ts: AsyncMutex wrapping refreshToken()
  - auth/refresh.test.ts: +1 test for concurrent refresh`

const REMAINING_STEPS = `2. Respond to jdoe's naming feedback (rename tkn → token)
3. Request re-review from jdoe`

// -- Tests --

describe("skill smoke tests — render with realistic GitHub data", () => {
  describe("observe", () => {
    it("renders completely with planned-action cadence", () => {
      const skill = loadSkillSync(path.join(SKILLS_DIR, "observe.md"))
      const rendered = skill.render(
        withCadence("observe", "planned-action", {
          eventType: "pull_request.review_submitted",
          eventPayload: GITHUB_EVENT_PAYLOAD,
          waitState: "None — not currently waiting.",
        }),
      )

      expect(rendered).not.toMatch(/\{\{\w+\}\}/)
      expect(rendered).toContain("planned-action")
      expect(rendered).toContain("HIGH")
      expect(rendered).toContain("pull_request.review_submitted")
      expect(rendered).toContain("race condition")
      expect(rendered).toContain("None — not currently waiting.")
    })

    it("renders with real-time cadence and active wait state", () => {
      const skill = loadSkillSync(path.join(SKILLS_DIR, "observe.md"))
      const rendered = skill.render(
        withCadence("observe", "real-time", {
          eventType: "ci.status_change",
          eventPayload: `{"branch": "auth-token-refresh", "status": "passing", "suite": "auth/refresh.test.ts"}`,
          waitState: `Waiting for: CI to pass on auth-token-refresh\nResolution signal: ci.status_change with status=passing\nDisposition: hold`,
        }),
      )

      expect(rendered).not.toMatch(/\{\{\w+\}\}/)
      expect(rendered).toContain("real-time")
      expect(rendered).toContain("LOW")
      expect(rendered).toContain("Resolution signal")
    })
  })

  describe("orient", () => {
    it("renders completely with all identity fields", () => {
      const skill = loadSkillSync(path.join(SKILLS_DIR, "orient.md"))
      const rendered = skill.render(
        withCadence("orient", "planned-action", {
          accumulatedEvents: ACCUMULATED_EVENTS,
          domainState: GITHUB_DOMAIN_STATE,
          background: AGENT_BACKGROUND,
          values: AGENT_VALUES,
          diary: AGENT_DIARY,
          emotionalWeight: "💅💢😰",
        }),
      )

      expect(rendered).not.toMatch(/\{\{\w+\}\}/)
      expect(rendered).toContain("acme/web-platform")
      expect(rendered).toContain("race condition")
      expect(rendered).toContain("Ship working code")
      expect(rendered).toContain("💅💢😰")
      expect(rendered).toContain("Session 14")
    })
  })

  describe("decide", () => {
    it("renders completely with orient output and available skills", () => {
      const skill = loadSkillSync(path.join(SKILLS_DIR, "decide.md"))
      const rendered = skill.render(
        withCadence("decide", "planned-action", {
          headline:
            "PR #247 has changes requested and CI is red; product wants ETA on Safari bug #501",
          whatChanged:
            "Review landed on #247 with real race condition feedback; CI broke; product pinged on #501",
          emotionalState: "💅💢😰",
          sections: ORIENT_SECTIONS,
          metrics: ORIENT_METRICS,
          currentPlanState:
            "No active plan — previous session ended after opening PR #247.",
          availableSkills: AVAILABLE_SKILLS,
        }),
      )

      expect(rendered).not.toMatch(/\{\{\w+\}\}/)
      expect(rendered).toContain("PR #247")
      expect(rendered).toContain("code-change")
      expect(rendered).toContain("review-respond")
      expect(rendered).toContain("💅💢😰")
      expect(rendered).toContain("No active plan")
    })
  })

  describe("evaluate", () => {
    it("renders completely with step result data", () => {
      const skill = loadSkillSync(path.join(SKILLS_DIR, "evaluate.md"))
      const rendered = skill.render(
        withCadence("evaluate", "planned-action", {
          task: "code-change",
          goal: "Fix race condition in refreshToken() by adding mutex",
          successCondition:
            "AsyncMutex wraps refreshToken(), concurrent refresh test passes",
          ticksBudgeted: "4",
          secondsBudgeted: "120",
          ticksConsumed: "3",
          secondsConsumed: "90",
          overrunWarning: "",
          executionReport: EXECUTION_REPORT,
          stateDiff: STATE_DIFF,
          conditionCheck:
            "PASS: AsyncMutex import found in refresh.ts; concurrent test file exists",
          emotionalState: "💅",
          remainingSteps: REMAINING_STEPS,
        }),
      )

      expect(rendered).not.toMatch(/\{\{\w+\}\}/)
      expect(rendered).toContain("code-change")
      expect(rendered).toContain("AsyncMutex")
      expect(rendered).toContain("PASS")
      expect(rendered).toContain("rename tkn")
      expect(rendered).toContain("3 ticks")
    })

    it("renders with overrun warning when over budget", () => {
      const skill = loadSkillSync(path.join(SKILLS_DIR, "evaluate.md"))
      const rendered = skill.render(
        withCadence("evaluate", "real-time", {
          task: "review-respond",
          goal: "Address all review comments on PR #247",
          successCondition: "All review threads resolved, re-review requested",
          ticksBudgeted: "2",
          secondsBudgeted: "60",
          ticksConsumed: "5",
          secondsConsumed: "150",
          overrunWarning:
            "⚠️ OVERRUN: consumed 5 ticks against a 2-tick budget (150s vs 60s planned)",
          executionReport:
            "Addressed race condition comment but got stuck on a related type error. Spent extra time refactoring the token type hierarchy.",
          stateDiff:
            "Before: 2 unresolved threads\nAfter: 1 resolved, 1 still open (naming)",
          conditionCheck:
            "PARTIAL: 1 of 2 threads resolved; re-review not yet requested",
          emotionalState: "😰😰",
          remainingSteps: "3. Request re-review from jdoe",
        }),
      )

      expect(rendered).not.toMatch(/\{\{\w+\}\}/)
      expect(rendered).toContain("OVERRUN")
      expect(rendered).toContain("real-time")
      expect(rendered).toContain("more willing to replan")
    })
  })
})

describe("skill output type validation", () => {
  it("ObserveResult shape is parseable", () => {
    const raw = `{"disposition":"escalate","emotionalWeight":"💅💢","reason":"Review with changes requested on active PR"}`
    const parsed: ObserveResult = JSON.parse(raw)
    expect(parsed.disposition).toBe("escalate")
    expect(parsed.emotionalWeight).toBe("💅💢")
    expect(parsed.reason).toBeTruthy()
  })

  it("OrientResult shape is parseable", () => {
    const raw = JSON.stringify({
      headline: "PR #247 needs attention — review feedback and CI failure",
      sections: [
        {
          id: "active-work",
          heading: "Active Work",
          body: "Race condition in auth refresh needs mutex fix",
        },
      ],
      whatChanged: "Review landed with real feedback; CI broke",
      emotionalState: "💅💢😰",
      metrics: { openPRs: 12, criticalIssues: 1, ciStatus: "red" },
    })
    const parsed: OrientResult = JSON.parse(raw)
    expect(parsed.headline).toBeTruthy()
    expect(parsed.sections).toHaveLength(1)
    expect(parsed.sections[0].id).toBe("active-work")
    expect(parsed.metrics.openPRs).toBe(12)
  })

  it("DecideResult plan shape is parseable", () => {
    const raw = JSON.stringify({
      decision: "plan",
      reasoning: "Need to fix race condition and respond to review",
      steps: [
        {
          task: "code-change",
          goal: "Add mutex to refreshToken()",
          successCondition: "Concurrent refresh test passes",
          tier: "smart",
          timeoutTicks: 4,
        },
        {
          task: "review-respond",
          goal: "Address naming feedback",
          successCondition: "All threads resolved",
          tier: "fast",
          timeoutTicks: 2,
        },
      ],
    })
    const parsed: DecideResult = JSON.parse(raw)
    expect(parsed.decision).toBe("plan")
    if (parsed.decision === "plan") {
      expect(parsed.steps).toHaveLength(2)
      expect(parsed.steps[0].tier).toBe("smart")
    }
  })

  it("DecideResult wait shape is parseable", () => {
    const raw = JSON.stringify({
      decision: "wait",
      reasoning: "CI is running after push",
      wait: {
        waitingFor: "CI to pass on auth-token-refresh",
        resolutionSignal: "ci.status_change with status=passing",
        disposition: "hold",
      },
    })
    const parsed: DecideResult = JSON.parse(raw)
    expect(parsed.decision).toBe("wait")
    if (parsed.decision === "wait") {
      expect(parsed.wait.disposition).toBe("hold")
    }
  })

  it("EvaluateResult with next_step transition is parseable", () => {
    const raw = JSON.stringify({
      judgment: "succeeded",
      reasoning: "Mutex added, concurrent test passes, CI triggered",
      transition: { transition: "next_step" },
      diaryEntry:
        "AsyncMutex pattern from shared utils works well for token refresh. Remember this for other concurrent operations.",
    })
    const parsed: EvaluateResult = JSON.parse(raw)
    expect(parsed.judgment).toBe("succeeded")
    expect(parsed.transition.transition).toBe("next_step")
    expect(parsed.diaryEntry).toBeTruthy()
  })

  it("EvaluateResult with replan transition is parseable", () => {
    const raw = JSON.stringify({
      judgment: "failed",
      reasoning: "Type error in token hierarchy blocked the fix",
      transition: {
        transition: "replan",
        reason: "Need to fix type hierarchy before mutex can be added",
      },
    })
    const parsed: EvaluateResult = JSON.parse(raw)
    expect(parsed.judgment).toBe("failed")
    if (parsed.transition.transition === "replan") {
      expect(parsed.transition.reason).toBeTruthy()
    }
  })

  it("EvaluateResult tolerates extra fields from LLM", () => {
    // LLMs sometimes include all conditional fields with empty/null values
    const raw = JSON.stringify({
      judgment: "succeeded",
      reasoning: "Goal met",
      transition: {
        transition: "next_step",
        reason: "",
        wait: null,
        summary: "",
      },
      diaryEntry: null,
    })
    const parsed = JSON.parse(raw)
    // Should still be usable — the transition type is what matters
    expect(parsed.transition.transition).toBe("next_step")
    expect(parsed.judgment).toBe("succeeded")
  })
})
