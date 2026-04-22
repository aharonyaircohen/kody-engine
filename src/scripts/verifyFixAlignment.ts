/**
 * Postflight for the `fix` executable: enforce that the agent's final message
 * actually acted on the review feedback.
 *
 * Problem it solves (issue #3):
 * The fix prompt asks the agent to produce a `FEEDBACK_ACTIONS:` block listing
 * each extracted item as `fixed: …` or `declined: …`. Nothing downstream
 * verifies the block is present, non-empty, or consistent with whether a
 * commit was actually made. Without enforcement, the agent can emit a DONE
 * with no actions (silent no-op) or claim `fixed` for items and not commit —
 * both observed in live tests.
 *
 * Enforcement:
 *   1. FEEDBACK_ACTIONS block must exist and list at least one item.
 *   2. If any item is `fixed: …` but `commitResult.committed === false`,
 *      mark the run as FIX_FAILED (agent claimed to fix but produced no diff).
 *   3. If all items are `declined: …` and no commit was made, that's
 *      allowed — the agent can legitimately reject a review — but the
 *      action is emitted as FIX_DECLINED so the history distinguishes it
 *      from a real completion.
 *
 * This script must run AFTER parseAgentResult (which populates feedbackActions)
 * and AFTER commitAndPush (which populates commitResult), and BEFORE
 * postIssueComment / saveTaskState so the adjusted action reaches them.
 */

import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"

export interface FeedbackActionsSummary {
  totalItems: number
  fixedItems: number
  declinedItems: number
  unparsedLines: number
}

/**
 * Parse the raw FEEDBACK_ACTIONS block (plain text, one bullet per item).
 * Each item line is expected to contain either `fixed:` or `declined:` after
 * the item label. Lines not matching either shape are counted as unparsed.
 */
export function summarizeFeedbackActions(block: string): FeedbackActionsSummary {
  const summary: FeedbackActionsSummary = { totalItems: 0, fixedItems: 0, declinedItems: 0, unparsedLines: 0 }
  if (!block.trim()) return summary
  for (const raw of block.split("\n")) {
    // Only bullet lines (`-` or `*` at line start) count as items.
    if (!/^\s*[-*]\s+/.test(raw)) continue
    const line = raw.replace(/^\s*[-*]\s*/, "").trim()
    summary.totalItems++
    if (/\bfixed\s*:/i.test(line)) summary.fixedItems++
    else if (/\bdeclined\s*:/i.test(line)) summary.declinedItems++
    else summary.unparsedLines++
  }
  return summary
}

function makeAction(type: string, payload: Record<string, unknown>): Action {
  return { type, payload, timestamp: new Date().toISOString() }
}

export const verifyFixAlignment: PostflightScript = async (ctx, profile) => {
  if (profile.name !== "fix") return // no-op on other profiles
  if (ctx.skipAgent) return
  if (!ctx.data.agentDone) return // parseAgentResult already emitted FIX_FAILED

  const feedbackActions = (ctx.data.feedbackActions as string | undefined) ?? ""
  const summary = summarizeFeedbackActions(feedbackActions)
  ctx.data.feedbackActionsSummary = summary

  const committed = Boolean((ctx.data.commitResult as { committed?: boolean } | undefined)?.committed)

  if (summary.totalItems === 0) {
    ctx.output.exitCode = 1
    ctx.output.reason = "fix produced no FEEDBACK_ACTIONS items"
    ctx.data.agentDone = false
    ctx.data.action = makeAction("FIX_FAILED", {
      reason: ctx.output.reason,
      feedbackActionsSummary: summary,
    })
    return
  }

  if (summary.fixedItems > 0 && !committed) {
    ctx.output.exitCode = 1
    ctx.output.reason = `fix claimed ${summary.fixedItems} fixed item(s) but produced no commit`
    ctx.data.agentDone = false
    ctx.data.action = makeAction("FIX_FAILED", {
      reason: ctx.output.reason,
      feedbackActionsSummary: summary,
    })
    return
  }

  if (summary.fixedItems === 0 && summary.declinedItems > 0 && !committed) {
    // All items declined, no commit. Legitimate but distinct from a real fix.
    ctx.data.action = makeAction("FIX_DECLINED", {
      feedbackActionsSummary: summary,
      note: "agent declined all feedback items; no commit made",
    })
    // Don't change exitCode — postIssueComment will report "no changes".
  }
}
