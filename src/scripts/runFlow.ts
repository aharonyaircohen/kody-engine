/**
 * Flow script for the `run` executable.
 * Loads the issue, creates/checks out a feature branch, posts the "started"
 * comment. Issue number lives in `ctx.args.issue`.
 */

import type { PreflightScript } from "../executables/types.js"
import { ensureFeatureBranch } from "../branch.js"
import { getRunUrl } from "../gha.js"
import {
  DEFAULT_COMMENT_LIMIT,
  DEFAULT_COMMENT_MAX_BYTES,
  formatIssueComments,
  getIssue,
  postIssueComment,
} from "../issue.js"

export const runFlow: PreflightScript = async (ctx) => {
  const issueNumber = ctx.args.issue as number

  const issue = getIssue(issueNumber, ctx.cwd)
  const cfgCtx = ctx.config.issueContext ?? {}
  const commentsFormatted = formatIssueComments(
    issue.comments,
    cfgCtx.commentLimit ?? DEFAULT_COMMENT_LIMIT,
    cfgCtx.commentMaxBytes ?? DEFAULT_COMMENT_MAX_BYTES,
  )
  ctx.data.issue = { ...issue, commentsFormatted }
  if (issue.isPullRequest) {
    ctx.data.commentTargetType = "pr"
    ctx.data.commentTargetNumber = issueNumber
    ctx.skipAgent = true
    ctx.output.exitCode = 1
    ctx.output.reason = `run target #${issueNumber} is a pull request; dispatch a PR action or the source issue instead`
    return
  }

  ctx.data.commentTargetType = "issue"
  ctx.data.commentTargetNumber = issueNumber

  // Resolve base branch from an explicit, validated --base override.
  // This remains useful for safe manual branch targeting; managed goals no
  // longer dispatch stacked task branches through this path.
  const argBase = resolveBaseOverride(ctx.args.base as string | undefined)
  const baseRaw = ctx.args.base as string | undefined
  if (baseRaw && !argBase) {
    process.stderr.write(`[kody runFlow] ignoring --base "${baseRaw}" (must match kody-task or goal-branch pattern)\n`)
  }
  const base = argBase
  if (base) {
    ctx.data.baseBranch = base
    process.stderr.write(`[kody runFlow] resolved base branch: ${base} (from --base)\n`)
  }

  // Rerun feedback: when the dashboard's Rerun action passes `Rerun.feedback`,
  // it lands here via the `feedback` input (either as an explicit `--feedback`
  // CLI flag or as comment-rest bound by `bindsCommentRest: true` in
  // profile.json). Surface it as `{{feedback}}` in the prompt so the agent
  // inherits the operator's intent on a re-triggered run.
  const feedbackRaw = ctx.args.feedback as string | undefined
  if (feedbackRaw && feedbackRaw.trim().length > 0) {
    ctx.data.feedback = feedbackRaw
  }

  const branchInfo = ensureFeatureBranch(
    issueNumber,
    issue.title,
    ctx.config.git.defaultBranch,
    ctx.cwd,
    base ?? undefined,
  )
  ctx.data.branch = branchInfo.branch

  const runUrl = getRunUrl()
  const startMsg = runUrl
    ? `⚙️ kody started — branch \`${ctx.data.branch}\`, run ${runUrl}`
    : `⚙️ kody started — branch \`${ctx.data.branch}\``
  tryPost(issueNumber, startMsg, ctx.cwd)
}

function tryPost(issueNumber: number, body: string, cwd?: string): void {
  try {
    postIssueComment(issueNumber, body, cwd)
  } catch {
    /* best effort */
  }
}

/**
 * git branch ref, otherwise null. Base overrides are intended for safe
 * branch targeting only.
 * caller; it passes either the leaf task branch or the repo's default
 * branch (dev, main, etc.), so we need to accept any ordinary branch
 * name without leaving the door open for path-traversal / shell-meta
 * injection.
 *
 * Allowed: lowercase letters, digits, slash, dot, underscore, hyphen.
 * No leading slash/dash/dot; no `..`; max 200 chars.
 */
export function resolveBaseOverride(value: string | undefined): string | null {
  if (!value) return null
  if (value.length > 200) return null
  if (value.includes("..")) return null
  if (!/^[a-z0-9][a-z0-9/._-]*$/.test(value)) return null
  return value
}
