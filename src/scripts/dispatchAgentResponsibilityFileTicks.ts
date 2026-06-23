import type { PreflightScript } from "../agent-actions/types.js"

/**
 * Compatibility no-op for old scheduler profiles.
 *
 * Responsibilities no longer own cadence. Goals and loops decide when a
 * responsibility runs, then dispatch the responsibility's agentAction.
 */
export const dispatchAgentResponsibilityFileTicks: PreflightScript = async (ctx) => {
  ctx.skipAgent = true
  ctx.data.jobTickResults = []
  ctx.output.exitCode = 0
  ctx.output.reason = "responsibility scheduling is owned by goals and loops"
  process.stdout.write(
    "[jobs] no flat agentResponsibility fan-out; goals and loops own scheduled responsibility decisions\n",
  )
}
