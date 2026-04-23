/**
 * Postflight for the `plan` executable. Posts the plan body as a clearly
 * labeled issue comment, separate from the machine-readable task-state block
 * (which `saveTaskState` writes elsewhere). The plan comment is what a human
 * reader sees; the state block is what the next executable (`run`) reads.
 *
 * No-op when the agent did not complete or produced no plan body.
 *
 * Footer must NEVER contain a literal `@kody X` string — the GHA
 * `contains(comment.body, '@kody')` filter ignores markdown backticks and
 * would re-fire the workflow on this very comment. We render the trigger as
 * inert code (`kody run`, no @) and instruct the reader to add the @.
 */

import type { PostflightScript } from "../executables/types.js"
import { postIssueComment as ghPostIssueComment } from "../issue.js"
import type { TaskState } from "../state.js"

export const postPlanComment: PostflightScript = async (ctx) => {
  if (!ctx.data.agentDone) return
  const targetType = ctx.data.commentTargetType as "issue" | "pr" | undefined
  const targetNumber = Number(ctx.data.commentTargetNumber ?? 0)
  const plan = (ctx.data.prSummary as string | undefined)?.trim()
  if (targetType !== "issue" || !targetNumber || !plan) return

  const flowActive = Boolean((ctx.data.taskState as TaskState | undefined)?.flow)
  const body = renderPlanComment(targetNumber, plan, { flowActive })
  try {
    ghPostIssueComment(targetNumber, body, ctx.cwd)
  } catch {
    /* best effort — state block still captures the plan */
  }
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
