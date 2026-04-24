/**
 * Preflight: load the persisted state comment for an issue into ctx.data.
 *
 * Reads kody config → github.owner/repo, looks at ctx.args[<issueArg>] for
 * the issue number. Places:
 *   ctx.data.stateMarker          echoed back from `with.marker` for later scripts
 *   ctx.data.issueIntent          issue body (human-owned prose = the mission)
 *   ctx.data.issueTitle           issue title
 *   ctx.data.issueStateComment    { commentId, commentNodeId, state } | null on first run
 *
 * Script args (via `with:`):
 *   marker      required — the state-comment HTML-comment marker (e.g. "kody-manager-state")
 *   issueArg    optional — name of the CLI input holding the issue number (default "issue")
 */

import type { PreflightScript } from "../executables/types.js"
import { getIssue } from "../issue.js"
import { findStateComment } from "./issueStateComment.js"

export const loadIssueStateComment: PreflightScript = async (ctx, _profile, args) => {
  const marker = String(args?.marker ?? "")
  if (!marker) {
    throw new Error("loadIssueStateComment: `with.marker` is required")
  }
  const issueArg = String(args?.issueArg ?? "issue")
  const issueNumber = Number(ctx.args[issueArg])
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    throw new Error(`loadIssueStateComment: ctx.args.${issueArg} must be a positive integer`)
  }

  const owner = ctx.config.github.owner
  const repo = ctx.config.github.repo
  if (!owner || !repo) {
    throw new Error("loadIssueStateComment: ctx.config.github.owner/repo must be set")
  }

  const issue = getIssue(issueNumber, ctx.cwd)
  const loaded = findStateComment(owner, repo, issueNumber, marker, ctx.cwd)

  ctx.data.stateMarker = marker
  ctx.data.issueIntent = issue.body
  ctx.data.issueTitle = issue.title
  ctx.data.issueNumber = String(issueNumber)
  ctx.data.issueStateComment = loaded
  // Rendered, prompt-ready view of the current state. "null" on first run.
  ctx.data.issueStateJson = loaded ? JSON.stringify(loaded.state, null, 2) : "null"
}
