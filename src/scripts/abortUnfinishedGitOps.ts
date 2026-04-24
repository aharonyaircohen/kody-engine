/**
 * Postflight: clean up any unfinished git state the agent may have left behind
 * (stashes, in-progress merges, cherry-picks, rebases, reverts, unmerged paths).
 *
 * Typical placement: right before commitAndPush in any executable that commits
 * the agent's edits. Executables that intentionally leave MERGE_HEAD in place
 * (e.g. resolve, which needs it to produce a merge commit) should NOT use this.
 */

import { abortUnfinishedGitOps as doAbort } from "../commit.js"
import type { PostflightScript } from "../executables/types.js"

export const abortUnfinishedGitOps: PostflightScript = async (ctx) => {
  if (ctx.data.agentDone === false) return
  const aborted = doAbort(ctx.cwd)
  if (aborted.length > 0) {
    process.stderr.write(`[kody] cleaned up unfinished git ops: ${aborted.join(", ")}\n`)
  }
}
