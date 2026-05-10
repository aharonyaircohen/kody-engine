/**
 * gh-CLI operations the goal-flow scripts share. Thin wrappers that
 * invoke `gh` via the existing `issue.gh` helper, surface errors via
 * the `OperationResult` shape, and have no `process.exit` calls — so
 * the scripts can decide what to do on each failure.
 *
 * Tests mock `../issue.js` (the `gh` export) and assert that the right
 * arguments were passed. No live network in unit tests.
 */

import { execFileSync } from "node:child_process"
import { gh } from "../issue.js"
import { goalLabel } from "./labels.js"
import type { GoalIssueSnapshot } from "./phase.js"

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

/**
 * List issues with `goal:<id>` label, excluding the umbrella issue and
 * pull requests. Mirrors tick.sh's `list_goal_issues`.
 */
export function listGoalIssues(
  goalId: string,
  excludeIssueNumber: number | undefined,
  cwd?: string,
): OperationResult<GoalIssueSnapshot[]> {
  try {
    const out = gh(
      [
        "api",
        `repos/{owner}/{repo}/issues?labels=${goalLabel(goalId)}&state=all&per_page=100`,
        "--jq",
        "[.[] | select(.pull_request == null) | {number, state: (.state | ascii_upcase), labels: [.labels[].name]}]",
      ],
      { cwd },
    )
    const arr = JSON.parse(out) as GoalIssueSnapshot[]
    const filtered = excludeIssueNumber !== undefined ? arr.filter((i) => i.number !== excludeIssueNumber) : arr
    return { ok: true, value: filtered }
  } catch (err) {
    return fail(err)
  }
}

