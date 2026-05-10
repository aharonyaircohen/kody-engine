/**
 * Preflight (runWhen phase==="all-done"): every child task closed.
 * Promote the goal PR from draft to ready-for-review (creating it if
 * absent), refresh its body to the finalize copy, and transition
 * `state` → "done".
 *
 * The umbrella issue auto-closes when the goal PR merges (via the
 * `Closes #N` we put in the body) — no separate close call here.
 */

import type { PreflightScript } from "../executables/types.js"
import { createPr, editPrBody, listPrsByHead, markPrReady, remoteBranchExists } from "../goal/operations.js"
import { nowIso } from "../goal/state.js"
import type { GoalCtx } from "./goalCtx.js"

export const finalizeGoal: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  process.stdout.write(`[goal-tick] all task(s) closed — finalising goal ${goal.id}\n`)

  if (!remoteBranchExists(goal.goalBranch, ctx.cwd)) {
    process.stderr.write(`[goal-tick] goal branch ${goal.goalBranch} not found on origin — skipping final PR\n`)
    finishState(goal)
    return
  }

  const title = `goal: ${goal.id}`
  const closesLine = goal.goalIssueNumber ? `\n\nCloses #${goal.goalIssueNumber}\n` : "\n"
  const body =
    `Final integration PR for goal **${goal.id}**.\n\n` +
    `All task issues are closed and merged into \`${goal.goalBranch}\`. Ready for review.${closesLine}`

  const existing = listPrsByHead(goal.goalBranch, "open", ctx.cwd)
  if (existing.ok && existing.value && existing.value.length > 0) {
    const pr = existing.value[0]!
    goal.goalPrUrl = pr.url
    // Refresh the body with the finalize copy.
    const edit = editPrBody(pr.number, body, ctx.cwd)
    if (!edit.ok) {
      process.stderr.write(`[goal-tick] finalizeGoal: editPrBody failed: ${edit.error}\n`)
    }
    if (pr.isDraft) {
      process.stdout.write(`[goal-tick] promoting draft goal PR #${pr.number} to ready-for-review\n`)
      const ready = markPrReady(pr.number, ctx.cwd)
      if (!ready.ok) {
        process.stderr.write(`[goal-tick] finalizeGoal: markPrReady failed: ${ready.error}\n`)
      }
    }
  } else {
    // Older goals from before the early-PR feature land here as fallback.
    const created = createPr(
      {
        head: goal.goalBranch,
        base: goal.defaultBranch,
        title,
        body,
        // ready-for-review (not draft) since we're finalizing.
        draft: false,
      },
      ctx.cwd,
    )
    if (!created.ok) {
      process.stderr.write(`[goal-tick] finalizeGoal: gh pr create failed: ${created.error}\n`)
    } else {
      goal.goalPrUrl = created.value
    }
  }

  finishState(goal)
}

function finishState(goal: GoalCtx): void {
  goal.state = "done"
  goal.completedAt = nowIso()
}
