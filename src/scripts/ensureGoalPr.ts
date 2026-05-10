/**
 * Preflight (runWhen state==="active"): open or adopt the draft goal
 * PR (`goal-<id>` → default-branch) so the dashboard has a single anchor
 * for the goal's branch + Vercel preview.
 *
 * Idempotent — early-returns if `ctx.data.goal.goalPrUrl` is set or a PR
 * already exists. Used twice in the chain (early + post-merge) per the
 * fix shipped in 0.4.26.
 */

import type { PreflightScript } from "../executables/types.js"
import { createPr, listPrsByHead, remoteBranchExists } from "../goal/operations.js"
import type { GoalCtx } from "./goalCtx.js"

export const ensureGoalPr: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return
  if (goal.goalPrUrl) return

  if (!remoteBranchExists(goal.goalBranch, ctx.cwd)) return

  // Recovery: PR may already exist from a prior tick that didn't persist.
  const existing = listPrsByHead(goal.goalBranch, "open", ctx.cwd)
  if (existing.ok && existing.value && existing.value.length > 0) {
    goal.goalPrUrl = existing.value[0]!.url
    return
  }

  const title = `goal: ${goal.id}`
  const body = goal.goalIssueNumber
    ? `Tracking integration PR for goal **${goal.id}**.\n\nChild task PRs merge into \`${goal.goalBranch}\`. This PR is held in **draft** until every task is complete, then promoted to ready-for-review by goal-tick.\n\nCloses #${goal.goalIssueNumber}\n`
    : `Tracking integration PR for goal **${goal.id}**.\n\nChild task PRs merge into \`${goal.goalBranch}\`. Held in **draft** until every task is complete.\n`

  const created = createPr(
    {
      head: goal.goalBranch,
      base: goal.defaultBranch,
      title,
      body,
      draft: true,
    },
    ctx.cwd,
  )
  if (!created.ok) {
    // Common cause: the goal branch has no commits ahead of base yet. Surface
    // the actual error so it's diagnosable; the next tick after a merge retries.
    process.stderr.write(
      `[goal-tick] ensureGoalPr: gh pr create failed: ${created.error} (continuing without goal PR)\n`,
    )
    return
  }
  process.stdout.write(`[goal-tick] opened draft goal PR ${created.value} for ${goal.id}\n`)
  goal.goalPrUrl = created.value
}
