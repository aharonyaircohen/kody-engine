/**
 * Postflight for the `fix` executable. The fix prompt requires the agent to
 * emit a FEEDBACK_ACTIONS block enumerating each extracted review item with
 * an explicit action (`fixed: …` or `declined: …`). Without it, we cannot
 * tell whether the agent actually addressed the feedback — so we flip a
 * DONE-without-enumeration into a failure, matching the "agent did not emit
 * DONE" treatment downstream.
 *
 * Must run AFTER parseAgentResult (which populates ctx.data.feedbackActions
 * + ctx.data.action) and BEFORE commitAndPush (which would otherwise push
 * the agent's unrelated edits).
 *
 * No-op unless the agent reported DONE.
 */

import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"

const MIN_ITEMS = 1

export const requireFeedbackActions: PostflightScript = async (ctx, profile) => {
  if (!ctx.data.agentDone) return

  const actions = String(ctx.data.feedbackActions ?? "").trim()
  const items = countActionItems(actions)

  if (items >= MIN_ITEMS) return

  const reason =
    actions.length === 0
      ? "agent omitted required FEEDBACK_ACTIONS block — cannot verify that review feedback was addressed"
      : "agent FEEDBACK_ACTIONS block listed no items — cannot verify that review feedback was addressed"

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
 * We accept any line starting with `-` or `*` as an item; empty block or
 * prose-only responses don't count.
 */
export function countActionItems(block: string): number {
  if (!block.trim()) return 0
  const lines = block.split("\n")
  let count = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (/^[-*]\s+/.test(line)) count++
  }
  return count
}
