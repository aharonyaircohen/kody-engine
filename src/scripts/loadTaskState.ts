/**
 * Preflight: read the task's state comment into ctx.data.taskState.
 * Returns emptyState() if no kody state comment exists yet.
 *
 * Must run AFTER the mode flow (runFlow/fixFlow/...) so that
 * ctx.data.commentTargetType + ctx.data.commentTargetNumber are populated.
 */

import type { PreflightScript } from "../executables/types.js"
import { emptyState, readTaskState, type TaskTarget } from "../state.js"

export const loadTaskState: PreflightScript = async (ctx) => {
  const target = ctx.data.commentTargetType as TaskTarget | undefined
  const number = ctx.data.commentTargetNumber as number | undefined
  if (!target || !number) {
    ctx.data.taskState = emptyState()
    return
  }
  ctx.data.taskState = readTaskState(target, number, ctx.cwd)
}
