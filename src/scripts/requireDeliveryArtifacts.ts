/**
 * Postflight: require the structured artifacts needed for a reviewable PR.
 *
 * parseAgentResult intentionally remains generic because non-PR capabilities
 * have different output contracts. The pr-branch lifecycle adds this script
 * after verification and the commit decision so run/fix/fix-ci require
 * COMMIT_MSG and PR_SUMMARY only when there is a PR delivery, without
 * teaching the executor any capability names.
 *
 * Incomplete output is preserved rather than discarded: ensurePr opens a
 * draft using the final prose as a fallback summary.
 */

import type { PostflightScript } from "../implementations/types.js"
import type { Action } from "../state.js"

const FALLBACK_SUMMARY_MAX = 6000

export const requireDeliveryArtifacts: PostflightScript = async (ctx) => {
  // Explicit FAILED / SDK failure paths are already authoritative and must
  // never become salvageable merely because they also lack delivery fields.
  if (ctx.data.agentDone !== true) return

  const commitResult = ctx.data.commitResult as { committed?: boolean } | undefined
  const hasCommits = ctx.data.hasCommitsAhead === true
  if (!commitResult?.committed && !hasCommits) return

  const commitMessage = String(ctx.data.commitMessage ?? "").trim()
  const prSummary = String(ctx.data.prSummary ?? "").trim()
  const missing: string[] = []
  if (!commitMessage) missing.push("COMMIT_MSG")
  if (!prSummary) missing.push("PR_SUMMARY")
  if (missing.length === 0) return

  const reason = `agent omitted required delivery artifacts: ${missing.join(", ")}`
  ctx.data.agentDone = false
  ctx.data.agentResultIncomplete = true
  ctx.data.agentMissingArtifacts = missing
  ctx.data.agentFailureReason = reason

  if (!prSummary) {
    const fallback = fallbackSummary(String(ctx.data.agentFinalText ?? ""))
    if (fallback) ctx.data.agentFallbackSummary = fallback
  }

  const action = ctx.data.action as Action | undefined
  if (action?.type.endsWith("_COMPLETED")) {
    ctx.data.action = {
      type: action.type.replace(/_COMPLETED$/, "_FAILED"),
      payload: { reason, downgradedFrom: action.type },
      timestamp: new Date().toISOString(),
    }
  }
}

function fallbackSummary(finalText: string): string {
  const prose = finalText
    .split("\n")
    .filter(
      (line) =>
        !/^[\s>*_#`~-]*(?:DONE\b|COMMIT_MSG\s*:|PR_SUMMARY\s*:|PLAN_DEVIATIONS\s*:|FEEDBACK_ACTIONS\s*:)/i.test(line),
    )
    .join("\n")
    .trim()
  if (!prose) return ""
  if (prose.length <= FALLBACK_SUMMARY_MAX) return prose
  return `${prose.slice(0, FALLBACK_SUMMARY_MAX - 1)}…`
}
