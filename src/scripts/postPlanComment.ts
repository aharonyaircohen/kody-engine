/**
 * Postflight for the `plan` agentAction. Posts the plan body as a clearly
 * labeled issue comment, separate from the machine-readable task-state block
 * (which `saveTaskState` writes elsewhere). The plan comment is what a human
 * reader sees; the state block is what the next agentAction (`run`) reads.
 *
 * No-op when the agent did not complete or produced no plan body.
 *
 * Footer must NEVER contain a literal `@kody X` string — the GHA
 * `contains(comment.body, '@kody')` filter ignores markdown backticks and
 * would re-fire the workflow on this very comment. We render the trigger as
 * inert code (`kody run`, no @) and instruct the reader to add the @.
 */

import type { PostflightScript } from "../agent-actions/types.js"
import type { TaskState } from "../state.js"
import { postAgentSummaryComment } from "./postAgentSummaryComment.js"

export const postPlanComment: PostflightScript = async (ctx) => {
  const flowActive = Boolean((ctx.data.taskState as TaskState | undefined)?.flow)
  postAgentSummaryComment(ctx, {
    issueOnly: true,
    render: (n, plan) => renderPlanComment(n, plan, { flowActive }),
  })
}

export function renderPlanComment(issueNumber: number, plan: string, opts?: { flowActive?: boolean }): string {
  const head = `## Plan for issue #${issueNumber}\n\n${plan}`
  if (opts?.flowActive) {
    return `${head}\n\n---\n_Orchestrator will advance to the next step automatically._`
  }
  // Inert: no `@` in the rendered code so the GHA contains() filter doesn't
  // self-fire when this comment is posted.
  return `${head}\n\n---\nComment \`kody run\` (prefixed with \`@\`) to execute this plan.`
}
