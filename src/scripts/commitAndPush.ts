/**
 * Postflight: commit whatever is staged and push the branch. Records the
 * commit result on ctx.data.commitResult for downstream postflights
 * (ensurePr, postIssueComment) to consume.
 *
 * Staging and pre-commit cleanup are the responsibility of earlier
 * postflight entries (e.g. abortUnfinishedGitOps for normal flows,
 * stageMergeConflicts for merge flows). This script does not branch on
 * executable identity.
 *
 * Commit message source (in priority order):
 *   1. ctx.data.commitMessage (agent's COMMIT_MSG line, parsed by parseAgentResult)
 *   2. generic fallback ("chore: kody changes")
 */

import {
  commitAndPush as doCommitAndPush,
  hasCommitsAhead,
  isForbiddenPath,
  listChangedFiles,
  listFilesInCommit,
} from "../commit.js"
import type { PostflightScript } from "../executables/types.js"

const DEFAULT_COMMIT_MESSAGE = "chore: kody changes"

export const commitAndPush: PostflightScript = async (ctx) => {
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

  const message = (ctx.data.commitMessage as string) || DEFAULT_COMMIT_MESSAGE

  try {
    const result = doCommitAndPush(branch, message, ctx.cwd)
    ctx.data.commitResult = result
    // After a successful commit the working tree is clean, so listChangedFiles
    // (which reads `git status`) returns []. Use the commit's own file list
    // so downstream postflights (verifyFixAlignment) know what we committed.
    // Fall back to working-tree status only if the commit was skipped.
    const postCommitFiles = result.committed ? listFilesInCommit("HEAD", ctx.cwd) : listChangedFiles(ctx.cwd)
    ctx.data.changedFiles = postCommitFiles.filter((f) => !isForbiddenPath(f))
  } catch (err) {
    ctx.data.commitCrash = err instanceof Error ? err.message : String(err)
    ctx.data.commitResult = { committed: false, pushed: false }
  }

  ctx.data.hasCommitsAhead = hasCommitsAhead(branch, ctx.config.git.defaultBranch, ctx.cwd)
}
