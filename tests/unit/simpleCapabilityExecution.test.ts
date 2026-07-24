import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const executor = vi.hoisted(() => ({
  runImplementation: vi.fn(),
  runImplementationChain: vi.fn(
    async (_runtime: string, _input: unknown) => ({
      exitCode: 0,
      capabilityResults: [] as Array<{
        version: 1
        status: "pass" | "fail" | "blocked" | "changed" | "noop"
        summary: string
        facts: Record<string, unknown>
        artifacts: Array<{ label: string; url?: string; path?: string }>
        missingEvidence: string[]
        blockers: string[]
      }>,
    }),
  ),
}))

vi.mock("../../src/executor.js", () => executor)

import { runJob } from "../../src/job.js"

const roots: string[] = []

afterEach(() => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function writeCapability(
  cwd: string,
  slug: string,
  outputSchema: Record<string, unknown> = { type: "object" },
): void {
  const dir = path.join(cwd, ".kody-engine", "definitions", "capabilities", slug)
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true })
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true })
  fs.writeFileSync(path.join(dir, "instructions.md"), "Inspect the request.\n")
  fs.writeFileSync(
    path.join(dir, "contract.json"),
    JSON.stringify({
      input: { name: "request", schema: { type: "object" } },
      output: { name: "result", schema: outputSchema },
    }),
  )
}

describe("simple Capability execution", () => {
  it("lowers a Capability folder to the one internal runtime", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-capability-run-"))
    roots.push(cwd)
    writeCapability(cwd, "inspect")

    await runJob(
      {
        capability: "inspect",
        cliArgs: { input: '{"change":"abc"}' },
        flavor: "instant",
      },
      { cwd },
    )

    expect(executor.runImplementationChain).toHaveBeenCalledOnce()
    const [runtime, input] = executor.runImplementationChain.mock.calls[0] as [
      string,
      { cliArgs: Record<string, unknown> },
    ]
    expect(runtime).toBe("capability-run")
    expect(input.cliArgs).toEqual({
      capability: "inspect",
      input: '{"change":"abc"}',
    })
  })

  it("runs Workflow steps with one Workflow Agent", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-workflow-run-"))
    roots.push(cwd)
    writeCapability(cwd, "inspect")
    writeCapability(cwd, "summarize")
    const workflowDir = path.join(
      cwd,
      ".kody-engine",
      "definitions",
      "workflows",
      "review",
    )
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(
      path.join(workflowDir, "workflow.json"),
      JSON.stringify({
        name: "Review",
        agent: "reviewer",
        capabilities: ["inspect", "summarize"],
      }),
    )

    await runJob(
      { workflow: "review", cliArgs: {}, flavor: "instant" },
      { cwd },
    )

    expect(executor.runImplementationChain).toHaveBeenCalledTimes(2)
    for (const [runtime, input] of executor.runImplementationChain.mock.calls) {
      expect(runtime).toBe("capability-run")
      expect(
        (input as { preloadedData?: Record<string, unknown> }).preloadedData
          ?.jobAgent,
      ).toBe("reviewer")
    }
  })

  it("passes Workflow step arguments through the Capability input", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-workflow-input-"))
    roots.push(cwd)
    writeCapability(cwd, "prepare")
    const workflowDir = path.join(cwd, ".kody-engine", "definitions", "workflows", "release")
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(
      path.join(workflowDir, "workflow.json"),
      JSON.stringify({
        name: "Release",
        agent: "kody",
        steps: [{ capability: "prepare", cliArgs: { prefer: "ours" } }],
      }),
    )

    await runJob({ workflow: "release", cliArgs: {}, flavor: "instant" }, { cwd })

    expect(executor.runImplementationChain.mock.calls[0]?.[1]).toMatchObject({
      cliArgs: {
        capability: "prepare",
        input: JSON.stringify({ prefer: "ours" }),
      },
    })
  })

  it("preserves Workflow conditions with simple Capability folders", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-workflow-condition-"))
    roots.push(cwd)
    writeCapability(cwd, "inspect", {
      type: "object",
      properties: { status: { type: "string" } },
    })
    writeCapability(cwd, "repair")
    writeCapability(cwd, "verify")
    const workflowDir = path.join(cwd, ".kody-engine", "definitions", "workflows", "quality")
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(
      path.join(workflowDir, "workflow.json"),
      JSON.stringify({
        name: "Quality",
        agent: "reviewer",
        startAt: "inspect",
        steps: [
          {
            id: "inspect",
            capability: "inspect",
            next: [
              { to: "repair", when: { "result.status": "fail" } },
              { to: "verify", default: true },
            ],
          },
          { id: "repair", capability: "repair", next: "verify" },
          { id: "verify", capability: "verify" },
        ],
      }),
    )
    executor.runImplementationChain
      .mockResolvedValueOnce({
        exitCode: 0,
        capabilityResults: [{
          version: 1,
          status: "fail",
          summary: "Repair required",
          facts: {},
          artifacts: [],
          missingEvidence: [],
          blockers: [],
        }],
      })
      .mockResolvedValueOnce({ exitCode: 0, capabilityResults: [] })
      .mockResolvedValueOnce({ exitCode: 0, capabilityResults: [] })

    const result = await runJob(
      { workflow: "quality", cliArgs: {}, flavor: "instant" },
      { cwd },
    )

    expect(result.workflowState?.status, JSON.stringify(result, null, 2)).toBe("done")
    expect(executor.runImplementationChain).toHaveBeenCalledTimes(3)
    expect(
      executor.runImplementationChain.mock.calls.map(
        ([runtime, input]) =>
          `${runtime}:${(input as { cliArgs: { capability: string } }).cliArgs.capability}`,
      ),
    ).toEqual([
      "capability-run:inspect",
      "capability-run:repair",
      "capability-run:verify",
    ])
  })
})
