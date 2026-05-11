/**
 * Preflight (runWhen phase==="all-done"): every child task is closed or
 * has a ready (non-draft) open PR. Squash-merge each stacked task PR
 * into the repo default branch in dispatch order, so the cumulative
 * goal lands as a series of squash commits.
 *
 * Cascade gotcha: `gh pr merge --delete-branch` removes the merged
 * head, which GitHub treats as "base branch deleted" for any PR still
 * stacked on it. Depending on divergence, GitHub may either auto-
 * retarget to the repo default OR close the PR. We saw the latter
 * happen during the v9 live test on Tester (#3330 closed after #3326
 * merged). To force a deterministic outcome, we explicitly retarget
 * every non-root stacked PR to the default branch BEFORE merging it.
 *
 * Stacked-PR model:
 *   - Promote any draft PR to ready-for-review (defensive — phase
 *     "all-done" already implies non-draft, but a stray draft would
 *     otherwise block the merge).
 *   - Sort open task PRs by their head-ref issue number (root first,
 *     leaf last).
 *   - For each PR in order: retarget base to defaultBranch (if it
 *     isn't already there), then squash-merge with --delete-branch.
 *   - Bail on the first failure so a partial finalize is observable
 *     and retryable on the next tick.
 *   - Transition `state` → "done"; the next tick exits as `terminal`.
 *
 * No-op (state still transitions to "done") when there are no open
 * task PRs — e.g. the goal had only manually-closed task issues.
 */

import type { PreflightScript } from "../executables/types.js"
import { editPrBase, markPrReady, mergePrSquash, type OpenTaskPr } from "../goal/operations.js"
import type { GoalCtx } from "./goalCtx.js"

export const finalizeGoal: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  process.stdout.write(`[goal-tick] all task(s) done — finalising goal ${goal.id}\n`)

  const taskPrs = goal.openTaskPrs ?? []
  if (taskPrs.length === 0) {
    process.stdout.write(`[goal-tick] no open task PRs — marking goal done without merge\n`)
    goal.state = "done"
    return
  }

  const ordered = [...taskPrs].sort((a, b) => extractIssueNumber(a) - extractIssueNumber(b))

  for (const pr of ordered) {
    if (pr.isDraft) {
      process.stdout.write(`[goal-tick] promoting draft PR #${pr.number} → ready\n`)
      const ready = markPrReady(pr.number, ctx.cwd)
      if (!ready.ok) {
        process.stderr.write(`[goal-tick] finalizeGoal: markPrReady #${pr.number} failed: ${ready.error}\n`)
        return
      }
    }

    if (pr.baseRefName !== goal.defaultBranch) {
      process.stdout.write(
        `[goal-tick] retargeting PR #${pr.number} base ${pr.baseRefName} → ${goal.defaultBranch}\n`,
      )
      const retarget = editPrBase(pr.number, goal.defaultBranch, ctx.cwd)
      if (!retarget.ok) {
        process.stderr.write(`[goal-tick] finalizeGoal: editPrBase #${pr.number} failed: ${retarget.error}\n`)
        return
      }
    }

    process.stdout.write(`[goal-tick] squash-merging PR #${pr.number} → ${goal.defaultBranch} (head=${pr.headRefName})\n`)
    const merged = mergePrSquash(pr.number, ctx.cwd)
    if (!merged.ok) {
      process.stderr.write(`[goal-tick] finalizeGoal: mergePrSquash #${pr.number} failed: ${merged.error}\n`)
      return
    }
  }

  goal.state = "done"
}

/**
 * Extract the issue number that prefixes a kody-task branch name
 * (`<issueNumber>-<slug>`). Falls back to the PR number when the
 * convention doesn't match — keeps the sort stable even on
 * non-standard branches.
 */
function extractIssueNumber(pr: OpenTaskPr): number {
  const m = pr.headRefName.match(/^(\d+)-/)
  if (m?.[1]) return Number.parseInt(m[1], 10)
  return pr.number
}
