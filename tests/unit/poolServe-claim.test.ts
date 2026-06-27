import { describe, expect, it } from "vitest"
import { parseClaimRequest } from "../../src/servers/pool-serve.js"

describe("poolServe: parseClaimRequest", () => {
  it("accepts scheduled mode with no issueNumber/sessionId", () => {
    const out = parseClaimRequest({ jobId: "s1", repo: "acme/widgets", mode: "scheduled" })
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

  it("still requires issueNumber for issue mode", () => {
    const out = parseClaimRequest({ jobId: "s1", repo: "acme/widgets", mode: "issue" })
    expect("error" in out).toBe(true)
    if ("error" in out) expect(out.error).toMatch(/issueNumber/)
  })

  it("still requires sessionId for interactive mode", () => {
    const out = parseClaimRequest({ jobId: "s1", repo: "acme/widgets", mode: "interactive" })
    expect("error" in out).toBe(true)
    if ("error" in out) expect(out.error).toMatch(/sessionId/)
  })

  it("rejects a bad repo", () => {
    const out = parseClaimRequest({ jobId: "s1", repo: "nope", mode: "scheduled" })
    expect("error" in out).toBe(true)
  })
})
