/**
 * gh-CLI operations the goal-flow scripts share. Thin wrappers around
 * the existing `issue.gh` helper, surfacing errors via OperationResult
 * (no thrown exceptions) so callers decide what to do on each failure.
 *
 * Stacked-PR model: dropped umbrella-era helpers (createIssue,
 * findUmbrellaByTitle, ensureLabel, addLabel, compareBranches,
 * createBranchFrom, ensure-style branch ops, sequential PR merging).
 * What's left is the minimum surface for the new flow:
 *   - listGoalIssues:    enumerate child task issues for a goal
 *   - listGoalTaskPrs:   discover the PRs stacked against those issues
 *   - commentOnIssue:    @kody dispatch
 *   - closeIssue/closePr: abandonment cleanup
 *   - mergePrSquash:     finalize (squash-merge leaf → main)
 *   - fetchDefaultBranch: bootstrap base for the first task
 *
 * Tests mock `../issue.js`'s `gh` export and assert arguments. No live
 * network in unit tests.
 */

import { gh } from "../issue.js"
import { goalLabel, QA_GATE_LABEL } from "./labels.js"
import type { GoalIssueSnapshot, TaskPrState } from "./phase.js"

export interface OperationResult<T = void> {
  ok: boolean
  /** Returned on success; undefined on failure. */
  value?: T
  /** First line of stderr (or .message) on failure. */
  error?: string
}

function fail(err: unknown): OperationResult<never> {
  if (err instanceof Error) {
    const lines = err.message.split("\n").filter(Boolean)
    return { ok: false, error: lines[0] ?? err.message }
  }
  return { ok: false, error: String(err) }
}

/** Bare child-task issue view — phase.ts pairs these with PR state. */
export interface RawGoalIssue {
  number: number
  state: "OPEN" | "CLOSED"
  /**
   * True when the issue carries the `kody:qa-gate` label. The live `gh`
   * query always populates this (jq `any` → boolean); optional only so
   * ordinary-task test fixtures don't have to spell out `false`.
   */
  isQaGate?: boolean
}

/**
 * List issues with `goal:<id>` label, excluding pull requests. Each
 * returned record carries only the fields phase.ts needs; PR state
 * is attached by `listGoalTaskPrs` and merged by the caller.
 */
export function listGoalIssues(goalId: string, cwd?: string): OperationResult<RawGoalIssue[]> {
  try {
    const out = gh(
      [
        "api",
        `repos/{owner}/{repo}/issues?labels=${goalLabel(goalId)}&state=all&per_page=100`,
        "--jq",
        `[.[] | select(.pull_request == null) | {number, state: (.state | ascii_upcase), isQaGate: ([.labels[].name] | any(. == "${QA_GATE_LABEL}"))}]`,
      ],
      { cwd },
    )
    return { ok: true, value: JSON.parse(out) as RawGoalIssue[] }
  } catch (err) {
    return fail(err)
  }
}

/** Open PR view used to map issues → PR state and to walk the stack. */
export interface OpenTaskPr {
  number: number
  url: string
  isDraft: boolean
  headRefName: string
  baseRefName: string
  body: string
}

/**
 * List every OPEN PR in the repo, returning just the fields the
 * stacked-PR flow needs. Caller filters by goal/task association via
 * the body ("Closes #N") or the head ref convention (`<issueNumber>-…`).
 *
 * Single repo-wide listing is cheaper than per-issue lookups (one gh
 * call vs N) and gives us the full stack at once so the leaf can be
 * detected by base-chain traversal.
 */
export function listOpenPrs(cwd?: string): OperationResult<OpenTaskPr[]> {
  try {
    const out = gh(
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "number,url,isDraft,headRefName,baseRefName,body",
      ],
      { cwd },
    )
    return { ok: true, value: JSON.parse(out) as OpenTaskPr[] }
  } catch (err) {
    return fail(err)
  }
}

