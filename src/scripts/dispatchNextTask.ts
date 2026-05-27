/**
 * Preflight (runWhen phase==="ready-to-dispatch"): pick the lowest-
 * numbered open task issue without an open PR and hand it to kody-cli via
 * `ctx.output.nextDispatch` so the task's pipeline (classify → build) runs
 * IN-PROCESS in this goal-tick run, and record it in
 * `ctx.data.goal.lastDispatchedIssue`.
 *
 * Why in-process instead of an `@kody --base <leaf>` comment: the comment is
 * bot-authored when Kody runs as a GitHub App, and the follow-up run silently
 * ignores it — so the task never starts and the goal stalls. goal-tick fires
 * one dispatchable task per tick, so building it inline keeps the same
 * one-task-at-a-time cadence (it just runs here instead of a separate run).
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
  process.stdout.write(`[goal-tick] dispatching #${next.number} in-process via classify (--base ${base})\n`)

  // Run the task's pipeline entry (classify, which chains to the build
  // in-process) against the task issue, stacking its PR on `base`.
  ctx.output.nextDispatch = {
    executable: "classify",
    cliArgs: { issue: next.number, base },
  }
  goal.lastDispatchedIssue = next.number
}
