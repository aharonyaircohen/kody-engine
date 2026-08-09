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

const FALLBACK_SUMMARY_MAX = 6000

export const requireDeliveryArtifacts: PostflightScript = async (ctx) => {
  // Explicit FAILED / SDK failure paths are already authoritative and must
  // never become salvageable merely because they also lack delivery fields.
  if (ctx.data.agentDone !== true) return

  const commitResult = ctx.data.commitResult as { committed?: boolean; pushed?: boolean } | undefined
  const hasCommits = ctx.data.hasCommitsAhead === true
  if (ctx.data.jobDelivery === "pull-request" && (!commitResult?.committed || !commitResult.pushed)) {
    const reason = "pull-request delivery produced no commit"
    ctx.data.agentFailureReason = reason
    ctx.output.exitCode = 4
    ctx.output.reason = reason
    return
  }
  if (!commitResult?.committed && !hasCommits) {
    return
  }

  const commitMessage = String(ctx.data.commitMessage ?? "").trim()
  const prSummary = String(ctx.data.prSummary ?? "").trim()
  const missing: string[] = []
  if (!commitMessage) missing.push("COMMIT_MSG")
  if (!prSummary) missing.push("PR_SUMMARY")
  if (missing.length === 0) return

  const reason = `agent omitted required delivery artifacts: ${missing.join(", ")}`
  // Delivery must remain reviewable even when the model forgets the markers.
  // Fill deterministic defaults and retain a warning for observability instead
  // of converting an otherwise successful run into RUN_FAILED.
  const target =
    typeof ctx.args.issue === "number"
      ? `issue #${ctx.args.issue}`
      : typeof ctx.args.pr === "number"
        ? `PR #${ctx.args.pr}`
        : "task"
  if (!commitMessage) ctx.data.commitMessage = `chore: update ${target}`
  if (!prSummary) {
    const fallback = fallbackSummary(String(ctx.data.agentFinalText ?? ""))
    ctx.data.prSummary = fallback || `Automated changes for ${target}.`
    if (fallback) ctx.data.agentFallbackSummary = fallback
  }
  ctx.data.agentResultIncomplete = true
  ctx.data.agentMissingArtifacts = missing
  ctx.data.agentFailureReason = reason
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
