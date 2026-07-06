import type { PreflightScript } from "../implementations/types.js"
import { type GoalState, nowIso, serializeGoalState } from "../goal/state.js"
import type { GoalCtx } from "./goalCtx.js"

export const saveManagedGoalState: PreflightScript = async (ctx) => {
  ctx.skipAgent = true

  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal?.raw) return

  const original = typeof ctx.data.goalOriginalStateText === "string" ? ctx.data.goalOriginalStateText : ""
  const changedBeforeTimestamp = original !== serializeGoalState(goal.raw)
  const updated: GoalState = changedBeforeTimestamp ? { ...goal.raw, updatedAt: nowIso() } : goal.raw

  ctx.data.goalPersistState = updated
  ctx.data.goalPersistChanged = original !== serializeGoalState(updated)
}
