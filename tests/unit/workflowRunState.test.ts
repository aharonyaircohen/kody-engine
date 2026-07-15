import { describe, expect, it } from "vitest"
import { normalizeWorkflowDefinition } from "../../src/workflowDefinitions.js"
import { parseWorkflowRunState, workflowRunStatePath } from "../../src/workflowRunState.js"

describe("workflow run state", () => {
  it("stores runs beside the current workflow definition", () => {
    expect(workflowRunStatePath("pilot-flow", "pilot-run-1")).toBe("workflows/pilot-flow/runs/pilot-run-1.json")
  })

  it("parses a durable workflow cursor without changing capability output", () => {
    expect(
      parseWorkflowRunState({
        status: "running",
        currentStepId: "review",
        completedStepIds: ["prepare"],
        transitionCounts: { "repair->review": 1 },
        facts: { releasePr: 42 },
        evidence: { releasePrExists: true },
        artifacts: [{ label: "Release PR", url: "https://github.com/o/r/pull/42" }],
      }),
    ).toEqual({
      status: "running",
      currentStepId: "review",
      completedStepIds: ["prepare"],
      transitionCounts: { "repair->review": 1 },
      facts: { releasePr: 42 },
      evidence: { releasePrExists: true },
      artifacts: [{ label: "Release PR", url: "https://github.com/o/r/pull/42" }],
    })
  })

  it("rejects corrupt workflow state", () => {
    expect(parseWorkflowRunState({ status: "unknown" })).toBeNull()
  })

  it("preserves the start cursor on current stored workflow definitions", () => {
    expect(
      normalizeWorkflowDefinition({
        version: 1,
        name: "Pilot",
        startAt: "verify",
        steps: [
          { id: "inspect", capability: "run" },
          { id: "verify", capability: "review" },
        ],
      })?.startAt,
    ).toBe("verify")
  })
})
