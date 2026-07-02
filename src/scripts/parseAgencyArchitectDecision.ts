import { parseAgencyArchitectDecisionText } from "../agencyArchitectDecision.js"
import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"

export const parseAgencyArchitectDecision: PostflightScript = async (ctx, _profile, agentResult) => {
  if (!agentResult) {
    ctx.data.agencyArchitectDecision = { summary: "", actions: [] }
    ctx.data.action = makeAction("AGENCY_ARCHITECT_NOT_RUN", { reason: "no agent result" })
    return
  }

  try {
    const decision = parseAgencyArchitectDecisionText(agentResult.finalText)
    ctx.data.agencyArchitectDecision = decision
    ctx.data.action = makeAction("AGENCY_ARCHITECT_DECIDED", {
      summary: decision.summary,
      actionCount: decision.actions.length,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.data.agencyArchitectDecisionError = reason
    ctx.data.action = makeAction("AGENCY_ARCHITECT_FAILED", { reason })
    ctx.output.exitCode = 1
    ctx.output.reason = reason
  }
}

function makeAction(type: string, payload: Record<string, unknown>): Action {
  return { type, payload, timestamp: new Date().toISOString() }
}
