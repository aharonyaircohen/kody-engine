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
        input: { pr: 42 },
        definitionHash: "abc123",
        steps: {
          prepare: {
            input: { pr: 42 },
            output: { status: "pass", releasePr: 42 },
            status: "completed",
          },
        },
        evidence: { releasePrExists: true },
        artifacts: [{ label: "Release PR", url: "https://github.com/o/r/pull/42" }],
        usage: {
          version: 1,
          tokens: { input: 100, output: 20, cacheRead: 30, cacheCreate: 0, total: 150 },
          costUsd: 0.5,
          agentRuns: 1,
          turns: 4,
          byModel: {},
        },
      }),
    ).toEqual({
      status: "running",
      currentStepId: "review",
      completedStepIds: ["prepare"],
      transitionCounts: { "repair->review": 1 },
      facts: { releasePr: 42 },
      input: { pr: 42 },
      definitionHash: "abc123",
      steps: {
        prepare: {
          input: { pr: 42 },
          output: { status: "pass", releasePr: 42 },
          status: "completed",
        },
      },
      evidence: { releasePrExists: true },
      artifacts: [{ label: "Release PR", url: "https://github.com/o/r/pull/42" }],
      usage: {
        version: 1,
        tokens: { input: 100, output: 20, cacheRead: 30, cacheCreate: 0, total: 150 },
        costUsd: 0.5,
        agentRuns: 1,
        turns: 4,
        measurement: "reported",
        byModel: {},
      },
    })
  })

  it("rejects corrupt workflow state", () => {
    expect(parseWorkflowRunState({ status: "unknown" })).toBeNull()
  })

  it("drops corrupt usage without discarding a valid workflow cursor", () => {
    expect(
      parseWorkflowRunState({
        status: "running",
        completedStepIds: [],
        transitionCounts: {},
        facts: {},
        evidence: {},
        artifacts: [],
        usage: { version: 1, tokens: { input: -1 } },
      }),
    ).toEqual({
      status: "running",
      completedStepIds: [],
      transitionCounts: {},
      facts: {},
      evidence: {},
      artifacts: [],
    })
  })

  it("preserves the start cursor on current stored workflow definitions", () => {
    expect(
      normalizeWorkflowDefinition({
        version: 1,
        name: "Pilot",
        startAt: "verify",
        steps: [{ id: "verify", capability: "review" }],
      })?.startAt,
    ).toBe("verify")
  })
})
