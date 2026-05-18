/**
 * Preflight (runWhen phase==="all-done"): every child task is closed or
 * has a ready (non-draft) open PR. Finalize the goal by PREPARING the
 * **leaf** PR as the single deliverable — the engine never merges to the
 * default branch. The leaf's diff against the repo default branch is the
 * cumulative goal (every task's change accumulates into the next task's
 * branch); a human reviews and merges that one PR in GitHub.
 *
 * Why leaf-only (and not sequential):
 *   A sequential strategy (merge root, then leaf) breaks on the second
 *   merge: the leaf's history still points at the OLD predecessor
 *   branch's SHAs, so a subsequent merge produces conflicts even when
 *   the textual diff is identical. Surfacing only the leaf sidesteps
 *   this entirely — one branch, one reviewable PR, one human merge.
 *
 * Stacked-PR model:
 *   - Identify the leaf (already cached as `goal.leafPr` by
 *     deriveGoalPhase; deterministic via the base-chain).
 *   - Retarget the leaf's base to `defaultBranch` so the PR diff is the
 *     true cumulative goal change. (Use REST PATCH because gh's edit
 *     path needs read:org scope — see editPrBase.)
 *   - Promote it to ready-for-review if still draft.
 *   - Close every other open task PR in the stack (their content is
 *     carried by the leaf branch; they're redundant once the leaf is the
 *     single deliverable).
 *   - Close child task issues (the goal's work is complete; it lands when
 *     the human merges the deliverable PR).
 *   - Leave the leaf PR OPEN. Transition state → "done"; the next tick
 *     exits as "terminal".
 *
 * No-op (state still transitions to "done") when there is no leaf —
 * e.g. the goal had only manually-closed task issues with no PRs.
 *
 * NOTE: the engine deliberately does NOT squash-merge. Auto-merge to the
 * default branch was removed by product decision — a goal finishes with
 * one open, review-ready PR and nothing merged.
 */

import type { PreflightScript } from "../executables/types.js"
import {
  branchContains,
  closeIssue,
  closePr,
  commentOnIssue,
  editPrBase,
  extractClosesIssues,
  markPrReady,
} from "../goal/operations.js"
import type { OpenTaskPr } from "../goal/operations.js"
import type { GoalCtx } from "./goalCtx.js"

/** Issue numbers a PR speaks for: `Closes #N` refs ∪ the `<n>-slug` head convention. */
function prIssueNumbers(pr: OpenTaskPr): number[] {
  const nums = new Set(extractClosesIssues(pr.body))
  const headMatch = pr.headRefName.match(/^(\d+)-/)
  if (headMatch) {
    const n = Number.parseInt(headMatch[1]!, 10)
    if (Number.isFinite(n)) nums.add(n)
  }
  return [...nums]
}

export const finalizeGoal: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  process.stdout.write(`[goal-tick] all task(s) done — preparing deliverable PR for goal ${goal.id}\n`)

  const leaf = goal.leafPr
  if (!leaf) {
    process.stdout.write(`[goal-tick] no leaf PR — marking goal done without a deliverable PR\n`)
    goal.state = "done"
    return
  }

  // Retarget the leaf to defaultBranch so its open diff is the true
  // cumulative goal change. Idempotent: skip if already there.
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
    process.stdout.write(`[goal-tick] promoting draft leaf PR #${leaf.number} → ready-for-review\n`)
    const ready = markPrReady(leaf.number, ctx.cwd)
    if (!ready.ok) {
      process.stderr.write(`[goal-tick] finalizeGoal: markPrReady #${leaf.number} failed: ${ready.error}\n`)
      return
    }
  }

  process.stdout.write(
    `[goal-tick] leaf PR #${leaf.number} is the deliverable (cumulative goal diff vs ${goal.defaultBranch}) — left open for human merge\n`,
  )

  // Close every other open task PR — but ONLY after verifying the leaf
  // branch actually carries that PR's commits. The "leaf carries
  // everything" invariant holds only for a strictly linear stack; a
  // broken chain (a task branch cut fresh off the default branch
  // instead of stacked on its predecessor) would otherwise be silently
  // dropped here. Uncarried PRs (and their issues) are left OPEN.
  // Best-effort: a failure here doesn't block finalize.
  const uncarriedIssues = new Set<number>()
  const others = (goal.openTaskPrs ?? []).filter((p) => p.number !== leaf.number)
  for (const pr of others) {
    const contained = branchContains(leaf.headRefName, pr.headRefName, ctx.cwd)
    if (!contained.ok || contained.value !== true) {
      const why = contained.ok
        ? `commits on \`${pr.headRefName}\` are NOT reachable from the deliverable leaf \`${leaf.headRefName}\``
        : `could not verify containment (${contained.error})`
      process.stderr.write(
        `[goal-tick] finalizeGoal: NOT closing PR #${pr.number} — ${why}; leaving it open (broken stack)\n`,
      )
      for (const n of prIssueNumbers(pr)) uncarriedIssues.add(n)
      commentOnIssue(
        pr.number,
        `⚠️ _Stacked-PR finalize: this PR's commits are **not** carried by the goal's deliverable PR #${leaf.number} (the stack chain was broken). Leaving this PR open so its work isn't lost — review and land it manually._`,
        ctx.cwd,
      )
      continue
    }
    process.stdout.write(`[goal-tick] closing intermediate stacked PR #${pr.number} (carried by deliverable leaf)\n`)
    const closed = closePr(
      pr.number,
      `_Stacked-PR finalize: this PR's content is carried by the goal's single deliverable PR #${leaf.number} (open against \`${goal.defaultBranch}\`, awaiting human merge)._`,
      ctx.cwd,
    )
    if (!closed.ok) {
      process.stderr.write(`[goal-tick] finalizeGoal: closePr #${pr.number} failed: ${closed.error}\n`)
    }
  }

  // Close every still-open child task issue: the goal's work is complete
  // and consolidated into the deliverable PR. The changes land when a
  // human merges that PR — we close now so task issues track the goal's
  // "done" state rather than waiting on a merge the engine never does.
  const openIssues = (goal.childTasks ?? []).filter((t) => t.state === "OPEN")
  for (const t of openIssues) {
    if (uncarriedIssues.has(t.number)) {
      process.stderr.write(
        `[goal-tick] finalizeGoal: NOT closing task issue #${t.number} — its PR's work is not carried by the deliverable (broken stack)\n`,
      )
      continue
    }
    process.stdout.write(`[goal-tick] closing task issue #${t.number} (goal finalized — carried by PR #${leaf.number})\n`)
    const closed = closeIssue(
      t.number,
      {
        comment: `_Goal \`${goal.id}\` finalized — its single deliverable PR #${leaf.number} (open against \`${goal.defaultBranch}\`) carries this task's changes. Merge that PR to ship._`,
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
