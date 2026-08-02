import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readWorkflowDefinition, workflowDefinitionToCapabilityFolder } from "../../src/workflowDefinitions.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-definition-"))
  roots.push(root)
  return root
}

function writeWorkflow(root: string, source: "runtime" | "definitions", name: string): void {
  const directory = path.join(root, ".kody-engine", source, "workflows", "refresh-knowledge-system")
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, "workflow.json"),
    `${JSON.stringify({ version: 1, name, agent: "developer", capabilities: ["build-knowledge-graph"] })}\n`,
  )
}

describe("readWorkflowDefinition", () => {
  it("loads a checked-out Store workflow when the backend runtime has none", () => {
    const root = workspace()
    writeWorkflow(root, "definitions", "Store workflow")

    expect(readWorkflowDefinition({}, root, "refresh-knowledge-system")?.name).toBe("Store workflow")
    expect(readWorkflowDefinition({}, root, "refresh-knowledge-system")?.agent).toBe("developer")
  })

  it("defaults migrated workflows to Kody", () => {
    const root = workspace()
    const directory = path.join(root, ".kody-engine", "definitions", "workflows", "legacy")
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(
      path.join(directory, "workflow.json"),
      `${JSON.stringify({ name: "Legacy", capabilities: ["inspect"] })}\n`,
    )
    expect(readWorkflowDefinition({}, root, "legacy")?.agent).toBe("kody")
  })

  it("keeps the backend runtime workflow authoritative when both sources exist", () => {
    const root = workspace()
    writeWorkflow(root, "definitions", "Store workflow")
    writeWorkflow(root, "runtime", "Runtime workflow")

    expect(readWorkflowDefinition({}, root, "refresh-knowledge-system")?.name).toBe("Runtime workflow")
  })

  it("preserves a workflow-level report through capability conversion", () => {
    const root = workspace()
    const directory = path.join(root, ".kody-engine", "definitions", "workflows", "agency-observer")
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(
      path.join(directory, "workflow.json"),
      `${JSON.stringify({
        name: "Agency Observer",
        agent: "kody",
        startAt: "observe",
        report: {
          type: "agency-observer",
          owner: "agency-observer",
          slug: "agency-observer",
          title: "Agency Observer",
        },
        steps: [{ id: "observe", capability: "observe-agency-flow" }],
      })}\n`,
    )

    const workflow = readWorkflowDefinition({}, root, "agency-observer")

    expect(workflow?.report?.slug).toBe("agency-observer")
    expect(
      workflow && workflowDefinitionToCapabilityFolder("agency-observer", workflow).config.workflow?.report?.slug,
    ).toBe("agency-observer")
  })
})
