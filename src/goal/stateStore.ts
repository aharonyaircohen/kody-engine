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
import { isManagedTodoRaw, parseTodoGoalState, serializeTodoGoalState } from "./managedTodoState.js"
import type { GoalState } from "./state.js"

export function goalStatePath(goalId: string): string {
  return `todos/${goalId}.json`
}

/** Read and parse one goal state. Returns `null` when it does not exist. */
export function fetchGoalState(config: StateRepoConfig, goalId: string, cwd?: string): GoalState | null {
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
export function putGoalState(
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

export function listGoalStateIds(config: StateRepoConfig, cwd?: string): string[] {
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
