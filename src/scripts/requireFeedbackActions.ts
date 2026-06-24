/**
 * Postflight for the `fix` agentAction. Records whether the agent emitted a
 * `FEEDBACK_ACTIONS:` block and counts its items, but does NOT hard-fail
 * the run when the block is missing or empty.
 *
 * Soft-check rationale (matches requirePlanDeviations softening in 0.4.30):
 * verifyFixAlignment + verify/tests are the real shipability gates.
 * Forgetting a bureaucratic checklist at the end of a long task should not
 * throw away working code. Today's example: an agent that emitted natural
 * prose summarizing what it did (no markers) was killed here, even though
 * the diff itself was correct.
 *
 * Anything stronger (did the fix actually touch the files the review
 * named?) belongs to verifyFixAlignment, which compares the diff to the
 * review's file:line references — that's still a hard gate.
 *
 * Must run AFTER parseAgentResult (populates feedbackActions + action).
 * No-op unless the agent reported DONE.
 */

import type { PostflightScript } from "../agent-actions/types.js"

const MIN_ITEMS = 1

export const requireFeedbackActions: PostflightScript = async (ctx) => {
  if (!ctx.data.agentDone) return

  const actions = String(ctx.data.feedbackActions ?? "").trim()
  const items = countActionItems(actions)
  ctx.data.feedbackAgentItemCount = items

  if (items < MIN_ITEMS) {
    const reason = actions.length === 0 ? "FEEDBACK_ACTIONS block missing" : "FEEDBACK_ACTIONS block listed no items"
    process.stderr.write(
      `[kody requireFeedbackActions] warning: ${reason} — proceeding anyway (verifyFixAlignment + tests are the real gate)\n`,
    )
    ctx.data.feedbackActionsOmitted = actions.length === 0
    ctx.data.feedbackActionsMalformed = actions.length > 0
  }
}

/**
 * Counts bullet-style entries in the FEEDBACK_ACTIONS block.
 */
export function countActionItems(block: string): number {
  if (!block.trim()) return 0
  let count = 0
  for (const raw of block.split("\n")) {
    if (/^\s*[-*]\s+/.test(raw)) count++
  }
  return count
}
