/**
 * Goal state persistence in the configured Kody state repo.
 *
 * Consumer repos no longer own a `.kody/goals` runtime tree. The canonical
 * file lives under:
 *
 *   <statePath>/todos/<id>.md
 */
import { listStateDirectory, readStateText, type StateRepoConfig, upsertStateText } from "../stateRepo.js"
import { isManagedTodoRaw, parseTodoGoalState, serializeTodoGoalState } from "./managedTodoState.js"
import { type GoalState, parseGoalState } from "./state.js"

export function goalStatePath(goalId: string): string {
  return `todos/${goalId}.md`
}

export function legacyGoalStatePath(goalId: string): string {
  return `goals/instances/${goalId}/state.json`
}

/** Read and parse one goal state. Returns `null` when it does not exist. */
export function fetchGoalState(config: StateRepoConfig, goalId: string, cwd?: string): GoalState | null {
  const filePath = goalStatePath(goalId)
  const loaded = readStateText(config, cwd, filePath)
  if (loaded) {
    if (!isManagedTodoRaw(loaded.content)) return null
    return parseTodoGoalState(goalId, loaded.path, loaded.content)
  }

  const legacyPath = legacyGoalStatePath(goalId)
  const legacy = readStateText(config, cwd, legacyPath)
  if (!legacy) return null
  return parseGoalState(legacy.path, JSON.parse(legacy.content))
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
  const todoFileIds = new Set<string>()
  for (const entry of listStateDirectory(config, cwd, "todos")) {
    if (entry.type !== "file" || !entry.name?.endsWith(".md")) continue
    const id = entry.name.slice(0, -3)
    todoFileIds.add(id)
    const loaded = readStateText(config, cwd, goalStatePath(id))
    if (loaded && isManagedTodoRaw(loaded.content)) ids.add(id)
  }
  for (const entry of listStateDirectory(config, cwd, "goals/instances")) {
    if (entry.type !== "dir" || !entry.name) continue
    if (todoFileIds.has(entry.name)) continue
    ids.add(entry.name)
  }
  return [...ids].sort()
}
