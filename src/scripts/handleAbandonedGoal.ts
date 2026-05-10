/**
 * Preflight (runWhen state==="abandoned"): close every open child task,
 * close the goal PR if open, then transition state → "closed". Subsequent
 * scripts in the chain are gated by `state==="active"` so they no-op
 * after this runs.
 */

import type { PreflightScript } from "../executables/types.js"
import { closeIssue, closePr, listGoalIssues, listPrsByHead } from "../goal/operations.js"
import type { GoalCtx } from "./goalCtx.js"

export const handleAbandonedGoal: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal || goal.state !== "abandoned") return

  process.stdout.write(`[goal-tick] ${goal.id} is abandoned — running cleanup\n`)

  const issues = listGoalIssues(goal.id, goal.goalIssueNumber, ctx.cwd)
  if (!issues.ok) {
    process.stderr.write(`[goal-tick] handleAbandonedGoal: list failed: ${issues.error}\n`)
  } else {
    for (const i of issues.value ?? []) {
      if (i.state !== "OPEN") continue
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
  }

  const goalPrs = listPrsByHead(goal.goalBranch, "open", ctx.cwd)
  if (goalPrs.ok && goalPrs.value && goalPrs.value.length > 0) {
    const pr = goalPrs.value[0]!
    const r = closePr(pr.number, "_Goal abandoned by operator — closing without merge._", ctx.cwd)
    if (!r.ok) {
      process.stderr.write(`[goal-tick] handleAbandonedGoal: failed to close goal PR #${pr.number}: ${r.error}\n`)
    }
  }

  // Transition state. saveGoalState (last preflight) will write to disk.
  goal.state = "closed"
}
