/**
 * Preflight: load `.kody/goals/instances/<goalId>/state.json` from the `kody-state`
 * branch into `ctx.data.goal` for goal-manager scripts.
 */

import type { PreflightScript } from "../executables/types.js"
import { fetchGoalState } from "../goal/stateStore.js"

export const loadGoalState: PreflightScript = async (ctx) => {
  const goalId = ctx.args.goal
  if (typeof goalId !== "string" || goalId.length === 0) {
    ctx.skipAgent = true
    ctx.output.exitCode = 1
    ctx.output.reason = "missing --goal"
    return
  }

  if (goalId.includes("/") || goalId.includes("..")) {
    ctx.skipAgent = true
    ctx.output.exitCode = 1
    ctx.output.reason = "invalid goal id (no slashes or '..' allowed)"
    return
  }

  const owner = ctx.config.github?.owner
  const repo = ctx.config.github?.repo
  if (!owner || !repo) {
    ctx.skipAgent = true
    ctx.output.exitCode = 1
    ctx.output.reason = "missing github owner/repo in config"
    return
  }

  try {
    const state = fetchGoalState(owner, repo, goalId, ctx.cwd)
    if (!state) {
      process.stdout.write(`[goal-manager] no goal state for ${goalId} on ${owner}/${repo}; nothing to tick\n`)
      ctx.skipAgent = true
      ctx.output.exitCode = 0
      ctx.output.reason = "no goal state to tick"
      return
    }

    ctx.data.goal = {
      id: goalId,
      state: state.state,
      raw: state,
      defaultBranch: ctx.config.git.defaultBranch,
    }
  } catch (err) {
    process.stdout.write(`[goal-manager] ${err instanceof Error ? err.message : String(err)}\n`)
    ctx.skipAgent = true
    ctx.output.exitCode = 0
    ctx.output.reason = "no goal state to tick"
  }
}
