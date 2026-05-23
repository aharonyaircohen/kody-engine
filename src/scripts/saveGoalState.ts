/**
 * Preflight (run last): persist `ctx.data.goal` mutations back to
 * `.kody/goals/<id>/state.json`. Always sets `ctx.skipAgent = true`
 * because goal-tick is a no-agent flow.
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

  // Only bump `updatedAt` when something the tick actually persists changed.
  // Bumping it on every tick made each idle no-op tick produce a fresh diff,
  // and `commitGoalState` then committed a `chore(goals): tick (idle)` to the
  // default branch every cycle. With the timestamp frozen on no-op ticks the
  // file is byte-identical, the diff check short-circuits, and nothing commits.
  const prev = goal.raw
  const changed =
    !prev || prev.state !== goal.state || prev.lastDispatchedIssue !== goal.lastDispatchedIssue

  const updated: GoalState = {
    ...(prev ?? { state: goal.state, extra: {} }),
    state: goal.state,
    lastDispatchedIssue: goal.lastDispatchedIssue,
    updatedAt: changed ? nowIso() : prev?.updatedAt,
  }

  writeGoalState(ctx.cwd, goal.id, updated)
  ctx.skipAgent = true
}
