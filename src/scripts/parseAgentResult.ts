/**
 * Postflight: extract DONE / COMMIT_MSG / PR_SUMMARY / FAILED from the agent's
 * final message, stuff them into ctx.data, and emit a typed Action the
 * reducer will merge into task state.
 */

import type { PostflightScript } from "../implementations/types.js"
import { parseAgentResult as parse } from "../prompt.js"
import type { Action } from "../state.js"

export const parseAgentResult: PostflightScript = async (ctx, profile, agentResult) => {
  if (!agentResult) {
    ctx.data.agentDone = false
    ctx.data.action = makeAction("AGENT_NOT_RUN", { reason: "no agent result" })
    return
  }
  const parsed = parse(agentResult.finalText)
  ctx.data.agentFinalText = agentResult.finalText
  ctx.data.agentDone = parsed.done
  ctx.data.commitMessage = parsed.commitMessage
  ctx.data.prSummary = parsed.prSummary
  ctx.data.feedbackActions = parsed.feedbackActions
  ctx.data.planDeviations = parsed.planDeviations
  ctx.data.priorArt = parsed.priorArt
  ctx.data.agentFailureReason = parsed.failureReason
  ctx.data.agentMarkerMissing = parsed.markerMissing
  ctx.data.agentOutcome = agentResult.outcome
  ctx.data.agentOutcomeKind = agentResult.outcomeKind
  ctx.data.agentError = agentResult.error

  const modeSeg = ((ctx.args.mode as string | undefined) ?? profile.name).replace(/-/g, "_").toUpperCase()
  if (parsed.done) {
    // prSummary is intentionally NOT in the payload — for plan/run/research
    // it's the entire artifact body (tens of KB). The reducer stores the
    // full action under both `core.lastOutcome` and `implementations[x].lastAction`,
    // so embedding prSummary there would persist it 2× into the state comment.
    // Consumers read prSummary from ctx.data within the same run, or from
    // state.artifacts.<name>.content (set by persistArtifacts) across runs.
    ctx.data.action = makeAction(`${modeSeg}_COMPLETED`, {
      commitMessage: parsed.commitMessage,
    })
  } else {
    // Prefer the SDK's own error over the parser's generic "no final
    // message" diagnostic when both are present — the SDK error names the
    // *actual* failure (MCP startup crash, model 5xx, auth, etc.), whereas
    // "no final message" is the symptom. Without this, an agent that
    // crashed before emitting any text shows up as a content failure,
    // hiding the real cause from the state comment.
    const isGenericNoOutput = parsed.failureReason === "agent produced no final message"
    const reason =
      isGenericNoOutput && agentResult.error
        ? `agent SDK error: ${agentResult.error}`
        : parsed.failureReason || agentResult.error || "unknown failure"
    ctx.data.action = makeAction(`${modeSeg}_FAILED`, { reason })
  }
}

function makeAction(type: string, payload: Record<string, unknown>): Action {
  return { type, payload, timestamp: new Date().toISOString() }
}
