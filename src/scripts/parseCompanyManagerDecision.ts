import type { PostflightScript } from "../agent-actions/types.js"
import { parseCompanyManagerDecisionText } from "../companyManagerDecision.js"
import type { Action } from "../state.js"

export const parseCompanyManagerDecision: PostflightScript = async (ctx, _profile, agentResult) => {
  if (!agentResult) {
    ctx.data.companyManagerDecision = { summary: "", actions: [] }
    ctx.data.action = makeAction("COMPANY_MANAGER_NOT_RUN", { reason: "no agent result" })
    return
  }

  try {
    const decision = parseCompanyManagerDecisionText(agentResult.finalText)
    ctx.data.companyManagerDecision = decision
    ctx.data.action = makeAction("COMPANY_MANAGER_DECIDED", {
      summary: decision.summary,
      actionCount: decision.actions.length,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.data.companyManagerDecisionError = reason
    ctx.data.action = makeAction("COMPANY_MANAGER_FAILED", { reason })
    ctx.output.exitCode = 1
    ctx.output.reason = reason
  }
}

function makeAction(type: string, payload: Record<string, unknown>): Action {
  return { type, payload, timestamp: new Date().toISOString() }
}
