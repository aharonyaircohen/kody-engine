/**
 * Preflight (runWhen state==="active"): pull a fresh snapshot of the
 * goal's world from GitHub — child task issues + open PRs stacked
 * against them — and classify the phase via `derivePhase`.
 *
 * Stacked-PR model: PR state is observed directly (open + draft = in
 * flight, open + ready = done waiting for finalize); no kody-managed
 * sync labels. The leaf PR — topmost in the base-chain — is cached on
 * `ctx.data.goal.leafPr` so `dispatchNextTask` can use it as the next
 * task's base and `finalizeGoal` knows what to merge.
 *
 * Downstream scripts (finalizeGoal, dispatchNextTask) gate on
 * `data.goal.phase` via runWhen — this is the ONE script in the chain
 * that decides what the next action should be.
 */

import type { PreflightScript } from "../executables/types.js"
import {
  extractClosesIssues,
  listGoalIssues,
  listOpenPrs,
  pairIssuesWithPrs,
  pickLeafPr,
  type OpenTaskPr,
} from "../goal/operations.js"
import { derivePhase } from "../goal/phase.js"
import type { GoalCtx } from "./goalCtx.js"

export const deriveGoalPhase: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  // goal.defaultBranch was set from ctx.config.git.defaultBranch by
  // loadGoalState — that's now the source of truth (goal-tick is no
  // longer configless, see entry.ts). The consumer's kody.config.json
  // wins over GitHub's repo default because repos may merge to a
  // non-default branch (e.g. main is release, `dev` is integration).

  const issues = listGoalIssues(goal.id, ctx.cwd)
  if (!issues.ok) {
    process.stderr.write(`[goal-tick] deriveGoalPhase: list issues failed: ${issues.error}\n`)
    goal.childTasks = []
    goal.openTaskPrs = []
    goal.phase = "idle"
    return
  }
  const rawIssues = issues.value ?? []

  const allPrs = listOpenPrs(ctx.cwd)
  if (!allPrs.ok) {
    process.stderr.write(`[goal-tick] deriveGoalPhase: list PRs failed: ${allPrs.error}\n`)
    goal.childTasks = rawIssues.map((i) => ({ ...i, prState: "absent" as const }))
    goal.openTaskPrs = []
    goal.phase = "idle"
    return
  }

  const taskPrs = filterGoalTaskPrs(allPrs.value ?? [], rawIssues.map((i) => i.number))
  goal.openTaskPrs = taskPrs
  goal.leafPr = pickLeafPr(taskPrs)

  goal.childTasks = pairIssuesWithPrs(rawIssues, taskPrs)
  goal.phase = derivePhase({
    lifecycleState: goal.state,
    childTasks: goal.childTasks,
  })
  process.stdout.write(
    `[goal-tick] phase=${goal.phase} goal=${goal.id} tasks=${rawIssues.length} stack=${taskPrs.length}` +
      (goal.leafPr ? ` leaf=#${goal.leafPr.number}` : "") +
      "\n",
  )
}

/**
 * From the repo-wide open PR list, keep only those that target a child
 * task of THIS goal — matched by "Closes #N" in the body or by the
 * head-ref convention `<issueNumber>-…` (kody branch naming).
 */
function filterGoalTaskPrs(prs: readonly OpenTaskPr[], taskIssueNumbers: readonly number[]): OpenTaskPr[] {
  const taskSet = new Set(taskIssueNumbers)
  return prs.filter((pr) => {
    for (const n of extractClosesIssues(pr.body)) {
      if (taskSet.has(n)) return true
    }
    const headMatch = pr.headRefName.match(/^(\d+)-/)
    if (headMatch) {
      const n = Number.parseInt(headMatch[1]!, 10)
      if (Number.isFinite(n) && taskSet.has(n)) return true
    }
    return false
  })
}
