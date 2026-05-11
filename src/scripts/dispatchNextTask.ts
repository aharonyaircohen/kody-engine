/**
 * Preflight (runWhen phase==="ready-to-dispatch"): pick the lowest-
 * numbered open task issue without an open PR, comment
 * `@kody --base <leaf>` on it, and record the dispatch in
 * `ctx.data.goal.lastDispatchedIssue`.
 *
 * Stacked-PR base selection:
 *   - First task (no leaf PR yet) → base = default branch (e.g. `main`).
 *   - Subsequent tasks → base = leaf PR's head ref, so each new task PR
 *     stacks on top of the previous one.
 *
 * No `goal-runner:dispatched` label anymore — `deriveGoalPhase` reads
 * "is dispatched?" directly from the issue having an open PR.
 */

import type { PreflightScript } from "../executables/types.js"
import { commentOnIssue } from "../goal/operations.js"
import { pickNextDispatchable } from "../goal/phase.js"
import type { GoalCtx } from "./goalCtx.js"

export const dispatchNextTask: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal?.childTasks) return

  const next = pickNextDispatchable({
    lifecycleState: goal.state,
    childTasks: goal.childTasks,
  })
  if (!next) {
    process.stdout.write("[goal-tick] no dispatchable task — idle\n")
    return
  }

  const base = goal.leafPr?.headRefName ?? goal.defaultBranch
  process.stdout.write(`[goal-tick] dispatching @kody on #${next.number} (--base ${base})\n`)

  const comment = commentOnIssue(next.number, `@kody --base ${base}`, ctx.cwd)
  if (!comment.ok) {
    process.stderr.write(`[goal-tick] dispatchNextTask: comment failed on #${next.number}: ${comment.error}\n`)
    return
  }

  goal.lastDispatchedIssue = next.number
}
