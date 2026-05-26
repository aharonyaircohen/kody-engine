import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  probeActionsStatus,
  gitHubActionsDegraded,
  _resetGitHubHealthCache,
} from "../../src/github-health.js"

function statusResponse(components: Array<{ name: string; status: string }>) {
  return { ok: true, json: async () => ({ components }) } as unknown as Response
}

beforeEach(() => {
  _resetGitHubHealthCache()
})

describe("probeActionsStatus", () => {
  it("operational Actions → not degraded", async () => {
    const fetchImpl = vi.fn(async () => statusResponse([{ name: "Actions", status: "operational" }])) as unknown as typeof fetch
    expect(await probeActionsStatus(fetchImpl)).toEqual({ degraded: false, label: "operational" })
  })

  it("major_outage → degraded", async () => {
    const fetchImpl = vi.fn(async () => statusResponse([{ name: "Actions", status: "major_outage" }])) as unknown as typeof fetch
    const p = await probeActionsStatus(fetchImpl)
    expect(p.degraded).toBe(true)
    expect(p.label).toBe("major_outage")
  })

  it("fails open when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("net down")
    }) as unknown as typeof fetch
    expect((await probeActionsStatus(fetchImpl)).degraded).toBe(false)
  })

  it("fails open on non-200", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch
    expect((await probeActionsStatus(fetchImpl)).degraded).toBe(false)
  })

  it("caches a definite result (no re-fetch within TTL)", async () => {
    const fetchImpl = vi.fn(async () => statusResponse([{ name: "Actions", status: "operational" }])) as unknown as typeof fetch
    await probeActionsStatus(fetchImpl)
    await probeActionsStatus(fetchImpl)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

describe("gitHubActionsDegraded", () => {
  it("true when Actions is down", async () => {
    const fetchImpl = vi.fn(async () => statusResponse([{ name: "Actions", status: "partial_outage" }])) as unknown as typeof fetch
    expect(await gitHubActionsDegraded(fetchImpl)).toBe(true)
  })
})
