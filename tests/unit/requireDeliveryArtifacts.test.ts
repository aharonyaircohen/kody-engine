import { describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"
import { requireDeliveryArtifacts } from "../../src/scripts/requireDeliveryArtifacts.js"

function makeCtx(data: Record<string, unknown>): Context {
  return {
    args: {},
    cwd: "/tmp/repo",
    config: {} as never,
    data,
    output: { exitCode: 0 },
  } as Context
}

const profile = { name: "opaque-pr-capability" } as Profile

describe("requireDeliveryArtifacts", () => {
  it("accepts complete commit and PR summary artifacts without requiring DONE", async () => {
    const ctx = makeCtx({
      agentDone: true,
      commitResult: { committed: true, pushed: true },
      commitMessage: "fix: preserve delivery",
      prSummary: "- Preserves the delivery.",
      agentFinalText: "COMMIT_MSG: fix: preserve delivery\nPR_SUMMARY:\n- Preserves the delivery.",
      action: { type: "OPAQUE_COMPLETED", payload: {}, timestamp: "2026-01-01T00:00:00.000Z" },
    })

    await requireDeliveryArtifacts(ctx, profile, null)

    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.agentResultIncomplete).toBeUndefined()
  })

  it("marks prose-only output incomplete and preserves the prose for a draft PR", async () => {
    const ctx = makeCtx({
      agentDone: true,
      commitResult: { committed: true, pushed: true },
      commitMessage: "",
      prSummary: "",
      agentFinalText: "All tests pass. Ready for review.",
      action: { type: "OPAQUE_COMPLETED", payload: {}, timestamp: "2026-01-01T00:00:00.000Z" },
    })

    await requireDeliveryArtifacts(ctx, profile, null)

    expect(ctx.data.agentDone).toBe(false)
    expect(ctx.data.agentResultIncomplete).toBe(true)
    expect(ctx.data.agentMissingArtifacts).toEqual(["COMMIT_MSG", "PR_SUMMARY"])
    expect(ctx.data.agentFallbackSummary).toBe("All tests pass. Ready for review.")
    expect(ctx.data.agentFailureReason).toMatch(/COMMIT_MSG, PR_SUMMARY/)
    expect(ctx.data.action).toMatchObject({
      type: "OPAQUE_FAILED",
      payload: { downgradedFrom: "OPAQUE_COMPLETED" },
    })
  })

  it("preserves a supplied PR summary when only the commit message is missing", async () => {
    const ctx = makeCtx({
      agentDone: true,
      commitResult: { committed: true, pushed: true },
      commitMessage: "",
      prSummary: "- Fixed the issue.",
      agentFinalText: "PR_SUMMARY:\n- Fixed the issue.",
      action: { type: "OPAQUE_COMPLETED", payload: {}, timestamp: "2026-01-01T00:00:00.000Z" },
    })

    await requireDeliveryArtifacts(ctx, profile, null)

    expect(ctx.data.agentDone).toBe(false)
    expect(ctx.data.agentMissingArtifacts).toEqual(["COMMIT_MSG"])
    expect(ctx.data.prSummary).toBe("- Fixed the issue.")
    expect(ctx.data.agentFallbackSummary).toBeUndefined()
  })
})
