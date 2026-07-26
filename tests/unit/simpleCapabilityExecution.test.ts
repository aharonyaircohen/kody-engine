import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { capabilityOutputConditionPaths, readCapabilityFolder } from "../../src/capabilityFolders.js"

interface MockCapabilityResult {
  version: 1
  status: "pass" | "fail" | "blocked" | "changed" | "noop"
  summary: string
  facts: Record<string, unknown>
  artifacts: Array<{ label: string; url?: string; path?: string }>
  missingEvidence: string[]
  blockers: string[]
}

interface MockExecutorOutput {
  exitCode: number
  prUrl?: string
  capabilityOutput?: unknown
  capabilityResults: MockCapabilityResult[]
}

const executor = vi.hoisted(() => ({
  runImplementation: vi.fn(),
  runImplementationChain: vi.fn(
    async (_runtime: string, _input: unknown): Promise<MockExecutorOutput> => ({
      exitCode: 0,
      capabilityResults: [],
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
  contract?: { input: Record<string, unknown>; output: Record<string, unknown> },
): void {
  const dir = path.join(cwd, ".kody-engine", "definitions", "capabilities", slug)
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true })
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true })
  fs.writeFileSync(path.join(dir, "instructions.md"), "Inspect the request.\n")
  if (contract) fs.writeFileSync(path.join(dir, "contract.json"), JSON.stringify(contract))
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
    const workflowDir = path.join(cwd, ".kody-engine", "definitions", "workflows", "review")
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(
      path.join(workflowDir, "workflow.json"),
      JSON.stringify({
        name: "Review",
        agent: "reviewer",
        capabilities: ["inspect", "summarize"],
      }),
    )

    await runJob({ workflow: "review", cliArgs: {}, flavor: "instant" }, { cwd })

    expect(executor.runImplementationChain).toHaveBeenCalledTimes(2)
    for (const [runtime, input] of executor.runImplementationChain.mock.calls) {
      expect(runtime).toBe("capability-run")
      expect((input as { preloadedData?: Record<string, unknown> }).preloadedData?.jobAgent).toBe("reviewer")
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
        steps: [{ capability: "prepare", input: { prefer: "ours" } }],
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
    writeCapability(cwd, "inspect")
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
        capabilityResults: [
          {
            version: 1,
            status: "fail",
            summary: "Repair required",
            facts: {},
            artifacts: [],
            missingEvidence: [],
            blockers: [],
          },
        ],
      })
      .mockResolvedValueOnce({ exitCode: 0, capabilityResults: [] })
      .mockResolvedValueOnce({ exitCode: 0, capabilityResults: [] })

    const result = await runJob({ workflow: "quality", cliArgs: {}, flavor: "instant" }, { cwd })

    expect(result.workflowState?.status, JSON.stringify(result, null, 2)).toBe("done")
    expect(executor.runImplementationChain).toHaveBeenCalledTimes(3)
    expect(
      executor.runImplementationChain.mock.calls.map(
        ([runtime, input]) => `${runtime}:${(input as { cliArgs: { capability: string } }).cliArgs.capability}`,
      ),
    ).toEqual(["capability-run:inspect", "capability-run:repair", "capability-run:verify"])
  })

  it("uses the generic delivery runtime for any pull-request-producing step", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-workflow-delivery-"))
    roots.push(cwd)
    writeCapability(cwd, "make-change")
    writeCapability(cwd, "inspect")
    const workflowDir = path.join(cwd, ".kody-engine", "definitions", "workflows", "delivery")
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(
      path.join(workflowDir, "workflow.json"),
      JSON.stringify({
        name: "Delivery",
        agent: "kody",
        startAt: "change",
        steps: [
          {
            id: "change",
            capability: "make-change",
            target: "issue",
            delivery: "pull-request",
            next: "inspect",
          },
          {
            id: "inspect",
            capability: "inspect",
            target: "pr",
          },
        ],
      }),
    )
    executor.runImplementationChain
      .mockResolvedValueOnce({
        exitCode: 0,
        prUrl: "https://github.com/acme/widgets/pull/42",
        capabilityOutput: { prUrl: "https://github.com/acme/widgets/pull/42" },
        capabilityResults: [],
      })
      .mockResolvedValueOnce({ exitCode: 0, capabilityResults: [] })

    await runJob(
      {
        workflow: "delivery",
        target: 7,
        cliArgs: { issue: 7 },
        flavor: "instant",
      },
      { cwd },
    )

    expect(executor.runImplementationChain.mock.calls.map(([runtime]) => runtime)).toEqual([
      "capability-delivery",
      "capability-run",
    ])
    expect(executor.runImplementationChain.mock.calls[0]?.[1]).toMatchObject({
      cliArgs: {
        capability: "make-change",
        issue: 7,
      },
    })
    expect(executor.runImplementationChain.mock.calls[1]?.[1]).toMatchObject({
      cliArgs: {
        capability: "inspect",
        input: JSON.stringify({
          prUrl: "https://github.com/acme/widgets/pull/42",
          pr: 42,
        }),
      },
    })
  })

  it("validates Workflow result paths against the source Capability contract", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-workflow-contract-"))
    roots.push(cwd)
    writeCapability(cwd, "inspect", {
      input: {},
      output: {
        type: "object",
        properties: { verdict: { enum: ["pass", "fix"] } },
        required: ["verdict"],
      },
    })
    writeCapability(cwd, "repair")
    const loaded = readCapabilityFolder(path.join(cwd, ".kody-engine", "definitions", "capabilities"), "inspect")
    expect(capabilityOutputConditionPaths(loaded!.config)).toContain("result.verdict")
    const workflowDir = path.join(cwd, ".kody-engine", "definitions", "workflows", "quality")
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(
      path.join(workflowDir, "workflow.json"),
      JSON.stringify({
        name: "Quality",
        agent: "kody",
        startAt: "inspect",
        steps: [
          {
            id: "inspect",
            capability: "inspect",
            next: [
              { to: "$end", when: { "result.unknown": true } },
              { to: "repair", default: true },
            ],
          },
          { id: "repair", capability: "repair" },
        ],
      }),
    )

    await expect(runJob({ workflow: "quality", cliArgs: {}, flavor: "instant" }, { cwd })).resolves.toMatchObject({
      exitCode: 64,
      reason: expect.stringMatching(/does not declare it/),
    })
    expect(executor.runImplementationChain).not.toHaveBeenCalled()
  })
})
