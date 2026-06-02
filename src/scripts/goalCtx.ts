/**
 * Shared shape of `ctx.data.goal` populated by loadGoalState and
 * mutated by every other goal-tick script. Centralized so each script
 * imports the same type instead of re-declaring its slice.
 *
 * Stacked-PR model: dropped goalIssueNumber / goalPrUrl / completedAt /
 * goalBranch — none exist in this world. `leafPr` is the topmost open
 * task PR (or undefined when the stack is empty); subsequent dispatches
 * use `leafPr.headRefName` as the base.
 */

import type { OpenTaskPr } from "../goal/operations.js"
import type { GoalIssueSnapshot, GoalPhase } from "../goal/phase.js"
import type { GoalLifecycleState, GoalState } from "../goal/state.js"

export interface GoalCtx {
  /** Goal id (`KODY_ARG_GOAL`). */
  id: string
  /** Lifecycle state from state.json. Mutated by handleAbandonedGoal/finalizeGoal. */
  state: GoalLifecycleState
  /** Most recently dispatched task issue (audit; set by dispatchNextTask). */
  lastDispatchedIssue?: number
  /** Phase derived by deriveGoalPhase; runWhen-gated downstream scripts read this. */
  phase?: GoalPhase
  /** Child task issues with their PR state, populated by deriveGoalPhase. */
  childTasks?: GoalIssueSnapshot[]
  /** Open task PRs for this goal (input to leaf detection + finalize). */
  openTaskPrs?: OpenTaskPr[]
  /** Topmost open PR in the stack (undefined when stack is empty). */
  leafPr?: OpenTaskPr
  /** Default branch from kody.config.json — fallback base for the first task. */
  defaultBranch: string
  /** Cached parsed state.json so saveGoalState can preserve `extra` fields. */
  raw?: GoalState
}
