/**
 * Goal state persistence in the configured Kody state repo.
 *
 * Consumer repos no longer own a `.kody/goals` runtime tree. The canonical
 * file lives under:
 *
 *   <statePath>/todos/<id>.json
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { getCompanyStoreAssetRoot } from "../companyStore.js"
import { listStateDirectory, readStateText, type StateRepoConfig, upsertStateText } from "../stateRepo.js"
import { createStateBackendFromEnv, type GoalDocument } from "../state-backend.js"
import { isManagedTodoRaw, parseTodoGoalState, serializeTodoGoalState } from "./managedTodoState.js"
import type { GoalState } from "./state.js"

export function goalStatePath(goalId: string): string {
  return `todos/${goalId}.json`
}

/** Read and parse one goal state. Returns `null` when it does not exist. */
function fetchGoalStateLegacy(config: StateRepoConfig, goalId: string, cwd?: string): GoalState | null {
  const filePath = goalStatePath(goalId)
  const loaded = readStateText(config, cwd, filePath)
  if (!loaded) return null
  if (!isManagedTodoRaw(loaded.content)) return null
  return resolveStoreBackedGoalState(parseTodoGoalState(goalId, loaded.path, loaded.content))
}

function resolveStoreBackedGoalState(state: GoalState): GoalState {
  const templateId = templateIdFromGoalState(state)
  if (!templateId) return state

  const template = readStoreGoalTemplate(templateId)
  if (!template) return state

  const nextExtra = { ...state.extra }
  for (const key of [
    "type",
    "destination",
    "capabilities",
    "route",
    "schedule",
    "scheduleMode",
    "loopTarget",
    "preferredRunTime",
    "saveReport",
  ]) {
    if (Object.hasOwn(template, key)) nextExtra[key] = template[key]
    else if (["schedule", "loopTarget", "preferredRunTime", "saveReport"].includes(key)) delete nextExtra[key]
  }
  nextExtra.facts = {
    ...(recordField(template.facts) ?? {}),
    ...(recordField(state.extra.facts) ?? {}),
  }
  return { ...state, extra: nextExtra }
}

function templateIdFromGoalState(state: GoalState): string {
  for (const key of ["sourceTemplate", "templateId", "template"]) {
    const value = state.extra[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function readStoreGoalTemplate(templateId: string): Record<string, unknown> | null {
  const root = getCompanyStoreAssetRoot("goals")
  if (!root) return null
  const file = path.join(root, "templates", templateId, "state.json")
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
    return recordField(parsed)
  } catch {
    return null
  }
}

function recordField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Write one goal state to the configured state repo. */
function putGoalStateLegacy(
  config: StateRepoConfig,
  goalId: string,
  state: GoalState,
  message = `chore(goals): update ${goalId}`,
  cwd?: string,
): void {
  const previous = readStateText(config, cwd, goalStatePath(goalId))
  if (previous && !isManagedTodoRaw(previous.content)) {
    throw new Error(`Cannot overwrite regular todo list ${goalId} as managed goal`)
  }
  upsertStateText(config, cwd, goalStatePath(goalId), serializeTodoGoalState(goalId, state, previous?.content), message)
}

function listGoalStateIdsLegacy(config: StateRepoConfig, cwd?: string): string[] {
  const ids = new Set<string>()
  const todoEntries = listStateDirectory(config, cwd, "todos")
  for (const entry of todoEntries) {
    if (entry.type !== "file" || !entry.name?.endsWith(".json")) continue
    const id = entry.name.slice(0, -5)
    const loaded = readStateText(config, cwd, goalStatePath(id))
    if (loaded && isManagedTodoRaw(loaded.content)) ids.add(id)
  }
  return [...ids].sort()
}

function backendTenant(config: StateRepoConfig): string | null {
  const owner = config.github?.owner?.trim() || process.env.GITHUB_REPOSITORY?.split("/")[0]?.trim()
  const repo = config.github?.repo?.trim() || process.env.GITHUB_REPOSITORY?.split("/")[1]?.trim()
  return owner && repo ? `${owner}/${repo}` : null
}

function backendEnabled(config: StateRepoConfig): boolean {
  return Boolean(process.env.CONVEX_URL?.trim() && process.env.KODY_SERVICE_KEY?.trim() && backendTenant(config))
}

function backendRequired(): boolean {
  return process.env.GITHUB_ACTIONS === "true"
}

function decodeGoal(doc: GoalDocument | null): GoalState | null {
  if (!doc || !doc.state || typeof doc.state !== "object" || Array.isArray(doc.state)) return null
  const state = doc.state as GoalState
  if (typeof state.state !== "string" || !state.extra || typeof state.extra !== "object") return null
  return resolveStoreBackedGoalState(state)
}

export async function fetchGoalStateAsync(config: StateRepoConfig, goalId: string, cwd?: string): Promise<GoalState | null> {
  const tenantId = backendTenant(config)
  if (backendEnabled(config) && tenantId) {
    const fromBackend = decodeGoal(await createStateBackendFromEnv().getGoal(tenantId, goalId))
    if (fromBackend) return fromBackend
    // Scheduler-spawned loop instances are still written to the state repo
    // (todos/<id>.json) before any Convex doc exists — fall back so the first
    // tick can run; the tick's own write then creates the Convex doc.
    return fetchGoalStateLegacy(config, goalId, cwd)
  }
  if (backendRequired()) throw new Error("Convex backend is required for goal state in GitHub Actions")
  return fetchGoalStateLegacy(config, goalId, cwd)
}

export async function putGoalStateAsync(
  config: StateRepoConfig,
  goalId: string,
  state: GoalState,
  message = `chore(goals): update ${goalId}`,
  cwd?: string,
): Promise<void> {
  const tenantId = backendTenant(config)
  if (backendEnabled(config) && tenantId) {
    const backend = createStateBackendFromEnv()
    const previous = await backend.getGoal(tenantId, goalId)
    await backend.saveGoal(tenantId, goalId, state, state.updatedAt ?? new Date().toISOString(), previous?.updatedAt)
    return
  }
  if (backendRequired()) throw new Error("Convex backend is required for goal state in GitHub Actions")
  putGoalStateLegacy(config, goalId, state, message, cwd)
}

export async function listGoalStateIdsAsync(config: StateRepoConfig, cwd?: string): Promise<string[]> {
  const tenantId = backendTenant(config)
  if (backendEnabled(config) && tenantId) {
    const docs = await createStateBackendFromEnv().listGoals(tenantId)
    return docs.map((doc) => doc.goalId).filter(Boolean).sort()
  }
  if (backendRequired()) throw new Error("Convex backend is required for goal state in GitHub Actions")
  return listGoalStateIdsLegacy(config, cwd)
}

// Synchronous compatibility API for local callers and existing tests. Runtime
// workflows should use the async backend-first variants above.
export function fetchGoalState(config: StateRepoConfig, goalId: string, cwd?: string): GoalState | null {
  return fetchGoalStateLegacy(config, goalId, cwd)
}
export function putGoalState(
  config: StateRepoConfig,
  goalId: string,
  state: GoalState,
  message = `chore(goals): update ${goalId}`,
  cwd?: string,
): void {
  putGoalStateLegacy(config, goalId, state, message, cwd)
}
export function listGoalStateIds(config: StateRepoConfig, cwd?: string): string[] {
  return listGoalStateIdsLegacy(config, cwd)
}
