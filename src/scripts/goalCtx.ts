/** Shared shape of `ctx.data.goal` populated by loadGoalState and used by goal-manager scripts. */
import type { GoalLifecycleState, GoalState } from "../goal/state.js"

export interface GoalCtx {
  /** Goal id (`KODY_ARG_GOAL`). */
  id: string
  /** Lifecycle state from the managed goal state file. */
  state: GoalLifecycleState
  /** Default branch from kody.config.json. */
  defaultBranch: string
  /** Cached parsed state so managed goal scripts can preserve extra fields. */
  raw?: GoalState
}
