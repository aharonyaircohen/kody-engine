/**
 * Postflight: persist the goal's state.json to the `kody-state` branch via the
 * Contents API (see ../goal/stateStore). `saveGoalState` (preflight) computed
 * the updated state and stashed it on `ctx.data.goalPersistState` plus a
 * `goalPersistChanged` flag; we skip the write entirely on a no-op tick.
 *
 * Previously this git-added/committed/pushed `.kody/goals/<id>/state.json` to
 * the default branch — the `chore(goals): …` commits that dominated the branch.
 * Best-effort: a failed write is logged and retried on the next tick.
 */

import type { PostflightScript } from "../executables/types.js"
import type { GoalState } from "../goal/state.js"
import { putGoalState } from "../goal/stateStore.js"
import type { GoalCtx } from "./goalCtx.js"

export const commitGoalState: PostflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  // No real change this tick → nothing to persist (idle ticks stay silent).
  if (ctx.data.goalPersistChanged !== true) return
  const updated = ctx.data.goalPersistState as GoalState | undefined
  if (!updated) return

  const owner = ctx.config.github?.owner
  const repo = ctx.config.github?.repo
  if (!owner || !repo) {
    process.stderr.write(`[goal-tick] commitGoalState: missing github owner/repo; cannot persist ${goal.id}\n`)
    return
  }

  try {
    putGoalState(owner, repo, goal.id, updated, describeCommitMessage(goal), ctx.cwd)
  } catch (err) {
    process.stderr.write(
      `[goal-tick] commitGoalState: persist to ${STATE_BRANCH_LABEL} failed (${err instanceof Error ? err.message : String(err)}); will retry next tick\n`,
    )
  }
}

const STATE_BRANCH_LABEL = "kody-state"

function describeCommitMessage(goal: GoalCtx): string {
  if (goal.state === "closed") return `chore(goals): abandon ${goal.id} (cleanup complete)`
  if (goal.state === "awaiting-merge") return `chore(goals): park ${goal.id} awaiting merge`
  if (goal.state === "done") return `chore(goals): mark ${goal.id} done`
  if (goal.lastDispatchedIssue !== undefined) {
    return `chore(goals): dispatched #${goal.lastDispatchedIssue} for ${goal.id}`
  }
  if (goal.phase === "in-flight") {
    return `chore(goals): tick ${goal.id} (waiting for in-flight task)`
  }
  return `chore(goals): tick ${goal.id} (idle)`
}
