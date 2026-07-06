/**
 * Postflight for the `research` implementation. Posts the research findings as
 * an issue comment with a clear header. Unlike `postPlanComment`, this does
 * NOT append a next-step instruction — research fills in missing info and
 * stops; deciding what to do next is the user's call.
 *
 * No-op when the agent did not complete or produced no body.
 */

import type { PostflightScript } from "../implementations/types.js"
import { postAgentSummaryComment } from "./postAgentSummaryComment.js"

export const postResearchComment: PostflightScript = async (ctx) => {
  postAgentSummaryComment(ctx, { issueOnly: true, render: renderResearchComment })
}

export function renderResearchComment(issueNumber: number, body: string): string {
  return `## Research for issue #${issueNumber}\n\n${body}`
}
