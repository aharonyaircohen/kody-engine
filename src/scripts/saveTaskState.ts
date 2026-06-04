/**
 * Postflight (runs last): apply the reducer to the task state with the
 * action emitted by parseAgentResult, then write the state comment.
 *
 * If no action was emitted (executable had no agent run, e.g. init), a
 * synthetic action is composed from ctx.output so the state comment still
 * reflects the run's outcome.
 */

import type { JobFlavor, PostflightScript } from "../executables/types.js"
import {
  type Action,
  type JobMeta,
  reduce,
  renderStateComment,
  type TaskState,
  type TaskTarget,
  writeTaskState,
} from "../state.js"

/** Read the current run's job identity (seeded by runJob) from ctx.data. */
export function jobMetaFromData(data: Record<string, unknown>): JobMeta {
  return {
    jobId: typeof data.jobId === "string" ? data.jobId : undefined,
    flavor: typeof data.jobFlavor === "string" ? (data.jobFlavor as JobFlavor) : undefined,
    schedule: typeof data.jobSchedule === "string" ? data.jobSchedule : undefined,
    runUrl: typeof data.runUrl === "string" ? data.runUrl : undefined,
  }
}

export const saveTaskState: PostflightScript = async (ctx, profile) => {
  const target = ctx.data.commentTargetType as TaskTarget | undefined
  const number = ctx.data.commentTargetNumber as number | undefined
  const state = ctx.data.taskState as TaskState | undefined
  if (!target || !number || !state) return

  const executable = profile.name
  const action: Action = (ctx.data.action as Action | undefined) ?? synthesizeAction(ctx)

  // Don't mutate the loaded prior state — `reduce` treats it as immutable input
  // and other postflights may hold the same reference. The prUrl/runUrl carry
  // is applied to `next` below, which is the only thing we persist.
  const next = reduce(state, executable, action, profile.phase, profile.staff, jobMetaFromData(ctx.data))
  if (ctx.output.prUrl) next.core.prUrl = ctx.output.prUrl
  if (typeof ctx.data.runUrl === "string") next.core.runUrl = ctx.data.runUrl as string

  writeTaskState(target, number, next, ctx.cwd)
  ctx.data.taskStateRendered = renderStateComment(next)
}

interface CtxShape {
  output: { exitCode: number; reason?: string; prUrl?: string }
  data: Record<string, unknown>
}

function synthesizeAction(ctx: CtxShape): Action {
  const ok = ctx.output.exitCode === 0
  return {
    type: ok ? "RUN_COMPLETED" : "RUN_FAILED",
    payload: {
      exitCode: ctx.output.exitCode,
      reason: ctx.output.reason,
      prUrl: ctx.output.prUrl,
    },
    timestamp: new Date().toISOString(),
  }
}
