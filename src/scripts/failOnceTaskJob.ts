import type { Job, PostflightScript } from "../executables/types.js"
import { stableJobKey } from "../jobIdentity.js"
import type { TaskState } from "../state.js"

export const failOnceTaskJob: PostflightScript = async (ctx, profile) => {
  ctx.skipAgent = true

  const issue = typeof ctx.args.issue === "number" ? ctx.args.issue : undefined
  const fallbackJob: Job = {
    executable: profile.name,
    flavor: "instant",
    ...(typeof issue === "number" ? { target: issue, cliArgs: { issue } } : { cliArgs: {} }),
  }
  const jobKey = typeof ctx.data.jobKey === "string" ? ctx.data.jobKey : stableJobKey(fallbackJob)
  const state = ctx.data.taskState as TaskState | undefined
  const runs = state?.jobs?.[jobKey]?.runs ?? []
  const hasFailedBefore = runs.some((run) => run.status === "failed")

  if (!hasFailedBefore) {
    ctx.output.exitCode = 1
    ctx.output.reason = "intentional first-attempt failure for task job live test"
    return
  }

  ctx.output.exitCode = 0
  ctx.output.reason = "task job live test succeeded after prior failure"
}
