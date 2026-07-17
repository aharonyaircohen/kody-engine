/**
 * Preflight: load goal state from the configured Kody state repo into
 * `ctx.data.goal` for goal-manager scripts.
 */

import type { KodyConfig } from "../config.js"
import { type GoalState } from "../goal/state.js"
import { fetchGoalStateAsync } from "../goal/stateStore.js"
import type { PreflightScript } from "../implementations/types.js"
import { resolveStateRepoConfig } from "../stateRepo.js"

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

async function fetchGoalStateWithRetry(config: KodyConfig, goalId: string, cwd: string): Promise<GoalState | null> {
  let state = await fetchGoalStateAsync(config, goalId, cwd)
  if (state) return state

  for (const delay of retryDelaysMs()) {
    await sleep(delay)
    state = await fetchGoalStateAsync(config, goalId, cwd)
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

  try {
    const state = await fetchGoalStateWithRetry(ctx.config, goalId, ctx.cwd)
    if (!state) {
      const stateTarget = resolveStateRepoConfig(ctx.config)
      process.stdout.write(
        `[goal-manager] no goal state for ${goalId} in ${stateTarget.repo}/${stateTarget.path}; nothing to tick\n`,
      )
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
