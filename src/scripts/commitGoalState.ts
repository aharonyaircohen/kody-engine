/**
 * Postflight: persist goal state to the configured Kody state repo.
 * `saveManagedGoalState` stashes the updated state on
 * `ctx.data.goalPersistState` and marks `goalPersistChanged`.
 */

import type { PostflightScript } from "../agent-actions/types.js"
import type { GoalState } from "../goal/state.js"
import { putGoalState } from "../goal/stateStore.js"
import type { GoalCtx } from "./goalCtx.js"

export const commitGoalState: PostflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return
  if (ctx.data.goalPersistChanged !== true) return

  const updated = ctx.data.goalPersistState as GoalState | undefined
  if (!updated) return

  try {
    putGoalState(ctx.config, goal.id, updated, describeCommitMessage(goal), ctx.cwd)
  } catch (err) {
    process.stderr.write(
      `[goal-manager] commitGoalState: persist to state repo failed (${
        err instanceof Error ? err.message : String(err)
      }); will retry next tick\n`,
    )
  }
}

function describeCommitMessage(goal: GoalCtx): string {
  if (goal.state === "done") return `chore(goals): complete ${goal.id}`
  return `chore(goals): update ${goal.id}`
}
