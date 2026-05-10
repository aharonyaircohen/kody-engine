/**
 * Preflight (runWhen state==="active"): close child task issues whose
 * PR has merged into the goal branch.
 *
 * `Closes #N` in a PR body only auto-closes the issue when the PR
 * merges into the *default* branch. Goal-task PRs target the goal
 * branch, so we close them ourselves. Without this, in_flight stays
 * > 0 forever and the goal stalls after task 1.
 */

import type { PreflightScript } from "../executables/types.js"
import { closeIssue, getIssueState, inferLinkedIssue, listPrsByBase } from "../goal/operations.js"
import type { GoalCtx } from "./goalCtx.js"

export const closeMergedTaskIssues: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  const merged = listPrsByBase(goal.goalBranch, "merged", ctx.cwd)
  if (!merged.ok) {
    process.stderr.write(`[goal-tick] closeMergedTaskIssues: list failed: ${merged.error}\n`)
    return
  }

  const seen = new Set<number>()
  for (const pr of merged.value ?? []) {
    const linked = inferLinkedIssue(pr)
    if (linked === undefined || seen.has(linked)) continue
    seen.add(linked)

    const stateRes = getIssueState(linked, ctx.cwd)
    if (!stateRes.ok || stateRes.value !== "OPEN") continue

    process.stdout.write(`[goal-tick] closing #${linked} (PR merged into ${goal.goalBranch})\n`)
    const r = closeIssue(
      linked,
      {
        comment: `_Closed by goal-tick: PR for this task merged into \`${goal.goalBranch}\`._`,
        reason: "completed",
      },
      ctx.cwd,
    )
    if (!r.ok) {
      process.stderr.write(`[goal-tick] failed to close #${linked}: ${r.error} (continuing)\n`)
    }
  }
}
