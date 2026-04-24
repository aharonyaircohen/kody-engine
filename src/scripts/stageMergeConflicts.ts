/**
 * Postflight: stage everything in the working tree so commitAndPush can
 * produce a merge commit. Specifically for flows that intentionally left
 * MERGE_HEAD behind (resolve) and need the agent's conflict resolutions
 * plus any auto-resolved files to land in one commit.
 *
 * Placement: right before commitAndPush. Must NOT be paired with
 * abortUnfinishedGitOps — that would abort the merge we're trying to finish.
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"

export const stageMergeConflicts: PostflightScript = async (ctx) => {
  if (ctx.data.agentDone === false) return
  try {
    execFileSync("git", ["add", "-A"], {
      cwd: ctx.cwd,
      env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
      stdio: "pipe",
    })
  } catch {
    /* best effort */
  }
}
