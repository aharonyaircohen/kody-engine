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
  it("fails a workflow-owned PR delivery that produced no commit", async () => {
    const ctx = makeCtx({
      agentDone: true,
      jobDelivery: "pull-request",
      commitResult: { committed: false, pushed: false },
      hasCommitsAhead: true,
    })

    await requireDeliveryArtifacts(ctx, profile, null)

    expect(ctx.output.exitCode).toBe(4)
    expect(ctx.output.reason).toMatch(/produced no commit/i)
    expect(ctx.data.agentFailureReason).toMatch(/produced no commit/i)
  })

  it("accepts complete commit and PR summary artifacts without requiring DONE", async () => {
    const ctx = makeCtx({
      agentDone: true,
      commitResult: { committed: true, pushed: true },
      commitMessage: "fix: preserve delivery",
      prSummary: "- Preserves the delivery.",
      acceptanceEvidence: "- A1 → integration test passes",
      testEvidence: "- delivery preservation → commitAndPushGate.test.ts",
      agentFinalText: "COMMIT_MSG: fix: preserve delivery\nPR_SUMMARY:\n- Preserves the delivery.",
      action: { type: "OPAQUE_COMPLETED", payload: {}, timestamp: "2026-01-01T00:00:00.000Z" },
    })

    await requireDeliveryArtifacts(ctx, profile, null)

    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.agentResultIncomplete).toBeUndefined()
  })

  it("fills safe defaults for prose-only output and preserves the warning", async () => {
    const ctx = makeCtx({
      agentDone: true,
      commitResult: { committed: true, pushed: true },
      commitMessage: "",
      prSummary: "",
      agentFinalText: "All tests pass. Ready for review.",
      action: { type: "OPAQUE_COMPLETED", payload: {}, timestamp: "2026-01-01T00:00:00.000Z" },
    })

    await requireDeliveryArtifacts(ctx, profile, null)

    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.agentResultIncomplete).toBe(true)
    expect(ctx.data.agentMissingArtifacts).toEqual(["COMMIT_MSG", "PR_SUMMARY", "ACCEPTANCE_EVIDENCE", "TEST_EVIDENCE"])
    expect(ctx.data.agentFallbackSummary).toBe("All tests pass. Ready for review.")
    expect(ctx.data.agentFailureReason).toMatch(/COMMIT_MSG, PR_SUMMARY/)
    expect(ctx.data.action).toMatchObject({
      type: "OPAQUE_COMPLETED",
    })
    expect(ctx.data.commitMessage).toContain("chore: update task")
    expect(ctx.data.prSummary).toBe("All tests pass. Ready for review.")
  })

  it("preserves a supplied PR summary when only the commit message is missing", async () => {
    const ctx = makeCtx({
      agentDone: true,
      commitResult: { committed: true, pushed: true },
      commitMessage: "",
      prSummary: "- Fixed the issue.",
      acceptanceEvidence: "- A1 → focused test passes",
      testEvidence: "- fixed behavior → focused.test.ts",
      agentFinalText: "PR_SUMMARY:\n- Fixed the issue.",
      action: { type: "OPAQUE_COMPLETED", payload: {}, timestamp: "2026-01-01T00:00:00.000Z" },
    })

    await requireDeliveryArtifacts(ctx, profile, null)

    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.agentMissingArtifacts).toEqual(["COMMIT_MSG"])
    expect(ctx.data.prSummary).toBe("- Fixed the issue.")
    expect(ctx.data.agentFallbackSummary).toBeUndefined()
  })

  it("rejects delivery when an explicit acceptance item has no evidence entry", async () => {
    const ctx = makeCtx({
      agentDone: true,
      commitResult: { committed: true, pushed: true },
      commitMessage: "fix: isolate learners",
      prSummary: "- Isolates learner messages.",
      acceptanceCriteria: [{ id: "A1" }, { id: "A2" }],
      acceptanceEvidence: "- A1 → legacy upgrade test",
      testEvidence: "- learner isolation → isolation.test.ts",
      agentFinalText: "DONE",
    })

    await requireDeliveryArtifacts(ctx, profile, null)

    expect(ctx.data.agentMissingArtifacts).toContain("ACCEPTANCE_EVIDENCE[A2]")
    expect(ctx.data.agentFailureReason).toMatch(/ACCEPTANCE_EVIDENCE\[A2\]/)
  })
})
