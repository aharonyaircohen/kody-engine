import { describe, expect, it } from "vitest"
import { cronMatchesAt, cronMatchesInWindow, parseCron } from "../../src/cron-match.js"

describe("cron-match: parseCron", () => {
  it("expands wildcard fields to the full range", () => {
    const e = parseCron("* * * * *")
    expect(e.minute.size).toBe(60)
    expect(e.hour.size).toBe(24)
    expect(e.dom.size).toBe(31)
    expect(e.month.size).toBe(12)
    expect(e.dow.size).toBe(7)
  })

  it("parses lists and ranges", () => {
    const e = parseCron("0,15,30,45 9-17 * * 1-5")
    expect([...e.minute]).toEqual([0, 15, 30, 45])
    expect([...e.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect([...e.dow]).toEqual([1, 2, 3, 4, 5])
  })

  it("parses steps", () => {
    const e = parseCron("*/5 * * * *")
    expect([...e.minute]).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
  })

  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * *")).toThrow()
    expect(() => parseCron("60 * * * *")).toThrow() // out of range
    expect(() => parseCron("* * * * 8")).toThrow() // dow > 6
  })
})

describe("cron-match: cronMatchesAt", () => {
  it("matches the exact firing minute (UTC)", () => {
    const expr = parseCron("0 2 * * *")
    expect(cronMatchesAt(expr, new Date("2025-04-27T02:00:00Z"))).toBe(true)
    expect(cronMatchesAt(expr, new Date("2025-04-27T02:01:00Z"))).toBe(false)
    expect(cronMatchesAt(expr, new Date("2025-04-27T03:00:00Z"))).toBe(false)
  })

  it("matches every-5-min wildcard", () => {
    const expr = parseCron("*/5 * * * *")
    expect(cronMatchesAt(expr, new Date("2025-04-27T08:00:00Z"))).toBe(true)
    expect(cronMatchesAt(expr, new Date("2025-04-27T08:05:00Z"))).toBe(true)
    expect(cronMatchesAt(expr, new Date("2025-04-27T08:03:00Z"))).toBe(false)
  })
})

describe("cron-match: cronMatchesInWindow", () => {
  it("absorbs wake drift within the window", () => {
    // Wake arrives at 02:04 — daily 02:00 cron should still fire because
    // the 4-minute drift is within the 5-minute window.
    expect(cronMatchesInWindow("0 2 * * *", new Date("2025-04-27T02:04:00Z"), 300)).toBe(true)
  })

  it("does not fire outside the window", () => {
    // Wake at 02:10 with 5-min window — 02:00 was 10 minutes ago, outside.
    expect(cronMatchesInWindow("0 2 * * *", new Date("2025-04-27T02:10:00Z"), 300)).toBe(false)
  })

  it("fires on every wake when cron is wildcard-minute", () => {
    expect(cronMatchesInWindow("*/5 * * * *", new Date("2025-04-27T08:05:00Z"), 300)).toBe(true)
    expect(cronMatchesInWindow("*/5 * * * *", new Date("2025-04-27T08:07:00Z"), 300)).toBe(true)
  })
})
