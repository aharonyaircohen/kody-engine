/**
 * Postflight for the `fix` executable. Enforces only the minimum contract:
 * the agent's final message must contain a non-empty `FEEDBACK_ACTIONS:`
 * block. Anything stronger (did the fix actually touch the files the review
 * named?) belongs to `verifyFixAlignment`, which runs after the commit and
 * compares the diff to the review's file:line references.
 *
 * Previously this script also enforced bullet-count parity between the
 * FEEDBACK_ACTIONS and the review's Concerns/Suggestions/Bugs sections.
 * That produced false-positives when reviews paired each Concern with a
 * restating Suggestion (same underlying issue, counted twice). Correctness
 * is now anchored to locations the review points at, not how many bullets
 * the reviewer typed.
 *
 * Must run AFTER parseAgentResult (populates feedbackActions + action).
 * No-op unless the agent reported DONE.
 */

import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"

const MIN_ITEMS = 1

export const requireFeedbackActions: PostflightScript = async (ctx, profile) => {
  if (!ctx.data.agentDone) return

  const actions = String(ctx.data.feedbackActions ?? "").trim()
  const items = countActionItems(actions)
  ctx.data.feedbackAgentItemCount = items

  if (items < MIN_ITEMS) {
    fail(
      ctx,
      profile,
      actions.length === 0
        ? "agent omitted required FEEDBACK_ACTIONS block — cannot verify that review feedback was addressed"
        : "agent FEEDBACK_ACTIONS block listed no items — cannot verify that review feedback was addressed",
    )
  }
}

function fail(
  ctx: Parameters<PostflightScript>[0],
  profile: Parameters<PostflightScript>[1],
  reason: string,
): void {
  ctx.data.agentDone = false
  ctx.data.agentFailureReason = reason
  const modeSeg = profile.name.replace(/-/g, "_").toUpperCase()
  const failedAction: Action = {
    type: `${modeSeg}_FAILED`,
    payload: { reason },
    timestamp: new Date().toISOString(),
  }
  ctx.data.action = failedAction
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
