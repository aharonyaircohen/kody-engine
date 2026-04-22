/**
 * Postflight: extract DONE / COMMIT_MSG / PR_SUMMARY / FAILED from the agent's
 * final message, stuff them into ctx.data, and emit a typed Action the
 * reducer will merge into task state.
 */

import type { PostflightScript } from "../executables/types.js"
import { parseAgentResult as parse } from "../prompt.js"
import type { Action } from "../state.js"

export const parseAgentResult: PostflightScript = async (ctx, profile, agentResult) => {
  if (!agentResult) {
    ctx.data.agentDone = false
    ctx.data.action = makeAction("AGENT_NOT_RUN", { reason: "no agent result" })
    return
  }
  const parsed = parse(agentResult.finalText)
  ctx.data.agentDone = parsed.done
  ctx.data.commitMessage = parsed.commitMessage
  ctx.data.prSummary = parsed.prSummary
  ctx.data.feedbackActions = parsed.feedbackActions
  ctx.data.agentFailureReason = parsed.failureReason
  ctx.data.agentOutcome = agentResult.outcome
  ctx.data.agentError = agentResult.error

  const modeSeg = ((ctx.args.mode as string | undefined) ?? profile.name).replace(/-/g, "_").toUpperCase()
  if (parsed.done) {
    ctx.data.action = makeAction(`${modeSeg}_COMPLETED`, {
      commitMessage: parsed.commitMessage,
      prSummary: parsed.prSummary,
    })
  } else {
    ctx.data.action = makeAction(`${modeSeg}_FAILED`, {
      reason: parsed.failureReason || agentResult.error || "unknown failure",
    })
  }
}

function makeAction(type: string, payload: Record<string, unknown>): Action {
  return { type, payload, timestamp: new Date().toISOString() }
}
