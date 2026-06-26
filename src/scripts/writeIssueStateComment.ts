/**
 * Postflight: persist ctx.data.nextIssueState into the marker-keyed state
 * comment on the triggering issue. Creates the comment on first run, updates
 * it thereafter. Minimized (collapsed) via GraphQL after each write.
 *
 * If a prior preflight reported a parse error (ctx.data.nextStateParseError),
 * logs it and surfaces exit code 1 so the run fails loudly rather than
 * silently noop'ing on a broken agent response.
 *
 * Script args (via `with:`):
 *   marker    required — same marker used by loadIssueStateComment
 *   issueArg  optional — name of the CLI input holding the issue number (default "issue")
 */

import type { PostflightScript } from "../executables/types.js"
import {
  createStateComment,
  type LoadedStateComment,
  type StateEnvelope,
  updateStateComment,
} from "./issueStateComment.js"

export const writeIssueStateComment: PostflightScript = async (ctx, _profile, _agentResult, args) => {
  const marker = String(args?.marker ?? "")
  if (!marker) {
    throw new Error("writeIssueStateComment: `with.marker` is required")
  }
  const issueArg = String(args?.issueArg ?? "issue")
  const issueNumber = Number(ctx.args[issueArg])
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    throw new Error(`writeIssueStateComment: ctx.args.${issueArg} must be a positive integer`)
  }

  const parseError = ctx.data.nextStateParseError as string | undefined
  if (parseError) {
    process.stderr.write(`[kody] state write skipped: ${parseError}\n`)
    if (ctx.output.exitCode === 0) ctx.output.exitCode = 1
    if (!ctx.output.reason) ctx.output.reason = `next-state parse failed: ${parseError}`
    return
  }

  const next = ctx.data.nextIssueState as StateEnvelope | undefined
  if (!next) {
    // Agent emitted nothing new; leave the state comment alone.
    return
  }

  const owner = ctx.config.github.owner
  const repo = ctx.config.github.repo
  if (!owner || !repo) {
    throw new Error("writeIssueStateComment: ctx.config.github.owner/repo must be set")
  }

  const loaded = ctx.data.issueStateComment as LoadedStateComment | null | undefined

  if (loaded) {
    updateStateComment(owner, repo, loaded.commentId, loaded.commentNodeId, marker, next, ctx.cwd)
  } else {
    createStateComment(owner, repo, issueNumber, marker, next, ctx.cwd)
  }
}
