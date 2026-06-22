/**
 * Preflight: load `.kody/goals/instances/<goalId>/state.json` from `kody-state`
 * branch into `ctx.data.goal` for goal-manager scripts.
 */

import type { PreflightScript } from "../agent-actions/types.js"
import { type GoalState } from "../goal/state.js"
import { fetchGoalState } from "../goal/stateStore.js"

const DEFAULT_RETRY_DELAYS_MS = [250, 750, 1500, 2500]

function retryDelaysMs(): number[] {
  const raw = process.env.KODY_GOAL_STATE_RETRY_DELAYS_MS?.trim()
  if (!raw) return DEFAULT_RETRY_DELAYS_MS
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchGoalStateWithRetry(
  owner: string,
  repo: string,
  goalId: string,
  cwd: string,
): Promise<GoalState | null> {
  let state = fetchGoalState(owner, repo, goalId, cwd)
  if (state) return state

  for (const delay of retryDelaysMs()) {
    await sleep(delay)
    state = fetchGoalState(owner, repo, goalId, cwd)
    if (state) {
      process.stdout.write(`[goal-manager] loaded goal state for ${goalId} after retry\n`)
      return state
    }
  }

  return null
}

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
    const state = await fetchGoalStateWithRetry(owner, repo, goalId, ctx.cwd)
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
