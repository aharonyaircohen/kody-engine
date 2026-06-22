/**
 * Goal state persistence in the configured Kody state repo.
 *
 * Consumer repos no longer own a `.kody/goals` runtime tree or a `kody-state`
 * branch. The canonical file lives under:
 *
 *   <statePath>/goals/instances/<id>/state.json
 */
import { readStateText, type StateRepoConfig, upsertStateText } from "../stateRepo.js"
import { type GoalState, parseGoalState, serializeGoalState } from "./state.js"

function statePath(goalId: string): string {
  return `goals/instances/${goalId}/state.json`
}

/** Read and parse one goal state. Returns `null` when it does not exist. */
export function fetchGoalState(config: StateRepoConfig, goalId: string, cwd?: string): GoalState | null {
  const filePath = statePath(goalId)
  const loaded = readStateText(config, cwd, filePath)
  if (!loaded) return null
  return parseGoalState(loaded.path, JSON.parse(loaded.content))
}

/** Write one goal state to the configured state repo. */
export function putGoalState(
  config: StateRepoConfig,
  goalId: string,
  state: GoalState,
  message = `chore(goals): update ${goalId}`,
  cwd?: string,
): void {
  upsertStateText(config, cwd, statePath(goalId), serializeGoalState(state), message)
}
