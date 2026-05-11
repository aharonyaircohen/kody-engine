/**
 * Preflight: load `.kody/goals/<goalId>/state.json` into `ctx.data.goal`.
 *
 * Required as the first preflight in goal-tick — every other script in
 * the chain reads `ctx.data.goal` (with fields gradually populated by
 * later scripts). On a missing or malformed file the script signals the
 * tick to skip the rest of the chain by setting `ctx.skipAgent` plus a
 * non-fatal exit reason; the next tick retries.
 */

import type { PreflightScript } from "../executables/types.js"
import { readGoalState } from "../goal/state.js"

export const loadGoalState: PreflightScript = async (ctx) => {
  const goalId = ctx.args.goal
  if (typeof goalId !== "string" || goalId.length === 0) {
    ctx.skipAgent = true
    ctx.output.exitCode = 1
    ctx.output.reason = "missing --goal"
    return
  }

  // Defensive against path traversal — same checks tick.sh did.
  if (goalId.includes("/") || goalId.includes("..")) {
    ctx.skipAgent = true
    ctx.output.exitCode = 1
    ctx.output.reason = "invalid goal id (no slashes or '..' allowed)"
    return
  }

  try {
    const state = readGoalState(ctx.cwd, goalId)
    ctx.data.goal = {
      id: goalId,
      state: state.state,
      lastDispatchedIssue: state.lastDispatchedIssue,
      // Cache the full parsed object so saveGoalState can preserve `extra`.
      raw: state,
      // `phase`, `childTasks`, `openTaskPrs`, `leafPr` are populated by
      // deriveGoalPhase later in the chain. Initialize to undefined so
      // runWhen on `data.goal.phase` can match correctly.
      phase: undefined,
      defaultBranch: ctx.config.git.defaultBranch,
    }
  } catch (err) {
    // No state file or parse error — emit a log line and let the tick
    // exit cleanly (skipAgent without a non-zero exit). Matches the
    // legacy "no state file at … — nothing to tick" behavior.
    process.stdout.write(`[goal-tick] ${err instanceof Error ? err.message : String(err)}\n`)
    ctx.skipAgent = true
    ctx.output.exitCode = 0
    ctx.output.reason = "no goal state to tick"
  }
}
