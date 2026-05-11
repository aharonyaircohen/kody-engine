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
