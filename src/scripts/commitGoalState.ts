/**
 * Postflight: persist goal state back to the `kody-state` branch via the
 * Contents API. `saveManagedGoalState` stashes the updated state on
 * `ctx.data.goalPersistState` and marks `goalPersistChanged`.
 */

import type { PostflightScript } from "../executables/types.js"
import type { GoalState } from "../goal/state.js"
import { putGoalState } from "../goal/stateStore.js"
import type { GoalCtx } from "./goalCtx.js"

const STATE_BRANCH_LABEL = "kody-state"

export const commitGoalState: PostflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return
  if (ctx.data.goalPersistChanged !== true) return

  const updated = ctx.data.goalPersistState as GoalState | undefined
  if (!updated) return

  const owner = ctx.config.github?.owner
  const repo = ctx.config.github?.repo
  if (!owner || !repo) {
    process.stderr.write(`[goal-manager] commitGoalState: missing github owner/repo; cannot persist ${goal.id}\n`)
    return
  }

  try {
    putGoalState(owner, repo, goal.id, updated, describeCommitMessage(goal), ctx.cwd)
  } catch (err) {
    process.stderr.write(
      `[goal-manager] commitGoalState: persist to ${STATE_BRANCH_LABEL} failed (${
        err instanceof Error ? err.message : String(err)
      }); will retry next tick\n`,
    )
  }
}

function describeCommitMessage(goal: GoalCtx): string {
  if (goal.state === "done") return `chore(goals): complete ${goal.id}`
  return `chore(goals): update ${goal.id}`
}
