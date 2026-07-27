import { describe, expect, it } from "vitest"
import { parseClaimRequest } from "../../src/servers/pool-serve.js"

describe("poolServe: parseClaimRequest", () => {
  it("accepts a canonical scheduled request", () => {
    const out = parseClaimRequest({
      jobId: "s1",
      repo: "acme/widgets",
      runRequest: {
        requestId: "s1",
        target: { type: "workflow", id: "scheduled-fanout" },
        intent: "tick",
        source: "schedule",
      },
    })
    expect("req" in out).toBe(true)
    if ("req" in out) {
      expect(out.req.runRequest).toMatchObject({
        target: { type: "workflow", id: "scheduled-fanout" },
        intent: "tick",
      })
      expect(out.req.issueNumber).toBeUndefined()
      expect(out.req.sessionId).toBeUndefined()
    }
  })

  it("accepts a canonical run request", () => {
    const out = parseClaimRequest({
      jobId: "s1",
      repo: "acme/widgets",
      runRequest: {
        requestId: "s1",
        target: { type: "goal", id: "weekly-docs" },
        intent: "manage",
        source: "dashboard",
      },
    })
    expect("req" in out).toBe(true)
    if ("req" in out) {
      expect(out.req.runRequest.target).toEqual({ type: "goal", id: "weekly-docs" })
    }
  })

  it("requires the canonical request instead of legacy issue fields", () => {
    const out = parseClaimRequest({ jobId: "s1", repo: "acme/widgets", mode: "issue" })
    expect("error" in out).toBe(true)
    if ("error" in out) expect(out.error).toMatch(/runRequest required/)
  })

  it("requires the canonical request instead of legacy interactive fields", () => {
    const out = parseClaimRequest({ jobId: "s1", repo: "acme/widgets", mode: "interactive" })
    expect("error" in out).toBe(true)
    if ("error" in out) expect(out.error).toMatch(/runRequest required/)
  })

  it("rejects a bad repo", () => {
    const out = parseClaimRequest({
      jobId: "s1",
      repo: "nope",
      runRequest: {
        requestId: "s1",
        target: { type: "workflow", id: "scheduled-fanout" },
        intent: "tick",
        source: "schedule",
      },
    })
    expect("error" in out).toBe(true)
  })
})
