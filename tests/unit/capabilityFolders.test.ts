import { describe, expect, it } from "vitest"
import { parseCapabilityWorkflow } from "../../src/capabilityFolders.js"

describe("parseCapabilityWorkflow", () => {
  it("preserves documented camelCase graph ids and transition targets", () => {
    const workflow = parseCapabilityWorkflow({
      startAt: "healthCheck",
      steps: [
        { id: "healthCheck", capability: "dev-ci-health", next: "inspect" },
        {
          id: "inspect",
          capability: "dev-ci-health",
          next: [
            { to: "repair", when: { "result.needsFix": true } },
            { to: "finish", default: true },
          ],
        },
        { id: "repair", capability: "dev-ci-health", next: [{ to: "healthCheck", maxIterations: 1 }] },
        { id: "finish", capability: "dev-ci-health" },
      ],
    })

    expect(workflow?.startAt).toBe("healthCheck")
    expect(workflow?.steps.map((step) => step.id)).toEqual(["healthCheck", "inspect", "repair", "finish"])
    expect(workflow?.steps[2]?.next?.[0]?.to).toBe("healthCheck")
  })
})