/**
 * For each child-task issue, find its open PR (if any) via the body's
 * "Closes #N" reference or the head-ref convention (`<issue>-<slug>`),
 * and return GoalIssueSnapshot[] with `prState` populated.
 *
 * Pure given inputs — no I/O. Tested directly.
 */
export function pairIssuesWithPrs(
  issues: readonly RawGoalIssue[],
  openPrs: readonly OpenTaskPr[],
): GoalIssueSnapshot[] {
  // Each PR maps to at most ONE issue. Body `Closes #N` wins over the
  // head-ref convention so an explicit reference can override a PR
  // opened against a different branch name.
  const prByIssue = new Map<number, OpenTaskPr>()
  for (const pr of openPrs) claimPrForIssue(pr, prByIssue)
  return issues.map((i) => {
    const pr = prByIssue.get(i.number)
    let prState: TaskPrState = "absent"
    if (pr) prState = pr.isDraft ? "draft" : "ready"
    return { number: i.number, state: i.state, prState, isQaGate: i.isQaGate }
  })
}

function claimPrForIssue(pr: OpenTaskPr, prByIssue: Map<number, OpenTaskPr>): void {
  for (const issueNum of extractClosesIssues(pr.body)) {
    if (!prByIssue.has(issueNum)) {
      prByIssue.set(issueNum, pr)
      return
    }
  }
  const headMatch = pr.headRefName.match(/^(\d+)-/)
  if (headMatch) {
    const n = Number.parseInt(headMatch[1]!, 10)
    if (Number.isFinite(n) && !prByIssue.has(n)) prByIssue.set(n, pr)
  }
}

