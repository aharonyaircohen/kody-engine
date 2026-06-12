import { describe, expect, it } from "vitest"
import { isScheduleEvery, scheduleEveryToMs } from "../../src/scripts/scheduleEvery.js"

describe("isScheduleEvery", () => {
  it("accepts every supported cadence including the manual sentinel", () => {
    for (const v of ["15m", "30m", "1h", "2h", "6h", "12h", "1d", "3d", "7d", "manual"]) {
      expect(isScheduleEvery(v)).toBe(true)
    }
  })

  it("rejects unsupported strings and non-strings", () => {
    expect(isScheduleEvery("5s")).toBe(false)
    expect(isScheduleEvery("")).toBe(false)
    expect(isScheduleEvery(60)).toBe(false)
    expect(isScheduleEvery(null)).toBe(false)
    expect(isScheduleEvery(undefined)).toBe(false)
  })
})

describe("scheduleEveryToMs", () => {
  it("converts each cadence to its millisecond span", () => {
    const MIN = 60_000
    expect(scheduleEveryToMs("15m")).toBe(15 * MIN)
    expect(scheduleEveryToMs("30m")).toBe(30 * MIN)
    expect(scheduleEveryToMs("1h")).toBe(60 * MIN)
    expect(scheduleEveryToMs("2h")).toBe(120 * MIN)
    expect(scheduleEveryToMs("6h")).toBe(360 * MIN)
    expect(scheduleEveryToMs("12h")).toBe(720 * MIN)
    expect(scheduleEveryToMs("1d")).toBe(1440 * MIN)
    expect(scheduleEveryToMs("3d")).toBe(3 * 1440 * MIN)
    expect(scheduleEveryToMs("7d")).toBe(7 * 1440 * MIN)
  })

  it("returns Infinity for the manual sentinel so it never appears due", () => {
    expect(scheduleEveryToMs("manual")).toBe(Number.POSITIVE_INFINITY)
  })
})