/** Lazy-create a label with --force so it's safe to run on every tick. */
export function ensureLabel(name: string, color: string, description: string, cwd?: string): OperationResult {
  try {
    gh(["label", "create", name, "--color", color, "--description", description, "--force"], { cwd })
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

/** Add a label to an issue (idempotent — gh ignores already-applied labels). */
export function addLabel(issueNumber: number, label: string, cwd?: string): OperationResult {
  try {
    gh(["issue", "edit", String(issueNumber), "--add-label", label], { cwd })
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
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

/** View an issue's current state. */
export function getIssueState(issueNumber: number, cwd?: string): OperationResult<"OPEN" | "CLOSED"> {
  try {
    const out = gh(["issue", "view", String(issueNumber), "--json", "state", "--jq", ".state"], {
      cwd,
    })
    const norm = out.trim().toUpperCase()
    if (norm !== "OPEN" && norm !== "CLOSED") {
      return { ok: false, error: `unexpected state: ${out}` }
    }
    return { ok: true, value: norm }
  } catch (err) {
    return fail(err)
  }
}

/** Look up an existing umbrella issue by exact title + label. */
export function findUmbrellaByTitle(goalId: string, title: string, cwd?: string): OperationResult<number | null> {
  try {
    const out = gh(
      [
        "api",
        `repos/{owner}/{repo}/issues?labels=${goalLabel(goalId)}&state=all&per_page=100`,
        "--jq",
        `[.[] | select(.pull_request == null) | select(.title == "${title.replace(/"/g, '\\"')}")] | (map(select(.state == "open")) + map(select(.state != "open")))[0].number // empty`,
      ],
      { cwd },
    )
    const trimmed = out.trim()
    if (!trimmed) return { ok: true, value: null }
    const n = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(n)) return { ok: true, value: null }
    return { ok: true, value: n }
  } catch (err) {
    return fail(err)
  }
}

/**
 * Create an issue and parse its number from the URL gh prints.
 * Returns `{ ok: false, error: "..." }` if gh fails or the URL is malformed.
 */
export function createIssue(
  args: { title: string; body: string; labels: string[] },
  cwd?: string,
): OperationResult<number> {
  try {
    const cliArgs = ["issue", "create", "--title", args.title, "--body", args.body]
    for (const l of args.labels) cliArgs.push("--label", l)
    const url = gh(cliArgs, { cwd })
    const match = url.match(/\/issues\/(\d+)/)
    if (!match?.[1]) return { ok: false, error: `couldn't parse issue number from URL: ${url}` }
    return { ok: true, value: Number.parseInt(match[1], 10) }
  } catch (err) {
    return fail(err)
  }
}

export interface OpenPr {
  number: number
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  url: string
  headRefName?: string
  body?: string
}

/** PRs targeting a base branch. */
export function listPrsByBase(
  base: string,
  state: "open" | "closed" | "merged" | "all",
  cwd?: string,
): OperationResult<OpenPr[]> {
  try {
    const out = gh(
      [
        "pr",
        "list",
        "--base",
        base,
        "--state",
        state,
        "--limit",
        "50",
        "--json",
        "number,isDraft,mergeable,mergeStateStatus,url,headRefName,body",
      ],
      { cwd },
    )
    return { ok: true, value: JSON.parse(out) as OpenPr[] }
  } catch (err) {
    return fail(err)
  }
}

/** Open PRs whose head ref equals `head`. */
export function listPrsByHead(
  head: string,
  state: "open" | "closed" | "merged" | "all",
  cwd?: string,
): OperationResult<OpenPr[]> {
  try {
    const out = gh(
      [
        "pr",
        "list",
        "--head",
        head,
        "--state",
        state,
        "--json",
        "number,isDraft,mergeable,mergeStateStatus,url,headRefName,body",
      ],
      { cwd },
    )
    return { ok: true, value: JSON.parse(out) as OpenPr[] }
  } catch (err) {
    return fail(err)
  }
}

/** Squash-merge a PR (delete-branch=true). */
export function mergePrSquash(prNumber: number, cwd?: string): OperationResult {
  try {
    gh(["pr", "merge", String(prNumber), "--squash", "--delete-branch"], { cwd })
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

/** Create a PR. Returns the URL on success. */
export function createPr(
  args: { head: string; base: string; title: string; body: string; draft?: boolean },
  cwd?: string,
): OperationResult<string> {
  try {
    const cli = ["pr", "create", "--head", args.head, "--base", args.base, "--title", args.title, "--body", args.body]
    if (args.draft) cli.push("--draft")
    const url = gh(cli, { cwd })
    if (!url.includes("/pull/")) return { ok: false, error: `gh pr create returned unexpected output: ${url}` }
    return { ok: true, value: url.trim() }
  } catch (err) {
    return fail(err)
  }
}

/** Edit an existing PR (body refresh, ready-for-review promotion). */
export function editPrBody(prNumber: number, body: string, cwd?: string): OperationResult {
  try {
    gh(["pr", "edit", String(prNumber), "--body", body], { cwd })
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

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

// ── Git operations (subprocess via execFileSync so we don't pull in a git lib) ─

function ghTokenEnv(): NodeJS.ProcessEnv {
  const token = process.env.GH_PAT?.trim() || process.env.GH_TOKEN
  return token ? { ...process.env, GH_TOKEN: token } : { ...process.env }
}

/** True iff `refs/remotes/origin/<ref>` exists locally (assumes recent fetch). */
export function remoteBranchExists(ref: string, cwd?: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${ref}`], {
      cwd,
      stdio: "pipe",
      env: ghTokenEnv(),
    })
    return true
  } catch {
    return false
  }
}

/** `git fetch origin` (best-effort, never throws). */
export function fetchOrigin(cwd?: string): void {
  try {
    execFileSync("git", ["fetch", "origin", "--quiet"], { cwd, stdio: "pipe", env: ghTokenEnv() })
  } catch {
    /* best effort */
  }
}

/** Create `origin/<branch>` from `origin/<base>` via a server-side push. */
export function createBranchFrom(branch: string, base: string, cwd?: string): OperationResult {
  try {
    execFileSync("git", ["push", "origin", `refs/remotes/origin/${base}:refs/heads/${branch}`, "--quiet"], {
      cwd,
      stdio: "pipe",
      env: ghTokenEnv(),
    })
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export interface BranchCompare {
  ahead: number
  behind: number
}

/** `gh api compare` between two branches. */
export function compareBranches(base: string, head: string, cwd?: string): OperationResult<BranchCompare> {
  try {
    const out = gh(["api", `repos/{owner}/{repo}/compare/${base}...${head}`, "--jq", '"(.ahead_by) (.behind_by)"'], {
      cwd,
    })
    const [a, b] = out
      .trim()
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10))
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { ok: false, error: `unexpected compare output: ${out}` }
    }
    return { ok: true, value: { ahead: a as number, behind: b as number } }
  } catch (err) {
    return fail(err)
  }
}

/**
 * Parse the linked issue number from a merged PR — either via "Closes
 * #N" / "Fixes #N" / "Resolves #N" in the body, or the leading-digits
 * convention on the head ref (`<issue>-<slug>`).
 */
export function inferLinkedIssue(pr: OpenPr): number | undefined {
  const body = pr.body ?? ""
  const m = body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i)
  if (m?.[1]) return Number.parseInt(m[1], 10)
  const ref = pr.headRefName ?? ""
  const bm = ref.match(/^(\d+)-/)
  if (bm?.[1]) return Number.parseInt(bm[1], 10)
  return undefined
}
