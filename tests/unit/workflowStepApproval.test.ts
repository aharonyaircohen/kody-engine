import { describe, expect, it } from "vitest"
import {
  approveWorkflowStep,
  requireWorkflowStepApproval,
} from "../../src/workflowStepApproval.js"

const state = {
  status: "running" as const,
  input: { postPath: "content-studio/post.md" },
  definitionHash: "sha256:definition",
  currentStepId: "publish",
  completedStepIds: ["validate"],
  transitionCounts: {},
  facts: { sourceSha: "abc123", previewHash: "preview-1" },
  evidence: {},
  artifacts: [],
}

describe("Workflow step approval", () => {
  it("pauses before the exact step and produces a stable context hash", () => {
    const paused = requireWorkflowStepApproval(state, "publish")
    expect(paused.status).toBe("waiting-approval")
    expect(paused.approval).toMatchObject({
      stepId: "publish",
      action: "workflow-step:publish",
      status: "pending",
    })
    expect(requireWorkflowStepApproval(state, "publish").approval.contextHash).toBe(
      paused.approval.contextHash,
    )
  })

  it("executes only once after the matching approval is marked approved", () => {
    const paused = requireWorkflowStepApproval(state, "publish")
    const approved = approveWorkflowStep(paused, {
      stepId: "publish",
      contextHash: paused.approval.contextHash,
      approvedAt: "2026-08-31T12:00:00.000Z",
      approvedBy: "github:123",
    })
    expect(requireWorkflowStepApproval(approved, "publish").status).toBe("running")
    expect(() =>
      approveWorkflowStep(paused, {
        stepId: "publish",
        contextHash: "wrong",
        approvedAt: "2026-08-31T12:00:00.000Z",
        approvedBy: "github:123",
      }),
    ).toThrow(/approval context changed/i)
  })
})
