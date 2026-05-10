/**
 * Shared shape of `ctx.data.goal` populated by loadGoalState and
 * mutated by every other goal-tick script. Centralized so each script
 * imports the same type instead of re-declaring its slice.
 */

import type { GoalIssueSnapshot, GoalPhase } from "../goal/phase.js"
import type { GoalLifecycleState, GoalState } from "../goal/state.js"

export interface GoalCtx {
  /** Goal id (`KODY_ARG_GOAL`). */
  id: string
  /** Lifecycle state from state.json. Mutated by handleAbandonedGoal/finalizeGoal. */
  state: GoalLifecycleState
  /** Umbrella issue number (set by ensureUmbrellaIssue). */
  goalIssueNumber?: number
  /** Most recently dispatched task issue (set by dispatchNextTask). */
  lastDispatchedIssue?: number
  /** URL of the goal-<id> → default-branch PR (set by ensureGoalPr / finalizeGoal). */
  goalPrUrl?: string
  /** Completed-at timestamp set by finalizeGoal. */
  completedAt?: string
  /** Phase derived by deriveGoalPhase; runWhen-gated downstream scripts read this. */
  phase?: GoalPhase
  /**
   * Cached child task issues, populated by deriveGoalPhase. Excludes the
   * umbrella issue. Downstream scripts (dispatch, finalize) read it
   * without re-listing.
   */
  childTasks?: GoalIssueSnapshot[]
  /** Default branch from kody.config.json. */
  defaultBranch: string
  /** Conventional goal branch name `goal-<id>`. */
  goalBranch: string
  /** Cached parsed state.json so saveGoalState can preserve `extra` fields. */
  raw?: GoalState
}
