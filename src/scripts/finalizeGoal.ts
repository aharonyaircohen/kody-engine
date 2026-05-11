/**
 * Preflight (runWhen phase==="all-done"): every child task is closed or
 * has a ready (non-draft) open PR. Finalize the goal by merging the
 * **leaf** PR only — its diff against the repo default branch is the
 * cumulative goal (every task's change accumulates into the next
 * task's branch). Intermediate stacked PRs are then closed since their
 * content is already in the default branch.
 *
 * Why leaf-only (and not sequential):
 *   A sequential strategy (squash-merge root, then leaf) sounds simpler
 *   but breaks on the second merge: squash creates a new commit on the
 *   default branch with content but a brand-new SHA; the leaf's history
 *   still points at the OLD predecessor branch's SHAs, so a subsequent
 *   merge produces conflicts even when the textual diff is identical.
 *   Merging only the leaf sidesteps this entirely.
 *
 * Stacked-PR model:
 *   - Identify the leaf (already cached as `goal.leafPr` by
 *     deriveGoalPhase; deterministic via the base-chain).
 *   - Retarget the leaf's base to `defaultBranch` so the squash lands
 *     in the right place. (Use REST PATCH because gh's edit path needs
 *     read:org scope — see editPrBase.)
 *   - Promote it to ready-for-review if still draft (defensive).
 *   - Squash-merge with --delete-branch.
 *   - Close every other open task PR in the stack with a courtesy
 *     comment pointing at the merge.
 *   - Transition state → "done"; the next tick exits as "terminal".
 *
 * No-op (state still transitions to "done") when there is no leaf —
 * e.g. the goal had only manually-closed task issues with no PRs.
 */

import type { PreflightScript } from "../executables/types.js"
import { closeIssue, closePr, editPrBase, markPrReady, mergePrSquash } from "../goal/operations.js"
import type { GoalCtx } from "./goalCtx.js"

export const finalizeGoal: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  process.stdout.write(`[goal-tick] all task(s) done — finalising goal ${goal.id}\n`)

  const leaf = goal.leafPr
  if (!leaf) {
    process.stdout.write(`[goal-tick] no leaf PR — marking goal done without merge\n`)
    goal.state = "done"
    return
  }

  // Retarget the leaf to defaultBranch so its squash lands in the right
  // place. Idempotent: skip if already there.
  if (leaf.baseRefName !== goal.defaultBranch) {
    process.stdout.write(
      `[goal-tick] retargeting leaf PR #${leaf.number} base ${leaf.baseRefName} → ${goal.defaultBranch}\n`,
    )
    const retarget = editPrBase(leaf.number, goal.defaultBranch, ctx.cwd)
    if (!retarget.ok) {
      process.stderr.write(`[goal-tick] finalizeGoal: editPrBase #${leaf.number} failed: ${retarget.error}\n`)
      return
    }
  }

  if (leaf.isDraft) {
    process.stdout.write(`[goal-tick] promoting draft leaf PR #${leaf.number} → ready\n`)
    const ready = markPrReady(leaf.number, ctx.cwd)
    if (!ready.ok) {
      process.stderr.write(`[goal-tick] finalizeGoal: markPrReady #${leaf.number} failed: ${ready.error}\n`)
      return
    }
  }

  process.stdout.write(
    `[goal-tick] squash-merging leaf PR #${leaf.number} → ${goal.defaultBranch} (cumulative goal diff)\n`,
  )
  const merged = mergePrSquash(leaf.number, ctx.cwd)
  if (!merged.ok) {
    process.stderr.write(`[goal-tick] finalizeGoal: mergePrSquash #${leaf.number} failed: ${merged.error}\n`)
    return
  }

  // Close every other open task PR — their content is now in the
  // default branch via the leaf's cumulative squash. Best-effort: a
  // failure here doesn't roll back the merge.
  const others = (goal.openTaskPrs ?? []).filter((p) => p.number !== leaf.number)
  for (const pr of others) {
    process.stdout.write(`[goal-tick] closing intermediate stacked PR #${pr.number} (subsumed by leaf merge)\n`)
    const closed = closePr(
      pr.number,
      `_Stacked-PR finalize: this PR's content is included in the leaf squash to \`${goal.defaultBranch}\` (#${leaf.number})._`,
      ctx.cwd,
    )
    if (!closed.ok) {
      process.stderr.write(`[goal-tick] finalizeGoal: closePr #${pr.number} failed: ${closed.error}\n`)
    }
  }

  // Explicitly close every still-open child task issue. GitHub's
  // `Closes #N` keyword auto-closes only when a PR merges into the
  // *GitHub repo default branch* — but stacked goals usually merge
  // into the engine's `git.defaultBranch` (`dev`/`integration`/…),
  // which often differs. Doing it explicitly here is the only way to
  // guarantee task issues track the goal's "done" state.
  const openIssues = (goal.childTasks ?? []).filter((t) => t.state === "OPEN")
  for (const t of openIssues) {
    process.stdout.write(`[goal-tick] closing task issue #${t.number} (goal finalized)\n`)
    const closed = closeIssue(
      t.number,
      {
        comment: `_Goal \`${goal.id}\` finalized — leaf PR #${leaf.number} squash-merged to \`${goal.defaultBranch}\` carries this task's changes._`,
        reason: "completed",
      },
      ctx.cwd,
    )
    if (!closed.ok) {
      process.stderr.write(`[goal-tick] finalizeGoal: closeIssue #${t.number} failed: ${closed.error}\n`)
    }
  }

  goal.state = "done"
}
