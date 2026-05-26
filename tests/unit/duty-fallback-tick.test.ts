import { describe, it, expect, vi } from "vitest"
import { runDutyFallbackTick } from "../../src/pool/duty-fallback-tick.js"

const logs: string[] = []
const log = (m: string) => logs.push(m)

describe("runDutyFallbackTick", () => {
  it("does nothing when GitHub Actions is healthy (defers to GitHub cron)", async () => {
    const claim = vi.fn()
    const out = await runDutyFallbackTick({
      isDegraded: async () => false,
      activeRepos: () => ["acme/widgets"],
      claim,
      log,
    })
    expect(out).toEqual({ ran: false, claimed: 0 })
    expect(claim).not.toHaveBeenCalled()
  })

  it("claims a scheduled runner for each active repo when GitHub is degraded", async () => {
    const claim = vi.fn(async () => ({ ok: true, machineId: "m-1" }))
    const out = await runDutyFallbackTick({
      isDegraded: async () => true,
      activeRepos: () => ["acme/widgets", "acme/gadgets"],
      claim,
      log,
      now: () => 999,
    })
    expect(out).toEqual({ ran: true, claimed: 2 })
    expect(claim).toHaveBeenCalledTimes(2)
    expect(claim).toHaveBeenCalledWith("acme", "widgets", {
      jobId: "sched-acme-widgets-999",
      repo: "acme/widgets",
      mode: "scheduled",
    })
  })

  it("ran=true but claimed=0 when degraded with no active pools", async () => {
    const claim = vi.fn()
    const out = await runDutyFallbackTick({
      isDegraded: async () => true,
      activeRepos: () => [],
      claim,
      log,
    })
    expect(out).toEqual({ ran: true, claimed: 0 })
    expect(claim).not.toHaveBeenCalled()
  })

  it("counts only successful claims and survives a per-repo error", async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, machineId: "m-1" })
      .mockResolvedValueOnce({ ok: false, reason: "empty pool" })
      .mockRejectedValueOnce(new Error("network"))
    const out = await runDutyFallbackTick({
      isDegraded: async () => true,
      activeRepos: () => ["a/one", "a/two", "a/three"],
      claim,
      log,
    })
    expect(out.ran).toBe(true)
    expect(out.claimed).toBe(1)
    expect(claim).toHaveBeenCalledTimes(3)
  })
})
