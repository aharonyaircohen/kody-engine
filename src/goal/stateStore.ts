/**
 * Goal state persistence in the configured Kody state repo.
 *
 * Consumer repos no longer own a `.kody/goals` runtime tree. The canonical
 * file lives under:
 *
 *   <statePath>/todos/<id>.json
 */
import { listStateDirectory, readStateText, type StateRepoConfig, upsertStateText } from "../stateRepo.js"
import type { GoalState } from "./state.js"
import { isManagedTodoRaw, parseTodoGoalState, serializeTodoGoalState } from "./managedTodoState.js"

export function goalStatePath(goalId: string): string {
  return `todos/${goalId}.json`
}

/** Read and parse one goal state. Returns `null` when it does not exist. */
export function fetchGoalState(config: StateRepoConfig, goalId: string, cwd?: string): GoalState | null {
  const filePath = goalStatePath(goalId)
  const loaded = readStateText(config, cwd, filePath)
  if (!loaded) return null
  if (!isManagedTodoRaw(loaded.content)) return null
  return parseTodoGoalState(goalId, loaded.path, loaded.content)
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
