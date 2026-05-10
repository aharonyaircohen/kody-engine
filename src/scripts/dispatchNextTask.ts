/**
 * Preflight (runWhen phase==="ready-to-dispatch"): pick the lowest-
 * numbered open undispatched task issue, post `@kody --base <goal>`
 * on it, stamp it with `goal-runner:dispatched`. Records the issue
 * number in `ctx.data.goal.lastDispatchedIssue` so saveGoalState
 * persists it.
 */

import type { PreflightScript } from "../executables/types.js"
import { DISPATCHED_LABEL } from "../goal/labels.js"
import { addLabel, commentOnIssue } from "../goal/operations.js"
import { pickNextDispatchable } from "../goal/phase.js"
import type { GoalCtx } from "./goalCtx.js"

export const dispatchNextTask: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal?.childTasks) return

  const next = pickNextDispatchable({
    lifecycleState: goal.state,
    childTasks: goal.childTasks,
  })
  if (!next) {
    process.stdout.write("[goal-tick] no undispatched open task — idle\n")
    return
  }

  process.stdout.write(`[goal-tick] dispatching @kody on task #${next.number} (--base ${goal.goalBranch})\n`)

  const comment = commentOnIssue(next.number, `@kody --base ${goal.goalBranch}`, ctx.cwd)
  if (!comment.ok) {
    process.stderr.write(`[goal-tick] dispatchNextTask: comment failed on #${next.number}: ${comment.error}\n`)
    return
  }

  const label = addLabel(next.number, DISPATCHED_LABEL, ctx.cwd)
  if (!label.ok) {
    process.stderr.write(
      `[goal-tick] dispatchNextTask: add-label failed on #${next.number}: ${label.error} (continuing — comment already posted)\n`,
    )
  }

  goal.lastDispatchedIssue = next.number
}
