import { describe, expect, it } from "vitest"
import {
  derivePhase,
  type GoalIssueSnapshot,
  type GoalSnapshot,
  pickNextDispatchable,
  type TaskPrState,
} from "../../../src/goal/phase.js"

function task(number: number, state: "OPEN" | "CLOSED", prState: TaskPrState = "absent"): GoalIssueSnapshot {
  return { number, state, prState }
}

function snap(lifecycleState: GoalSnapshot["lifecycleState"], ...childTasks: GoalIssueSnapshot[]): GoalSnapshot {
  return { lifecycleState, childTasks }
}

describe("derivePhase (stacked-PR)", () => {
  it("missing state.json → missing", () => {
    expect(derivePhase(snap(undefined))).toBe("missing")
  })

  it("abandoned state → abandoned", () => {
    expect(derivePhase(snap("abandoned"))).toBe("abandoned")
  })

  it("closed and done → terminal", () => {
    expect(derivePhase(snap("closed"))).toBe("terminal")
    expect(derivePhase(snap("done"))).toBe("terminal")
  })

  it("active with no tasks → idle", () => {
    expect(derivePhase(snap("active"))).toBe("idle")
  })

  it("active with a draft task PR → in-flight (preempts everything else)", () => {
    const s = snap("active", task(1, "OPEN", "draft"), task(2, "OPEN", "absent"))
    expect(derivePhase(s)).toBe("in-flight")
  })

  it("active, all open tasks have ready PRs → all-done (awaiting finalize)", () => {
    const s = snap("active", task(1, "OPEN", "ready"), task(2, "OPEN", "ready"))
    expect(derivePhase(s)).toBe("all-done")
  })

  it("active, every task CLOSED → all-done (no PRs needed)", () => {
    const s = snap("active", task(1, "CLOSED"), task(2, "CLOSED"))
    expect(derivePhase(s)).toBe("all-done")
  })

  it("active, mix of CLOSED + ready PRs → all-done", () => {
    const s = snap("active", task(1, "CLOSED"), task(2, "OPEN", "ready"))
    expect(derivePhase(s)).toBe("all-done")
  })

  it("active, an open task with no PR → ready-to-dispatch", () => {
    expect(derivePhase(snap("active", task(1, "OPEN", "absent")))).toBe("ready-to-dispatch")
    expect(derivePhase(snap("active", task(1, "OPEN", "ready"), task(2, "OPEN", "absent")))).toBe(
      "ready-to-dispatch",
    )
  })

  it("draft PR beats every other condition (no race with all-done)", () => {
    const s = snap("active", task(1, "OPEN", "ready"), task(2, "OPEN", "draft"))
    expect(derivePhase(s)).toBe("in-flight")
  })
})

describe("pickNextDispatchable", () => {
  it("returns undefined when nothing dispatchable", () => {
    expect(pickNextDispatchable(snap("active"))).toBeUndefined()
    expect(pickNextDispatchable(snap("active", task(1, "CLOSED")))).toBeUndefined()
    expect(pickNextDispatchable(snap("active", task(1, "OPEN", "draft")))).toBeUndefined()
    expect(pickNextDispatchable(snap("active", task(1, "OPEN", "ready")))).toBeUndefined()
  })

  it("picks lowest-numbered open task with no PR", () => {
    const s = snap(
      "active",
      task(5, "OPEN", "absent"),
      task(3, "OPEN", "absent"),
      task(7, "OPEN", "draft"),
      task(2, "CLOSED"),
    )
    expect(pickNextDispatchable(s)?.number).toBe(3)
  })
})
