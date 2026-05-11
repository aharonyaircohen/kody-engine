/**
 * Preflight (runWhen state==="abandoned"): close every open child task
 * issue and every open stacked PR for the goal, then transition state →
 * "closed". Subsequent scripts in the chain are gated by `state==="active"`
 * so they no-op after this runs.
 *
 * Stacked-PR model: nothing else to clean up — no goal branch, no goal
 * PR, no umbrella issue. Just unwind whatever's still open.
 */

import type { PreflightScript } from "../executables/types.js"
import { closeIssue, closePr, listGoalIssues, listOpenPrs } from "../goal/operations.js"
import type { GoalCtx } from "./goalCtx.js"

export const handleAbandonedGoal: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal || goal.state !== "abandoned") return

  process.stdout.write(`[goal-tick] ${goal.id} is abandoned — running cleanup\n`)

  const issues = listGoalIssues(goal.id, ctx.cwd)
  if (!issues.ok) {
    process.stderr.write(`[goal-tick] handleAbandonedGoal: list issues failed: ${issues.error}\n`)
  } else {
    const issueNumbers = new Set<number>()
    for (const i of issues.value ?? []) {
      if (i.state !== "OPEN") continue
      issueNumbers.add(i.number)
      const r = closeIssue(
        i.number,
        {
          comment: "_Goal abandoned — closing this task without dispatch._",
          reason: "not planned",
        },
        ctx.cwd,
      )
      if (!r.ok) {
        process.stderr.write(`[goal-tick] handleAbandonedGoal: failed to close #${i.number}: ${r.error}\n`)
      }
    }

    // Close any open stacked PRs for this goal's tasks.
    const prs = listOpenPrs(ctx.cwd)
    if (prs.ok) {
      for (const pr of prs.value ?? []) {
        const headMatch = pr.headRefName.match(/^(\d+)-/)
        const headIssue = headMatch ? Number.parseInt(headMatch[1]!, 10) : NaN
        if (!Number.isFinite(headIssue) || !issueNumbers.has(headIssue)) continue
        const r = closePr(pr.number, "_Goal abandoned — closing stacked PR._", ctx.cwd)
        if (!r.ok) {
          process.stderr.write(`[goal-tick] handleAbandonedGoal: failed to close PR #${pr.number}: ${r.error}\n`)
        }
      }
    }
  }

  // Transition state. saveGoalState (last preflight) will write to disk.
  goal.state = "closed"
}
