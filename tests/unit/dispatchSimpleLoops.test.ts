import { describe, expect, it } from "vitest"
import type { LoopDefinition } from "../../src/loopDefinitions.js"
import { dueSlot, loopDispatchSlot, selectRunnableLoops } from "../../src/scripts/dispatchSimpleLoops.js"

const loop: LoopDefinition = {
  id: "daily-check",
  enabled: true,
  trigger: { type: "schedule", every: "15m" },
  target: { kind: "workflow", id: "quality" },
  input: {},
}

describe("dueSlot", () => {
  it("creates one stable schedule slot", () => {
    expect(dueSlot(loop, new Date("2026-07-25T09:07:00.000Z"))).toBe("2026-07-25T09:00:00.000Z")
    expect(dueSlot(loop, new Date("2026-07-25T09:14:59.000Z"))).toBe("2026-07-25T09:00:00.000Z")
  })

  it("ignores disabled and non-scheduled Loops", () => {
    expect(dueSlot({ ...loop, enabled: false }, new Date())).toBeNull()
    expect(dueSlot({ ...loop, trigger: { type: "manual" } }, new Date())).toBeNull()
  })

  it("keeps preferred-time Loops due across the scheduler wake window", () => {
    const preferred: LoopDefinition = {
      ...loop,
      trigger: { type: "schedule", every: "1d", at: { time: "12:00", timezone: "Asia/Jerusalem" } },
    }
    expect(dueSlot(preferred, new Date("2026-07-25T09:03:00.000Z"))).toBe("2026-07-25T12:00[Asia/Jerusalem]")
    expect(dueSlot(preferred, new Date("2026-07-25T09:06:00.000Z"))).toBeNull()
  })
})

describe("loopDispatchSlot", () => {
  it("gives manual runs a unique slot without changing scheduled slots", () => {
    const now = new Date("2026-07-25T09:07:00.000Z")

    expect(loopDispatchSlot(loop, now, false, "ignored")).toBe("2026-07-25T09:00:00.000Z")
    expect(loopDispatchSlot(loop, now, true, "run-123")).toBe("manual:2026-07-25T09:07:00.000Z:run-123")
  })
})

describe("selectRunnableLoops", () => {
  it("forces only the requested Loop", () => {
    const other = { ...loop, id: "other" }

    expect(
      selectRunnableLoops([loop, other], new Date("2026-07-25T09:07:00.000Z"), { force: true, loopId: "daily-check" }),
    ).toEqual([loop])
  })

  it("does not silently run every Loop when a requested Loop is missing", () => {
    expect(
      selectRunnableLoops([loop], new Date("2026-07-25T09:07:00.000Z"), { force: true, loopId: "missing" }),
    ).toEqual([])
  })
})
