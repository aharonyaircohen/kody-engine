/**
 * Postflight (runs last): apply the reducer to the task state with the
 * action emitted by parseAgentResult, then write the state comment.
 *
 * If no action was emitted (agentAction had no agent run, e.g. init), a
 * synthetic action is composed from ctx.output so the state comment still
 * reflects the run's outcome.
 */

import type { JobFlavor, PostflightScript } from "../agent-actions/types.js"
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
    jobKey: typeof data.jobKey === "string" ? data.jobKey : undefined,
    jobId: typeof data.jobId === "string" ? data.jobId : undefined,
    flavor: typeof data.jobFlavor === "string" ? (data.jobFlavor as JobFlavor) : undefined,
    schedule: typeof data.jobSchedule === "string" ? data.jobSchedule : undefined,
    runUrl: typeof data.runUrl === "string" ? data.runUrl : undefined,
    agentResponsibility: typeof data.jobAgentResponsibility === "string" ? data.jobAgentResponsibility : undefined,
    agentAction: typeof data.jobAgentAction === "string" ? data.jobAgentAction : undefined,
    target: typeof data.jobTarget === "number" ? data.jobTarget : undefined,
    agent: typeof data.jobAgent === "string" ? data.jobAgent : undefined,
    why: typeof data.jobWhy === "string" ? data.jobWhy : undefined,
  }
}

export const saveTaskState: PostflightScript = async (ctx, profile) => {
  const target = ctx.data.commentTargetType as TaskTarget | undefined
  const number = ctx.data.commentTargetNumber as number | undefined
  const state = ctx.data.taskState as TaskState | undefined
  if (!target || !number || !state) return

  const agentAction = profile.name
  const action: Action = (ctx.data.action as Action | undefined) ?? synthesizeAction(ctx)

  // Don't mutate the loaded prior state — `reduce` treats it as immutable input
  // and other postflights may hold the same reference. The prUrl/runUrl carry
  // is applied to `next` below, which is the only thing we persist.
  const next = reduce(state, agentAction, action, profile.phase, profile.agent, {
    ...jobMetaFromData(ctx.data),
    ...(ctx.output.prUrl ? { prUrl: ctx.output.prUrl } : {}),
  })
  if (ctx.output.prUrl) next.core.prUrl = ctx.output.prUrl
  if (typeof ctx.data.runUrl === "string") next.core.runUrl = ctx.data.runUrl as string

  writeTaskState(target, number, next, ctx.cwd)
  ctx.data.taskState = next
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
