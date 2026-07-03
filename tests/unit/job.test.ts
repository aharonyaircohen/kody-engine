import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Hoist-safe mock of the executor so runJob is tested in isolation (no real
// executable spins up). Mirrors tests/unit/dispatchCapabilityFileTicks.routing.test.ts.
const { gh, runExecutableChain } = vi.hoisted(() => ({
  gh: vi.fn(),
  runExecutableChain: vi.fn(),
}))
vi.mock("../../src/executor.js", () => ({ runExecutableChain }))
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
    runExecutableChain.mockReset()
    runExecutableChain.mockResolvedValue({ exitCode: 0 })
    gh.mockReset()
    gh.mockImplementation(() => {
      throw new Error("HTTP 404 Not Found")
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("lowers an instant job onto runExecutableChain with its executable + cliArgs", async () => {
    await runJob(
      { capability: "run", executable: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    expect(runExecutableChain).toHaveBeenCalledTimes(1)
    const [profile, input] = runExecutableChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.cliArgs).toEqual({ issue: 42 })
    expect(input.cwd).toBe("/x")
    expect(input.preloadedData?.jobCapability).toBe("run")
  })

  it("seeds result target as internal postflight context, not CLI args", async () => {
    await runJob(
      {
        capability: "vercel-production-deploy",
        executable: "vercel-production-deploy",
        cliArgs: {},
        flavor: "instant",
        resultTarget: { type: "goal", id: "web-release-2026-07-01", evidence: "productionDeployed" },
      },
      { cwd: "/x" },
    )

    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.cliArgs).toEqual({})
    expect(input.preloadedData?.capabilityResultTarget).toEqual({
      type: "goal",
      id: "web-release-2026-07-01",
      evidence: "productionDeployed",
    })
  })

  it("lowers an action-only instant job through the capability action registry", async () => {
    await runJob({ action: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" }, { cwd: "/x" })
    const [profile, input] = runExecutableChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.cliArgs).toEqual({ issue: 42 })
    expect(input.preloadedData?.jobAction).toBe("run")
    expect(input.preloadedData?.jobCapability).toBe("run")
    expect(input.preloadedData?.jobExecutable).toBe("run")
  })

  it("resolves a capability-only job to the capability-selected executable", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-capability-job-"))
    const capabilityDir = path.join(cwd, ".kody", "capabilities", "ci-health")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({ name: "ci-health", action: "ci-health", executable: "ci-check", agent: "kody" }),
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

    const [profile, input] = runExecutableChain.mock.calls[0]!
    expect(profile).toBe("ci-check")
    expect(input.cliArgs).toEqual({ pr: 456, goal: "release-aguy", evidence: "mainDeployPrGreen" })
    expect(input.preloadedData?.jobCapability).toBe("ci-health")
    expect(input.preloadedData?.jobExecutable).toBe("ci-check")
  })
  it("preserves capability identity without injecting capability args when executable is explicit", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-goal-handoff-"))
    const capabilityDir = path.join(cwd, ".kody", "capabilities", "company-graph")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.writeFileSync(path.join(capabilityDir, "profile.json"), JSON.stringify({ name: "company-graph" }))
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Company Graph\n")
    await runJob(
      {
        capability: "company-graph",
        executable: "company-graph",
        cliArgs: { goal: "hourly-monitor-goal-smoke" },
        flavor: "instant",
      },
      { cwd },
    )
    const [profile, input] = runExecutableChain.mock.calls[0]!
    expect(profile).toBe("company-graph")
    expect(input.cliArgs).toEqual({ goal: "hourly-monitor-goal-smoke" })
    expect(input.preloadedData?.jobCapability).toBe("company-graph")
    expect(input.preloadedData?.jobExecutable).toBe("company-graph")
  })

  it("seeds inline why into preloadedData.jobWhy", async () => {
    await runJob(
      { capability: "unit-fix", executable: "unit-fix", why: "fix the flaky test", cliArgs: {}, flavor: "instant" },
      { cwd: "/x" },
    )
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBe("fix the flaky test")
    expect(input.preloadedData?.jobIntent).toBeUndefined()
  })

  it("does not seed jobWhy for an empty why string", async () => {
    await runJob({ capability: "run", executable: "run", why: "", cliArgs: {}, flavor: "instant" }, { cwd: "/x" })
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBeUndefined()
  })

  it("always seeds a jobId + flavor so the run can be recorded in the task ledger", async () => {
    await runJob(
      { capability: "run", executable: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(typeof input.preloadedData?.jobId).toBe("string")
    expect(input.preloadedData?.jobKey).toBe("instant:run:42")
    expect(input.preloadedData?.jobFlavor).toBe("instant")
    expect(input.preloadedData?.jobExecutable).toBe("run")
    expect(input.preloadedData?.jobTarget).toBe(42)
  })

  it("keeps the same stable job key for retries of the same target + executable", async () => {
    await runJob(
      { capability: "run", executable: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    await runJob(
      { capability: "run", executable: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )

    const first = runExecutableChain.mock.calls[0]![1].preloadedData
    const second = runExecutableChain.mock.calls[1]![1].preloadedData
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
        executable: "run",
        cliArgs: { issue: 5 },
        target: 5,
        why: "also add tests",
      }),
      { cwd: "/x" },
    )
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBe("also add tests")
  })

  it("seeds agent into preloadedData.jobAgent", async () => {
    await runJob(
      { capability: "run", agent: "kody", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" },
      { cwd: "/x" },
    )
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobAgent).toBe("kody")
  })

  it("uses the capability reference in the stable key for scheduled jobs", async () => {
    await runJob(
      {
        capability: "capability-tick",
        executable: "capability-tick",
        schedule: "*/5 * * * *",
        cliArgs: {},
        flavor: "scheduled",
      },
      { cwd: "/x" },
    )
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobKey).toBe("scheduled:capability-tick:capability-tick")
  })

  it("falls back to the capability slug as the profile when no executable", async () => {
    await runJob({ capability: "run", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" }, { cwd: "/x" })
    expect(runExecutableChain.mock.calls[0]![0]).toBe("run")
  })

  it("seeds only job identity (no why/agent) for a bare scheduled job", async () => {
    await runJob({ capability: "run", cliArgs: {}, flavor: "scheduled" }, { cwd: "/x" })
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobFlavor).toBe("scheduled")
    expect(input.preloadedData?.jobWhy).toBeUndefined()
    expect(input.preloadedData?.jobAgent).toBeUndefined()
  })

  it("rejects a job with no capability action or capability", () => {
    expect(() => validateJob({ cliArgs: {}, flavor: "instant" })).toThrow(InvalidJobError)
  })

  it("rejects an executable-only job", () => {
    expect(() => validateJob({ executable: "run", cliArgs: {}, flavor: "instant" })).toThrow(
      /capability action, capability, or workflow/,
    )
  })

  it("rejects an unknown flavor", () => {
    expect(() => validateJob({ capability: "run", executable: "run", cliArgs: {}, flavor: "bogus" })).toThrow(
      InvalidJobError,
    )
  })

  it("defaults cliArgs to an empty object when omitted", () => {
    const j = validateJob({ capability: "run", executable: "run", flavor: "instant" })
    expect(j.cliArgs).toEqual({})
  })

  it("accepts a workflow-only job", () => {
    const j = validateJob({ workflow: "bug-flow", flavor: "instant" })
    expect(j.workflow).toBe("bug-flow")
    expect(j.cliArgs).toEqual({})
  })

  it("runs a workflow capability as ordered child capability jobs", async () => {
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

      expect(runExecutableChain).toHaveBeenCalledTimes(2)
      expect(runExecutableChain.mock.calls[0]![0]).toBe("reproduce")
      expect(runExecutableChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42 })
      expect(runExecutableChain.mock.calls[0]![1].preloadedData).toMatchObject({
        workflowCapability: "bug",
        workflowStep: "reproduce",
        workflowStepIndex: 1,
        workflowStepCount: 2,
        jobCapability: "reproduce",
        jobExecutable: "reproduce",
      })
      expect(runExecutableChain.mock.calls[0]![1].preloadedData?.jobWhy).toContain("operator note")
      expect(runExecutableChain.mock.calls[0]![1].preloadedData?.jobWhy).toContain("capture the failing test")

      expect(runExecutableChain.mock.calls[1]![0]).toBe("run")
      expect(runExecutableChain.mock.calls[1]![1].cliArgs).toEqual({ issue: 42, base: "feature/base" })
      expect(runExecutableChain.mock.calls[1]![1].preloadedData).toMatchObject({
        workflowCapability: "bug",
        workflowStep: "run",
        workflowStepIndex: 2,
        workflowStepCount: 2,
        jobCapability: "run",
        jobExecutable: "run",
      })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("runs an action-only workflow capability without treating the action as an executable", async () => {
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

      expect(runExecutableChain).toHaveBeenCalledTimes(1)
      expect(runExecutableChain.mock.calls[0]![0]).toBe("run")
      expect(runExecutableChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42 })
      expect(runExecutableChain.mock.calls[0]![1].preloadedData).toMatchObject({
        workflowCapability: "feature",
        workflowStep: "run",
        jobCapability: "run",
        jobExecutable: "run",
      })
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("runs a stored workflow definition as ordered child capability jobs", async () => {
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
      gh.mockReturnValue(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(workflow), "utf8").toString("base64"),
          sha: "workflow-sha",
        }),
      )
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
            state: { repo: "o/kody-state", path: "r" },
          },
        },
      )

      expect(gh).toHaveBeenCalledWith(
        ["api", "/repos/o/kody-state/contents/r/workflows/bug-flow/workflow.json?ref=main"],
        {
          cwd,
        },
      )
      expect(runExecutableChain).toHaveBeenCalledTimes(2)
      expect(runExecutableChain.mock.calls[0]![0]).toBe("reproduce")
      expect(runExecutableChain.mock.calls[0]![1].preloadedData).toMatchObject({
        workflowCapability: "bug-flow",
        workflowTitle: "Bug workflow",
        workflowStep: "reproduce",
        workflowStepIndex: 1,
        workflowStepCount: 2,
      })
      expect(runExecutableChain.mock.calls[0]![1].preloadedData).not.toHaveProperty("jobWhy")
      expect(runExecutableChain.mock.calls[1]![0]).toBe("run")
      expect(runExecutableChain.mock.calls[1]![1].preloadedData).toMatchObject({
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

  it("preserves stored workflow step order, duplicate capabilities, and PR handoff", async () => {
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
      gh.mockReturnValue(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(workflow), "utf8").toString("base64"),
          sha: "workflow-sha",
        }),
      )
      process.chdir(cwd)
      runExecutableChain
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
            state: { repo: "o/kody-state", path: "r" },
          },
        },
      )

      expect(runExecutableChain).toHaveBeenCalledTimes(5)
      expect(runExecutableChain.mock.calls.map((call) => call[0])).toEqual([
        "release-prepare",
        "release-merge",
        "release-promote",
        "release-merge",
        "vercel-production-deploy",
      ])
      expect(runExecutableChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42 })
      expect(runExecutableChain.mock.calls[1]![1].cliArgs).toEqual({ issue: 42, pr: 10 })
      expect(runExecutableChain.mock.calls[2]![1].cliArgs).toEqual({ issue: 42 })
      expect(runExecutableChain.mock.calls[3]![1].cliArgs).toEqual({ issue: 42, pr: 11 })
      expect(runExecutableChain.mock.calls[4]![1].cliArgs).toEqual({})
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("runs a workflow when the public route includes the selected executable", async () => {
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
      })
      process.chdir(cwd)

      await runJob(
        {
          action: "bug",
          capability: "bug",
          executable: "reproduce",
          cliArgs: { issue: 42 },
          target: 42,
          flavor: "instant",
        },
        { cwd },
      )

      expect(runExecutableChain).toHaveBeenCalledTimes(2)
      expect(runExecutableChain.mock.calls[0]![0]).toBe("reproduce")
      expect(runExecutableChain.mock.calls[1]![0]).toBe("run")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("passes workflow issue and PR targets to matching steps", async () => {
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
      runExecutableChain
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

      expect(runExecutableChain).toHaveBeenCalledTimes(3)
      expect(runExecutableChain.mock.calls[0]![1].cliArgs).toEqual({ issue: 42, base: "feature/base" })
      expect(runExecutableChain.mock.calls[1]![1].cliArgs).toEqual({ pr: 99 })
      expect(runExecutableChain.mock.calls[2]![1].cliArgs).toEqual({ pr: 99 })
      expect(runExecutableChain.mock.calls[1]![1].preloadedData?.workflowStep).toBe("review")
      expect(runExecutableChain.mock.calls[2]![1].preloadedData?.workflowStep).toBe("fix")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("skips conditional workflow steps when runWhen does not match", async () => {
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
      runExecutableChain
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RUN_COMPLETED", "https://github.com/o/r/pull/99") })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("REVIEW_PASS") })

      await runJob(
        { action: "feature", capability: "feature", cliArgs: { issue: 42 }, target: 42, flavor: "instant" },
        { cwd },
      )

      expect(runExecutableChain).toHaveBeenCalledTimes(2)
      expect(runExecutableChain.mock.calls[0]![0]).toBe("run")
      expect(runExecutableChain.mock.calls[1]![0]).toBe("review")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("can continue a workflow after an allowed non-zero action outcome", async () => {
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
      runExecutableChain
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("RUN_COMPLETED", "https://github.com/o/r/pull/99") })
        .mockResolvedValueOnce({ exitCode: 1, reason: "blocking review", taskState: taskState("REVIEW_FAIL") })
        .mockResolvedValueOnce({ exitCode: 0, taskState: taskState("FIX_COMPLETED") })

      const result = await runJob(
        { action: "feature", capability: "feature", cliArgs: { issue: 42 }, target: 42, flavor: "instant" },
        { cwd },
      )

      expect(result).toMatchObject({ exitCode: 0 })
      expect(runExecutableChain).toHaveBeenCalledTimes(3)
      expect(runExecutableChain.mock.calls[1]![1].preloadedData?.workflowContinueOn).toEqual(["REVIEW_FAIL"])
      expect(runExecutableChain.mock.calls[2]![0]).toBe("fix")
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("stops a workflow when a child capability fails", async () => {
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
      runExecutableChain.mockResolvedValueOnce({ exitCode: 1, reason: "repro failed" })

      const result = await runJob(
        { action: "bug", capability: "bug", cliArgs: { issue: 42 }, target: 42, flavor: "instant" },
        { cwd },
      )

      expect(result).toMatchObject({ exitCode: 1, reason: "repro failed" })
      expect(runExecutableChain).toHaveBeenCalledTimes(1)
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

function writeCapability(cwd: string, slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(cwd, ".kody", "capabilities", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile))
  fs.writeFileSync(path.join(dir, "capability.md"), `# ${slug}\n`)
}

function writeWorkflowStages(cwd: string): void {
  writeCapability(cwd, "run", {
    name: "run",
    action: "run",
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
      currentExecutable: null,
      attempts: {},
      lastOutcome: { type, payload: {}, timestamp: "2026-06-26T00:00:00.000Z" },
      ...(prUrl ? { prUrl } : {}),
    },
    executables: {},
    artifacts: {},
    jobs: {},
    history: [],
  }
}

describe("mintInstantJob (Phase 2)", () => {
  const dispatch = { action: "fix", capability: "fix", executable: "fix", cliArgs: { pr: 7 }, target: 7 }

  it("maps a DispatchResult to an instant job", () => {
    const job = mintInstantJob(dispatch, { why: "fix the typo" })
    expect(job).toMatchObject({
      executable: "fix",
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
    runExecutableChain.mockResolvedValue({ exitCode: 0 })
    await runJob(mintInstantJob(dispatch, { why: "x" }), { cwd: "/x" })
    expect(runExecutableChain.mock.calls.at(-1)![0]).toBe("fix")
  })
})

describe("mintScheduledJob (Phase 2)", () => {
  it("maps a due capability slug to a scheduled job", () => {
    const job = mintScheduledJob({
      capability: "stale-prs",
      executable: "capability-tick",
      schedule: "*/5 * * * *",
      agent: "kody",
      cliArgs: { capability: "stale-prs" },
    })
    expect(job).toMatchObject({
      capability: "stale-prs",
      executable: "capability-tick",
      schedule: "*/5 * * * *",
      agent: "kody",
      cliArgs: { capability: "stale-prs" },
      flavor: "scheduled",
    })
  })

  it("defaults cliArgs to empty", () => {
    expect(mintScheduledJob({ capability: "d", executable: "capability-tick" }).cliArgs).toEqual({})
  })

  it("carries the cadence onto ctx.data.jobSchedule so the ledger records when it fired", async () => {
    await runJob(
      mintScheduledJob({
        capability: "capability-tick",
        executable: "capability-tick",
        schedule: "7d",
      }),
      { cwd: "/x" },
    )
    const [, input] = runExecutableChain.mock.calls.at(-1)!
    expect(input.preloadedData?.jobSchedule).toBe("7d")
    expect(input.preloadedData?.jobFlavor).toBe("scheduled")
    expect(input.preloadedData?.jobCapability).toBe("capability-tick")
    expect(input.preloadedData?.jobExecutable).toBe("capability-tick")
  })

  it("carries saveReport onto ctx.data.jobSaveReport", async () => {
    await runJob(
      mintScheduledJob({
        capability: "model-health-audit",
        executable: "model-health-audit",
        saveReport: true,
      }),
      { cwd: "/x" },
    )

    const [, input] = runExecutableChain.mock.calls.at(-1)!
    expect(input.preloadedData?.jobSaveReport).toBe(true)
  })
})
