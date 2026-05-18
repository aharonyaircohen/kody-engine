/**
 * Goal-flow phase machine for the **stacked-PR** model.
 *
 * Pure logic: given the goal's lifecycle state + each child task's
 * issue/PR state, classify the tick's next action. No I/O — everything
 * is passed in so the module is fully testable.
 *
 * Replaces the umbrella-era machine that read `goal-runner:dispatched`
 * and `goal-runner:failed` labels. In the stacked model, "is a task in
 * flight?" = "does its open PR exist as draft?", and "is a task done?" =
 * "does its open PR exist as ready (non-draft)?" — both observable
 * directly from GitHub without any kody-managed sync labels.
 *
 * Merged/closed PR states aren't modelled — intermediate stacked PRs
 * stay open throughout the goal; they only close transiently when the
 * leaf PR merges at finalize (cascade close). The next tick after
 * finalize observes `state="done"` and exits via `terminal`.
 */

import type { GoalLifecycleState } from "./state.js"

/** Discrete phases the tick can be in. Drives runWhen gates. */
export type GoalPhase =
  /** state.json missing — tick is a no-op. */
  | "missing"
  /** state="abandoned" — run cleanup, transition to "closed". */
  | "abandoned"
  /** state="closed" or "done" — fully terminal, no-op. */
  | "terminal"
  /**
   * state="awaiting-merge" — every task done, cumulative diff NOT
   * merged. No-op for the tick: nothing is gated on this phase, so
   * finalize/dispatch both skip. Only the dashboard "Merge goal"
   * button advances it (→ active + mergeApproved).
   */
  | "awaiting-merge"
  /** Active, no work to do (no open issues). */
  | "idle"
  /** Active, leaf task PR is still draft (kody is working) — wait. */
  | "in-flight"
  /** Active, at least one open task has no open PR yet — dispatch it. */
  | "ready-to-dispatch"
  /** Active, every open task has a ready PR (or is closed) — finalize. */
  | "all-done"

/** Per-issue PR observation. */
export type TaskPrState =
  /** No open PR found for this issue. */
  | "absent"
  /** Open PR, draft — kody still working. */
  | "draft"
  /** Open PR, non-draft — work complete, awaiting goal finalize. */
  | "ready"

/** Issue + its PR state — minimal shape phase logic needs. */
export interface GoalIssueSnapshot {
  number: number
  state: "OPEN" | "CLOSED"
  prState: TaskPrState
}

export interface GoalSnapshot {
  /** Lifecycle state from state.json, or undefined if file missing. */
  lifecycleState: GoalLifecycleState | undefined
  /** Child task issues with their PR states. */
  childTasks: GoalIssueSnapshot[]
}

/**
 * Map a snapshot to the phase. Pure function. Order of checks matters —
 * earlier branches take precedence (e.g. abandoned overrides all others).
 */
export function derivePhase(snap: GoalSnapshot): GoalPhase {
  if (!snap.lifecycleState) return "missing"
  if (snap.lifecycleState === "abandoned") return "abandoned"
  if (snap.lifecycleState === "closed" || snap.lifecycleState === "done") return "terminal"
  if (snap.lifecycleState === "awaiting-merge") return "awaiting-merge"

  // lifecycleState === "active" from here on.
  const hasInFlight = snap.childTasks.some((t) => t.state === "OPEN" && t.prState === "draft")
  if (hasInFlight) return "in-flight"

  if (snap.childTasks.length === 0) return "idle"

  const allDone = snap.childTasks.every((t) => t.state === "CLOSED" || t.prState === "ready")
  if (allDone) return "all-done"

  const dispatchable = snap.childTasks.some((t) => t.state === "OPEN" && t.prState === "absent")
  if (dispatchable) return "ready-to-dispatch"

  return "idle"
}

/**
 * Pick the lowest-numbered open task without an open PR. Returns
 * undefined when none qualify (caller should treat that as `idle`).
 */
export function pickNextDispatchable(snap: GoalSnapshot): GoalIssueSnapshot | undefined {
  return snap.childTasks
    .filter((t) => t.state === "OPEN" && t.prState === "absent")
    .sort((a, b) => a.number - b.number)[0]
}
