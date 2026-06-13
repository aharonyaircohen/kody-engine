import type { Job } from "./executables/types.js"

/** Stable key for the required work on a task; retries keep this value. */
export function stableJobKey(job: Job): string {
  const duty = job.duty ?? job.action
  const executable = job.executable ?? duty ?? "unknown"
  if (job.flavor === "scheduled" && job.duty) return `scheduled:${job.duty}:${executable}`
  const target = typeof job.target === "number" ? job.target : targetFromCliArgs(job.cliArgs)
  const work = duty && executable && executable !== duty ? `${duty}:${executable}` : (duty ?? executable)
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
