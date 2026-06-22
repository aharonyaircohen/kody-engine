/**
 * Shared landing for "advise, don't change code" executables (`plan`,
 * `research`, and the generic `agent-ask` answer). They all do the same
 * thing: when the agent completed, take its summary (ctx.data.prSummary),
 * optionally wrap it in a header, and post it as one best-effort comment on
 * the target the preflight stamped. The render/target rules differ; the
 * guard-and-post boilerplate doesn't — so it lives here once.
 */

import type { Context } from "../executables/types.js"
import { postIssueComment as ghPostIssueComment } from "../issue.js"

export interface PostSummaryOptions {
  /** Wrap the body before posting (e.g. add a "## Plan for #N" header). */
  render?: (targetNumber: number, body: string) => string
  /** Skip when the comment target is a PR rather than an issue. */
  issueOnly?: boolean
}

/**
 * No-op unless the agent finished and produced a non-empty summary on a known
 * target. Posting is best-effort: a failed comment never fails the run,
 * because the run summary / state block still captures the body.
 */
export function postAgentSummaryComment(ctx: Context, opts: PostSummaryOptions = {}): void {
  if (!ctx.data.agentDone) return
  const targetType = ctx.data.commentTargetType as "issue" | "pr" | undefined
  const targetNumber = Number(ctx.data.commentTargetNumber ?? 0)
  const body = (ctx.data.prSummary as string | undefined)?.trim()
  if (!targetNumber || !body) return
  if (opts.issueOnly && targetType !== "issue") return

  const rendered = opts.render ? opts.render(targetNumber, body) : body
  try {
    ghPostIssueComment(targetNumber, rendered, ctx.cwd)
  } catch {
    /* best effort — run summary / state block still captures the body */
  }
}
