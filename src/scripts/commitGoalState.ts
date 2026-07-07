/**
 * Postflight: persist goal state to the configured Kody state repo.
 * `saveManagedGoalState` stashes the updated state on
 * `ctx.data.goalPersistState` and marks `goalPersistChanged`.
 */

import { refreshGoalDashboardReport } from "../goal/report.js"
import { flushGoalRunLogEvents } from "../goal/runLog.js"
import type { GoalState } from "../goal/state.js"
import { putGoalState } from "../goal/stateStore.js"
import type { PostflightScript } from "../implementations/types.js"
import type { GoalCtx } from "./goalCtx.js"

export const commitGoalState: PostflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) {
    flushLogs(ctx)
    return
  }
  if (ctx.data.goalPersistChanged !== true) {
    refreshReportOrFail(ctx, goal.id, goal.raw)
    flushLogs(ctx)
    return
  }

  const updated = ctx.data.goalPersistState as GoalState | undefined
  if (!updated) {
    flushLogs(ctx)
    return
  }

  try {
    putGoalState(ctx.config, goal.id, updated, describeCommitMessage(goal), ctx.cwd)
    refreshReportOrFail(ctx, goal.id, updated)
  } catch (err) {
    process.stderr.write(
      `[goal-manager] commitGoalState: persist to state repo failed (${
        err instanceof Error ? err.message : String(err)
      }); will retry next tick\n`,
    )
  } finally {
    flushLogs(ctx)
  }
}

function refreshReportOrFail(ctx: Parameters<PostflightScript>[0], goalId: string, state: GoalState | undefined): void {
  if (!state) return
  try {
    refreshGoalDashboardReport({
      config: ctx.config,
      cwd: ctx.cwd,
      data: ctx.data,
      goalId,
      state,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.output.reason = ctx.output.reason ? `${ctx.output.reason}; ${reason}` : reason
    if (ctx.output.exitCode === 0) ctx.output.exitCode = 99
  }
}

function flushLogs(ctx: Parameters<PostflightScript>[0]): void {
  try {
    flushGoalRunLogEvents(ctx.config, ctx.cwd, ctx.data)
  } catch (err) {
    process.stderr.write(
      `[goal-manager] goal log persist failed (${err instanceof Error ? err.message : String(err)})\n`,
    )
  }
}

function describeCommitMessage(goal: GoalCtx): string {
  if (goal.state === "done") return `chore(goals): complete ${goal.id}`
  return `chore(goals): update ${goal.id}`
}
