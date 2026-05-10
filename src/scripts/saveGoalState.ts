/**
 * Preflight (run last): persist `ctx.data.goal` mutations back to
 * `.kody/goals/<id>/state.json`. Mirrors tick.sh's bumpUpdatedAt +
 * write at the tail. Always sets `ctx.skipAgent = true` because
 * goal-tick is a no-agent flow.
 *
 * This script does NOT git-add/commit — that's `commitGoalState`'s job
 * in postflight, so disk writes happen before the executor's lifecycle
 * label cleanup runs and a single commit captures everything.
 */

import type { PreflightScript } from "../executables/types.js"
import type { GoalState } from "../goal/state.js"
import { nowIso, writeGoalState } from "../goal/state.js"
import type { GoalCtx } from "./goalCtx.js"

export const saveGoalState: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) {
    ctx.skipAgent = true
    return
  }

  const updated: GoalState = {
    ...(goal.raw ?? { state: goal.state, extra: {} }),
    state: goal.state,
    goalIssueNumber: goal.goalIssueNumber,
    lastDispatchedIssue: goal.lastDispatchedIssue,
    goalPrUrl: goal.goalPrUrl,
    completedAt: goal.completedAt ?? goal.raw?.completedAt,
    updatedAt: nowIso(),
  }

  writeGoalState(ctx.cwd, goal.id, updated)
  ctx.skipAgent = true
}
