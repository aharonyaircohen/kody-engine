/**
 * Read-only preflight: load an issue's metadata + formatted comments into
 * ctx.data.issue. No branch creation, no "started" comment. Used by
 * read-only executables (plan, orchestrator) that must not touch git state.
 *
 * ctx.data.issue: IssueData & { commentsFormatted: string }
 * ctx.data.commentTargetType = "issue"
 * ctx.data.commentTargetNumber = issueNumber
 */

import type { PreflightScript } from "../executables/types.js"
import { getIssue, truncate } from "../issue.js"

const DEFAULT_COMMENT_LIMIT = 12
// 16KB/comment is enough to pass through a full research artifact (findings
// + ambiguities) without clipping. Override per-project via kody.config.json
// > issueContext > commentMaxBytes.
const DEFAULT_COMMENT_MAX_BYTES = 16_000

export const loadIssueContext: PreflightScript = async (ctx) => {
  const issueNumber = ctx.args.issue as number
  if (typeof issueNumber !== "number" || issueNumber <= 0) {
    throw new Error("loadIssueContext: ctx.args.issue (positive integer) is required")
  }

  const issue = getIssue(issueNumber, ctx.cwd)
  const cfgCtx = ctx.config.issueContext ?? {}
  const limit = cfgCtx.commentLimit ?? DEFAULT_COMMENT_LIMIT
  const maxBytes = cfgCtx.commentMaxBytes ?? DEFAULT_COMMENT_MAX_BYTES

  const sorted = [...issue.comments].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  const kept = sorted.slice(0, limit)
  const commentsFormatted =
    kept.length === 0
      ? "(no comments yet)"
      : kept
          .map((c) => `- **${c.author}** (${c.createdAt}):\n  ${truncate(c.body, maxBytes).replace(/\n/g, "\n  ")}`)
          .join("\n\n")

  const labels = issue.labels ?? []
  const labelsFormatted = labels.length === 0 ? "(no labels)" : labels.map((l) => `\`${l}\``).join(", ")

  ctx.data.issue = { ...issue, commentsFormatted, labelsFormatted }
  ctx.data.commentTargetType = "issue"
  ctx.data.commentTargetNumber = issueNumber
}
