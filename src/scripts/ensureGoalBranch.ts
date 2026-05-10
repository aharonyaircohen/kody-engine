/**
 * Preflight (runWhen phase==="ready-to-dispatch"): ensure
 * `origin/goal-<id>` exists before dispatchNextTask comments `@kody`.
 * Lazy-creates the branch from `origin/<defaultBranch>`; idempotent
 * on existing branches.
 */

import type { PreflightScript } from "../executables/types.js"
import { createBranchFrom, fetchOrigin, remoteBranchExists } from "../goal/operations.js"
import type { GoalCtx } from "./goalCtx.js"

export const ensureGoalBranch: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  fetchOrigin(ctx.cwd)

  if (remoteBranchExists(goal.goalBranch, ctx.cwd)) {
    process.stdout.write(`[goal-tick] origin/${goal.goalBranch} already exists — leaving as-is\n`)
    return
  }
  if (!remoteBranchExists(goal.defaultBranch, ctx.cwd)) {
    process.stderr.write(`[goal-tick] cannot create goal branch: origin/${goal.defaultBranch} missing\n`)
    return
  }
  process.stdout.write(`[goal-tick] creating origin/${goal.goalBranch} from origin/${goal.defaultBranch}\n`)
  const r = createBranchFrom(goal.goalBranch, goal.defaultBranch, ctx.cwd)
  if (!r.ok) {
    process.stderr.write(
      `[goal-tick] push of ${goal.goalBranch} failed: ${r.error} — task dispatch will fall back to defaultBranch\n`,
    )
  }
}
