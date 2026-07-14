import { describe, expect, it, vi } from "vitest"
import { runAgencyLoopTick } from "../../src/pool/agency-loop-tick.js"

describe("runAgencyLoopTick", () => {
  it("discovers repositories on every tick and dispatches scheduled fan-out", async () => {
    const claim = vi.fn(async () => ({ ok: true, machineId: "m-1" }))
    const discover = vi.fn(async () => ["acme/widgets", "acme/gadgets"])

    const result = await runAgencyLoopTick({ discover, claim, log: vi.fn(), now: () => 999 })

    expect(result).toEqual({ discovered: 2, claimed: 2 })
    expect(discover).toHaveBeenCalledTimes(1)
    expect(claim).toHaveBeenCalledWith("acme", "widgets", {
      jobId: "sched-acme-widgets-999",
      repo: "acme/widgets",
      runRequest: {
        target: { type: "workflow", id: "scheduled-fanout" },
        intent: "tick",
        source: "schedule",
      },
    })
  })

  it("deduplicates repositories and isolates per-repo claim failures", async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, machineId: "m-1" })
      .mockRejectedValueOnce(new Error("network"))

    const result = await runAgencyLoopTick({
      discover: async () => ["Acme/Widgets", "acme/widgets", "other/api", "invalid"],
      claim,
      log: vi.fn(),
    })

    expect(result).toEqual({ discovered: 2, claimed: 1 })
    expect(claim).toHaveBeenCalledTimes(2)
  })

  it("does not require GitHub Actions to be degraded", async () => {
    const claim = vi.fn(async () => ({ ok: true, machineId: "m-1" }))

    await runAgencyLoopTick({ discover: async () => ["acme/widgets"], claim, log: vi.fn() })

    expect(claim).toHaveBeenCalledTimes(1)
  })

  it("returns cleanly when no consumer agencies are discovered", async () => {
    const claim = vi.fn()

    await expect(runAgencyLoopTick({ discover: async () => [], claim, log: vi.fn() })).resolves.toEqual({
      discovered: 0,
      claimed: 0,
    })
    expect(claim).not.toHaveBeenCalled()
  })

  it("does not count a runner refusal as a claimed Loop", async () => {
    const claim = vi.fn(async () => ({ ok: false, reason: "runner unavailable" }))

    await expect(runAgencyLoopTick({ discover: async () => ["acme/widgets"], claim, log: vi.fn() })).resolves.toEqual({
      discovered: 1,
      claimed: 0,
    })
  })
})
