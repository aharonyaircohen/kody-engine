import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  GoalStateError,
  goalStatePath,
  nowIso,
  parseGoalState,
  readGoalState,
  serializeGoalState,
  writeGoalState,
} from "../../../src/goal/state.js"

describe("parseGoalState (stacked-PR)", () => {
  it("rejects non-objects", () => {
    expect(() => parseGoalState("/x", null)).toThrow(GoalStateError)
    expect(() => parseGoalState("/x", [])).toThrow(GoalStateError)
    expect(() => parseGoalState("/x", "string")).toThrow(GoalStateError)
  })

  it("rejects missing or invalid state field", () => {
    expect(() => parseGoalState("/x", {})).toThrow(/"state" is required/)
    expect(() => parseGoalState("/x", { state: "running" })).toThrow(/active.*abandoned.*closed.*done/)
  })

  it("accepts the minimum valid object", () => {
    const s = parseGoalState("/x", { state: "active" })
    expect(s.state).toBe("active")
    expect(s.extra).toEqual({})
    expect(s.lastDispatchedIssue).toBeUndefined()
  })

  it("parses every known field", () => {
    const raw = {
      state: "done",
      lastDispatchedIssue: 41,
      updatedAt: "2026-05-10T12:00:00Z",
      createdAt: "2026-05-09T12:00:00Z",
      startedAt: "2026-05-09T12:00:00Z",
    }
    const s = parseGoalState("/x", raw)
    expect(s).toMatchObject({
      state: "done",
      lastDispatchedIssue: 41,
      updatedAt: "2026-05-10T12:00:00Z",
      createdAt: "2026-05-09T12:00:00Z",
      startedAt: "2026-05-09T12:00:00Z",
    })
    expect(s.extra).toEqual({})
  })

  it("preserves unknown fields on extra (including legacy umbrella fields)", () => {
    const raw = {
      state: "active",
      title: "x",
      description: "y",
      version: 1,
      // Legacy umbrella-era fields — round-trip via extra so older repos
      // upgrade losslessly.
      goalIssueNumber: 42,
      goalPrUrl: "https://github.com/o/r/pull/100",
      completedAt: "2026-05-10T12:00:00Z",
    }
    const s = parseGoalState("/x", raw)
    expect(s.extra).toEqual({
      title: "x",
      description: "y",
      version: 1,
      goalIssueNumber: 42,
      goalPrUrl: "https://github.com/o/r/pull/100",
      completedAt: "2026-05-10T12:00:00Z",
    })
  })

  it("ignores invalid number/string fields without throwing", () => {
    const raw = {
      state: "active",
      lastDispatchedIssue: NaN,
      updatedAt: 5,
    }
    const s = parseGoalState("/x", raw)
    expect(s.lastDispatchedIssue).toBeUndefined()
    expect(s.updatedAt).toBeUndefined()
  })
})

describe("serializeGoalState", () => {
  it("round-trips through parseGoalState (incl. legacy extras)", () => {
    const raw = {
      state: "active",
      title: "extra",
      goalIssueNumber: 7, // legacy — kept via extra
    }
    const parsed = parseGoalState("/x", raw)
    const out = serializeGoalState(parsed)
    expect(JSON.parse(out)).toEqual(raw)
  })

  it("trailing newline matches engine convention", () => {
    const out = serializeGoalState({ state: "active", extra: {} })
    expect(out.endsWith("\n")).toBe(true)
  })
})

describe("readGoalState/writeGoalState (disk)", () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-state-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("throws GoalStateError when file missing", () => {
    expect(() => readGoalState(tmp, "g")).toThrow(/file not found/)
  })

  it("throws GoalStateError on malformed JSON", () => {
    const file = goalStatePath(tmp, "g")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "{not json", "utf-8")
    expect(() => readGoalState(tmp, "g")).toThrow(/invalid JSON/)
  })

  it("write then read round-trips (with extras)", () => {
    writeGoalState(tmp, "g", {
      state: "active",
      lastDispatchedIssue: 3,
      extra: { keep: "me" },
    })
    const round = readGoalState(tmp, "g")
    expect(round.state).toBe("active")
    expect(round.lastDispatchedIssue).toBe(3)
    expect(round.extra).toEqual({ keep: "me" })
  })
})

describe("nowIso", () => {
  it("emits a valid ISO timestamp ending in Z", () => {
    const s = nowIso()
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(Number.isNaN(Date.parse(s))).toBe(false)
  })
})
