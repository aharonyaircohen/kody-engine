import type { PreflightScript } from "../executables/types.js"

/**
 * Compatibility no-op for old scheduler profiles.
 *
 * Capabilities no longer own cadence. Goals and loops decide when a
 * capability runs, then dispatch the capability's executable.
 */
export const dispatchCapabilityFileTicks: PreflightScript = async (ctx) => {
  ctx.skipAgent = true
  ctx.data.jobTickResults = []
  ctx.output.exitCode = 0
  ctx.output.reason = "capability scheduling is owned by goals and loops"
  process.stdout.write(
    "[jobs] no flat capability fan-out; goals and loops own scheduled capability decisions\n",
  )
}
