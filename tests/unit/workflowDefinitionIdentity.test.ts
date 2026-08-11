import { describe, expect, it } from "vitest"
import type { CapabilityWorkflowConfig } from "../../src/capabilityFolders.js"
import { workflowDefinitionHash, workflowResumeBlocker } from "../../src/workflowDefinitionIdentity.js"

const workflow: CapabilityWorkflowConfig = {
  steps: [{ capability: "inspect" }, { capability: "repair" }],
}

describe("workflow definition identity", () => {
  it("produces the same hash when object keys are reordered", () => {
    expect(workflowDefinitionHash(workflow)).toBe(
      workflowDefinitionHash({
        steps: [{ capability: "inspect" }, { capability: "repair" }],
      }),
    )
  })

  it("allows a saved run to resume against the same definition", () => {
    expect(
      workflowResumeBlocker(
        {
          status: "running",
          completedStepIds: ["inspect"],
          transitionCounts: {},
          definitionHash: workflowDefinitionHash(workflow),
          facts: {},
          evidence: {},
          artifacts: [],
        },
        workflow,
      ),
    ).toBeNull()
  })

  it("blocks resume when the Workflow definition changed", () => {
    expect(
      workflowResumeBlocker(
        {
          status: "running",
          completedStepIds: ["inspect"],
          transitionCounts: {},
          definitionHash: workflowDefinitionHash(workflow),
          facts: {},
          evidence: {},
          artifacts: [],
        },
        { steps: [{ capability: "inspect" }, { capability: "publish" }] },
      ),
    ).toMatch(/definition changed/i)
  })

  it("allows legacy saved progress to finish its one-time migration", () => {
    expect(
      workflowResumeBlocker(
        {
          status: "running",
          completedStepIds: ["inspect"],
          transitionCounts: {},
          facts: {},
          evidence: {},
          artifacts: [],
        },
        workflow,
      ),
    ).toBeNull()
  })
})
