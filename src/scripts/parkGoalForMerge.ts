/**
 * Preflight (runWhen phase==="all-done"): gate the cumulative-diff merge
 * behind an explicit user action instead of auto-merging.
 *
 * Why this exists:
 *   `finalizeGoal` used to fire automatically the moment every task was
 *   done — squash-merging the leaf into the default branch with no human
 *   in the loop. Product decision: a goal should finish with all tasks
 *   complete but NOTHING merged, and a dashboard "Merge goal" button does
 *   the merge on click.
 *
 * Mechanism (reuses the existing finalize flow verbatim):
 *   - This script runs immediately before `finalizeGoal`, on the same
 *     `phase==="all-done"` gate.
 *   - Not approved → set state="awaiting-merge" and neutralize the phase
 *     so `finalizeGoal` / `dispatchNextTask` both skip this tick. The
 *     scheduler ignores non-active states, so the goal now sits parked
 *     until the user clicks Merge. No PR is merged, no issue is closed.
 *   - Approved (`mergeApproved` set by the dashboard's merge endpoint
 *     alongside state="active") → consume the one-shot flag and leave the
 *     phase as "all-done" so the UNCHANGED `finalizeGoal` runs exactly as
 *     it always did (retarget leaf, squash-merge, close stack, →"done").
 *
 * The flag is consumed (set false) even though finalize then sets
 * state="done": a later manual re-run (Run button → state="active")
 * carries no approval, so it re-parks rather than silently auto-merging.
 */

import type { PreflightScript } from "../executables/types.js"
import type { GoalCtx } from "./goalCtx.js"

export const parkGoalForMerge: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  const approved = goal.raw?.mergeApproved === true

  if (approved) {
    process.stdout.write(`[goal-tick] goal ${goal.id}: merge approved — running finalize (one-shot)\n`)
    // Consume the one-shot so a future re-run can't auto-merge.
    if (goal.raw) goal.raw.mergeApproved = false
    // Leave goal.phase === "all-done" untouched: finalizeGoal runs next.
    return
  }

  process.stdout.write(`[goal-tick] all task(s) done — parking goal ${goal.id} for manual merge (no auto-merge)\n`)
  goal.state = "awaiting-merge"
  // Neutralize the phase so finalizeGoal (all-done) and dispatchNextTask
  // (ready-to-dispatch) both skip. saveGoalState persists the new state.
  goal.phase = "awaiting-merge"
}
