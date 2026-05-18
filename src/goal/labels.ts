/**
 * Goal-flow label constants. Single source of truth for label names the
 * tick emits and reads — used by goal-flow scripts + dashboard discovery.
 *
 * Stacked-PR model: dropped the umbrella-era `goal-runner:dispatched`
 * and `goal-runner:failed` labels. Dispatched/failure state is now
 * derived directly from PR state on GitHub, not synced labels.
 */

/** Per-goal label that tags every child task issue. */
export function goalLabel(goalId: string): string {
  return `goal:${goalId}`
}

/**
 * Marks the goal-manager's QA-gate issue. An issue carrying BOTH
 * `goal:<id>` and this label is NOT a dispatchable task — goal-tick must
 * never `@kody` it — and while it is OPEN the goal can never reach
 * `all-done` (so finalize/deliverable-PR is blocked until the
 * goal-manager worker verifies the end-to-end journey and closes it).
 *
 * Constant (not per-goal): the `goal:<id>` label already scopes it to
 * one goal; this is just the "I am the gate, not a task" marker.
 */
export const QA_GATE_LABEL = "kody:qa-gate"
