/**
 * Goal-flow phase machine.
 *
 * Pure logic: given a snapshot of the goal's external world (state.json
 * + the list of goal-labelled issues), classify which phase the tick is
 * in. Drives `runWhen` gates on the preflight chain in `goal-tick`.
 *
 * No I/O. All inputs are passed in; this module is fully testable in
 * isolation.
 */

import type { GoalLifecycleState } from "./state.js"

/** Discrete phases the goal-tick can be in. Drives runWhen gates. */
export type GoalPhase =
  /** state.json missing → tick is a no-op. */
  | "missing"
  /** state.json says abandoned → run cleanup, then exit. */
  | "abandoned"
  /** state.json says closed or done → fully terminal, nothing to do. */
  | "terminal"
  /** Active, but no goal-labelled issues exist yet. */
  | "no-tasks"
  /** Active, every task is closed → finalize the goal PR. */
  | "all-done"
  /** Active, at least one task carries the failed label → block until cleared. */
  | "blocked-by-failure"
  /** Active, a previously dispatched task is still open → wait for it to merge. */
  | "in-flight"
  /** Active, has at least one open undispatched task → dispatch it. */
  | "ready-to-dispatch"
  /** Active, no candidate to dispatch (everything either done or filtered out). */
  | "idle"

/** Issue snapshot — the minimum shape derivePhase needs about each task. */
export interface GoalIssueSnapshot {
  number: number
  /** "OPEN" or "CLOSED" — uppercased to match GitHub's API. */
  state: "OPEN" | "CLOSED"
  labels: string[]
}

/** Snapshot fed to derivePhase. */
export interface GoalSnapshot {
  /** Lifecycle state from state.json, or `undefined` if the file is missing. */
  lifecycleState: GoalLifecycleState | undefined
  /**
   * Goal-labelled issues filtered to *child tasks only* — the umbrella
   * issue must be excluded by the caller (it shares the `goal:<id>`
   * label but isn't a child task).
   */
  childTasks: GoalIssueSnapshot[]
}

import { DISPATCHED_LABEL, FAILED_LABEL } from "./labels.js"

/**
 * Map a snapshot to the phase the goal is in. Pure function; the order
 * of checks matches tick.sh's original control flow exactly so the
 * migration preserves behavior.
 */
export function derivePhase(snap: GoalSnapshot): GoalPhase {
  if (snap.lifecycleState === undefined) return "missing"
  if (snap.lifecycleState === "abandoned") return "abandoned"
  if (snap.lifecycleState === "closed" || snap.lifecycleState === "done") return "terminal"

  // lifecycleState === "active"
  if (snap.childTasks.length === 0) return "no-tasks"
  const allClosed = snap.childTasks.every((t) => t.state === "CLOSED")
  if (allClosed) return "all-done"

  const anyFailed = snap.childTasks.some((t) => t.labels.includes(FAILED_LABEL))
  if (anyFailed) return "blocked-by-failure"

  const inFlight = snap.childTasks.some((t) => t.state === "OPEN" && t.labels.includes(DISPATCHED_LABEL))
  if (inFlight) return "in-flight"

  const dispatchable = snap.childTasks.some((t) => t.state === "OPEN" && !t.labels.includes(DISPATCHED_LABEL))
  if (dispatchable) return "ready-to-dispatch"

  return "idle"
}

/**
 * Pick the lowest-numbered open undispatched issue. Returns `undefined`
 * when none qualify (caller should treat that as `idle`).
 */
export function pickNextDispatchable(snap: GoalSnapshot): GoalIssueSnapshot | undefined {
  const candidates = snap.childTasks
    .filter((t) => t.state === "OPEN" && !t.labels.includes(DISPATCHED_LABEL))
    .sort((a, b) => a.number - b.number)
  return candidates[0]
}
