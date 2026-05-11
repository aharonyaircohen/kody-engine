/**
 * Preflight (runWhen phase==="all-done"): every child task is closed or
 * has a ready (non-draft) open PR. Squash-merge the leaf PR — its diff
 * vs the default branch is the cumulative goal — and let the cascade
 * close every other stacked PR + their referenced issues via `Closes #N`.
 *
 * Stacked-PR model:
 *   - Promote leaf to ready-for-review if still draft (defensive — phase
 *     "all-done" already implies non-draft, but a stray draft would
 *     otherwise block the merge).
 *   - Squash-merge the leaf with --delete-branch.
 *   - Transition `state` → "done"; the next tick exits as `terminal`.
 *
 * No-op (state still transitions to "done") when there is no leaf — e.g.
 * the goal had only manually-closed task issues with no PRs ever opened.
 */

import type { PreflightScript } from "../executables/types.js"
import { markPrReady, mergePrSquash } from "../goal/operations.js"
import type { GoalCtx } from "./goalCtx.js"

export const finalizeGoal: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  process.stdout.write(`[goal-tick] all task(s) done — finalising goal ${goal.id}\n`)

  const leaf = goal.leafPr
  if (leaf) {
    if (leaf.isDraft) {
      process.stdout.write(`[goal-tick] promoting draft leaf PR #${leaf.number} → ready\n`)
      const ready = markPrReady(leaf.number, ctx.cwd)
      if (!ready.ok) {
        process.stderr.write(`[goal-tick] finalizeGoal: markPrReady failed: ${ready.error}\n`)
        return
      }
    }
    process.stdout.write(`[goal-tick] squash-merging leaf PR #${leaf.number}\n`)
    const merged = mergePrSquash(leaf.number, ctx.cwd)
    if (!merged.ok) {
      process.stderr.write(`[goal-tick] finalizeGoal: mergePrSquash failed: ${merged.error}\n`)
      return
    }
  } else {
    process.stdout.write(`[goal-tick] no leaf PR — marking goal done without merge\n`)
  }

  goal.state = "done"
}
