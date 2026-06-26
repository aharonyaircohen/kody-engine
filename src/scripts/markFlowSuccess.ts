/**
 * Postflight: signal that the mechanical work succeeded.
 *
 * Sets `ctx.data.agentDone = true` ONLY when no failure has been recorded
 * (`ctx.output.exitCode` is undefined or zero). Used by no-agent flows
 * (e.g. revert) where the success signal must come from a shell entry's
 * exit status, not from agent output. Place this immediately after the
 * shell entry in the postflight chain — before commitAndPush / ensurePr —
 * so downstream success-gating checks read the correct flag.
 *
 * No-op if a prior step has already set a non-zero exit code.
 */

import type { PostflightScript } from "../executables/types.js"

export const markFlowSuccess: PostflightScript = async (ctx) => {
  const exit = ctx.output.exitCode
  if (exit === undefined || exit === 0) {
    ctx.data.agentDone = true
  }
}
