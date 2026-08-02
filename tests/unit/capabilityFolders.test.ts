import { describe, expect, it } from "vitest"
import { parseCapabilityWorkflow } from "../../src/capabilityFolders.js"

describe("parseCapabilityWorkflow", () => {
  it("preserves documented camelCase graph ids and transition targets", () => {
    const workflow = parseCapabilityWorkflow({
      startAt: "healthCheck",
      report: {
        type: "agency-observer",
        owner: "agency-observer",
        slug: "agency-observer",
        title: "Agency Observer",
      },
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
    expect(workflow?.report).toEqual({
      type: "agency-observer",
      owner: "agency-observer",
      slug: "agency-observer",
      title: "Agency Observer",
    })
    expect(workflow?.steps.map((step) => step.id)).toEqual(["healthCheck", "inspect", "repair", "finish"])
    expect(workflow?.steps[2]?.next?.[0]?.to).toBe("healthCheck")
  })

  it("parses declared structured result facts from a capability profile", async () => {
    const { parseCapabilityConfig } = await import("../../src/capabilityFolders.js")

    const config = parseCapabilityConfig({
      name: "observe",
      output: { result: { facts: ["observation", "finding"] } },
    })

    expect(config.output).toEqual({ result: { facts: ["observation", "finding"] } })
  })

  it("allows a conditional workflow connection to end", () => {
    const workflow = parseCapabilityWorkflow({
      startAt: "check",
      steps: [
        {
          id: "check",
          capability: "ci-health-check",
          next: [
            { to: "repair", when: { "result.needsRepair": true } },
            { to: "$end", default: true },
          ],
        },
        { id: "repair", capability: "run" },
      ],
    })

    expect(workflow?.steps[0]?.next?.[1]?.to).toBe("$end")
  })
})
