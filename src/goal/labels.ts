/**
 * Goal-flow label constants. Single source of truth for the label names
 * the tick emits and reads — used by every goal-flow script + the
 * dashboard's discovery logic.
 */

/** Per-goal label that tags every child task issue. Also on the umbrella. */
export function goalLabel(goalId: string): string {
  return `goal:${goalId}`
}

/** Set on a task issue once tick has dispatched `@kody` against it. */
export const DISPATCHED_LABEL = "goal-runner:dispatched"

/** Set on a task issue when its kody flow ended in failure. Blocks the tick. */
export const FAILED_LABEL = "goal-runner:failed"

/** Lifecycle label kody-tick stamps on the umbrella issue while building. */
export const UMBRELLA_BUILDING_LABEL = "kody:building"

export interface KodyLabelSpec {
  name: string
  color: string
  description: string
}

/** Labels the tick lazy-creates on the repo (--force, idempotent). */
export const TICK_LABELS: readonly KodyLabelSpec[] = [
  {
    name: DISPATCHED_LABEL,
    color: "ededed",
    description: "kody goal-runner: already dispatched this tick",
  },
  {
    name: FAILED_LABEL,
    color: "b60205",
    description: "kody goal-runner: task failed; needs human attention",
  },
]
