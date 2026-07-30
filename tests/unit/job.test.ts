import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Hoist-safe mock of the executor so runJob is tested in isolation (no real
// implementation spins up). Mirrors tests/unit/dispatchCapabilityFileTicks.routing.test.ts.
const { gh, runImplementationChain } = vi.hoisted(() => ({
  gh: vi.fn(),
  runImplementationChain: vi.fn(),
}))
vi.mock("../../src/executor.js", () => ({ runImplementationChain }))
vi.mock("../../src/issue.js", () => ({ gh }))

import {
  DEFAULT_INSTANT_AGENT,
  InvalidJobError,
  mintInstantJob,
  mintScheduledJob,
  newJobId,
  runJob,
  validateJob,
} from "../../src/job.js"

describe("runJob (Phase 1 seam)", () => {
  beforeEach(() => {
    runImplementationChain.mockReset()
    runImplementationChain.mockResolvedValue({ exitCode: 0 })
    gh.mockReset()
    gh.mockImplementation(() => {
      throw new Error("HTTP 404 Not Found")
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("lowers an instant job onto runImplementationChain with its implementation + cliArgs", async () => {
    await runJob(
      { capability: "run", implementation: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    expect(runImplementationChain).toHaveBeenCalledTimes(1)
    const [profile, input] = runImplementationChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.cliArgs).toEqual({ issue: 42 })
    expect(input.cwd).toBe("/x")
    expect(input.preloadedData?.jobCapability).toBe("run")
  })

  it("seeds result target as internal postflight context, not CLI args", async () => {
    await runJob(
      {
        capability: "vercel-production-deploy",
        implementation: "vercel-production-deploy",
        cliArgs: {},
        flavor: "instant",
        evidence: "productionDeployed",
        resultTarget: { type: "goal", id: "web-release-2026-07-01" },
      },
      { cwd: "/x" },
    )

    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.cliArgs).toEqual({})
    expect(input.preloadedData?.capabilityResultTarget).toEqual({
      type: "goal",
      id: "web-release-2026-07-01",
    })
    expect(input.preloadedData?.capabilityEvidence).toEqual({ evidence: "productionDeployed" })
  })

  it.skip("lowers an action-only instant job through the capability action registry", async () => {
    await runJob({ action: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" }, { cwd: "/x" })
    const [profile, input] = runImplementationChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.cliArgs).toEqual({ issue: 42 })
    expect(input.preloadedData?.jobAction).toBe("run")
    expect(input.preloadedData?.jobCapability).toBe("run")
    expect(input.preloadedData?.selectedImplementation).toBe("run")
    expect(input.preloadedData?.selectedImplementation).toBe("run")
  })

  it("accepts implementation as the selected profile and writes both metadata fields", async () => {
    await runJob(
      { capability: "run", implementation: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    const [profile, input] = runImplementationChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.preloadedData?.selectedImplementation).toBe("run")
    expect(input.preloadedData?.selectedImplementation).toBe("run")
  })

  it.skip("resolves a capability-only job to the capability-selected implementation", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-capability-job-"))
    const capabilityDir = path.join(cwd, ".kody-engine", "definitions", "capabilities", "ci-health")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({ name: "ci-health", action: "ci-health", implementation: "ci-check", agent: "kody" }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# CI Health\n")

    await runJob(
      {
        capability: "ci-health",
        cliArgs: { pr: 456, goal: "release-aguy", evidence: "mainDeployPrGreen" },
        flavor: "instant",
      },
      { cwd },
    )

    const [profile, input] = runImplementationChain.mock.calls[0]!
    expect(profile).toBe("ci-check")
    expect(input.cliArgs).toEqual({ pr: 456, goal: "release-aguy", evidence: "mainDeployPrGreen" })
    expect(input.preloadedData?.jobCapability).toBe("ci-health")
    expect(input.preloadedData?.selectedImplementation).toBe("ci-check")
    expect(input.preloadedData?.selectedImplementation).toBe("ci-check")
  })

  it.skip("seeds capabilityKind from capability folders for shared implementation traces", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-capability-kind-job-"))
    const capabilityDir = path.join(cwd, ".kody-engine", "definitions", "capabilities", "pr-health")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({
        name: "pr-health",
        action: "pr-health",
        implementation: "capability-tick",
        agent: "kody",
        capabilityKind: "observe",
      }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# PR Health\n")

    await runJob({ capability: "pr-health", cliArgs: {}, flavor: "scheduled" }, { cwd })

    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobCapability).toBe("pr-health")
    expect(input.preloadedData?.jobCapabilityKind).toBe("observe")
  })

  it("preserves capability identity without injecting capability args when implementation is explicit", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-goal-handoff-"))
    const capabilityDir = path.join(cwd, ".kody-engine", "definitions", "capabilities", "company-graph")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.writeFileSync(path.join(capabilityDir, "profile.json"), JSON.stringify({ name: "company-graph" }))
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Company Graph\n")
    await runJob(
      {
        capability: "company-graph",
        implementation: "company-graph",
        cliArgs: { goal: "hourly-monitor-goal-smoke" },
        flavor: "instant",
      },
      { cwd },
    )
    const [profile, input] = runImplementationChain.mock.calls[0]!
    expect(profile).toBe("company-graph")
    expect(input.cliArgs).toEqual({ goal: "hourly-monitor-goal-smoke" })
    expect(input.preloadedData?.jobCapability).toBe("company-graph")
    expect(input.preloadedData?.selectedImplementation).toBe("company-graph")
  })

  it("seeds inline why into preloadedData.jobWhy", async () => {
    await runJob(
      { capability: "unit-fix", implementation: "unit-fix", why: "fix the flaky test", cliArgs: {}, flavor: "instant" },
      { cwd: "/x" },
    )
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBe("fix the flaky test")
    expect(input.preloadedData?.jobIntent).toBeUndefined()
  })

  it("does not seed jobWhy for an empty why string", async () => {
    await runJob({ capability: "run", implementation: "run", why: "", cliArgs: {}, flavor: "instant" }, { cwd: "/x" })
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBeUndefined()
  })

  it("always seeds a jobId + flavor so the run can be recorded in the task ledger", async () => {
    await runJob(
      { capability: "run", implementation: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(typeof input.preloadedData?.jobId).toBe("string")
    expect(input.preloadedData?.jobKey).toBe("instant:run:42")
    expect(input.preloadedData?.jobFlavor).toBe("instant")
    expect(input.preloadedData?.selectedImplementation).toBe("run")
    expect(input.preloadedData?.selectedImplementation).toBe("run")
    expect(input.preloadedData?.jobTarget).toBe(42)
  })

  it("keeps the same stable job key for retries of the same target + implementation", async () => {
    await runJob(
      { capability: "run", implementation: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    await runJob(
      { capability: "run", implementation: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )

    const first = runImplementationChain.mock.calls[0]![1].preloadedData
    const second = runImplementationChain.mock.calls[1]![1].preloadedData
    expect(first?.jobKey).toBe("instant:run:42")
    expect(second?.jobKey).toBe("instant:run:42")
    expect(first?.jobId).not.toBe(second?.jobId)
  })

  it("keeps GitHub attempt ids unique when multiple jobs run in one workflow", () => {
    vi.stubEnv("GITHUB_RUN_ID", "77")
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "3")

    const first = newJobId("instant")
    const second = newJobId("instant")

    expect(first).toMatch(/^gh-77-3-\d+$/)
    expect(second).toMatch(/^gh-77-3-\d+$/)
    expect(first).not.toBe(second)
  })

  it("carries the DispatchResult's why through mintInstantJob into jobWhy", async () => {
    await runJob(
      mintInstantJob({
        action: "run",
        capability: "run",
        implementation: "run",
        cliArgs: { issue: 5 },
        target: 5,
        why: "also add tests",
      }),
      { cwd: "/x" },
    )
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBe("also add tests")
  })

  it.skip("seeds agent into preloadedData.jobAgent", async () => {
    await runJob(
      { capability: "run", agent: "kody", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" },
      { cwd: "/x" },
    )
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobAgent).toBe("kody")
  })

  it("uses the capability reference in the stable key for scheduled jobs", async () => {
    await runJob(
      {
        capability: "capability-tick",
        implementation: "capability-tick",
        schedule: "*/5 * * * *",
        cliArgs: {},
        flavor: "scheduled",
      },
      { cwd: "/x" },
    )
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobKey).toBe("scheduled:capability-tick:capability-tick")
  })

  it.skip("falls back to the capability slug as the profile when no implementation", async () => {
    await runJob({ capability: "run", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" }, { cwd: "/x" })
    expect(runImplementationChain.mock.calls[0]![0]).toBe("run")
  })

  it.skip("seeds only job identity (no why/agent) for a bare scheduled job", async () => {
    await runJob({ capability: "run", cliArgs: {}, flavor: "scheduled" }, { cwd: "/x" })
    const [, input] = runImplementationChain.mock.calls[0]!
    expect(input.preloadedData?.jobFlavor).toBe("scheduled")
    expect(input.preloadedData?.jobWhy).toBeUndefined()
    expect(input.preloadedData?.jobAgent).toBeUndefined()
  })

  it("rejects a job with no capability action or capability", () => {
    expect(() => validateJob({ cliArgs: {}, flavor: "instant" })).toThrow(InvalidJobError)
  })

  it("rejects an implementation-only job", () => {
    expect(() => validateJob({ implementation: "run", cliArgs: {}, flavor: "instant" })).toThrow(
      /capability action, capability, or workflow/,
    )
  })

  it("rejects an unknown flavor", () => {
    expect(() => validateJob({ capability: "run", implementation: "run", cliArgs: {}, flavor: "bogus" })).toThrow(
      InvalidJobError,
    )
  })

  it("defaults cliArgs to an empty object when omitted", () => {
    const j = validateJob({ capability: "run", implementation: "run", flavor: "instant" })
    expect(j.cliArgs).toEqual({})
  })

  it("accepts a workflow-only job", () => {
    const j = validateJob({ workflow: "bug-flow", flavor: "instant" })
    expect(j.workflow).toBe("bug-flow")
    expect(j.cliArgs).toEqual({})
  })

  it.skip("runs a workflow capability as ordered child capability jobs", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-job-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "bug", {
        name: "bug",
        action: "bug",
        workflow: {
          steps: [
            { capability: "reproduce", reason: "capture the failing test" },
            { capability: "run", reason: "fix the bug using the repro artifact" },
          ],
        },
      })
      writeCapability(cwd, "reproduce", {
        name: "reproduce",
        action: "reproduce",
        implementation: "reproduce",
        inputs: [
          { name: "issue", flag: "--issue", type: "int", required: true },
          { name: "base", flag: "--base", type: "string", required: false },
        ],
      })
      writeCapability(cwd, "run", {
        inputs: [
          { name: "issue", flag: "--issue", type: "int", required: true },
          { name: "base", flag: "--base", type: "string", required: false },
        ],
      })
      process.chdir(cwd)

      await runJob(
        {
          action: "bug",
          capability: "bug",
          cliArgs: { issue: 42, base: "feature/base" },
          target: 42,
          why: "operator note",
          flavor: "instant",
        },
        { cwd },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(2)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("reproduce")
      expect(runImplementationChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42, base: "feature/base" })
      expect(runImplementationChain.mock.calls[0]![1].preloadedData).toMatchObject({
        workflowCapability: "bug",
        workflowStep: "reproduce",
        workflowStepIndex: 1,
        workflowStepCount: 2,
        jobCapability: "reproduce",
        selectedImplementation: "reproduce",
      })
      expect(runImplementationChain.mock.calls[0]![1].preloadedData?.jobWhy).toContain("operator note")
      expect(runImplementationChain.mock.calls[0]![1].preloadedData?.jobWhy).toContain("capture the failing test")

      expect(runImplementationChain.mock.calls[1]![0]).toBe("run")
      expect(runImplementationChain.mock.calls[1]![1].cliArgs).toEqual({ issue: 42, base: "feature/base" })
      expect(runImplementationChain.mock.calls[1]![1].preloadedData).toMatchObject({
        workflowCapability: "bug",
        workflowStep: "run",
        workflowStepIndex: 2,
        workflowStepCount: 2,
        jobCapability: "run",
        selectedImplementation: "run",
      })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("does not misreport a Workflow as a Capability boundary", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-trace-job-"))
    const originalCwd = process.cwd()
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      writeCapability(cwd, "feature", {
        name: "feature",
        action: "feature",
        capabilityKind: "act",
        workflow: {
          steps: [{ capability: "run", reason: "implement the feature" }],
        },
      })
      process.chdir(cwd)

      await runJob(
        {
          action: "feature",
          cliArgs: { issue: 42 },
          target: 42,
          flavor: "instant",
        },
        { cwd },
      )

      const out = write.mock.calls.map((call) => String(call[0])).join("")
      expect(out).not.toContain("KODY_AGENCY_BOUNDARY_EVAL=")
      expect(out).toContain("workflow feature")
    } finally {
      write.mockRestore()
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("runs an action-only workflow capability without treating the action as an implementation", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-action-workflow-job-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "feature", {
        name: "feature",
        action: "feature",
        workflow: {
          steps: [{ capability: "run", reason: "implement the feature" }],
        },
      })
      process.chdir(cwd)

      await runJob(
        {
          action: "feature",
          cliArgs: { issue: 42 },
          target: 42,
          flavor: "instant",
        },
        { cwd },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(1)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("run")
      expect(runImplementationChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42 })
      expect(runImplementationChain.mock.calls[0]![1].preloadedData).toMatchObject({
        workflowCapability: "feature",
        workflowStep: "run",
        jobCapability: "run",
        selectedImplementation: "run",
      })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("runs a stored workflow definition as ordered child capability jobs", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-definition-job-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "reproduce", {
        name: "reproduce",
        action: "reproduce",
        implementation: "reproduce",
      })
      writeCapability(cwd, "run", {
        name: "run",
        action: "run",
        implementation: "run",
      })
      writeCapability(cwd, "bug-flow", {
        name: "bug-flow",
        action: "bug-flow",
        implementation: "bug-flow",
      })
      const workflow = {
        version: 1,
        name: "Bug workflow",
        capabilities: ["reproduce", "run"],
        createdAt: "2026-06-27T00:00:00Z",
        updatedAt: "2026-06-27T00:00:00Z",
      }
      writeWorkflowDefinition(cwd, "bug-flow", workflow)
      process.chdir(cwd)

      await runJob(
        {
          workflow: "bug-flow",
          cliArgs: { issue: 42 },
          flavor: "instant",
        },
        {
          cwd,
          config: {
            quality: { typecheck: "", lint: "", testUnit: "", format: "" },
            git: { defaultBranch: "main" },
            github: { owner: "o", repo: "r" },
            agent: { model: "anthropic/claude-haiku-4-5-20251001" },
          },
        },
      )

      expect(gh).not.toHaveBeenCalled()
      expect(runImplementationChain).toHaveBeenCalledTimes(2)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("reproduce")
      expect(runImplementationChain.mock.calls[0]![1].preloadedData).toMatchObject({
        workflowCapability: "bug-flow",
        workflowTitle: "Bug workflow",
        workflowStep: "reproduce",
        workflowStepIndex: 1,
        workflowStepCount: 2,
      })
      expect(runImplementationChain.mock.calls[0]![1].preloadedData).not.toHaveProperty("jobWhy")
      expect(runImplementationChain.mock.calls[1]![0]).toBe("run")
      expect(runImplementationChain.mock.calls[1]![1].preloadedData).toMatchObject({
        workflowCapability: "bug-flow",
        workflowStep: "run",
        workflowStepIndex: 2,
        workflowStepCount: 2,
      })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("preserves stored workflow step order, duplicate capabilities, and PR handoff", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-web-release-workflow-job-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "release-prepare", {
        name: "release-prepare",
        action: "release-prepare",
        implementation: "release-prepare",
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: false }],
      })
      writeCapability(cwd, "release-merge", {
        name: "release-merge",
        action: "release-merge",
        implementation: "release-merge",
        inputs: [
          { name: "pr", flag: "--pr", type: "int", required: true },
          { name: "issue", flag: "--issue", type: "int", required: false },
        ],
      })
      writeCapability(cwd, "release-promote", {
        name: "release-promote",
        action: "release-promote",
        implementation: "release-promote",
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: false }],
      })
      writeCapability(cwd, "vercel-production-deploy", {
        name: "vercel-production-deploy",
        action: "vercel-production-deploy",
        implementation: "vercel-production-deploy",
        inputs: [],
      })
      const workflow = {
        version: 1,
        name: "Web release",
        steps: [
          { capability: "release-prepare", target: "issue" },
          { capability: "release-merge", target: "pr" },
          { capability: "release-promote", target: "issue" },
          { capability: "release-merge", target: "pr" },
          { capability: "vercel-production-deploy" },
        ],
      }
      writeWorkflowDefinition(cwd, "web-release", workflow)
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({
          exitCode: 0,
          prUrl: "https://github.com/o/r/pull/10",
        })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RELEASE_MERGED") })
        .mockResolvedValueOnce({
          exitCode: 0,
          prUrl: "https://github.com/o/r/pull/11",
        })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RELEASE_BRANCH_MERGED") })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("VERCEL_PRODUCTION_DEPLOY_COMPLETED") })

      await runJob(
        {
          workflow: "web-release",
          cliArgs: { issue: 42 },
          target: 42,
          flavor: "instant",
        },
        {
          cwd,
          config: {
            quality: { typecheck: "", lint: "", testUnit: "", format: "" },
            git: { defaultBranch: "main" },
            github: { owner: "o", repo: "r" },
            agent: { model: "anthropic/claude-haiku-4-5-20251001" },
          },
        },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(5)
      expect(runImplementationChain.mock.calls.map((call) => call[0])).toEqual([
        "release-prepare",
        "release-merge",
        "release-promote",
        "release-merge",
        "vercel-production-deploy",
      ])
      expect(runImplementationChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42 })
      expect(runImplementationChain.mock.calls[1]![1].cliArgs).toEqual({ issue: 42, pr: 10 })
      expect(runImplementationChain.mock.calls[2]![1].cliArgs).toEqual({ issue: 42 })
      expect(runImplementationChain.mock.calls[3]![1].cliArgs).toEqual({ issue: 42, pr: 11 })
      expect(runImplementationChain.mock.calls[4]![1].cliArgs).toEqual({})
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("lets the workflow request a typed report without changing the capability contract", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-report-job-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "observe-repo-ci", {
        name: "observe-repo-ci",
        action: "observe-repo-ci",
        implementation: "observe-repo-ci",
        inputs: [],
      })
      const workflow = {
        version: 1,
        name: "Agency observer",
        steps: [
          {
            capability: "observe-repo-ci",
            report: {
              type: "finding",
              version: 1,
              owner: "agency-observer",
              slugFact: "finding.id",
              titleFact: "finding.title",
              publishWhenFact: "finding.id",
            },
          },
        ],
      }
      writeWorkflowDefinition(cwd, "agency-observer", workflow)
      process.chdir(cwd)

      await runJob(
        { workflow: "agency-observer", cliArgs: {}, flavor: "scheduled" },
        {
          cwd,
          config: {
            quality: { typecheck: "", lint: "", testUnit: "", format: "" },
            git: { defaultBranch: "main" },
            github: { owner: "o", repo: "r" },
            agent: { model: "anthropic/claude-haiku-4-5-20251001" },
          },
        },
      )

      expect(runImplementationChain.mock.calls[0]![1].preloadedData?.reportPublication).toEqual(
        workflow.steps[0]!.report,
      )
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("resumes a workflow at the step that owns the pending goal evidence", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-web-release-resume-job-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "release-prepare", {
        name: "release-prepare",
        action: "release-prepare",
        implementation: "release-prepare",
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: false }],
      })
      writeCapability(cwd, "release-merge", {
        name: "release-merge",
        action: "release-merge",
        implementation: "release-merge",
        inputs: [
          { name: "pr", flag: "--pr", type: "int", required: true },
          { name: "issue", flag: "--issue", type: "int", required: false },
        ],
      })
      writeCapability(cwd, "release-promote", {
        name: "release-promote",
        action: "release-promote",
        implementation: "release-promote",
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: false }],
      })
      writeCapability(cwd, "vercel-production-deploy", {
        name: "vercel-production-deploy",
        action: "vercel-production-deploy",
        implementation: "vercel-production-deploy",
        inputs: [],
      })
      const workflow = {
        version: 1,
        name: "Web release",
        steps: [
          { capability: "release-prepare", target: "issue", evidence: "releasePrExists" },
          { capability: "release-merge", target: "pr", evidence: "defaultBranchMerged", targetFact: "releasePr" },
          { capability: "release-promote", target: "issue", evidence: "releasePromotionPrExists" },
          { capability: "release-merge", target: "pr", evidence: "releaseBranchMerged", targetFact: "promotionPr" },
          { capability: "vercel-production-deploy", evidence: "productionDeployed" },
        ],
      }
      writeWorkflowDefinition(cwd, "web-release", workflow)
      process.chdir(cwd)
      runImplementationChain.mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RELEASE_BRANCH_MERGED") })

      await runJob(
        {
          workflow: "web-release",
          cliArgs: { issue: 756 },
          target: 756,
          flavor: "instant",
          evidence: "releaseBranchMerged",
          resultTarget: { type: "goal", id: "web-release-2026-07-06" },
          workflowFacts: { releasePr: 767, promotionPr: 763 },
        } as never,
        {
          cwd,
          config: {
            quality: { typecheck: "", lint: "", testUnit: "", format: "" },
            git: { defaultBranch: "main" },
            github: { owner: "o", repo: "r" },
            agent: { model: "anthropic/claude-haiku-4-5-20251001" },
          },
        },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(2)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("release-merge")
      expect(runImplementationChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 756, pr: 763 })
      expect(runImplementationChain.mock.calls[0]![1].preloadedData?.capabilityResultTarget).toEqual({
        type: "goal",
        id: "web-release-2026-07-06",
      })
      expect(runImplementationChain.mock.calls[0]![1].preloadedData?.capabilityEvidence).toEqual({
        evidence: "releaseBranchMerged",
      })
      expect(runImplementationChain.mock.calls[1]![0]).toBe("vercel-production-deploy")
      expect(runImplementationChain.mock.calls[1]![1].cliArgs).toEqual({})
      expect(runImplementationChain.mock.calls[1]![1].preloadedData?.capabilityResultTarget).toEqual({
        type: "goal",
        id: "web-release-2026-07-06",
      })
      expect(runImplementationChain.mock.calls[1]![1].preloadedData?.capabilityEvidence).toEqual({
        evidence: "productionDeployed",
      })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("resolves each workflow step instead of pinning one Implementation on the Workflow", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-route-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "bug", {
        name: "bug",
        action: "bug",
        workflow: { steps: ["reproduce", "run"] },
      })
      writeCapability(cwd, "reproduce", {
        name: "reproduce",
        action: "reproduce",
        implementation: "reproduce",
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: true }],
      })
      writeCapability(cwd, "run", {
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: true }],
      })
      process.chdir(cwd)

      await runJob(
        {
          action: "bug",
          capability: "bug",
          cliArgs: { issue: 42 },
          target: 42,
          flavor: "instant",
        },
        { cwd },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(2)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("reproduce")
      expect(runImplementationChain.mock.calls[1]![0]).toBe("run")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("passes workflow issue and PR targets to matching steps", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-targets-"))
    const originalCwd = process.cwd()
    try {
      writeWorkflowStages(cwd)
      writeCapability(cwd, "feature", {
        name: "feature",
        action: "feature",
        workflow: {
          steps: [
            { capability: "run", target: "issue" },
            { capability: "review", target: "pr" },
            {
              capability: "fix",
              target: "pr",
              runWhen: { "lastOutcome.type": ["REVIEW_CONCERNS", "REVIEW_FAIL"] },
            },
          ],
        },
      })
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RUN_COMPLETED", "https://github.com/o/r/pull/99") })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("REVIEW_CONCERNS") })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("FIX_COMPLETED") })

      await runJob(
        {
          action: "feature",
          capability: "feature",
          cliArgs: { issue: 42, base: "feature/base" },
          target: 42,
          flavor: "instant",
        },
        { cwd },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(3)
      expect(runImplementationChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42, base: "feature/base" })
      expect(runImplementationChain.mock.calls[1]![1].cliArgs).toEqual({ pr: 99 })
      expect(runImplementationChain.mock.calls[2]![1].cliArgs).toEqual({ pr: 99 })
      expect(runImplementationChain.mock.calls[1]![1].preloadedData?.workflowStep).toBe("review")
      expect(runImplementationChain.mock.calls[2]![1].preloadedData?.workflowStep).toBe("fix")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("skips conditional workflow steps when runWhen does not match", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-skip-"))
    const originalCwd = process.cwd()
    try {
      writeWorkflowStages(cwd)
      writeCapability(cwd, "feature", {
        name: "feature",
        action: "feature",
        workflow: {
          steps: [
            { capability: "run", target: "issue" },
            { capability: "review", target: "pr" },
            {
              capability: "fix",
              target: "pr",
              runWhen: { "lastOutcome.type": ["REVIEW_CONCERNS", "REVIEW_FAIL"] },
            },
          ],
        },
      })
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RUN_COMPLETED", "https://github.com/o/r/pull/99") })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("REVIEW_PASS") })

      await runJob(
        { action: "feature", capability: "feature", cliArgs: { issue: 42 }, target: 42, flavor: "instant" },
        { cwd },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(2)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("run")
      expect(runImplementationChain.mock.calls[1]![0]).toBe("review")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("can continue a workflow after an allowed non-zero action outcome", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-continue-"))
    const originalCwd = process.cwd()
    try {
      writeWorkflowStages(cwd)
      writeCapability(cwd, "feature", {
        name: "feature",
        action: "feature",
        workflow: {
          steps: [
            { capability: "run", target: "issue" },
            { capability: "review", target: "pr", continueOn: ["REVIEW_FAIL"] },
            {
              capability: "fix",
              target: "pr",
              runWhen: { "lastOutcome.type": ["REVIEW_CONCERNS", "REVIEW_FAIL"] },
            },
          ],
        },
      })
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RUN_COMPLETED", "https://github.com/o/r/pull/99") })
        .mockResolvedValueOnce({ exitCode: 1, reason: "blocking review", taskState: taskState("REVIEW_FAIL") })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("FIX_COMPLETED") })

      const result = await runJob(
        { action: "feature", capability: "feature", cliArgs: { issue: 42 }, target: 42, flavor: "instant" },
        { cwd },
      )

      expect(result).toMatchObject({ exitCode: 0 })
      expect(runImplementationChain).toHaveBeenCalledTimes(3)
      expect(runImplementationChain.mock.calls[1]![1].preloadedData?.workflowContinueOn).toEqual(["REVIEW_FAIL"])
      expect(runImplementationChain.mock.calls[2]![0]).toBe("fix")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("follows explicit workflow connections and maps prior facts into the next capability", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-graph-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "graph-pilot", {
        name: "graph-pilot",
        action: "graph-pilot",
        workflow: {
          startAt: "inspect",
          steps: [
            {
              id: "inspect",
              capability: "run",
              target: "issue",
              next: [
                { to: "repair", when: { "result.facts.needsFix": true } },
                { to: "verify", default: true },
              ],
            },
            {
              id: "repair",
              capability: "fix",
              inputs: { feedback: { from: "facts.feedback" } },
              next: "verify",
            },
            { id: "verify", capability: "review", target: "pr" },
          ],
        },
      })
      writeWorkflowStages(cwd)
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({
          exitCode: 0,
          prUrl: "https://github.com/o/r/pull/99",
          capabilityResults: [capabilityResult({ needsFix: true, feedback: "repair the failing check" })],
        })
        .mockResolvedValueOnce({ exitCode: 0, capabilityResults: [capabilityResult({ repaired: true })] })
        .mockResolvedValueOnce({ exitCode: 0, capabilityResults: [capabilityResult({ verified: true })] })

      const result = await runJob(
        { action: "graph-pilot", capability: "graph-pilot", cliArgs: { issue: 42 }, target: 42, flavor: "instant" },
        { cwd },
      )

      expect(result).toMatchObject({
        exitCode: 0,
        workflowState: {
          status: "done",
          facts: { needsFix: true, feedback: "repair the failing check", repaired: true, verified: true },
        },
      })
      expect(runImplementationChain.mock.calls.map((call) => call[0])).toEqual(["run", "fix", "review"])
      expect(runImplementationChain.mock.calls[1]![1].cliArgs).toEqual({ feedback: "repair the failing check" })
      expect(runImplementationChain.mock.calls[2]![1].cliArgs).toEqual({ pr: 99 })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("passes one explicit input, then the prior output, through a simple workflow", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-simple-workflow-"))
    const originalCwd = process.cwd()
    try {
      writeSimpleCapability(cwd, "prepare")
      writeSimpleCapability(cwd, "publish")
      writeWorkflowDefinition(cwd, "release", {
        name: "Release",
        agent: "kody",
        steps: [{ capability: "prepare", target: "issue", input: { prefer: "ours" } }, { capability: "publish" }],
      })
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({
          exitCode: 0,
          capabilityOutput: { releasePr: 42 },
          capabilityResults: [capabilityResult({ releasePr: 42 })],
        })
        .mockResolvedValueOnce({ exitCode: 0, capabilityOutput: "published" })

      await runJob({ workflow: "release", target: 7, cliArgs: {}, flavor: "instant" }, { cwd })

      expect(runImplementationChain.mock.calls.map((call) => call[0])).toEqual(["capability-run", "capability-run"])
      expect(JSON.parse(String(runImplementationChain.mock.calls[0]![1].cliArgs.input))).toEqual({
        prefer: "ours",
        issue: 7,
      })
      expect(JSON.parse(String(runImplementationChain.mock.calls[1]![1].cliArgs.input))).toEqual({
        releasePr: 42,
      })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("uses an explicit workflow target fact instead of a stale prior PR URL", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-target-fact-"))
    try {
      for (const capability of ["prepare", "promote", "merge"]) {
        writeSimpleCapability(cwd, capability)
      }
      writeWorkflowDefinition(cwd, "release", {
        name: "Release",
        agent: "kody",
        steps: [
          { id: "prepare", capability: "prepare", target: "issue", next: "promote" },
          { id: "promote", capability: "promote", next: "merge" },
          { id: "merge", capability: "merge", target: "pr", targetFact: "promotionPr" },
        ],
      })
      runImplementationChain
        .mockResolvedValueOnce({
          exitCode: 0,
          prUrl: "https://github.com/acme/web/pull/991",
          capabilityResults: [capabilityResult({ releasePr: 991 })],
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          capabilityResults: [capabilityResult({ promotionPr: 992 })],
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          capabilityResults: [capabilityResult({ mergedPr: 992 })],
        })

      await runJob({ workflow: "release", target: 7, cliArgs: {}, flavor: "instant" }, { cwd })

      expect(JSON.parse(String(runImplementationChain.mock.calls[2]![1].cliArgs.input))).toEqual({ pr: 992 })
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("ends a workflow through an explicit $end connection", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-end-"))
    try {
      writeSimpleCapability(cwd, "check")
      writeSimpleCapability(cwd, "repair")
      writeWorkflowDefinition(cwd, "health", {
        name: "Health",
        agent: "kody",
        startAt: "check",
        steps: [
          {
            id: "check",
            capability: "check",
            next: [
              { to: "repair", when: { "result.needsRepair": true } },
              { to: "$end", default: true },
            ],
          },
          { id: "repair", capability: "repair" },
        ],
      })
      runImplementationChain.mockResolvedValueOnce({
        exitCode: 0,
        capabilityOutput: { needsRepair: false },
        capabilityResults: [capabilityResult({ needsRepair: false })],
      })

      const result = await runJob({ workflow: "health", cliArgs: {}, flavor: "instant" }, { cwd })

      expect(runImplementationChain).toHaveBeenCalledTimes(1)
      expect(result.workflowState).toMatchObject({
        status: "done",
        completedStepIds: ["check"],
      })
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.each([
    { status: "fail", workflowStatus: "failed", exitCode: 1 },
    { status: "blocked", workflowStatus: "blocked", exitCode: 64 },
  ])("propagates a terminal structured $status result to the workflow boundary", async ({
    status,
    workflowStatus,
    exitCode,
  }) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-terminal-result-"))
    try {
      writeSimpleCapability(cwd, "deploy")
      writeWorkflowDefinition(cwd, "release", {
        name: "Release",
        agent: "kody",
        steps: [{ id: "deploy", capability: "deploy" }],
      })
      runImplementationChain.mockResolvedValueOnce({
        exitCode: 0,
        capabilityOutput: { status },
        capabilityResults: [
          {
            ...capabilityResult({ productionDeployed: false }),
            status,
            summary: "Production deployment failed",
            blockers: ["Production deployment failed"],
          },
        ],
      })

      const result = await runJob({ workflow: "release", cliArgs: {}, flavor: "instant" }, { cwd })

      expect(result).toMatchObject({
        exitCode,
        reason: "Production deployment failed",
        workflowState: {
          status: workflowStatus,
          blocker: "Production deployment failed",
        },
      })
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("keeps direct capability text as the request when routing adds a target", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-simple-capability-input-"))
    try {
      writeSimpleCapability(cwd, "prepare")

      await runJob(
        {
          capability: "prepare",
          target: 7,
          cliArgs: { input: "prepare a patch release", issue: 7 },
          flavor: "instant",
        },
        { cwd },
      )

      expect(JSON.parse(String(runImplementationChain.mock.calls[0]![1].cliArgs.input))).toEqual({
        request: "prepare a patch release",
        issue: 7,
      })
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("does not expose the capability routing slug as business input", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-simple-capability-routing-"))
    try {
      writeSimpleCapability(cwd, "prepare")

      await runJob(
        {
          action: "prepare",
          capability: "prepare",
          implementation: "capability-run",
          cliArgs: { capability: "prepare" },
          flavor: "instant",
        },
        { cwd },
      )

      expect(runImplementationChain.mock.calls[0]![1].cliArgs).toEqual({
        capability: "prepare",
      })
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("blocks a conditional workflow when the source step declares a result but emits none", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-missing-result-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "inspect", {
        name: "inspect",
        action: "inspect",
        output: { result: { facts: ["needsFix"] } },
      })
      writeCapability(cwd, "repair", { name: "repair", action: "repair" })
      writeCapability(cwd, "finish", { name: "finish", action: "finish" })
      writeCapability(cwd, "graph-pilot", {
        name: "graph-pilot",
        action: "graph-pilot",
        workflow: {
          startAt: "inspect",
          steps: [
            {
              id: "inspect",
              capability: "inspect",
              next: [
                { to: "repair", when: { "result.facts.needsFix": true } },
                { to: "finish", default: true },
              ],
            },
            { id: "repair", capability: "repair" },
            { id: "finish", capability: "finish" },
          ],
        },
      })
      process.chdir(cwd)
      runImplementationChain.mockResolvedValueOnce({ exitCode: 0 })

      const result = await runJob(
        { action: "graph-pilot", capability: "graph-pilot", cliArgs: {}, flavor: "instant" },
        { cwd },
      )

      expect(result).toMatchObject({ exitCode: 64 })
      expect(result.reason).toContain("did not emit the structured result")
      expect(runImplementationChain).toHaveBeenCalledTimes(1)
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("rejects every unknown workflow capability before executing the first step", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-preflight-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "unsafe-pilot", {
        name: "unsafe-pilot",
        action: "unsafe-pilot",
        workflow: {
          startAt: "inspect",
          steps: [
            { id: "inspect", capability: "run", next: "missing" },
            { id: "missing", capability: "does-not-exist" },
          ],
        },
      })
      writeWorkflowStages(cwd)
      process.chdir(cwd)

      const result = await runJob(
        { action: "unsafe-pilot", capability: "unsafe-pilot", cliArgs: {}, flavor: "instant" },
        { cwd },
      )

      expect(result).toMatchObject({
        exitCode: 64,
        reason: expect.stringContaining("unknown capability does-not-exist"),
        workflowState: { status: "blocked", currentStepId: "inspect" },
      })
      expect(runImplementationChain).not.toHaveBeenCalled()
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("preflights every capability in a linear workflow before executing it", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-linear-workflow-preflight-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "unsafe-linear", {
        name: "unsafe-linear",
        action: "unsafe-linear",
        workflow: { steps: ["run", "does-not-exist"] },
      })
      writeWorkflowStages(cwd)
      process.chdir(cwd)

      const result = await runJob(
        { action: "unsafe-linear", capability: "unsafe-linear", cliArgs: {}, flavor: "instant" },
        { cwd },
      )

      expect(result).toMatchObject({
        exitCode: 64,
        reason: expect.stringContaining("unknown capability does-not-exist"),
      })
      expect(runImplementationChain).not.toHaveBeenCalled()
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.each([
    { status: "fail", expectedSteps: ["run", "fix"] },
    { status: "pass", expectedSteps: ["run", "review"] },
  ])("routes a $status result through the expected visual branch", async ({ status, expectedSteps }) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-status-"))
    const originalCwd = process.cwd()
    try {
      for (const capability of ["run", "fix", "review"]) {
        writeSimpleCapability(cwd, capability)
      }
      writeWorkflowDefinition(cwd, "status-pilot", {
        name: "Status pilot",
        agent: "kody",
        startAt: "inspect",
        steps: [
          {
            id: "inspect",
            capability: "run",
            next: [
              { to: "repair", when: { "result.status": "fail" } },
              { to: "verify", default: true },
            ],
          },
          { id: "repair", capability: "fix" },
          { id: "verify", capability: "review" },
        ],
      })
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({
          exitCode: 0,
          capabilityOutput: { status },
          capabilityResults: [{ ...capabilityResult({}), status }],
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          capabilityOutput: { completed: true },
          capabilityResults: [capabilityResult({ completed: true })],
        })

      const result = await runJob({ workflow: "status-pilot", cliArgs: {}, flavor: "instant" }, { cwd })

      expect(result.workflowState?.status).toBe("done")
      expect(runImplementationChain.mock.calls.map((call) => String(call[1].cliArgs.capability))).toEqual(expectedSteps)
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.each([
    {
      name: "repeats once, then exits when the condition becomes false",
      results: [true, false],
      expectedSteps: ["run", "fix", "run", "review"],
      expectedCounts: { "repair->inspect": 1 },
    },
    {
      name: "takes the fallback without entering the loop",
      results: [false],
      expectedSteps: ["run", "review"],
      expectedCounts: {},
    },
  ])("routes a conditional loop correctly when it $name", async ({ results, expectedSteps, expectedCounts }) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-conditional-loop-"))
    const originalCwd = process.cwd()
    try {
      for (const capability of ["run", "fix", "review"]) {
        writeSimpleCapability(cwd, capability)
      }
      writeWorkflowDefinition(cwd, "conditional-loop-pilot", {
        name: "Conditional loop pilot",
        agent: "kody",
        startAt: "inspect",
        steps: [
          {
            id: "inspect",
            capability: "run",
            next: [
              { to: "repair", when: { "result.needsFix": true } },
              { to: "verify", default: true },
            ],
          },
          {
            id: "repair",
            capability: "fix",
            next: [{ to: "inspect", maxIterations: 2 }],
          },
          { id: "verify", capability: "review" },
        ],
      })
      process.chdir(cwd)
      for (const needsFix of results) {
        runImplementationChain.mockResolvedValueOnce({
          exitCode: 0,
          capabilityOutput: { needsFix },
          capabilityResults: [capabilityResult({ needsFix })],
        })
        if (needsFix) {
          runImplementationChain.mockResolvedValueOnce({
            exitCode: 0,
            capabilityOutput: { repaired: true },
            capabilityResults: [capabilityResult({ repaired: true })],
          })
        }
      }
      runImplementationChain.mockResolvedValueOnce({
        exitCode: 0,
        capabilityOutput: { verified: true },
        capabilityResults: [capabilityResult({ verified: true })],
      })

      const result = await runJob({ workflow: "conditional-loop-pilot", cliArgs: {}, flavor: "instant" }, { cwd })

      expect(result.workflowState).toMatchObject({ status: "done", transitionCounts: expectedCounts })
      expect(runImplementationChain.mock.calls.map((call) => String(call[1].cliArgs.capability))).toEqual(expectedSteps)
      const executionKeys = runImplementationChain.mock.calls.map((call) => call[1].preloadedData?.workflowExecutionKey)
      expect(executionKeys.every((key) => typeof key === "string" && key.length > 0)).toBe(true)
      expect(new Set(executionKeys).size).toBe(expectedSteps.length)
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("blocks a workflow when no conditional connection matches", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-unmatched-condition-"))
    const originalCwd = process.cwd()
    try {
      for (const capability of ["run", "fix"]) {
        writeSimpleCapability(cwd, capability)
      }
      writeWorkflowDefinition(cwd, "conditional-block-pilot", {
        name: "Conditional block pilot",
        agent: "kody",
        startAt: "inspect",
        steps: [
          {
            id: "inspect",
            capability: "run",
            next: [{ to: "repair", when: { "result.status": "changed" } }],
          },
          { id: "repair", capability: "fix" },
        ],
      })
      process.chdir(cwd)
      runImplementationChain.mockResolvedValueOnce({
        exitCode: 0,
        capabilityOutput: { status: "blocked" },
        capabilityResults: [capabilityResult({ status: "blocked" })],
      })

      const result = await runJob({ workflow: "conditional-block-pilot", cliArgs: {}, flavor: "instant" }, { cwd })

      expect(result.exitCode).toBe(64)
      expect(result.reason).toBe("workflow step inspect has no available connection")
      expect(result.workflowState).toMatchObject({
        status: "blocked",
        blocker: "workflow step inspect has no available connection",
      })
      expect(runImplementationChain).toHaveBeenCalledTimes(1)
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("does not replay a workflow whose persisted state is already done", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-idempotent-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "done-pilot", {
        name: "done-pilot",
        action: "done-pilot",
        workflow: {
          startAt: "inspect",
          steps: [{ id: "inspect", capability: "run" }],
        },
      })
      writeWorkflowStages(cwd)
      process.chdir(cwd)
      const result = await runJob(
        {
          action: "done-pilot",
          capability: "done-pilot",
          cliArgs: {},
          flavor: "instant",
          workflowState: {
            status: "done",
            completedStepIds: ["inspect"],
            transitionCounts: {},
            facts: { verified: true },
            evidence: {},
            artifacts: [],
          },
        },
        { cwd },
      )

      expect(result.workflowState).toMatchObject({ status: "done", completedStepIds: ["inspect"] })
      expect(runImplementationChain).not.toHaveBeenCalled()
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("limits backward workflow connections and takes the default exit", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-loop-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "loop-pilot", {
        name: "loop-pilot",
        action: "loop-pilot",
        workflow: {
          startAt: "inspect",
          steps: [
            {
              id: "inspect",
              capability: "run",
              target: "issue",
              next: [
                { to: "repair", when: { "facts.needsFix": true } },
                { to: "verify", default: true },
              ],
            },
            {
              id: "repair",
              capability: "fix",
              next: [
                { to: "inspect", maxIterations: 1 },
                { to: "verify", default: true },
              ],
            },
            { id: "verify", capability: "review", target: "pr" },
          ],
        },
      })
      writeWorkflowStages(cwd)
      process.chdir(cwd)
      runImplementationChain
        .mockResolvedValueOnce({
          exitCode: 0,
          prUrl: "https://github.com/o/r/pull/99",
          capabilityResults: [capabilityResult({ needsFix: true })],
        })
        .mockResolvedValueOnce({ exitCode: 0, capabilityResults: [capabilityResult({ repaired: true })] })
        .mockResolvedValueOnce({ exitCode: 0, capabilityResults: [capabilityResult({ needsFix: true })] })
        .mockResolvedValueOnce({ exitCode: 0, capabilityResults: [capabilityResult({ repairedAgain: true })] })
        .mockResolvedValueOnce({ exitCode: 0, capabilityResults: [capabilityResult({ verified: true })] })

      const result = await runJob(
        { action: "loop-pilot", capability: "loop-pilot", cliArgs: { issue: 42 }, target: 42, flavor: "instant" },
        { cwd },
      )

      expect(result.workflowState).toMatchObject({
        status: "done",
        transitionCounts: { "repair->inspect": 1 },
      })
      expect(runImplementationChain.mock.calls.map((call) => call[0])).toEqual(["run", "fix", "run", "fix", "review"])
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("resumes a graph workflow from its saved current step and facts", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-resume-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "resume-pilot", {
        name: "resume-pilot",
        action: "resume-pilot",
        workflow: {
          startAt: "inspect",
          steps: [
            { id: "inspect", capability: "run", next: "repair" },
            {
              id: "repair",
              capability: "fix",
              inputs: { feedback: { from: "facts.feedback" } },
            },
          ],
        },
      })
      writeWorkflowStages(cwd)
      process.chdir(cwd)
      runImplementationChain.mockResolvedValueOnce({
        exitCode: 0,
        capabilityResults: [capabilityResult({ repaired: true })],
      })

      const result = await runJob(
        {
          action: "resume-pilot",
          capability: "resume-pilot",
          cliArgs: { issue: 42 },
          target: 42,
          flavor: "instant",
          workflowState: {
            status: "running",
            currentStepId: "repair",
            completedStepIds: ["inspect"],
            transitionCounts: {},
            facts: { feedback: "continue here" },
            evidence: {},
            artifacts: [],
          },
        },
        { cwd },
      )

      expect(runImplementationChain).toHaveBeenCalledTimes(1)
      expect(runImplementationChain.mock.calls[0]![0]).toBe("fix")
      expect(runImplementationChain.mock.calls[0]![1].cliArgs).toEqual({ feedback: "continue here" })
      expect(result.workflowState).toMatchObject({
        status: "done",
        facts: { feedback: "continue here", repaired: true },
      })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("returns a clear blocked workflow state when a mapped input is missing", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-missing-input-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "mapping-pilot", {
        name: "mapping-pilot",
        action: "mapping-pilot",
        workflow: {
          startAt: "repair",
          steps: [
            {
              id: "repair",
              capability: "fix",
              inputs: { feedback: { from: "facts.feedback" } },
            },
          ],
        },
      })
      writeWorkflowStages(cwd)
      process.chdir(cwd)

      const result = await runJob(
        { action: "mapping-pilot", capability: "mapping-pilot", cliArgs: {}, flavor: "instant" },
        { cwd },
      )

      expect(result).toMatchObject({
        exitCode: 64,
        reason: "workflow step repair needs missing input facts.feedback",
        workflowState: { status: "blocked", currentStepId: "repair" },
      })
      expect(runImplementationChain).not.toHaveBeenCalled()
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("rejects a mapped input that the target capability does not accept", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-invalid-input-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "invalid-mapping-pilot", {
        name: "invalid-mapping-pilot",
        action: "invalid-mapping-pilot",
        workflow: {
          startAt: "repair",
          steps: [
            {
              id: "repair",
              capability: "fix",
              inputs: { unsupported: { from: "facts.feedback" } },
            },
          ],
        },
      })
      writeWorkflowStages(cwd)
      process.chdir(cwd)

      const result = await runJob(
        {
          action: "invalid-mapping-pilot",
          capability: "invalid-mapping-pilot",
          cliArgs: {},
          workflowFacts: { feedback: "available" },
          flavor: "instant",
        },
        { cwd },
      )

      expect(result).toMatchObject({
        exitCode: 64,
        reason: expect.stringContaining("does not declare input unsupported"),
        workflowState: { status: "blocked" },
      })
      expect(runImplementationChain).not.toHaveBeenCalled()
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skip("stops a workflow when a child capability fails", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-workflow-fail-"))
    const originalCwd = process.cwd()
    try {
      writeCapability(cwd, "bug", {
        name: "bug",
        action: "bug",
        workflow: { steps: ["reproduce", "run"] },
      })
      writeCapability(cwd, "reproduce", {
        name: "reproduce",
        action: "reproduce",
        implementation: "reproduce",
      })
      process.chdir(cwd)
      runImplementationChain.mockResolvedValueOnce({ exitCode: 1, reason: "repro failed" })

      const result = await runJob(
        { action: "bug", capability: "bug", cliArgs: { issue: 42 }, target: 42, flavor: "instant" },
        { cwd },
      )

      expect(result).toMatchObject({ exitCode: 1, reason: "repro failed" })
      expect(runImplementationChain).toHaveBeenCalledTimes(1)
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

function writeCapability(cwd: string, slug: string, profile: Record<string, unknown>): void {
  if (profile.workflow && typeof profile.workflow === "object") {
    writeWorkflowDefinition(cwd, slug, {
      version: 1,
      name: slug,
      ...(profile.workflow as Record<string, unknown>),
    })
    return
  }
  const implementationId = typeof profile.implementation === "string" ? profile.implementation : slug
  const builtinPath = path.resolve(__dirname, "../../src/implementations", implementationId, "profile.json")
  const builtinProfile = fs.existsSync(builtinPath) ? JSON.parse(fs.readFileSync(builtinPath, "utf8")) : {}
  const effectiveProfile = { ...builtinProfile, ...profile }
  const declaredFacts =
    effectiveProfile.output &&
    typeof effectiveProfile.output === "object" &&
    effectiveProfile.output.result &&
    typeof effectiveProfile.output.result === "object" &&
    Array.isArray(effectiveProfile.output.result.facts)
      ? effectiveProfile.output.result.facts.filter((fact: unknown): fact is string => typeof fact === "string")
      : []
  const capability = {
    id: slug,
    action: typeof effectiveProfile.action === "string" ? effectiveProfile.action : slug,
    purpose: typeof effectiveProfile.describe === "string" ? effectiveProfile.describe : slug,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        (Array.isArray(effectiveProfile.inputs) ? effectiveProfile.inputs : []).flatMap((input: unknown) => {
          const record = input && typeof input === "object" ? (input as Record<string, unknown>) : null
          return record && typeof record.name === "string" ? [[record.name, {}]] : []
        }),
      ),
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        summary: { type: "string" },
        resultClass: { type: "string" },
        facts: {
          type: "object",
          properties: Object.fromEntries(declaredFacts.map((fact: string) => [fact, {}])),
        },
      },
      additionalProperties: true,
    },
    effects: [],
    permissions: [],
    success: "success",
    failure: "failure",
  }
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`
    }
    return JSON.stringify(value)
  }
  const capabilityDir = path.join(cwd, ".kody-engine", "definitions", "capabilities", slug)
  const implementationDir = path.join(cwd, ".kody-engine", "definitions", "implementations", implementationId)
  fs.mkdirSync(capabilityDir, { recursive: true })
  fs.mkdirSync(implementationDir, { recursive: true })
  fs.writeFileSync(path.join(capabilityDir, "definition.json"), JSON.stringify(capability))
  fs.writeFileSync(path.join(capabilityDir, "capability.md"), `# ${slug}\n`)
  fs.writeFileSync(
    path.join(implementationDir, "definition.json"),
    JSON.stringify({
      id: implementationId,
      capabilityRef: { kind: "capability", id: slug },
      compatibleCapabilityRevision: createHash("sha256").update(canonical(capability)).digest("hex"),
      type: "agent",
      agentRef: { kind: "agent", id: "kody" },
    }),
  )
  fs.writeFileSync(
    path.join(implementationDir, "runtime.json"),
    JSON.stringify({
      adapter: "kody-engine-profile",
      inputBindings: {},
      outputBindings: {},
      requirements: {},
      role: "utility",
      inputs: [],
      claudeCode: {
        model: "inherit",
        permissionMode: "default",
        maxTurns: 0,
        maxThinkingTokens: null,
        systemPromptAppend: null,
        tools: [],
        hooks: [],
        skills: [],
        commands: [],
        subagents: [],
        plugins: [],
        mcpServers: [],
      },
      cliTools: [],
      scripts: { preflight: [], postflight: [] },
      ...effectiveProfile,
    }),
  )
}

function writeWorkflowDefinition(cwd: string, slug: string, workflow: Record<string, unknown>): void {
  const dir = path.join(cwd, ".kody-engine", "runtime", "workflows", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(workflow))
}

function writeSimpleCapability(cwd: string, slug: string): void {
  const dir = path.join(cwd, ".kody-engine", "definitions", "capabilities", slug)
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true })
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true })
  fs.writeFileSync(path.join(dir, "instructions.md"), `# ${slug}\n\nDo the work.\n`)
}

function writeWorkflowStages(cwd: string): void {
  writeCapability(cwd, "run", {
    name: "run",
    action: "run",
    output: { result: { facts: ["needsFix"] } },
    role: "primitive",
    inputs: [
      { name: "issue", flag: "--issue", type: "int", required: true },
      { name: "base", flag: "--base", type: "string", required: false },
    ],
  })
  writeCapability(cwd, "review", {
    name: "review",
    action: "review",
    role: "primitive",
    inputs: [{ name: "pr", flag: "--pr", type: "int", required: true }],
  })
  writeCapability(cwd, "fix", {
    name: "fix",
    action: "fix",
    role: "primitive",
    inputs: [
      { name: "pr", flag: "--pr", type: "int", required: true },
      { name: "feedback", flag: "--feedback", type: "string", required: false },
    ],
  })
}

function taskState(type: string, prUrl?: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    core: {
      phase: "idle",
      status: "succeeded",
      currentImplementation: null,
      attempts: {},
      lastOutcome: { type, payload: {}, timestamp: "2026-06-26T00:00:00.000Z" },
      ...(prUrl ? { prUrl } : {}),
    },
    implementations: {},
    artifacts: {},
    jobs: {},
    history: [],
  }
}

function capabilityResult(facts: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    status: "changed",
    summary: "pilot result",
    facts,
    artifacts: [],
    missingEvidence: [],
    blockers: [],
  }
}

describe("mintInstantJob (Phase 2)", () => {
  const dispatch = {
    action: "fix",
    capability: "fix",
    implementation: "fix",
    cliArgs: { pr: 7 },
    target: 7,
  }

  it("maps a DispatchResult to an instant job", () => {
    const job = mintInstantJob(dispatch, { why: "fix the typo" })
    expect(job).toMatchObject({
      implementation: "fix",
      capability: "fix",
      target: 7,
      cliArgs: { pr: 7 },
      why: "fix the typo",
      flavor: "instant",
    })
  })

  it("defaults agent to the standard agent", () => {
    expect(mintInstantJob(dispatch).agent).toBe(DEFAULT_INSTANT_AGENT)
  })

  it("lets the caller override the agent", () => {
    expect(mintInstantJob(dispatch, { agent: "reviewer" }).agent).toBe("reviewer")
  })

  it("produces a job that runJob can run", async () => {
    runImplementationChain.mockResolvedValue({ exitCode: 0 })
    await runJob(mintInstantJob(dispatch, { why: "x" }), { cwd: "/x" })
    expect(runImplementationChain.mock.calls.at(-1)![0]).toBe("fix")
  })
})

describe("mintScheduledJob (Phase 2)", () => {
  it("maps a due capability slug to a scheduled job", () => {
    const job = mintScheduledJob({
      capability: "stale-prs",
      implementation: "capability-tick",
      schedule: "*/5 * * * *",
      agent: "kody",
      cliArgs: { capability: "stale-prs" },
    })
    expect(job).toMatchObject({
      capability: "stale-prs",
      implementation: "capability-tick",
      schedule: "*/5 * * * *",
      agent: "kody",
      cliArgs: { capability: "stale-prs" },
      flavor: "scheduled",
    })
  })

  it("defaults cliArgs to empty", () => {
    expect(mintScheduledJob({ capability: "d", implementation: "capability-tick" }).cliArgs).toEqual({})
  })

  it("carries the cadence onto ctx.data.jobSchedule so the ledger records when it fired", async () => {
    await runJob(
      mintScheduledJob({
        capability: "capability-tick",
        implementation: "capability-tick",
        schedule: "7d",
      }),
      { cwd: "/x" },
    )
    const [, input] = runImplementationChain.mock.calls.at(-1)!
    expect(input.preloadedData?.jobSchedule).toBe("7d")
    expect(input.preloadedData?.jobFlavor).toBe("scheduled")
    expect(input.preloadedData?.jobCapability).toBe("capability-tick")
    expect(input.preloadedData?.selectedImplementation).toBe("capability-tick")
    expect(input.preloadedData?.selectedImplementation).toBe("capability-tick")
  })

  it("carries saveReport onto ctx.data.jobSaveReport", async () => {
    await runJob(
      mintScheduledJob({
        capability: "model-health-audit",
        implementation: "model-health-audit",
        saveReport: true,
      }),
      { cwd: "/x" },
    )

    const [, input] = runImplementationChain.mock.calls.at(-1)!
    expect(input.preloadedData?.jobSaveReport).toBe(true)
  })
})
