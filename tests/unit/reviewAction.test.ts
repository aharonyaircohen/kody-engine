import { describe, expect, it, vi } from "vitest"
import type { AgentResult } from "../../src/agent.js"
import type { Profile } from "../../src/executables/types.js"
import { postReviewResult } from "../../src/scripts/postReviewResult.js"

vi.mock("../../src/issue.js", async (orig) => {
  const actual = await orig<typeof import("../../src/issue.js")>()
  return { ...actual, postPrReviewComment: () => undefined }
})

function mkCtx(): Parameters<typeof postReviewResult>[0] {
  return {
    args: { pr: 123 },
    data: { commentTargetType: "pr", commentTargetNumber: 123 },
    output: { exitCode: 0 },
    config: { github: { owner: "o", repo: "r" }, git: { defaultBranch: "main" } } as never,
    cwd: process.cwd(),
    skipAgent: false,
  } as never
}

const profile = { name: "review" } as Profile

function okAgent(body: string): AgentResult {
  return { outcome: "completed", finalText: body, error: undefined, ndjsonPath: "" } as AgentResult
}

describe("postReviewResult: ctx.data.action emission", () => {
  it("emits REVIEW_PASS for a PASS verdict", async () => {
    const ctx = mkCtx()
    await postReviewResult(ctx, profile, okAgent("## Verdict: PASS\n\nLooks fine."))
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("REVIEW_PASS")
    expect((ctx.data.action as { payload: { verdict: string } }).payload.verdict).toBe("PASS")
  })

  it("emits REVIEW_CONCERNS for a CONCERNS verdict", async () => {
    const ctx = mkCtx()
    await postReviewResult(ctx, profile, okAgent("## Verdict: CONCERNS\n\nOne issue."))
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("REVIEW_CONCERNS")
  })

  it("emits REVIEW_FAIL for a FAIL verdict", async () => {
    const ctx = mkCtx()
    await postReviewResult(ctx, profile, okAgent("## Verdict: FAIL\n\nBroken."))
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("REVIEW_FAIL")
  })

  it("emits REVIEW_FAILED when the agent did not complete", async () => {
    const ctx = mkCtx()
    await postReviewResult(ctx, profile, { outcome: "failed", finalText: "", error: "boom", ndjsonPath: "" })
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("REVIEW_FAILED")
  })

  it("emits REVIEW_FAILED on empty review body", async () => {
    const ctx = mkCtx()
    await postReviewResult(ctx, profile, okAgent("   "))
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("REVIEW_FAILED")
  })

  it("exposes reviewBody on ctx.data for downstream consumers", async () => {
    const ctx = mkCtx()
    const body = "## Verdict: CONCERNS\n\nCache is per-request."
    await postReviewResult(ctx, profile, okAgent(body))
    expect(ctx.data.reviewBody).toBe(body)
  })
})
