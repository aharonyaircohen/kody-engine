import type { Job } from "./agent-actions/types.js"

/** Stable key for the required work on a task; retries keep this value. */
export function stableJobKey(job: Job): string {
  const agentResponsibility = job.agentResponsibility ?? job.action
  const agentAction = job.agentAction ?? agentResponsibility ?? "unknown"
  if (job.flavor === "scheduled" && job.agentResponsibility) return `scheduled:${job.agentResponsibility}:${agentAction}`
  const target = typeof job.target === "number" ? job.target : targetFromCliArgs(job.cliArgs)
  const work = agentResponsibility && agentAction && agentAction !== agentResponsibility ? `${agentResponsibility}:${agentAction}` : (agentResponsibility ?? agentAction)
  return target === undefined ? `${job.flavor}:${work}` : `${job.flavor}:${work}:${target}`
}

export function targetFromCliArgs(cliArgs: Record<string, unknown> | undefined): number | undefined {
  if (!cliArgs) return undefined
  for (const key of ["issue", "pr", "target", "issue_number"]) {
    const value = cliArgs[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}
