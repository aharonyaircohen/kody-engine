/**
 * Postflight: post the agent's final answer as a plain comment on the
 * target issue/PR. This is the generic "comment-only" landing — used by
 * implementations that advise rather than change code (no branch, no PR).
 *
 * The answer is the agent's final summary (ctx.data.prSummary, set by
 * parseAgentResult). The comment target (issue/PR + number) is stamped by a
 * preflight context loader (loadIssueContext / setCommentTarget). No-op when
 * the agent did not complete or produced no answer.
 *
 * Footer is intentionally omitted: unlike postPlanComment there is no
 * follow-up trigger to advertise, so nothing here can self-fire the GHA
 * `contains(comment.body, '@kody')` filter beyond whatever the agent itself
 * wrote — same exposure as postReviewResult.
 */

import type { PostflightScript } from "../implementations/types.js"
import { postAgentSummaryComment } from "./postAgentSummaryComment.js"

export const postAgentComment: PostflightScript = async (ctx) => {
  // Generic comment-only landing: post the answer verbatim on the target
  // issue/PR. No header, no issue-only restriction.
  postAgentSummaryComment(ctx)
}
