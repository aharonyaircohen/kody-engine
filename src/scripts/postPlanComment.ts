/**
 * Postflight for the `plan` executable. Posts the plan body as a clearly
 * labeled issue comment, separate from the machine-readable task-state block
 * (which `saveTaskState` writes elsewhere). The plan comment is what a human
 * reader sees; the state block is what the next executable (`run`) reads.
 *
 * No-op when the agent did not complete or produced no plan body.
 */

import type { PostflightScript } from "../executables/types.js"
import { postIssueComment as ghPostIssueComment } from "../issue.js"

export const postPlanComment: PostflightScript = async (ctx) => {
  if (!ctx.data.agentDone) return
  const targetType = ctx.data.commentTargetType as "issue" | "pr" | undefined
  const targetNumber = Number(ctx.data.commentTargetNumber ?? 0)
  const plan = (ctx.data.prSummary as string | undefined)?.trim()
  if (targetType !== "issue" || !targetNumber || !plan) return

  const body = renderPlanComment(targetNumber, plan)
  try {
    ghPostIssueComment(targetNumber, body, ctx.cwd)
  } catch {
    /* best effort — state block still captures the plan */
  }
}

export function renderPlanComment(issueNumber: number, plan: string): string {
  return `## Plan for issue #${issueNumber}\n\n${plan}\n\n---\nComment \`@kody2 run\` to execute this plan.`
}
