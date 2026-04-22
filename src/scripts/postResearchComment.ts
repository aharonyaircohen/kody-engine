/**
 * Postflight for the `research` executable. Posts the research findings as
 * an issue comment with a clear header. Unlike `postPlanComment`, this does
 * NOT append a next-step instruction — research fills in missing info and
 * stops; deciding what to do next is the user's call.
 *
 * No-op when the agent did not complete or produced no body.
 */

import type { PostflightScript } from "../executables/types.js"
import { postIssueComment as ghPostIssueComment } from "../issue.js"

export const postResearchComment: PostflightScript = async (ctx) => {
  if (!ctx.data.agentDone) return
  const targetType = ctx.data.commentTargetType as "issue" | "pr" | undefined
  const targetNumber = Number(ctx.data.commentTargetNumber ?? 0)
  const body = (ctx.data.prSummary as string | undefined)?.trim()
  if (targetType !== "issue" || !targetNumber || !body) return

  try {
    ghPostIssueComment(targetNumber, renderResearchComment(targetNumber, body), ctx.cwd)
  } catch {
    /* best effort — state block still captures the findings */
  }
}

export function renderResearchComment(issueNumber: number, body: string): string {
  return `## Research for issue #${issueNumber}\n\n${body}`
}
