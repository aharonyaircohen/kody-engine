/**
 * Preflight (runWhen state==="active"): pull the current child-task
 * snapshot from GitHub, classify the goal's phase via the pure
 * `derivePhase` function, and store both on `ctx.data.goal`.
 *
 * Downstream scripts (finalizeGoal, dispatchNextTask) gate on
 * `data.goal.phase` via runWhen — this is the ONE script in the chain
 * that decides what the next action should be.
 */

import type { PreflightScript } from "../executables/types.js"
import { listGoalIssues } from "../goal/operations.js"
import { derivePhase } from "../goal/phase.js"
import type { GoalCtx } from "./goalCtx.js"

export const deriveGoalPhase: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  const issues = listGoalIssues(goal.id, goal.goalIssueNumber, ctx.cwd)
  if (!issues.ok) {
    process.stderr.write(`[goal-tick] deriveGoalPhase: list failed: ${issues.error}\n`)
    // Conservative fallback: treat as idle so dispatch + finalize don't fire on
    // bad data.
    goal.childTasks = []
    goal.phase = "idle"
    return
  }

  const childTasks = issues.value ?? []
  goal.childTasks = childTasks
  goal.phase = derivePhase({
    lifecycleState: goal.state,
    childTasks,
  })
  process.stdout.write(`[goal-tick] phase=${goal.phase} goal=${goal.id} tasks=${childTasks.length}\n`)
}
