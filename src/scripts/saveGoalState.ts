/**
 * Preflight (run last): compute the persisted form of `ctx.data.goal`
 * mutations and stash it for `commitGoalState` (postflight) to write to the
 * `kody-state` branch. Always sets `ctx.skipAgent = true` because goal-tick is
 * a no-agent flow.
 *
 * This script does NOT persist itself — that's `commitGoalState`'s job — so the
 * write happens after the executor's lifecycle label cleanup, matching the
 * original ordering.
 */

import type { PreflightScript } from "../executables/types.js"
import type { GoalState } from "../goal/state.js"
import { nowIso } from "../goal/state.js"
import type { GoalCtx } from "./goalCtx.js"

export const saveGoalState: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) {
    ctx.skipAgent = true
    return
  }

  // Only bump `updatedAt` when something the tick actually persists changed.
  // Bumping it on every tick made each idle no-op tick rewrite state.json, and
  // the persist below would push a `chore(goals): tick (idle)` every cycle.
  // With the timestamp frozen on no-op ticks the state is byte-identical, so
  // `commitGoalState` skips the write entirely (`changed === false`).
  const prev = goal.raw
  const changed =
    !prev || prev.state !== goal.state || prev.lastDispatchedIssue !== goal.lastDispatchedIssue

  const updated: GoalState = {
    ...(prev ?? { state: goal.state, extra: {} }),
    state: goal.state,
    lastDispatchedIssue: goal.lastDispatchedIssue,
    updatedAt: changed ? nowIso() : prev?.updatedAt,
  }

  // Stash for the postflight persist (commitGoalState).
  ctx.data.goalPersistState = updated
  ctx.data.goalPersistChanged = changed
  ctx.skipAgent = true
}
