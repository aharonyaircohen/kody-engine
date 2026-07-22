/**
 * Goal state persistence in the Kody backend.
 */

import { createStateBackendFromEnv, type GoalDocument } from "../state-backend.js"
import type { GoalState } from "./state.js"

interface GoalBackendConfig {
  github?: { owner?: string; repo?: string }
}

function backendTenant(config: GoalBackendConfig): string | null {
  const owner = config.github?.owner?.trim() || process.env.GITHUB_REPOSITORY?.split("/")[0]?.trim()
  const repo = config.github?.repo?.trim() || process.env.GITHUB_REPOSITORY?.split("/")[1]?.trim()
  return owner && repo ? `${owner}/${repo}` : null
}

function decodeGoal(doc: GoalDocument | null): GoalState | null {
  if (!doc?.state || typeof doc.state !== "object" || Array.isArray(doc.state)) return null
  const state = doc.state as GoalState
  if (typeof state.state !== "string" || !state.extra || typeof state.extra !== "object") return null
  return state
}

export async function fetchGoalStateAsync(
  config: GoalBackendConfig,
  goalId: string,
  _cwd?: string,
): Promise<GoalState | null> {
  const tenantId = backendTenant(config)
  if (!tenantId) throw new Error("Repository identity is required for goal state")
  return decodeGoal(await createStateBackendFromEnv().getGoal(tenantId, goalId))
}

export async function putGoalStateAsync(
  config: GoalBackendConfig,
  goalId: string,
  state: GoalState,
  _message = `chore(goals): update ${goalId}`,
  _cwd?: string,
): Promise<void> {
  const tenantId = backendTenant(config)
  if (!tenantId) throw new Error("Repository identity is required for goal state")
  const backend = createStateBackendFromEnv()
  const previous = await backend.getGoal(tenantId, goalId)
  await backend.saveGoal(tenantId, goalId, state, state.updatedAt ?? new Date().toISOString(), previous?.updatedAt)
}

export async function listGoalStateIdsAsync(config: GoalBackendConfig, _cwd?: string): Promise<string[]> {
  const tenantId = backendTenant(config)
  if (!tenantId) throw new Error("Repository identity is required for goal state")
  const docs = await createStateBackendFromEnv().listGoals(tenantId)
  return docs
    .map((doc) => doc.goalId)
    .filter(Boolean)
    .sort()
}
