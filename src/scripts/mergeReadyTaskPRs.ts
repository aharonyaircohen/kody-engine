/**
 * Preflight (runWhen state==="active"): merge non-draft, MERGEABLE+CLEAN
 * task PRs into the goal branch. We own the merge here instead of using
 * GitHub's `--auto` flag (which silently no-ops if the repo's "Allow
 * auto-merge" setting is disabled).
 *
 * Anything else (BLOCKED, DIRTY, BEHIND, UNSTABLE, draft) is left for
 * the operator.
 */

import type { PreflightScript } from "../executables/types.js"
import { listPrsByBase, mergePrSquash } from "../goal/operations.js"
import type { GoalCtx } from "./goalCtx.js"

export const mergeReadyTaskPRs: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  const open = listPrsByBase(goal.goalBranch, "open", ctx.cwd)
  if (!open.ok) {
    process.stderr.write(`[goal-tick] mergeReadyTaskPRs: list failed: ${open.error}\n`)
    return
  }

  for (const pr of open.value ?? []) {
    if (pr.isDraft) continue
    if (pr.mergeable !== "MERGEABLE") continue
    if (pr.mergeStateStatus !== "CLEAN") continue

    process.stdout.write(`[goal-tick] merging PR #${pr.number} into ${goal.goalBranch}\n`)
    const r = mergePrSquash(pr.number, ctx.cwd)
    if (!r.ok) {
      process.stderr.write(`[goal-tick] failed to merge PR #${pr.number}: ${r.error} (continuing)\n`)
    }
  }
}
