/**
 * Preflight (runWhen phase==="ready-to-dispatch"): pick the lowest-
 * numbered open task issue without an open PR and fire a fresh
 * `workflow_dispatch` run to process it (`classify` → build, stacked on the
 * leaf), then record it in `ctx.data.goal.lastDispatchedIssue`.
 *
 * Why workflow_dispatch (not an `@kody --base` comment, nor an in-process
 * build):
 *   - The old `@kody --base <leaf>` comment is bot-authored when Kody runs as
 *     a GitHub App, and the follow-up run silently ignores it — the goal
 *     stalls.
 *   - Building the task in-process here would work, but goal-tick runs inside
 *     the cron `goal-scheduler` (a fast, short-timeout shell), so a full build
 *     blows the tick budget.
 *   - `workflow_dispatch` isn't subject to the bot-comment gate, starts
 *     immediately, and runs the task in its OWN run — keeping the scheduler
 *     tick fast. autoDispatch maps the `issue_number`/`executable`/`base`
 *     inputs back to `classify --issue <n> --base <leaf>`.
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
import { dispatchTaskRun } from "../goal/operations.js"
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
  process.stdout.write(`[goal-tick] dispatching #${next.number} via workflow_dispatch (classify, --base ${base})\n`)

  const res = dispatchTaskRun(next.number, base, ctx.cwd)
  if (!res.ok) {
    process.stderr.write(`[goal-tick] dispatchNextTask: workflow_dispatch on #${next.number} failed: ${res.error}\n`)
    return
  }
  goal.lastDispatchedIssue = next.number
}
