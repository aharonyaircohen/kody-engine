import { describe, expect, it } from "vitest"

import { GoalStateError, nowIso, parseGoalState, serializeGoalState } from "../../../src/goal/state.js"

describe("parseGoalState", () => {
  it("rejects non-objects", () => {
    expect(() => parseGoalState("/x", null)).toThrow(GoalStateError)
    expect(() => parseGoalState("/x", [])).toThrow(GoalStateError)
    expect(() => parseGoalState("/x", "string")).toThrow(GoalStateError)
  })

  it("rejects missing or invalid state field", () => {
    expect(() => parseGoalState("/x", {})).toThrow(/"state" is required/)
    expect(() => parseGoalState("/x", { state: "running" })).toThrow(/active.*abandoned.*closed.*done/)
    expect(() => parseGoalState("/x", { state: "paused" })).toThrow(/active.*abandoned.*closed.*done/)
  })

  it("accepts minimum valid object", () => {
    const s = parseGoalState("/x", { state: "active" })
    expect(s.state).toBe("active")
    expect(s.extra).toEqual({})
  })

  it("parses known timestamps and preserves unknown fields in extra", () => {
    const raw = {
      state: "done",
      legacyField: 41,
      updatedAt: "2026-05-10T12:00:00Z",
      createdAt: "2026-05-09T12:00:00Z",
      startedAt: "2026-05-09T12:00:00Z",
      destination: { outcome: "ship", evidence: ["published"] },
    }
    const s = parseGoalState("/x", raw)
    expect(s).toMatchObject({
      state: "done",
      updatedAt: "2026-05-10T12:00:00Z",
      createdAt: "2026-05-09T12:00:00Z",
      startedAt: "2026-05-09T12:00:00Z",
      extra: {
        legacyField: 41,
        destination: { outcome: "ship", evidence: ["published"] },
      },
    })
  })
})

describe("serializeGoalState", () => {
  it("round-trips state with unknown extra fields", () => {
    const serialized = serializeGoalState({
      state: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      extra: { type: "release", facts: { ok: true } },
    })

    expect(JSON.parse(serialized)).toEqual({
      type: "release",
      facts: { ok: true },
      state: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    })
  })
})

describe("nowIso", () => {
  it("emits valid ISO timestamp ending in Z", () => {
    const s = nowIso()
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(Number.isNaN(Date.parse(s))).toBe(false)
  })
})
