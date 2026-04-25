/**
 * Postflight: re-run quality commands as a trust-but-verify gate.
 *
 * If verify fails, downgrade any pending `*_COMPLETED` action set earlier in
 * the postflight chain (e.g. by parseAgentResult on agent self-report) to
 * its `*_FAILED` counterpart, so saveTaskState records the truth and
 * finishFlow doesn't post a `fix-applied` success comment for a red verify.
 */

import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"
import { summarizeFailure, verifyAll } from "../verify.js"

export const verify: PostflightScript = async (ctx) => {
  try {
    const result = await verifyAll(ctx.config, ctx.cwd)
    ctx.data.verifyOk = result.ok
    ctx.data.verifyReason = result.ok ? "" : summarizeFailure(result)
  } catch (err) {
    ctx.data.verifyOk = false
    ctx.data.verifyReason = `verify crashed: ${err instanceof Error ? err.message : String(err)}`
  }

  if (ctx.data.verifyOk === false) {
    const action = ctx.data.action as Action | undefined
    if (action && action.type.endsWith("_COMPLETED")) {
      const reason = (ctx.data.verifyReason as string | undefined) || "verify failed"
      ctx.data.action = {
        type: action.type.replace(/_COMPLETED$/, "_FAILED"),
        payload: { reason, downgradedFrom: action.type },
        timestamp: new Date().toISOString(),
      }
    }
  }
}
