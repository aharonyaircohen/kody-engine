/**
 * Preflight (runWhen state==="active"): make sure the umbrella goal
 * issue exists, persisting its number into `ctx.data.goal.goalIssueNumber`.
 *
 * Lookup order (mirrors tick.sh):
 *   1. ctx.data.goal.goalIssueNumber — already known.
 *   2. Search GitHub for issue with goal label + canonical title.
 *   3. Create a fresh umbrella issue.
 */

import type { PreflightScript } from "../executables/types.js"
import { goalLabel, UMBRELLA_BUILDING_LABEL } from "../goal/labels.js"
import { createIssue, findUmbrellaByTitle } from "../goal/operations.js"
import type { GoalCtx } from "./goalCtx.js"

export const ensureUmbrellaIssue: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return
  if (goal.goalIssueNumber !== undefined) return

  const title = `goal: ${goal.id}`
  const body =
    `Umbrella issue for goal **${goal.id}**.\n\n` +
    `Closed automatically when the goal PR (\`${goal.goalBranch}\` → \`${goal.defaultBranch}\`) merges.\n`

  // Recovery: an umbrella may already exist from a prior run that lost state.
  const existing = findUmbrellaByTitle(goal.id, title, ctx.cwd)
  if (existing.ok && existing.value !== null && existing.value !== undefined) {
    process.stdout.write(`[goal-tick] adopted existing umbrella issue #${existing.value} for ${goal.id}\n`)
    goal.goalIssueNumber = existing.value
    return
  }

  // Create a new umbrella issue.
  const created = createIssue(
    {
      title,
      body,
      labels: [goalLabel(goal.id), UMBRELLA_BUILDING_LABEL],
    },
    ctx.cwd,
  )
  if (!created.ok) {
    process.stderr.write(
      `[goal-tick] ensureUmbrellaIssue: gh issue create failed: ${created.error} — continuing without umbrella issue\n`,
    )
    return
  }
  process.stdout.write(`[goal-tick] opened umbrella issue #${created.value} for ${goal.id}\n`)
  goal.goalIssueNumber = created.value
}
