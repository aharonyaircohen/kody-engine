import { describe, expect, it, vi } from "vitest"
import type { LoopDefinition } from "../../src/loopDefinitions.js"
import {
  assertLoopDispatchesSucceeded,
  dispatchLoopsWith,
  dueSlot,
  loopDispatchSlot,
  selectRunnableLoops,
} from "../../src/scripts/dispatchLoops.js"

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

  it("allows an enabled manual Loop only when it is explicitly forced", () => {
    const manual = { ...loop, trigger: { type: "manual" } as const }

    expect(selectRunnableLoops([manual], new Date(), { force: false })).toEqual([])
    expect(selectRunnableLoops([manual], new Date(), { force: true, loopId: manual.id })).toEqual([manual])
  })
})

describe("dispatchLoopsWith", () => {
  it("persists the Loop parent and links the target run to it", async () => {
    const createAgencyRun = vi.fn()
    const finishAgencyRun = vi.fn()
    const finishLoopDispatch = vi.fn()
    const run = vi.fn().mockResolvedValue({ exitCode: 0, reason: "workflow completed" })
    const backend = {
      reserveLoopDispatch: vi.fn().mockResolvedValue({ acquired: true }),
      finishLoopDispatch,
      createAgencyRun,
      finishAgencyRun,
    }

    const results = await dispatchLoopsWith({
      loops: [{ ...loop, trigger: { type: "schedule", every: "1d" } }],
      tenantId: "acme/widgets",
      backend,
      now: new Date("2026-07-29T08:00:00.000Z"),
      force: false,
      run,
      nonce: () => "stable",
    })

    expect(results).toEqual([{ loopId: "daily-check", status: "dispatched", reason: "workflow completed" }])
    const parentRunId = createAgencyRun.mock.calls[0]?.[3]?.id
    expect(run).toHaveBeenCalledWith({ workflow: "quality", cliArgs: {}, flavor: "scheduled" }, parentRunId)
    expect(createAgencyRun).toHaveBeenCalledWith(
      "acme/widgets",
      "loop",
      "daily-check",
      expect.objectContaining({
        id: parentRunId,
        status: "running",
        target: { kind: "workflow", id: "quality" },
      }),
      "2026-07-29T08:00:00.000Z",
    )
    expect(finishAgencyRun).toHaveBeenCalledWith(
      "acme/widgets",
      expect.objectContaining({
        id: parentRunId,
        status: "succeeded",
        output: { summary: "workflow completed" },
      }),
      expect.any(String),
    )
    expect(finishLoopDispatch).toHaveBeenCalledWith(
      "acme/widgets",
      "daily-check:2026-07-29T00:00:00.000Z",
      "reservation-stable",
      "dispatched",
      expect.any(String),
      parentRunId,
    )
  })

  it("records a failed Loop run when the target throws", async () => {
    const finishAgencyRun = vi.fn()
    const backend = {
      reserveLoopDispatch: vi.fn().mockResolvedValue({ acquired: true }),
      finishLoopDispatch: vi.fn(),
      createAgencyRun: vi.fn(),
      finishAgencyRun,
    }

    const results = await dispatchLoopsWith({
      loops: [loop],
      tenantId: "acme/widgets",
      backend,
      now: new Date("2026-07-29T08:07:00.000Z"),
      force: false,
      run: vi.fn().mockRejectedValue(new Error("target crashed")),
      nonce: () => "failed",
    })

    expect(results).toEqual([{ loopId: "daily-check", status: "failed", reason: "target crashed" }])
    expect(finishAgencyRun).toHaveBeenCalledWith(
      "acme/widgets",
      expect.objectContaining({ status: "failed", error: "target crashed" }),
      expect.any(String),
    )
    expect(backend.finishLoopDispatch).toHaveBeenCalledWith(
      "acme/widgets",
      "daily-check:2026-07-29T08:00:00.000Z",
      "reservation-failed",
      "failed",
      expect.any(String),
      expect.any(String),
    )
  })

  it("does not create a second Run when the schedule slot is already reserved", async () => {
    const backend = {
      reserveLoopDispatch: vi.fn().mockResolvedValue({ acquired: false, reason: "duplicate" }),
      finishLoopDispatch: vi.fn(),
      createAgencyRun: vi.fn(),
      finishAgencyRun: vi.fn(),
    }
    const run = vi.fn()

    const results = await dispatchLoopsWith({
      loops: [loop],
      tenantId: "acme/widgets",
      backend,
      now: new Date("2026-07-29T08:07:00.000Z"),
      force: false,
      run,
      nonce: () => "duplicate",
    })

    expect(results).toEqual([{ loopId: "daily-check", status: "skipped", reason: "duplicate" }])
    expect(run).not.toHaveBeenCalled()
    expect(backend.createAgencyRun).not.toHaveBeenCalled()
    expect(backend.finishAgencyRun).not.toHaveBeenCalled()
  })
})

describe("assertLoopDispatchesSucceeded", () => {
  it("fails the outer CI run when any Loop target failed", () => {
    expect(() =>
      assertLoopDispatchesSucceeded([
        { loopId: "daily-check", status: "failed", reason: "target missing" },
      ]),
    ).toThrow("Loop dispatch failed: daily-check: target missing")
  })

  it("allows dispatched and idempotently skipped Loops", () => {
    expect(() =>
      assertLoopDispatchesSucceeded([
        { loopId: "daily-check", status: "dispatched", reason: "completed" },
        { loopId: "other", status: "skipped", reason: "duplicate" },
      ]),
    ).not.toThrow()
  })
})
