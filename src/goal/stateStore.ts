/**
 * Goal state persistence on the dedicated `kody-state` branch.
 *
 * Goal lifecycle state (`.kody/goals/instances/<id>/state.json`) used to be git-committed
 * to the default branch on every tick — `chore(goals): dispatched/activate/…`
 * commits were the dominant default-branch churn. These helpers read and write
 * it via the GitHub Contents API against `kody-state` (see ../stateBranch)
 * instead, mirroring the job-state backend. Synchronous (gh subprocess) so
 * script callers do not need async state plumbing.
 */

import { gh } from "../issue.js"
import { ensureStateBranch, STATE_BRANCH } from "../stateBranch.js"
import { type GoalState, parseGoalState, serializeGoalState } from "./state.js"

function statePath(goalId: string): string {
  return `.kody/goals/instances/${goalId}/state.json`
}

function is404(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /HTTP 404/i.test(msg) || /Not Found/i.test(msg)
}

/** Read + parse a goal's state from `kody-state`. `null` when it doesn't exist. */
export function fetchGoalState(owner: string, repo: string, goalId: string, cwd?: string): GoalState | null {
  const filePath = statePath(goalId)
  let raw: string
  try {
    raw = gh(["api", `/repos/${owner}/${repo}/contents/${filePath}?ref=${STATE_BRANCH}`], { cwd })
  } catch (err) {
    if (is404(err)) return null
    throw err
  }
  const o = JSON.parse(raw) as { content?: string }
  if (!o.content) return null
  const decoded = Buffer.from(o.content, "base64").toString("utf-8")
  return parseGoalState(filePath, JSON.parse(decoded))
}

/**
 * Write a goal's state to `kody-state`. Creates the branch on first use, then
 * fetches the current blob sha so the update is safe. Retries once on a sha
 * conflict (a concurrent tick wrote between our read and PUT).
 */
export function putGoalState(
  owner: string,
  repo: string,
  goalId: string,
  state: GoalState,
  message: string,
  cwd?: string,
): void {
  ensureStateBranch(owner, repo, cwd)
  const filePath = statePath(goalId)
  const content = Buffer.from(serializeGoalState(state), "utf-8").toString("base64")

  for (let attempt = 1; attempt <= 3; attempt++) {
    let sha: string | undefined
    try {
      const cur = gh(["api", `/repos/${owner}/${repo}/contents/${filePath}?ref=${STATE_BRANCH}`], { cwd })
      const o = JSON.parse(cur) as { sha?: string }
      if (o.sha) sha = o.sha
    } catch (err) {
      if (!is404(err)) throw err // 404 → new file, no sha
    }

    const payload: Record<string, unknown> = { message, content, branch: STATE_BRANCH }
    if (sha) payload.sha = sha

    try {
      gh(["api", "--method", "PUT", `/repos/${owner}/${repo}/contents/${filePath}`, "--input", "-"], {
        cwd,
        input: JSON.stringify(payload),
      })
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const conflict = /HTTP 409/i.test(msg) || /HTTP 422/i.test(msg) || /does not match|but expected/i.test(msg)
      if (!conflict || attempt === 3) throw err
      // else: re-read sha and retry
    }
  }
}
