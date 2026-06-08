import type { Job, PreflightScript } from "../executables/types.js"
import { stableJobKey } from "../jobIdentity.js"
import { emptyState, nextPendingTaskJob, type TaskJob, type TaskState } from "../state.js"

export const dispatchNextTaskJob: PreflightScript = async (ctx, profile) => {
  const state = (ctx.data.taskState as TaskState | undefined) ?? emptyState()
  const ids = Array.isArray(ctx.data.plannedTaskJobIds)
    ? (ctx.data.plannedTaskJobIds as unknown[]).filter((id): id is string => typeof id === "string")
    : undefined
  const next = nextPendingTaskJob(state, ids)
  ctx.skipAgent = true

  if (!next) {
    ctx.output.exitCode = 0
    ctx.output.reason = "all planned task jobs are complete"
    return
  }

  const plannedJobs = Array.isArray(ctx.data.plannedTaskJobs)
    ? (ctx.data.plannedTaskJobs as unknown[]).filter(isJob)
    : []
  ctx.output.nextJob = plannedJobs.find((job) => stableJobKey(job) === next.id) ?? taskJobToJob(next, ctx.args.issue)
  if (typeof ctx.args.issue === "number") {
    ctx.output.afterNextJob = { executable: profile.name, cliArgs: { issue: ctx.args.issue } }
  }
}

function taskJobToJob(job: TaskJob, issueArg: unknown): Job {
  const target = typeof job.target === "number" ? job.target : typeof issueArg === "number" ? issueArg : undefined
  return {
    executable: job.executable,
    ...(job.duty ? { duty: job.duty } : {}),
    ...(job.reason ? { why: job.reason } : {}),
    ...(job.staff ? { persona: job.staff } : {}),
    ...(job.schedule ? { schedule: job.schedule } : {}),
    ...(typeof target === "number" ? { target, cliArgs: { issue: target } } : { cliArgs: {} }),
    flavor: job.flavor ?? "instant",
  }
}

function isJob(input: unknown): input is Job {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const job = input as Partial<Job>
  return (
    typeof job.executable === "string" &&
    (job.flavor === "instant" || job.flavor === "scheduled") &&
    (!job.cliArgs || (typeof job.cliArgs === "object" && !Array.isArray(job.cliArgs)))
  )
}
