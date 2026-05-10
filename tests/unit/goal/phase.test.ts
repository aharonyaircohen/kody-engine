import { describe, expect, it } from "vitest"
import { DISPATCHED_LABEL, FAILED_LABEL } from "../../../src/goal/labels.js"
import {
  derivePhase,
  type GoalIssueSnapshot,
  type GoalSnapshot,
  pickNextDispatchable,
} from "../../../src/goal/phase.js"

function task(number: number, state: "OPEN" | "CLOSED", ...labels: string[]): GoalIssueSnapshot {
  return { number, state, labels }
}

function snap(lifecycleState: GoalSnapshot["lifecycleState"], ...childTasks: GoalIssueSnapshot[]): GoalSnapshot {
  return { lifecycleState, childTasks }
}

describe("derivePhase", () => {
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

  it("active with no tasks → no-tasks", () => {
    expect(derivePhase(snap("active"))).toBe("no-tasks")
  })

  it("active with all tasks closed → all-done", () => {
    const s = snap("active", task(1, "CLOSED"), task(2, "CLOSED"))
    expect(derivePhase(s)).toBe("all-done")
  })

  it("any failed label → blocked-by-failure (overrides in-flight)", () => {
    const s = snap("active", task(1, "OPEN", DISPATCHED_LABEL), task(2, "OPEN", FAILED_LABEL))
    expect(derivePhase(s)).toBe("blocked-by-failure")
  })

  it("dispatched label on an open task → in-flight", () => {
    const s = snap("active", task(1, "OPEN", DISPATCHED_LABEL), task(2, "OPEN"))
    expect(derivePhase(s)).toBe("in-flight")
  })

  it("dispatched on a closed task does NOT count as in-flight", () => {
    const s = snap("active", task(1, "CLOSED", DISPATCHED_LABEL), task(2, "OPEN"))
    expect(derivePhase(s)).toBe("ready-to-dispatch")
  })

  it("any open undispatched task → ready-to-dispatch", () => {
    expect(derivePhase(snap("active", task(1, "OPEN")))).toBe("ready-to-dispatch")
    expect(derivePhase(snap("active", task(1, "CLOSED"), task(2, "OPEN")))).toBe("ready-to-dispatch")
  })

  it("everything OPEN+dispatched → in-flight (no fall-through to idle)", () => {
    const s = snap("active", task(1, "OPEN", DISPATCHED_LABEL), task(2, "OPEN", DISPATCHED_LABEL))
    expect(derivePhase(s)).toBe("in-flight")
  })
})

describe("pickNextDispatchable", () => {
  it("returns undefined when nothing dispatchable", () => {
    expect(pickNextDispatchable(snap("active"))).toBeUndefined()
    expect(pickNextDispatchable(snap("active", task(1, "CLOSED")))).toBeUndefined()
    expect(pickNextDispatchable(snap("active", task(1, "OPEN", DISPATCHED_LABEL)))).toBeUndefined()
  })

  it("picks lowest-numbered open undispatched", () => {
    const s = snap("active", task(5, "OPEN"), task(3, "OPEN"), task(7, "OPEN", DISPATCHED_LABEL), task(2, "CLOSED"))
    const picked = pickNextDispatchable(s)
    expect(picked?.number).toBe(3)
  })
})
