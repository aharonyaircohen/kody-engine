/**
 * Read-only preflight: load an issue's metadata + formatted comments into
 * ctx.data.issue. No branch creation, no "started" comment. Used by
 * read-only implementations (plan, orchestrator) that must not touch git state.
 *
 * ctx.data.issue: IssueData & { commentsFormatted: string }
 * ctx.data.commentTargetType = "issue"
 * ctx.data.commentTargetNumber = issueNumber
 */

import type { PreflightScript } from "../implementations/types.js"
import { DEFAULT_COMMENT_LIMIT, DEFAULT_COMMENT_MAX_BYTES, formatIssueComments, getIssue } from "../issue.js"

export const loadIssueContext: PreflightScript = async (ctx) => {
  const issueNumber = ctx.args.issue as number
  if (typeof issueNumber !== "number" || issueNumber <= 0) {
    throw new Error("loadIssueContext: ctx.args.issue (positive integer) is required")
  }

  // Phase 5 fast path: if a parent container already loaded this
  // issue's snapshot and seeded ctx.data, skip the gh round-trip.
  // The seeded snapshot is trusted as-is — the container fetched it
  // once for the whole task instead of once per stage.
  const preloaded = ctx.data.issue as { number?: number } | undefined
  if (preloaded && typeof preloaded === "object" && preloaded.number === issueNumber) {
    if (!ctx.data.commentTargetType) ctx.data.commentTargetType = "issue"
    if (!ctx.data.commentTargetNumber) ctx.data.commentTargetNumber = issueNumber
    return
  }

  const issue = getIssue(issueNumber, ctx.cwd)
  const cfgCtx = ctx.config.issueContext ?? {}
  const limit = cfgCtx.commentLimit ?? DEFAULT_COMMENT_LIMIT
  const maxBytes = cfgCtx.commentMaxBytes ?? DEFAULT_COMMENT_MAX_BYTES

  const commentsFormatted = formatIssueComments(issue.comments, limit, maxBytes)

  const labels = issue.labels ?? []
  const labelsFormatted = labels.length === 0 ? "(no labels)" : labels.map((l) => `\`${l}\``).join(", ")

  ctx.data.issue = { ...issue, commentsFormatted, labelsFormatted }
  ctx.data.commentTargetType = "issue"
  ctx.data.commentTargetNumber = issueNumber
}
