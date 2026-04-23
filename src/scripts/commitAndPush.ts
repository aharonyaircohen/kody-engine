/**
 * Postflight: stage allowed files, commit, push. Stashes the commit result
 * on ctx.data.commitResult for ensurePr/postIssueComment to consume.
 *
 * For the resolve flow: stages all files explicitly (merge commit needs -A).
 */

import { execFileSync } from "node:child_process"
import {
  abortUnfinishedGitOps,
  commitAndPush as doCommitAndPush,
  hasCommitsAhead,
  isForbiddenPath,
  listChangedFiles,
  listFilesInCommit,
} from "../commit.js"
import type { PostflightScript } from "../executables/types.js"

export const commitAndPush: PostflightScript = async (ctx, profile) => {
  const branch = ctx.data.branch as string | undefined
  if (!branch) {
    ctx.data.commitResult = { committed: false, pushed: false }
    return
  }

  // If an earlier postflight (e.g. requireFeedbackActions) flipped agentDone
  // to false, we must not commit the agent's edits. Leave them in the working
  // tree so the failure reason is surfaced without polluting the branch.
  if (ctx.data.agentDone === false) {
    ctx.data.commitResult = { committed: false, pushed: false, skippedReason: "agentDone=false" }
    ctx.data.hasCommitsAhead = hasCommitsAhead(branch, ctx.config.git.defaultBranch, ctx.cwd)
    return
  }

  const kind = profile.name

  // Resolve flow: make sure conflict-resolved files get staged.
  // Do NOT abort MERGE_HEAD in resolve mode — the resolveFlow intentionally
  // created it, and commitAndPush needs to produce the merge commit from it.
  if (kind === "resolve") {
    try {
      execFileSync("git", ["add", "-A"], { cwd: ctx.cwd, env: { ...process.env, HUSKY: "0" }, stdio: "pipe" })
    } catch {
      /* best effort */
    }
  } else {
    // All other executables: clean up any agent-created unfinished git state
    // (e.g., stash/merge/rebase leftovers) before committing.
    const aborted = abortUnfinishedGitOps(ctx.cwd)
    if (aborted.length > 0) {
      process.stderr.write(`[kody] cleaned up unfinished git ops: ${aborted.join(", ")}\n`)
    }
  }

  const fallbackMsg = defaultCommitMessage(kind, ctx.data)
  const message = (ctx.data.commitMessage as string) || fallbackMsg

  try {
    const result = doCommitAndPush(branch, message, ctx.cwd)
    ctx.data.commitResult = result
    // After a successful commit the working tree is clean, so listChangedFiles
    // (which reads `git status`) returns []. Use the commit's own file list
    // so downstream postflights (verifyFixAlignment) know what we committed.
    // Fall back to working-tree status only if the commit was skipped.
    const postCommitFiles = result.committed
      ? listFilesInCommit("HEAD", ctx.cwd)
      : listChangedFiles(ctx.cwd)
    ctx.data.changedFiles = postCommitFiles.filter((f) => !isForbiddenPath(f))
  } catch (err) {
    ctx.data.commitCrash = err instanceof Error ? err.message : String(err)
    ctx.data.commitResult = { committed: false, pushed: false }
  }

  ctx.data.hasCommitsAhead = hasCommitsAhead(branch, ctx.config.git.defaultBranch, ctx.cwd)
}

function defaultCommitMessage(mode: string | undefined, data: Record<string, unknown>): string {
  switch (mode) {
    case "run":
      return `chore: kody changes for #${data.commentTargetNumber}`
    case "fix":
      return `chore(fix): kody fix for PR #${data.commentTargetNumber}`
    case "fix-ci":
      return `fix(ci): kody fix-ci for PR #${data.commentTargetNumber}`
    case "resolve":
      return `fix: resolve merge conflicts with ${data.baseBranch}`
    default:
      return `chore: kody changes`
  }
}