/** Parse "Closes #N" / "Fixes #N" / "Resolves #N" issue refs from a PR body. */
export function extractClosesIssues(body: string): number[] {
  const out: number[] = []
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    const n = Number.parseInt(m[1]!, 10)
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/**
 * Identify the leaf of the stack: the PR whose head ref is NOT a base
 * for any other PR in the set. With a true stack there's exactly one
 * such leaf; when the stack is empty (or unsupported shape) returns
 * undefined.
 *
 * `prs` should be the subset of `listOpenPrs` already filtered to this
 * goal's task PRs.
 */
export function pickLeafPr(prs: readonly OpenTaskPr[]): OpenTaskPr | undefined {
  if (prs.length === 0) return undefined
  const bases = new Set(prs.map((p) => p.baseRefName))
  const leaves = prs.filter((p) => !bases.has(p.headRefName))
  // A well-formed stack has exactly one leaf. If multiple (parallel
  // dispatches) return the highest PR number — most recently opened.
  return leaves.sort((a, b) => b.number - a.number)[0]
}

/** Comment on an issue. */
export function commentOnIssue(issueNumber: number, body: string, cwd?: string): OperationResult {
  try {
    gh(["issue", "comment", String(issueNumber), "--body", body], { cwd })
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

/** The workflow file goal-tick dispatches a fresh per-task run against. */
export const GOAL_TASK_WORKFLOW = "kody.yml"

/**
 * Fire a fresh `workflow_dispatch` run to process one goal task: run
 * `classify` (→ build) on the task issue with a stacked-PR `base`. This
 * replaces the old `@kody --base` comment — a bot-authored comment the
 * follow-up run ignores when Kody is a GitHub App. `workflow_dispatch` is
 * not subject to that gate, starts immediately, and keeps each task in its
 * own run (so it never blocks the cron scheduler's tick).
 *
 * No `--ref`: `gh` dispatches against the repository's default branch, which
 * is where `kody.yml` (and its `executable`/`base` inputs) lives. That can
 * differ from `config.git.defaultBranch` (the integration branch the task PR
 * stacks onto, passed as `base`) — e.g. a repo whose code merges to `dev` but
 * whose workflows live on `main`.
 */
export function dispatchTaskRun(issueNumber: number, base: string, cwd?: string): OperationResult {
  try {
    gh(
      [
        "workflow",
        "run",
        GOAL_TASK_WORKFLOW,
        "-f",
        `issue_number=${issueNumber}`,
        "-f",
        "executable=classify",
        "-f",
        `base=${base}`,
      ],
      { cwd },
    )
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

/** Close an issue, optionally with a reason and a closing comment. */
export function closeIssue(
  issueNumber: number,
  options: { comment?: string; reason?: "completed" | "not planned" },
  cwd?: string,
): OperationResult {
  try {
    if (options.comment) {
      gh(["issue", "comment", String(issueNumber), "--body", options.comment], { cwd })
    }
    const args = ["issue", "close", String(issueNumber)]
    if (options.reason) args.push("--reason", options.reason)
    gh(args, { cwd })
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

/** Close a PR (no merge). */
export function closePr(prNumber: number, comment: string, cwd?: string): OperationResult {
  try {
    gh(["pr", "close", String(prNumber), "--comment", comment], { cwd })
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

/** Squash-merge a PR (delete-branch=true). Used by finalizeGoal on the leaf. */
export function mergePrSquash(prNumber: number, cwd?: string): OperationResult {
  try {
    gh(["pr", "merge", String(prNumber), "--squash", "--delete-branch"], { cwd })
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

/**
 * Retarget a PR's base branch. finalizeGoal calls this on every non-root
 * stacked PR before merging it, so the merge lands in the repo default
 * (e.g. `dev`) instead of the now-deleted predecessor's branch.
 *
 * Uses REST PATCH instead of `gh pr edit --base` because gh's edit path
 * goes through GraphQL and requires `read:org` scope, which KODY_TOKEN
 * (a plain `repo`-scoped PAT) typically lacks. Same trick we use in
 * `pr.ts` for body updates.
 */
export function editPrBase(prNumber: number, baseBranch: string, cwd?: string): OperationResult {
  try {
    gh(
      ["api", "--method", "PATCH", `repos/{owner}/{repo}/pulls/${prNumber}`, "-f", `base=${baseBranch}`],
      { cwd },
    )
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

/**
 * True when every commit on `candidateHead` is already reachable from
 * `leafHead` — i.e. the leaf branch genuinely carries that branch's
 * work. finalizeGoal uses this to decide whether closing an intermediate
 * stacked PR is safe: the "leaf carries everything" invariant only holds
 * for a strictly linear stack, and a broken chain (a task branch cut
 * fresh off the default branch instead of stacked on its predecessor)
 * silently drops that task's diff if we close it blindly.
 *
 * `compare/<leafHead>...<candidateHead>`: `ahead_by` counts commits on
 * candidate not reachable from leaf. 0 ⇒ fully contained. A 404 (branch
 * already deleted) or any API error returns ok:false so the caller can
 * fail safe (keep the PR open) rather than assume containment.
 */
export function branchContains(
  leafHead: string,
  candidateHead: string,
  cwd?: string,
): OperationResult<boolean> {
  if (leafHead === candidateHead) return { ok: true, value: true }
  try {
    const out = gh(
      [
        "api",
        `repos/{owner}/{repo}/compare/${encodeURIComponent(leafHead)}...${encodeURIComponent(candidateHead)}`,
        "--jq",
        ".ahead_by",
      ],
      { cwd },
    )
    return { ok: true, value: Number.parseInt(out.trim(), 10) === 0 }
  } catch (err) {
    return fail(err)
  }
}

/** Promote a draft PR to ready-for-review. */
export function markPrReady(prNumber: number, cwd?: string): OperationResult {
  try {
    gh(["pr", "ready", String(prNumber)], { cwd })
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

/** Repo's default branch via the GitHub API. */
export function fetchDefaultBranch(cwd?: string): OperationResult<string> {
  try {
    const out = gh(["api", "repos/{owner}/{repo}", "--jq", ".default_branch"], { cwd })
    return { ok: true, value: out.trim() }
  } catch (err) {
    return fail(err)
  }
}
