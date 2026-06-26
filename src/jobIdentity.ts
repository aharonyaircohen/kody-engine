import type { Job } from "./executables/types.js"

/** Stable key for the required work on a task; retries keep this value. */
export function stableJobKey(job: Job): string {
  const capability = job.capability ?? job.action
  const executable = job.executable ?? capability ?? "unknown"
  if (job.flavor === "scheduled" && job.capability) return `scheduled:${job.capability}:${executable}`
  const target = typeof job.target === "number" ? job.target : targetFromCliArgs(job.cliArgs)
  const work =
    capability && executable && executable !== capability ? `${capability}:${executable}` : (capability ?? executable)
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
