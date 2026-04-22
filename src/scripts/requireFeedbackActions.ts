/**
 * Postflight for the `fix` executable. The fix prompt requires the agent to
 * emit a FEEDBACK_ACTIONS block enumerating each extracted review item with
 * an explicit action (`fixed: …` or `declined: …`). This script enforces:
 *
 *   1. The block exists and lists at least one item.
 *   2. The number of listed items is >= the number of actionable bullets
 *      in the review body (bullets under `### Concerns`, `### Suggestions`,
 *      and `### Bugs` — the headings the fix prompt names as actionable).
 *
 * Rule 2 catches the failure mode observed in live testing where the agent
 * produced a valid-looking FEEDBACK_ACTIONS with its own invented items
 * rather than enumerating the review's actual concerns.
 *
 * Must run AFTER parseAgentResult (populates ctx.data.feedbackActions +
 * action) and BEFORE commitAndPush (so we block a misaligned commit).
 *
 * No-op unless the agent reported DONE.
 */

import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"

const MIN_ITEMS = 1
const ACTIONABLE_HEADINGS = /^#{1,6}\s+(Concerns|Suggestions|Bugs)\b/i
const NEXT_HEADING = /^#{1,6}\s+/

export const requireFeedbackActions: PostflightScript = async (ctx, profile) => {
  if (!ctx.data.agentDone) return

  const actions = String(ctx.data.feedbackActions ?? "").trim()
  const items = countActionItems(actions)

  if (items < MIN_ITEMS) {
    fail(
      ctx,
      profile,
      actions.length === 0
        ? "agent omitted required FEEDBACK_ACTIONS block — cannot verify that review feedback was addressed"
        : "agent FEEDBACK_ACTIONS block listed no items — cannot verify that review feedback was addressed",
    )
    return
  }

  const reviewBody = String(ctx.data.feedback ?? "")
  const expectedItems = countActionableReviewBullets(reviewBody)
  ctx.data.feedbackReviewItemCount = expectedItems
  ctx.data.feedbackAgentItemCount = items

  if (expectedItems > 0 && items < expectedItems) {
    fail(
      ctx,
      profile,
      `agent FEEDBACK_ACTIONS listed ${items} item(s) but the review has ${expectedItems} actionable bullet(s) under ### Concerns / ### Suggestions / ### Bugs — every review item must be accounted for`,
    )
    return
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
 * Counts bullet-style entries in the FEEDBACK_ACTIONS block. A well-formed
 * block looks like:
 *
 *   - Item 1: "…" — fixed: …
 *   - Item 2: "…" — declined: …
 *
 * We accept any line starting with `-` or `*` as an item.
 */
export function countActionItems(block: string): number {
  if (!block.trim()) return 0
  let count = 0
  for (const raw of block.split("\n")) {
    if (/^\s*[-*]\s+/.test(raw)) count++
  }
  return count
}

/**
 * Counts top-level bullet-style entries under the fix prompt's declared
 * actionable review headings (`### Concerns`, `### Suggestions`, `### Bugs`).
 * Sub-bullets and prose paragraphs are ignored.
 */
export function countActionableReviewBullets(reviewBody: string): number {
  if (!reviewBody.trim()) return 0
  const lines = reviewBody.split("\n")
  let count = 0
  let insideActionable = false

  for (const raw of lines) {
    if (ACTIONABLE_HEADINGS.test(raw)) {
      insideActionable = true
      continue
    }
    if (insideActionable && NEXT_HEADING.test(raw)) {
      insideActionable = false
      continue
    }
    if (!insideActionable) continue
    if (/^[-*]\s+\S/.test(raw)) count++
  }
  return count
}
